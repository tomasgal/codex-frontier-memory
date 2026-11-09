import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MemoryStore, projectIdentity, resolveStoragePaths } from '../src/index.js';
import { captureHook } from '../src/hooks/adapter.js';

test('hook process fails closed and diagnostics contain only fixed delivery markers', t => {
  const temporary = realpathSync.native(tmpdir());
  const root = mkdtempSync(path.join(temporary, 'cfm-hooks-'));
  const old = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.LOCALAPPDATA = process.env.XDG_STATE_HOME = path.join(root, 'state');
  const project = path.join(root, 'a'); const other = path.join(root, 'b');
  mkdirSync(project); mkdirSync(other);
  const paths = resolveStoragePaths();
  t.after(() => {
    for (const key of ['LOCALAPPDATA', 'XDG_STATE_HOME'] as const) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
    assert.equal(path.dirname(root), temporary);
    rmSync(root, { recursive: true, force: true });
  });
  const policy = (enabled: boolean, projects: string[]) => {
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.policy, JSON.stringify({ version: 1, enabled, allowedProjects: projects.map(projectIdentity) }));
  };
  const event = { cwd: project, session_id: 'synthetic-session', turn_id: 'synthetic-turn', model: 'synthetic',
    permission_mode: 'default', transcript_path: null, hook_event_name: 'PostToolUse',
    tool_name: 'mcp__synthetic__test', tool_use_id: 'synthetic-call',
    tool_input: { secret: 'password=synthetic-secret' }, tool_response: { isError: true, content: 'person@example.test private output' } };
  const invoke = (data: string, target = project, diagnostics = false) => spawnSync(process.execPath, ['dist/src/hooks/cli.js', target, ...(diagnostics ? ['--diagnostics'] : [])],
    { input: data, encoding: 'utf8', env: process.env });
  policy(false, [project]);
  assert.equal(invoke(JSON.stringify(event)).status, 0);
  assert.equal(existsSync(paths.database), false);
  policy(true, [other]);
  invoke(JSON.stringify(event));
  assert.equal(existsSync(paths.database), false);
  policy(true, [project, other]);
  for (const value of ['{', '{}', JSON.stringify({ ...event, turn_id: null }), 'x'.repeat(300000)]) {
    const child = invoke(value);
    assert.equal(child.status, 0); assert.equal(child.stdout, ''); assert.equal(child.stderr, '');
  }
  assert.equal(existsSync(paths.database), false);
  invoke(JSON.stringify(event), other);
  assert.equal(existsSync(paths.database), false);
  // Category-like fields are deliberately unsupported, including distinct and repeated values.
  for (const category of ['alpha', 'beta', 'alpha']) {
    const result = invoke(JSON.stringify({ ...event, tool_use_id: category, tool_response: { isError: true, category } }));
    assert.equal(result.status, 0); assert.equal(result.stderr, '');
  }
  invoke(JSON.stringify(event)); invoke(JSON.stringify(event));
  assert.equal(existsSync(paths.database), false);
  const diagnostic = invoke(JSON.stringify(event), project, true);
  assert.equal(diagnostic.stdout, '');
  assert.equal(diagnostic.stderr, 'hook: invoked\nhook: processed\n');
  assert.equal(invoke('{', project, true).stderr, 'hook: invoked\nhook: discarded\n');
  assert.equal(invoke('x'.repeat(300000), project, true).stderr, 'hook: invoked\nhook: discarded\n');
  assert.equal(invoke(JSON.stringify(event), other, true).stderr, 'hook: invoked\nhook: discarded\n');
  assert.equal(existsSync(paths.database), false);
  const otherStore = new MemoryStore(other); assert.equal(otherStore.list().length, 0); otherStore.close();
  assert.equal(captureHook(project, JSON.stringify({ ...event, tool_name: 'Bash', tool_response: 'failure' })), 'ignored');
  assert.equal(captureHook(project, JSON.stringify({ ...event, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'private' })), 'ignored');
  policy(false, [project]);
  assert.throws(() => captureHook(project, JSON.stringify(event)));
  assert.equal(invoke(JSON.stringify(event), project, true).stderr, 'hook: invoked\nhook: discarded\n');
});
