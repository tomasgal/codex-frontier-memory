import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseGlobalArgs, globalConfig, globalBootstrap } from '../scripts/global-bootstrap.mjs';

test('global CLI arguments and public MCP configuration', () => {
  assert.deepEqual(parseGlobalArgs(['install', '--dry-run']), { action: 'install', dryRun: true });
  assert.deepEqual(parseGlobalArgs(['status']), { action: 'status', dryRun: false });
  assert.throws(() => parseGlobalArgs(['install', '--dry-run', '--dry-run']), /duplicate/);
  assert.throws(() => parseGlobalArgs(['install', '--project', 'x']), /Unknown/);
  const config = globalConfig('C:\\synthetic\\identity', 'C:\\synthetic\\node.exe',
    'C:\\synthetic\\server.js', 'C:\\synthetic\\state');
  assert.match(config, /\[mcp_servers\.frontier_memory\]/);
  assert.match(config, /memory_search\]\napproval_mode = "approve"/);
  assert.match(config, /memory_record\]\napproval_mode = "prompt"/);
  assert.doesNotMatch(config, /email|handoff|private_key|session_history/i);
});

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'cfm-global-synthetic-'));
  const home = path.join(root, 'codex-home');
  const state = path.join(root, 'state');
  mkdirSync(home); mkdirSync(state);
  const previous = { CODEX_HOME: process.env.CODEX_HOME, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.CODEX_HOME = home;
  process.env.LOCALAPPDATA = state;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const config = path.join(home, 'config.toml');
  const policy = path.join(state, 'codex-frontier-memory', 'win32', 'policy.json');
  const database = path.join(state, 'codex-frontier-memory', 'win32', 'memory.sqlite');
  const receipt = path.join(state, 'codex-frontier-memory', 'win32', 'bootstrap', 'global-public-v1.json');
  const identity = path.join(state, 'codex-frontier-memory', 'identity', 'global');
  let builds = 0;
  const fakeTools = { validateAndBuild: () => { builds++; } };
  const run = (action, dryRun = false) => globalBootstrap({ action, dryRun }, fakeTools);
  return { root, home, state, config, policy, database, receipt, identity, run, get builds() { return builds; } };
}

test('global install is opt-in, idempotent and fully local; rollback preserves memory', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  writeFileSync(f.config, '# unrelated Codex options\n');
  assert.equal(f.run('status').installed, false);
  assert.equal(f.run('install', true).dryRun, true);
  assert.equal(existsSync(f.policy), false);
  assert.equal(existsSync(f.identity), false);
  assert.equal(f.builds, 0);
  f.run('install');
  assert.equal(f.builds, 1);
  assert.equal(existsSync(f.identity), true);
  assert.equal(existsSync(f.database), false);
  assert.equal(f.run('status').installed, true);
  assert.equal(f.run('status').authorized, true);
  const p = JSON.parse(readFileSync(f.policy, 'utf8'));
  assert.deepEqual(p.allowedProjects, [f.identity.toLowerCase()]);
  const installed = readFileSync(f.config, 'utf8');
  assert.match(installed, /^# unrelated Codex options/m);
  assert.match(installed, /CFM GLOBAL \(public bootstrap v1\)/);
  assert.equal(f.run('install').unchanged, true);
  assert.equal(f.builds, 1);
  assert.equal(readFileSync(f.config, 'utf8'), installed);
  writeFileSync(f.config, installed + '\n# later user setting\n');
  writeFileSync(f.database, 'synthetic sentinel');
  f.run('uninstall');
  assert.equal(readFileSync(f.config, 'utf8'), '# unrelated Codex options\n\n# later user setting\n');
  assert.equal(existsSync(f.policy), false);
  assert.equal(readFileSync(f.database, 'utf8'), 'synthetic sentinel');
  assert.equal(f.run('status').installed, false);
});

test('global install never overrides an existing registration or enables unrelated OFF consent', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  writeFileSync(f.config, '[mcp_servers.frontier_memory]\ncommand = "other"\n');
  assert.throws(() => f.run('install'), /existing unmanaged/);
  assert.equal(f.builds, 0);
  rmSync(f.config);
  mkdirSync(path.dirname(f.policy), { recursive: true });
  writeFileSync(f.policy, JSON.stringify({ version: 1, enabled: false,
    allowedProjects: [path.join(f.root, 'unrelated')] }));
  assert.throws(() => f.run('install'), /OFF for other roots/);
  assert.equal(f.builds, 0);
});

test('an explicit later OFF decision survives reinstall and uninstall', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  f.run('install');
  const policy = JSON.parse(readFileSync(f.policy, 'utf8'));
  policy.enabled = false;
  writeFileSync(f.policy, JSON.stringify(policy));
  assert.throws(() => f.run('install'), /OFF, or revoked/);
  f.run('uninstall');
  assert.equal(existsSync(f.config), false);
  assert.equal(existsSync(f.receipt), false);
  const persisted = JSON.parse(readFileSync(f.policy, 'utf8'));
  assert.equal(persisted.enabled, false);
  assert.deepEqual(persisted.allowedProjects, []);
});

test('interrupted global transaction is recoverable without deleting unrelated data', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  f.run('install');
  const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
  receipt.phase = 'pending';
  writeFileSync(f.receipt, JSON.stringify(receipt));
  writeFileSync(f.database, 'synthetic database sentinel');
  assert.equal(f.run('status').recoveryRequired, true);
  assert.throws(() => f.run('install'), /Interrupted installation/);
  assert.equal(f.run('uninstall').action, 'rollback');
  assert.equal(existsSync(f.config), false);
  assert.equal(existsSync(f.policy), false);
  assert.equal(readFileSync(f.database, 'utf8'), 'synthetic database sentinel');
});
