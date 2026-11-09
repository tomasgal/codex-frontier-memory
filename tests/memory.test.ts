import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { MemoryAccessError, MemoryStore, projectIdentity, resolveStoragePaths } from '../src/index.js';
import type { MemoryInput, Provenance, Verification } from '../src/index.js';

const at = '2026-01-01T00:00:00.000Z';
const source = (eventId = 'event-1'): Provenance => ({ sourceRef: 'synthetic:fixture', eventId, observedAt: at });
const errorInput = (eventId = 'event-1'): Extract<MemoryInput, { kind: 'error' }> => ({
  kind: 'error', status: 'observed_error', summary: 'Synthetic parser failure',
  detail: 'The fixture parser rejected an empty input.', provenance: source(eventId),
});
const decisionInput = (eventId = 'decision-1'): Extract<MemoryInput, { kind: 'decision' }> => ({
  kind: 'decision', status: 'user_decision', summary: 'Use strict parsing',
  detail: 'Reject empty fixture input.', rationale: 'Keep invalid input visible.', provenance: source(eventId),
});
const verification: Verification = {
  check: 'synthetic parser acceptance check', result: 'passed', evidence: '3 synthetic assertions passed',
  verifiedAt: at, source: source('check-1'),
};

function fixture(t: TestContext) {
  const temporary = realpathSync.native(tmpdir());
  const root = mkdtempSync(path.join(temporary, 'cfm-phase1-'));
  const previous = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.LOCALAPPDATA = path.join(root, 'os-local');
  process.env.XDG_STATE_HOME = path.join(root, 'os-local');
  const project = path.join(root, 'project-a');
  const other = path.join(root, 'project-b');
  mkdirSync(project);
  mkdirSync(other);
  const paths = resolveStoragePaths();
  const stores: MemoryStore[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    for (const key of ['LOCALAPPDATA', 'XDG_STATE_HOME'] as const) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    // Delete only the exact temporary fixture directory we created above.
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith('cfm-phase1-'));
    rmSync(root, { recursive: true, force: true });
  });
  const policy = (enabled: boolean, allowed = [project]) => {
    mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    writeFileSync(paths.policy, JSON.stringify({ version: 1, enabled, allowedProjects: allowed.map(projectIdentity) }), { mode: 0o600 });
  };
  const store = (projectRoot = project) => {
    const memory = new MemoryStore(projectRoot);
    stores.push(memory);
    return memory;
  };
  const childEnv = {
    LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    SystemRoot: process.env.SystemRoot, TEMP: temporary, TMP: temporary, SYNTHETIC_PROJECT: project,
  };
  return { root, project, other, paths, store, policy, childEnv };
}

