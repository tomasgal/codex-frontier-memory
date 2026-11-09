import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, realpathSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootstrap, parseArgs, serverConfig } from '../scripts/bootstrap.mjs';
import { resolveStoragePaths, projectIdentity } from '../src/storage/paths.ts';
import { authorize } from '../dist/src/capture/policy.js';

function fixture(t) {
  const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'cfm-bootstrap-test-'));
  const project = path.join(root, 'synthetic project');
  const state = path.join(root, 'state');
  const codexHome = path.join(root, 'codex-home');
  for (const dir of [project, state, codexHome]) mkdirSync(dir);
  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_STATE_HOME: process.env.XDG_STATE_HOME, CODEX_HOME: process.env.CODEX_HOME };
  Object.assign(process.env, { LOCALAPPDATA: state, XDG_STATE_HOME: state, CODEX_HOME: codexHome });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) => {
    const r = spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  git('init', '--quiet');
  const stub = path.join(root, 'synthetic-cli.mjs');
  writeFileSync(stub, `import {appendFileSync} from 'node:fs';
appendFileSync(new URL('./calls.txt', import.meta.url), process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] === 'mcp') console.log(JSON.stringify({enabled:true,transport:{type:'stdio'}}));
`);
  const tools = { git: ['git'], npm: [process.execPath, stub], codex: [process.execPath, stub] };
  const paths = resolveStoragePaths();
  const config = path.join(project, '.codex/config.toml');
  const agents = path.join(project, 'AGENTS.md');
  const run = (action, extra = {}, toolset = tools) => bootstrap({ action, project, dryRun: false, ...extra }, toolset);
  const receiptFile = () => path.join(paths.directory, 'bootstrap', readdirSync(path.join(paths.directory, 'bootstrap'))[0]);
  return { root, project, state, codexHome, git, tools, paths, config, agents, run, receiptFile };
}

test('bootstrap dry-run is read-only; install is exact, idempotent, and uninstall preserves unrelated edits', t => {
  const f = fixture(t);
  mkdirSync(path.dirname(f.config));
  writeFileSync(f.config, '# synthetic unrelated configuration\n[features]\n');
  writeFileSync(f.agents, 'Existing synthetic guidance.');
  const exclude = path.join(f.project, '.git/info/exclude');
  const initialExclude = readFileSync(exclude, 'utf8');
  f.run('install', { dryRun: true });
  assert.equal(existsSync(f.paths.directory), false);
  assert.equal(existsSync(path.join(f.root, 'calls.txt')), false);
  assert.equal(f.run('status').authorized, false);
  f.run('install');
  const config = readFileSync(f.config, 'utf8'), agents = readFileSync(f.agents, 'utf8');
  assert.ok(config.includes(serverConfig(projectIdentity(f.project), f.paths)));
  assert.match(config, /tools\.memory_search\]\napproval_mode = "approve"/);
  assert.match(config, /tools\.memory_record\]\napproval_mode = "prompt"/);
  assert.match(config, /tools\.memory_supersede\]\napproval_mode = "prompt"/);
  assert.equal(f.git('check-ignore', '.codex/config.toml').trim(), '.codex/config.toml');
  assert.match(readFileSync(path.join(f.root, 'calls.txt'), 'utf8'), /ci --ignore-scripts\nrun build\n/);
  const receipt = readFileSync(f.receiptFile(), 'utf8');
  assert.equal(f.run('install').unchanged, true);
  assert.equal(readFileSync(f.receiptFile(), 'utf8'), receipt);
  assert.equal(readFileSync(f.config, 'utf8'), config);
  assert.equal(readFileSync(f.agents, 'utf8'), agents);
  assert.equal(f.run('status').authorized, true);
  assert.doesNotThrow(() => authorize(f.paths, projectIdentity(f.project)));
  const child = path.join(f.project, 'child'); mkdirSync(child);
  assert.throws(() => authorize(f.paths, projectIdentity(child)));
  assert.throws(() => authorize(f.paths, projectIdentity(f.root)));
  assert.equal(existsSync(f.paths.database), false);
  writeFileSync(f.config, config + '\n# later unrelated config\n');
  writeFileSync(f.agents, agents + '\nLater guidance.\n');
  f.run('uninstall', { dryRun: true });
  assert.equal(f.run('status').authorized, true);
  f.run('uninstall');
  assert.equal(readFileSync(f.config, 'utf8'), '# synthetic unrelated configuration\n[features]\n\n# later unrelated config\n');
  assert.equal(readFileSync(f.agents, 'utf8'), 'Existing synthetic guidance.\nLater guidance.\n');
  assert.equal(readFileSync(exclude, 'utf8'), initialExclude);
  assert.equal(existsSync(f.paths.policy), false);
  assert.equal(f.run('uninstall').unchanged, true);
});

