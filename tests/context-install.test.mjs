import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deploy, editConfig, editHooks, EVENTS } from '../scripts/cfm-context-config.mjs';

const command = '"C:\\Node\\node.exe" "C:\\CFM\\context-cli.js" "C:\\ID" --global';

test('TOML edits are root-level, reentrant and removable', () => {
  const original = '# Existing setting\nmodel = "gpt-6"\n[mcp_servers.frontier_memory]\ncommand = "node"\n';
  const once = editConfig(original);
  assert.ok(once.indexOf('model_post_turn_compact_threshold_percent = 80') < once.indexOf('[mcp_servers'));
  assert.equal(editConfig(once), once);
  assert.equal(editConfig(once, 'uninstall'), original);
  assert.equal(editConfig('model_post_turn_compact_threshold_percent = 80\n'), 'model_post_turn_compact_threshold_percent = 80\n');
  assert.throws(() => editConfig('model_post_turn_compact_threshold_percent = 70\n'), /conflicts/);
  assert.throws(() => editConfig('# BEGIN CFM ADAPTIVE CONTEXT\n'), /Incomplete/);
});

test('global hooks merge with existing entries, remain idempotent, and can be removed', () => {
  const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'existing prompt' }] }] }, custom: 'keep' });
  const output = editHooks(original, command);
  const parsed = JSON.parse(output);
  assert.equal(parsed.custom, 'keep');
  assert.equal(parsed.hooks.Stop.length, 1);
  assert.equal(parsed.hooks.UserPromptSubmit.length, 2);
  for (const event of EVENTS) assert.equal(parsed.hooks[event].at(-1).hooks[0].command, command);
  assert.equal(editHooks(output, command), output);
  const restored = JSON.parse(editHooks(output, command, 'uninstall'));
  assert.deepEqual(restored, JSON.parse(original));
  assert.throws(() => editHooks('{invalid', command), SyntaxError);
  assert.throws(() => editHooks('{"hooks":{"PreCompact":true}}', command), /collection/);
});

test('context deployment installs, verifies and uninstalls safely without private data', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'cfm-deploy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'codex');
  const identity = path.join(root, 'identity');
  const node = process.execPath;
  const contextCli = path.join(root, 'context-cli.js');
  mkdirSync(codexHome); mkdirSync(identity); writeFileSync(contextCli, '// synthetic');
  const config = path.join(codexHome, 'config.toml');
  const hooks = path.join(codexHome, 'hooks.json');
  const originalConfig = 'model = "gpt-6"\n[mcp_servers.frontier_memory]\ncommand = "node"\n';
  const originalHooks = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"other"}]}]}}\n';
  writeFileSync(config, originalConfig); writeFileSync(hooks, originalHooks);
  const args = { codexHome, node, contextCli, identity };
  assert.deepEqual(deploy({ mode: 'dry-run', ...args }), { mode: 'dry-run', changed: true });
  assert.equal(readFileSync(config, 'utf8'), originalConfig);
  assert.equal(deploy({ mode: 'install', ...args }).changed, true);
  assert.equal(deploy({ mode: 'status', ...args }).changed, false);
  assert.equal(deploy({ mode: 'install', ...args }).changed, false);
  assert.ok(JSON.parse(readFileSync(hooks, 'utf8')).hooks.PreCompact.length === 1);
  assert.equal(deploy({ mode: 'uninstall', ...args }).changed, true);
  assert.equal(readFileSync(config, 'utf8'), originalConfig);
  assert.deepEqual(JSON.parse(readFileSync(hooks, 'utf8')), JSON.parse(originalHooks));
  assert.throws(() => deploy({ mode: 'status', ...args }), /differs/);
});