import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { projectIdentity, resolveStoragePaths } from '../src/index.js';
import { ContextSupervisor, contextHookOutput, decideContextAction, sampleContextPercent } from '../src/session/supervisor.js';

test('adaptive policy delays work, inspects every tenth prompt and handles pressure immediately', () => {
  assert.equal(decideContextAction(1, null, 0), 'none');
  assert.equal(decideContextAction(9, 65, 0), 'none');
  assert.equal(decideContextAction(10, 20, 0), 'none');
  assert.equal(decideContextAction(10, 60, 0), 'review');
  assert.equal(decideContextAction(10, 76, 0), 'checkpoint');
  assert.equal(decideContextAction(10, null, 0), 'review');
  assert.equal(decideContextAction(1, 81, 0), 'none');
  assert.equal(decideContextAction(2, 81, 0), 'urgent');
  assert.equal(decideContextAction(3, 90, 2), 'none');
  assert.equal(decideContextAction(4, 90, 2), 'urgent');
});

test('local context metadata is durable, idempotent, scoped, opt-in and contains no transcript text', t => {
  const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'cfm-context-'));
  const former = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    CODEX_HOME: process.env.CODEX_HOME };
  process.env.LOCALAPPDATA = process.env.XDG_STATE_HOME = path.join(root, 'state');
  process.env.CODEX_HOME = path.join(root, 'codex');
  const project = path.join(root, 'project');
  const another = path.join(root, 'another');
  const rollouts = path.join(process.env.CODEX_HOME, 'sessions', '2026');
  mkdirSync(project); mkdirSync(another); mkdirSync(rollouts, { recursive: true });
  const transcript = path.join(rollouts, 'synthetic.jsonl');
  const payload = (used: number) => JSON.stringify({
    timestamp: '2026-01-01T00:00:00Z', type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: { total_tokens: used },
      model_context_window: 1000 } },
  });
  writeFileSync(transcript, payload(650) + '\n');
  const paths = resolveStoragePaths();
  const contextDb = path.join(paths.directory, 'context.sqlite');
  const policy = (enabled: boolean) => {
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.policy, JSON.stringify({
      version: 1, enabled, allowedProjects: [projectIdentity(project)],
    }));
  };
  const prompt = (n: number) => ({
    hook_event_name: 'UserPromptSubmit', cwd: project, model: 'synthetic',
    session_id: 'session-secret', turn_id: 'turn-' + n,
    transcript_path: transcript, prompt: 'password=synthetic-secret',
  });
  t.after(() => {
    for (const [key, value] of Object.entries(former)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.equal(path.dirname(root), realpathSync.native(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(sampleContextPercent(transcript), 65);
  assert.equal(sampleContextPercent(path.join(project, 'secrets.jsonl')), null);
  policy(false);
  const denied = new ContextSupervisor(project);
  assert.throws(() => denied.handle(prompt(1)));
  denied.close();
  assert.equal(existsSync(contextDb), false);
  policy(true);
  const sup = new ContextSupervisor(project);
  assert.equal(sup.handle(prompt(1)).action, 'none');
  assert.equal(sup.handle(prompt(1)).duplicate, true);
  for (let n = 2; n < 10; n++) assert.equal(sup.handle(prompt(n)).action, 'none');
  const ten = sup.handle(prompt(10));
  assert.equal(ten.action, 'review');
  assert.equal(ten.prompts, 10);
  assert.match(contextHookOutput(ten), /hookSpecificOutput/);
  assert.equal(contextHookOutput(sup.handle(prompt(10))), '');
  const compact = { hook_event_name: 'PreCompact', cwd: project, model: 'synthetic',
    session_id: 'session-secret', turn_id: 'compact-turn', trigger: 'auto' };
  assert.equal(sup.handle(compact).action, 'none');
  assert.equal(sup.handle({ ...compact, hook_event_name: 'PostCompact' }).action, 'none');
  assert.equal(sup.handle({ ...compact, hook_event_name: 'PostCompact' }).duplicate, true);
  assert.throws(() => sup.handle({ ...prompt(11), cwd: another }), /scope mismatch/);
  sup.close();
  const db = new DatabaseSync(contextDb);
  const session = db.prepare('SELECT prompts, compactions FROM sessions').get()!;
  assert.equal(session['prompts'], 10);
  assert.equal(session['compactions'], 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM checkpoints').get()!['count'], 3);
  db.close();
  const bytes = readFileSync(contextDb).toString('utf8');
  assert.ok(!bytes.includes('synthetic-secret'));
  assert.ok(!bytes.includes('session-secret'));
  policy(false);
  const revoked = new ContextSupervisor(project);
  assert.throws(() => revoked.handle(prompt(11)));
  revoked.close();
});

test('hook CLI emits only a bounded reminder and never leaks input on errors', t => {
  const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'cfm-context-cli-'));
  const former = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.LOCALAPPDATA = process.env.XDG_STATE_HOME = path.join(root, 'state');
  const project = path.join(root, 'project');
  mkdirSync(project);
  const paths = resolveStoragePaths();
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.policy, JSON.stringify({
    version: 1, enabled: true, allowedProjects: [projectIdentity(project)],
  }));
  t.after(() => {
    for (const [key, value] of Object.entries(former)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const run = (input: string) => spawnSync(process.execPath, ['dist/src/hooks/context-cli.js', project], {
    input, encoding: 'utf8', env: process.env,
  });
  for (let n = 1; n <= 10; n++) {
    const result = run(JSON.stringify({
      hook_event_name: 'UserPromptSubmit', cwd: project, model: 'synthetic',
      session_id: 'cli-session', turn_id: 'turn-' + n, transcript_path: null, prompt: 'synthetic private text',
    }));
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    if (n === 10) assert.match(result.stdout, /additionalContext/);
    else assert.equal(result.stdout, '');
  }
  assert.equal(run('{').stdout, '');
  assert.equal(run('x'.repeat(300000)).stdout, '');
  assert.equal(run(JSON.stringify({ hook_event_name: 'UserPromptSubmit' })).stdout, '');
  assert.equal(run(JSON.stringify({
    hook_event_name: 'UserPromptSubmit', cwd: project, model: 'synthetic',
    session_id: 'cli-session', turn_id: 'turn-10', transcript_path: null, prompt: 'synthetic private text',
  })).stdout, '');
});