test('OFF consent never enables another root, existing authorization survives, and later OFF is respected', t => {
  const f = fixture(t);
  mkdirSync(f.paths.directory, { recursive: true });
  const otherDirectory = path.join(f.root, 'other'); mkdirSync(otherDirectory);
  const other = projectIdentity(otherDirectory);
  const original = { version: 1, enabled: false, allowedProjects: [other] };
  writeFileSync(f.paths.policy, JSON.stringify(original));
  assert.throws(() => f.run('install'), /beyond this project/);
  assert.equal(existsSync(f.config), false);
  original.enabled = true;
  writeFileSync(f.paths.policy, JSON.stringify(original));
  f.run('install');
  const policy = JSON.parse(readFileSync(f.paths.policy));
  assert.deepEqual(policy.allowedProjects, [other, projectIdentity(f.project)]);
  policy.enabled = false;
  writeFileSync(f.paths.policy, JSON.stringify(policy));
  assert.throws(() => f.run('install'), /OFF\/revoked/);
  f.run('uninstall');
  original.enabled = false;
  assert.deepEqual(JSON.parse(readFileSync(f.paths.policy)), original);
});

test('tracked, synchronized, linked, inherited, and unmanaged configuration conflicts fail before mutation', t => {
  const f = fixture(t);
  mkdirSync(path.dirname(f.config)); writeFileSync(f.config, '# synthetic\n');
  f.git('add', '.codex/config.toml');
  assert.throws(() => f.run('install'), /tracked/);
  f.git('rm', '--cached', '.codex/config.toml');
  writeFileSync(f.config, '[mcp_servers.frontier_memory]\ncommand="synthetic"\n');
  assert.throws(() => f.run('install'), /Unmanaged/);
  rmSync(f.config);
  const linked = path.join(f.root, 'linked-config'); writeFileSync(linked, '# synthetic\n'); linkSync(linked, f.config);
  assert.throws(() => f.run('install'), /Linked/); rmSync(f.config);
  const shared = path.join(f.root, 'OneDrive', 'project'); mkdirSync(shared, { recursive: true });
  assert.throws(() => f.run('install', { project: shared }), /synchronized/);
  writeFileSync(path.join(f.codexHome, 'config.toml'), '[mcp_servers.frontier_memory]\n');
  assert.throws(() => f.run('install'), /Inherited/);
  assert.equal(existsSync(f.paths.directory), false);
  assert.equal(existsSync(path.join(f.root, 'calls.txt')), false);
});

test('build failure makes no configuration changes; interrupted journal rolls back without deleting memory', t => {
  const f = fixture(t);
  const failing = { ...f.tools, npm: [process.execPath, '-e', 'process.exit(1)'] };
  assert.throws(() => f.run('install', {}, failing), /Command failed/);
  assert.equal(existsSync(f.paths.directory), false);
  assert.equal(existsSync(f.config), false);
  f.run('install');
  const receiptFile = f.receiptFile();
  const receipt = JSON.parse(readFileSync(receiptFile));
  receipt.phase = 'pending';
  writeFileSync(receiptFile, JSON.stringify(receipt));
  writeFileSync(f.paths.database, 'synthetic sentinel, not a real database');
  assert.equal(f.run('status').recoveryRequired, true);
  assert.throws(() => f.run('install'), /Interrupted transaction/);
  assert.equal(f.run('uninstall').action, 'rollback');
  assert.equal(existsSync(f.config), false);
  assert.equal(existsSync(f.agents), false);
  assert.equal(existsSync(f.paths.policy), false);
  assert.equal(readFileSync(f.paths.database, 'utf8'), 'synthetic sentinel, not a real database');
});

test('malformed policy and changed managed blocks fail safely; CLI requires explicit project', t => {
  const f = fixture(t);
  assert.throws(() => parseArgs(['install']), /explicit/);
  assert.throws(() => parseArgs(['install', '--project', '.', '--project', '.']), /duplicate/);
  assert.equal(parseArgs(['status', '--dry-run', '--project', '.']).dryRun, true);
  mkdirSync(f.paths.directory, { recursive: true }); writeFileSync(f.paths.policy, '{invalid');
  assert.throws(() => f.run('install'));
  rmSync(f.paths.policy); f.run('install');
  writeFileSync(f.config, readFileSync(f.config, 'utf8').replace('approval_mode = "approve"', 'approval_mode = "prompt"'));
  assert.throws(() => f.run('uninstall'), /Managed content changed/);
  assert.equal(f.run('status').authorized, true);
});
