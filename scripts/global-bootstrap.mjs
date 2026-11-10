#!/usr/bin/env node
/**
 * Public, local-only Windows global installer for CFM's four MCP tools.
 * No cloud account, private repository, existing memory, or personal path is embedded.
 * Node.js 24.x required. Run from an unsynchronized checkout.
 */
import {
  existsSync, lstatSync, realpathSync, mkdirSync, readFileSync, writeFileSync,
  renameSync, unlinkSync, rmSync, mkdtempSync, statSync, accessSync, constants,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveStoragePaths, projectIdentity, assertSafeStorage, canonicalPath } from '../src/storage/paths.ts';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BEGIN = '# BEGIN CFM GLOBAL (public bootstrap v1)';
const END = '# END CFM GLOBAL (public bootstrap v1)';
const MAX_CONFIG = 1024 * 1024;
const fail = message => { throw new Error(message); };
const serialize = data => JSON.stringify(data, null, 2) + '\n';

export function parseGlobalArgs(args) {
  const action = args.shift();
  if (!['install', 'status', 'uninstall'].includes(action)) fail('Usage: node scripts/global-bootstrap.mjs install|status|uninstall [--dry-run]');
  let dryRun = false;
  while (args.length) {
    if (args.shift() !== '--dry-run' || dryRun) fail('Unknown or duplicate argument');
    dryRun = true;
  }
  return { action, dryRun };
}

function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

export function requirePrivateLocal(file, env = process.env) {
  if (!path.isAbsolute(file)) fail('Path must be absolute');
  const canonical = canonicalPath(file);
  if (process.platform === 'win32' && !/^[a-z]:\\/i.test(canonical)) {
    fail('Only local Windows drive paths are supported; UNC paths are forbidden');
  }
  if (/(?:^|[\\/])(?:onedrive[^\\/]*|dropbox|google ?drive|icloud[^\\/]*|nextcloud|syncthing)(?:[\\/]|$)/i.test(canonical)) {
    fail('Synchronized directory is not supported');
  }
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial', 'DROPBOX_HOME']) {
    if (env[key] && path.isAbsolute(env[key]) && within(canonicalPath(env[key]), canonical)) fail('Synchronized directory is not supported');
  }
  let cursor = path.resolve(file);
  for (;;) {
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) fail('Linked or nonregular path is not supported');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const next = path.dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return canonical;
}

function rejectGitParent(file) {
  let current = path.dirname(path.resolve(file));
  while (true) {
    if (existsSync(path.join(current, '.git'))) fail('Codex configuration/storage inside a Git checkout is not supported');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function read(file) {
  requirePrivateLocal(file);
  if (!existsSync(file)) return null;
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > MAX_CONFIG) fail('Unsafe or oversized file');
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) fail('Configuration must be valid UTF-8');
  return text;
}