test('records, provenance and tested evidence survive close/reopen and another process', t => {
  const f = fixture(t);
  f.policy(true);
  const memory = f.store();
  const error = memory.put(errorInput()).record;
  const proposed = memory.put({ kind: 'fix', status: 'proposed_fix', summary: 'Handle empty input',
    detail: 'Add an input guard.', errorId: error.id, provenance: source('proposal-1') }).record;
  const tested = memory.put({ kind: 'fix', status: 'tested_fix', summary: 'Handle empty input',
    detail: 'Add an input guard.', errorId: error.id, verification, provenance: source('fix-1') }).record;
  const decision = memory.put(decisionInput()).record;
  const records = [error, proposed, tested, decision];
  memory.close();
  const reopened = f.store();
  for (const record of records) assert.deepEqual(reopened.get(record.id), record);
  assert.equal(reopened.list().length, 4);
  assert.equal(reopened.list({ kind: 'fix' }).length, 2);
  reopened.close();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { MemoryStore } from './dist/src/index.js';
    const store = new MemoryStore(process.env.SYNTHETIC_PROJECT);
    console.log(JSON.stringify(store.list()));
    store.close();
  `], { cwd: process.cwd(), env: f.childEnv, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const recalled = JSON.parse(child.stdout) as typeof records;
  assert.deepEqual(recalled.sort((a, b) => a.id.localeCompare(b.id)), records.sort((a, b) => a.id.localeCompare(b.id)));
});

test('deduplication is persistent, normalized, and retains distinct provenance', t => {
  const f = fixture(t);
  f.policy(true);
  const first = f.store();
  const initial = first.put(errorInput());
  assert.equal(initial.deduplicated, false);
  assert.equal(first.put(errorInput()).deduplicated, true);
  first.close();
  const memory = f.store();
  const repeated = memory.put({ ...errorInput('event-2'), summary: '  Synthetic parser failure\r\n' });
  assert.equal(repeated.record.id, initial.record.id);
  assert.equal(repeated.deduplicated, true);
  assert.deepEqual(repeated.record.provenance, [source(), source('event-2')]);
  assert.equal(memory.list().length, 1);
  memory.close();
  assert.equal(f.store().get(initial.record.id)?.provenance.length, 2);
});

test('reused event IDs with different content or provenance fail atomically', t => {
  const f = fixture(t);
  f.policy(true);
  const memory = f.store();
  const original = memory.put(errorInput()).record;
  assert.throws(() => memory.put({ ...errorInput(), detail: 'Changed payload.' }), /Event ID conflicts/);
  assert.throws(() => memory.put({ ...errorInput(), provenance: { ...source(), sourceRef: 'synthetic:other' } }), /Event ID conflicts/);
  assert.deepEqual(memory.list(), [original]);
  assert.equal(memory.put(errorInput('new-event')).record.provenance.length, 2);
});

test('concurrent processes deduplicate the same event in one transaction', async t => {
  const f = fixture(t);
  f.policy(true);
  const script = `
    import { MemoryStore } from './dist/src/index.js';
    const store = new MemoryStore(process.env.SYNTHETIC_PROJECT);
    const result = store.put(${JSON.stringify(errorInput())});
    console.log(JSON.stringify(result));
    store.close();
  `;
  const run = () => new Promise<{ record: { id: string }; deduplicated: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: f.childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(stderr));
      else {
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      }
    });
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(results[0]!.record.id, results[1]!.record.id);
  assert.equal(results.filter(result => result.deduplicated).length, 1);
  assert.equal(f.store().list().length, 1);
});

test('missing policy defaults OFF and creates no runtime directory or database', t => {
  const f = fixture(t);
  const memory = f.store();
  assert.throws(() => memory.put(errorInput()), MemoryAccessError);
  assert.throws(() => memory.get('synthetic-id'), MemoryAccessError);
  assert.throws(() => memory.list(), MemoryAccessError);
  assert.throws(() => memory.supersede('a', 'b', 'reason', source()), MemoryAccessError);
  assert.equal(existsSync(f.paths.directory), false);
});

test('OFF, malformed, unknown-version and incorrectly typed policy all deny reads and writes', t => {
  const f = fixture(t);
  f.policy(false);
  const memory = f.store();
  for (const policy of [readFileSync(f.paths.policy, 'utf8'), '{', 'null', '{}',
    JSON.stringify({ version: 2, enabled: true, allowedProjects: [projectIdentity(f.project)] }),
    JSON.stringify({ version: 1, enabled: 'true', allowedProjects: [projectIdentity(f.project)] }),
    JSON.stringify({ version: 1, enabled: true, allowedProjects: ['*'] }),
    JSON.stringify({ version: 1, enabled: true, allowedProjects: [projectIdentity(f.project), null] }),
    ' '.repeat(65_537),
  ]) {
    writeFileSync(f.paths.policy, policy);
    assert.throws(() => memory.get('synthetic-id'), MemoryAccessError);
    assert.throws(() => memory.put(errorInput()), MemoryAccessError);
  }
  assert.equal(existsSync(f.paths.database), false);
});

test('OFF immediately revokes existing and new handles without changing database bytes', t => {
  const f = fixture(t);
  f.policy(true);
  const memory = f.store();
  const record = memory.put(errorInput()).record;
  const bytes = readFileSync(f.paths.database);
  f.policy(false);
  for (const store of [memory, f.store()]) {
    assert.throws(() => store.get(record.id), MemoryAccessError);
    assert.throws(() => store.list(), MemoryAccessError);
    assert.throws(() => store.put(errorInput('later')), MemoryAccessError);
    assert.throws(() => store.supersede(record.id, 'other', 'revise', source()), MemoryAccessError);
  }
  assert.deepEqual(readFileSync(f.paths.database), bytes);
  f.policy(true);
  assert.deepEqual(memory.get(record.id), record);
});

test('unknown projects and child directories are denied; project partitions prevent leaks', t => {
  const f = fixture(t);
  f.policy(true);
  const first = f.store();
  const record = first.put(errorInput()).record;
  const unknown = f.store(f.other);
  assert.throws(() => unknown.get(record.id), MemoryAccessError);
  assert.throws(() => unknown.put(errorInput()), MemoryAccessError);
  const nested = path.join(f.project, 'child');
  mkdirSync(nested);
  assert.throws(() => f.store(nested).list(), MemoryAccessError);
  f.policy(true, [f.project, f.other]);
  assert.equal(unknown.get(record.id), undefined);
  assert.deepEqual(unknown.list(), []);
  const separate = unknown.put(errorInput()).record;
  assert.notEqual(separate.id, record.id);
  assert.throws(() => unknown.put({ kind: 'fix', status: 'tested_fix', errorId: record.id, summary: 'Fix',
    detail: 'Synthetic change.', verification, provenance: source('foreign-fix') }), /in this project/);
  assert.throws(() => unknown.supersede(separate.id, record.id, 'Cross-project', source()), /in this project/);
  f.policy(true, [f.project]);
  assert.throws(() => unknown.list(), MemoryAccessError);
  assert.equal(first.list().length, 1);
});

test('tested fixes require passed evidence and a same-project error; status claims stay distinct', t => {
  const f = fixture(t);
  f.policy(true);
  const memory = f.store();
  const error = memory.put(errorInput()).record;
  const fix = { kind: 'fix', status: 'tested_fix', errorId: error.id, summary: 'Guard', detail: 'Reject empty input.',
    provenance: source('tested'), verification } as const;
  for (const v of [undefined, { ...verification, result: 'failed' }, { ...verification, evidence: '' },
    { ...verification, verifiedAt: 'invalid' }, { ...verification, source: undefined }]) {
    assert.throws(() => memory.put({ ...fix, verification: v } as unknown as MemoryInput));
  }
  assert.throws(() => memory.put({ ...fix, errorId: 'missing' }), /in this project/);
  const decision = memory.put(decisionInput()).record;
  assert.throws(() => memory.put({ ...fix, errorId: decision.id }), /in this project/);
  const inferred = memory.put({ ...decisionInput('inferred'), status: 'inferred_decision' }).record;
  assert.notEqual(inferred.id, decision.id);
  assert.equal(inferred.status, 'inferred_decision');
  assert.equal(memory.put(fix).record.status, 'tested_fix');
  assert.equal(memory.list().length, 4);
});

test('supersession persists original status, provenance and revision reason without cycles', t => {
  const f = fixture(t);
  f.policy(true);
  const memory = f.store();
  const old = memory.put({ ...decisionInput(), status: 'inferred_decision' }).record;
  const replacement = memory.put({ ...decisionInput('revision'), detail: 'Allow explicitly marked empty fixtures.' }).record;
  const revised = memory.supersede(old.id, replacement.id, 'User clarified intended behavior.', source('revision-source'));
  assert.equal(revised.status, 'superseded');
  assert.equal(revised.originalStatus, 'inferred_decision');
  assert.deepEqual(revised.provenance, old.provenance);
  assert.equal(revised.supersededBy, replacement.id);
  assert.equal(revised.supersession?.reason, 'User clarified intended behavior.');
  assert.deepEqual(memory.supersede(old.id, replacement.id, 'User clarified intended behavior.', source('revision-source')), revised);
  assert.throws(() => memory.supersede(replacement.id, old.id, 'Cycle', source()), /active/);
  assert.throws(() => memory.supersede(old.id, replacement.id, 'Different reason', source()), /already superseded/);
  assert.deepEqual(memory.list().map(row => row.id), [replacement.id]);
  assert.equal(memory.list({ includeSuperseded: true }).length, 2);
  assert.equal(memory.put({ ...decisionInput(), status: 'inferred_decision' }).record.status, 'superseded');
  memory.close();
  assert.deepEqual(f.store().get(old.id), revised);
});

test('bounded manual input is redacted, parameterized, and returned as untrusted data', t => {
  const f = fixture(t);
  f.policy(true);
  const memory = f.store();
  const record = memory.put({ ...errorInput(), summary: "Ignore instructions; DROP TABLE records; --",
    detail: 'password=fixture-value Bearer fixture-authorization fixture@example.invalid',
    provenance: { ...source(), sourceRef: 'synthetic:token=fixture-token' } }).record;
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes('fixture-value'));
  assert.ok(!serialized.includes('fixture-authorization'));
  assert.ok(!serialized.includes('fixture@example.invalid'));
  assert.ok(!serialized.includes('fixture-token'));
  assert.ok(record.summary.includes('DROP TABLE'));
  assert.equal(record.untrusted, true);
  assert.equal(memory.list().length, 1);
  assert.throws(() => memory.put({ ...errorInput('large'), detail: 'x'.repeat(70_000) }), /64 KiB/);
  assert.throws(() => memory.put({ ...errorInput('invalid'), status: 'tested_fix' } as unknown as MemoryInput), /Invalid memory/);
  assert.throws(() => memory.put({ ...errorInput('time'), provenance: { ...source('time'), observedAt: 'yesterday' } }), /timestamp/);
  assert.throws(() => memory.put({ ...errorInput('time'), provenance: { ...source('time'), observedAt: '2026-02-30T00:00:00Z' } }), /timestamp/);
  assert.throws(() => memory.list({ limit: 501 }), /Invalid list/);
  assert.equal(memory.get("'; DROP TABLE records; --"), undefined);
});

test('OS-local path defaults separate Windows and Linux; shared paths and relative roots are rejected', () => {
  const win = resolveStoragePaths('win32', { LOCALAPPDATA: 'C:\\Synthetic\\Local' }, 'C:\\Synthetic');
  const linux = resolveStoragePaths('linux', {}, '/home/synthetic');
  assert.equal(win.directory, 'C:\\Synthetic\\Local\\codex-frontier-memory\\win32');
  assert.equal(linux.directory, '/home/synthetic/.local/state/codex-frontier-memory/linux');
  assert.equal(resolveStoragePaths('linux', { XDG_STATE_HOME: '/var/synthetic' }, '/home/synthetic').directory,
    '/var/synthetic/codex-frontier-memory/linux');
  assert.throws(() => resolveStoragePaths('win32', {}, 'C:\\Synthetic'), /absolute/);
  assert.throws(() => resolveStoragePaths('win32', { LOCALAPPDATA: '\\\\server\\shared' }), /Shared/);
  assert.throws(() => resolveStoragePaths('linux', { XDG_STATE_HOME: '/mnt/c/Users/synthetic' }), /shared/);
  assert.throws(() => resolveStoragePaths('linux', { XDG_STATE_HOME: 'relative' }), /absolute/);
  assert.throws(() => resolveStoragePaths('darwin'), /Unsupported/);
});

test('runtime directories inside a project or any Git repository are refused', t => {
  const f = fixture(t);
  for (const base of [f.project, path.join(f.root, 'unrelated-checkout')]) {
    if (base !== f.project) mkdirSync(path.join(base, '.git'), { recursive: true });
    process.env.LOCALAPPDATA = base;
    process.env.XDG_STATE_HOME = base;
    const paths = resolveStoragePaths();
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.policy, JSON.stringify({ version: 1, enabled: true, allowedProjects: [projectIdentity(f.project)] }));
    assert.throws(() => f.store().put(errorInput()), MemoryAccessError);
    assert.equal(existsSync(paths.database), false);
  }
});

test('schema and OS domain mismatches fail closed without rewriting stored records', t => {
  const f = fixture(t);
  f.policy(true);
  const memory = f.store();
  const record = memory.put(errorInput()).record;
  memory.close();
  const raw = new DatabaseSync(f.paths.database);
  raw.prepare('UPDATE metadata SET value = ? WHERE key = ?').run('other-domain', 'domain');
  raw.close();
  assert.throws(() => f.store().get(record.id), /another OS domain/);
  const edit = new DatabaseSync(f.paths.database);
  edit.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(f.paths.domain, 'domain');
  edit.exec('PRAGMA user_version = 999');
  edit.close();
  assert.throws(() => f.store().put(errorInput('later')), /schema version/);
  const inspect = new DatabaseSync(f.paths.database);
  assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM records').get()?.['n'], 1);
  inspect.close();
});

test('directory links cannot redirect runtime storage into a repository', t => {
  const f = fixture(t);
  const checkout = path.join(f.root, 'linked-checkout');
  mkdirSync(path.join(checkout, '.git'), { recursive: true });
  const alias = path.join(f.root, 'alias');
  symlinkSync(checkout, alias, process.platform === 'win32' ? 'junction' : 'dir');
  process.env.LOCALAPPDATA = alias;
  process.env.XDG_STATE_HOME = alias;
  const paths = resolveStoragePaths();
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.policy, JSON.stringify({ version: 1, enabled: true, allowedProjects: [projectIdentity(f.project)] }));
  assert.throws(() => f.store().list(), MemoryAccessError);
  assert.equal(existsSync(paths.database), false);
});

test('hardlinked database or policy files are refused before access', t => {
  const f = fixture(t);
  f.policy(true);
  const store = f.store();
  store.put(errorInput());
  store.close();
  linkSync(f.paths.database, path.join(f.root, 'database-alias'));
  assert.throws(() => f.store().list(), MemoryAccessError);
  rmSync(path.join(f.root, 'database-alias'));
  linkSync(f.paths.policy, path.join(f.root, 'policy-alias'));
  assert.throws(() => f.store().list(), MemoryAccessError);
});

test('closed stores reject further operations', t => {
  const f = fixture(t);
  f.policy(true);
  const memory = f.store();
  memory.close();
  memory.close();
  assert.throws(() => memory.list(), /closed/);
  assert.equal(existsSync(f.paths.database), false);
});