function write(file, value) {
  requirePrivateLocal(file);
  if (value === null) {
    if (existsSync(file)) unlinkSync(file);
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, value, { flag: 'wx', mode: existsSync(file) ? statSync(file).mode & 0o777 : 0o600 });
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function policyValue(text) {
  const value = text === null ? { version: 1, enabled: false, allowedProjects: [] } : JSON.parse(text);
  if (text !== null && Buffer.byteLength(text) > 64 * 1024) fail('Policy is oversized');
  if (value?.version !== 1 || typeof value.enabled !== 'boolean' ||
      !Array.isArray(value.allowedProjects) ||
      !value.allowedProjects.every(root => typeof root === 'string' && path.isAbsolute(root))) fail('Invalid local policy');
  return value;
}

function quote(value) {
  if (/[\x00-\x1f\x7f]/.test(value)) fail('Path contains control characters');
  return JSON.stringify(value);
}

export function globalConfig(identity, nodeExecutable, serverExecutable, localAppData) {
  return BEGIN + '\n'
    + '[mcp_servers.frontier_memory]\n'
    + 'command = ' + quote(nodeExecutable) + '\n'
    + 'args = [' + quote(serverExecutable) + ', ' + quote(identity) + ']\n'
    + 'default_tools_approval_mode = "prompt"\n'
    + '[mcp_servers.frontier_memory.env]\n'
    + 'LOCALAPPDATA = ' + quote(localAppData) + '\n'
    + '[mcp_servers.frontier_memory.tools.memory_search]\n'
    + 'approval_mode = "approve"\n'
    + '[mcp_servers.frontier_memory.tools.memory_record]\n'
    + 'approval_mode = "prompt"\n'
    + '[mcp_servers.frontier_memory.tools.memory_supersede]\n'
    + 'approval_mode = "prompt"\n'
    + END + '\n';
}

function append(original, addition) {
  return (original ?? '') + (original && !original.endsWith('\n') ? '\n' : '') + addition;
}
function removeBlock(original, addition) {
  if (original === null || original.split(addition).length !== 2) fail('Managed configuration changed; resolve conflict manually');
  return original.replace(addition, '');
}

function locate(name) {
  for (const raw of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const directory = raw.replace(/^"|"$/g, '');
    const executable = path.join(directory, name + '.exe');
    try {
      accessSync(executable, constants.X_OK);
      if (statSync(executable).isFile()) return [executable];
    } catch { /* try next */ }
    const entry = name === 'npm' ? 'node_modules/npm/bin/npm-cli.js'
      : name === 'codex' ? 'node_modules/@openai/codex/bin/codex.js' : '';
    if (entry && existsSync(path.join(directory, entry))) return [process.execPath, path.join(directory, entry)];
  }
  fail('Missing required tool: ' + name);
}

function execute(tool, args, options = {}) {
  const result = spawnSync(tool[0], [...tool.slice(1), ...args], { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
  if (result.error || result.status !== 0) fail('Tool failed: ' + path.basename(tool[0]) + ' ' + args[0] + ' (exit ' + (result.status ?? 'unavailable') + ')');
  return (result.stdout || '').trim();
}

function buildAndValidate(candidate, tools) {
  if (execute(tools.codex, ['--version']) !== 'codex-cli 0.167.0') fail('Requires Codex CLI 0.167.0');
  execute(tools.npm, ['--version']);
  const temporaryRoot = realpathSync.native(tmpdir());
  requirePrivateLocal(temporaryRoot);
  rejectGitParent(path.join(temporaryRoot, 'cfm-global-validate-check'));
  const temporary = mkdtempSync(path.join(temporaryRoot, 'cfm-global-validate-'));
  try {
    writeFileSync(path.join(temporary, 'config.toml'), candidate, { mode: 0o600 });
    const env = { ...process.env, CODEX_HOME: temporary };
    execute(tools.codex, ['app-server', '--strict-config', '--print-startup-config'], { cwd: temporary, env });
    const registration = JSON.parse(execute(tools.codex, ['mcp', 'get', 'frontier_memory', '--json'], { cwd: temporary, env }));
    if (!registration.enabled || registration.transport?.type !== 'stdio') fail('Codex rejected MCP configuration');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  execute(tools.npm, ['ci', '--ignore-scripts'], { cwd: source, stdio: 'inherit' });
  execute(tools.npm, ['run', 'build'], { cwd: source, stdio: 'inherit' });
  if (!existsSync(path.join(source, 'dist/src/mcp/server.js'))) fail('Build did not produce the MCP server');
}

/** Exported for synthetic tests; real CLI always uses the installed executables. */
export function globalBootstrap(options, injectedTools) {
  if (process.platform !== 'win32') fail('Global bootstrap v1 supports native Windows only. WSL/Linux: use project-scoped installation.');
  const env = process.env;
  if (!env.LOCALAPPDATA || !path.isAbsolute(env.LOCALAPPDATA)) fail('LOCALAPPDATA must be an absolute local directory');
  const paths = resolveStoragePaths();
  const identity = path.join(path.dirname(paths.directory), 'identity', 'global');
  const configFile = path.join(env.CODEX_HOME || path.join(homedir(), '.codex'), 'config.toml');
  const receiptFile = path.join(paths.directory, 'bootstrap', 'global-public-v1.json');
  const server = path.join(source, 'dist/src/mcp/server.js');
  for (const item of [paths.directory, identity, configFile, receiptFile, source]) requirePrivateLocal(item);
  rejectGitParent(configFile);
  rejectGitParent(paths.policy);
  assertSafeStorage(paths, canonicalPath(identity));

  const beforeConfig = read(configFile);
  const beforePolicy = read(paths.policy);
  const beforeReceipt = read(receiptFile);
  const policy = policyValue(beforePolicy);
  const receipt = beforeReceipt === null ? null : JSON.parse(beforeReceipt);
  if (receipt && (receipt.version !== 1 || receipt.identity !== canonicalPath(identity)
      || !['pending', 'installed'].includes(receipt.phase) || !Array.isArray(receipt.changes)
      || receipt.changes.some(change => ![configFile, paths.policy].includes(change.file)
          || ![change.before, change.after].every(value => value === null || typeof value === 'string')))) {
    fail('Invalid bootstrap receipt');
  }
  const authorized = policy.enabled && policy.allowedProjects.includes(canonicalPath(identity));
  if (options.action === 'status') {
    let installed = receipt?.phase === 'installed';
    if (installed) {
      try {
        const item = receipt.changes.find(change => change.file === configFile);
        if (!item) installed = false;
        else removeBlock(beforeConfig, item.after.slice((item.before ?? '').length));
      } catch { installed = false; }
    }
    return { mode: 'global', installed, authorized, recoveryRequired: receipt?.phase === 'pending',
      databasePresent: existsSync(paths.database) };
  }

  if (receipt?.phase === 'pending') {
    if (options.action !== 'uninstall') fail('Interrupted installation; run uninstall to roll back');
    for (const change of receipt.changes) {
      const current = read(change.file);
      if (current !== change.before && current !== change.after) fail('Rollback conflict: file was modified');
    }
    if (!options.dryRun) {
      for (const change of [...receipt.changes].reverse()) write(change.file, change.before);
      write(receiptFile, receipt.previousReceipt ?? null);
    }
    return { action: 'rollback', dryRun: options.dryRun };
  }

  let changes = [];
  if (options.action === 'install') {
    if (receipt) {
      const item = receipt.changes.find(change => change.file === configFile);
      if (!item || !authorized) fail('Installed configuration is modified, OFF, or revoked; reconcile manually');
      removeBlock(beforeConfig, item.after.slice((item.before ?? '').length));
      return { action: 'install', mode: 'global', unchanged: true };
    }
    if (beforeConfig?.includes('frontier_memory') || beforeConfig?.includes(BEGIN)) {
      fail('An existing unmanaged frontier_memory registration was found; leave it untouched and reconcile manually');
    }
    if (!policy.enabled && policy.allowedProjects.some(root => root !== canonicalPath(identity))) {
      fail('Policy is OFF for other roots; refusing to enable them implicitly');
    }
    const block = globalConfig(canonicalPath(identity), process.execPath, server, env.LOCALAPPDATA);
    const newConfig = append(beforeConfig, block);
    const newPolicy = serialize({ ...policy, enabled: true, allowedProjects: [...new Set([...policy.allowedProjects, canonicalPath(identity)])] });
    if (Buffer.byteLength(newPolicy) > 64 * 1024) fail('Resulting policy is too large');
    changes = [{ file: configFile, before: beforeConfig, after: newConfig }];
    if (beforePolicy !== newPolicy) changes.push({ file: paths.policy, before: beforePolicy, after: newPolicy });
    if (!options.dryRun) {
      const tools = injectedTools || { npm: locate('npm'), codex: locate('codex') };
      if (injectedTools?.validateAndBuild) injectedTools.validateAndBuild(newConfig);
      else buildAndValidate(newConfig, tools);
    }
  } else {
    if (!receipt) return { action: 'uninstall', mode: 'global', unchanged: true };
    const configChange = receipt.changes.find(change => change.file === configFile);
    if (!configChange) fail('Receipt has no managed Codex configuration');
    const addition = configChange.after.slice((configChange.before ?? '').length);
    if (!addition.includes(BEGIN) || !addition.includes(END)) fail('Invalid managed configuration');
    const afterConfig = removeBlock(beforeConfig, addition);
    changes.push({ file: configFile, before: beforeConfig,
      after: afterConfig === '' && configChange.before === null ? null : afterConfig });
    const policyChange = receipt.changes.find(change => change.file === paths.policy);
    if (policyChange) {
      let afterPolicy;
      if (beforePolicy === policyChange.after) afterPolicy = policyChange.before;
      else {
        const original = policyValue(policyChange.before);
        const root = canonicalPath(identity);
        const allowed = original.allowedProjects.includes(root) ? policy.allowedProjects
          : policy.allowedProjects.filter(item => item !== root);
        afterPolicy = serialize({ ...policy, allowedProjects: allowed, enabled: policy.enabled && allowed.length > 0 });
      }
      if (beforePolicy !== afterPolicy) changes.unshift({ file: paths.policy, before: beforePolicy, after: afterPolicy });
    }
  }

  const result = { action: options.action, mode: 'global', dryRun: !!options.dryRun,
    changed: changes.map(item => item.file === configFile ? 'Codex config' : 'local consent policy'),
    database: 'preserved' };
  if (options.dryRun) return result;
  for (const change of changes) if (read(change.file) !== change.before) fail('Configuration changed during preflight');
  if (read(receiptFile) !== beforeReceipt) fail('Installer receipt changed during preflight');
  const journal = { version: 1, identity: canonicalPath(identity), phase: 'pending',
    changes, previousReceipt: beforeReceipt };
  if (Buffer.byteLength(serialize(journal)) > MAX_CONFIG) fail('Journal exceeds size limit');
  if (options.action === 'install') mkdirSync(identity, { recursive: true, mode: 0o700 });
  write(receiptFile, serialize(journal));
  try {
    for (const change of changes) write(change.file, change.after);
    write(receiptFile, options.action === 'install' ? serialize({ ...journal, phase: 'installed', previousReceipt: null }) : null);
  } catch (error) {
    for (const change of [...changes].reverse()) if (read(change.file) === change.after) write(change.file, change.before);
    write(receiptFile, beforeReceipt);
    throw error;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.versions.node.split('.')[0] !== '24') fail('Requires Node.js 24.x');
    console.log(serialize(globalBootstrap(parseGlobalArgs(process.argv.slice(2)))));
  } catch (error) {
    console.error('CFM global bootstrap: ' + error.message);
    process.exitCode = 1;
  }
}
