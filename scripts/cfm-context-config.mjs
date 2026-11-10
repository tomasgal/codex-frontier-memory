#!/usr/bin/env node
/**
 * OS-local configuration deployment for CFM adaptive context supervision.
 * Usage: node cfm-context-config.mjs install|status|uninstall|dry-run CODEX_HOME NODE_EXE CONTEXT_CLI IDENTITY_ROOT
 * This script edits only the CFM-managed TOML block and CFM-managed hook groups.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVENTS = ['UserPromptSubmit', 'PreCompact', 'PostCompact'];
const BEGIN = '# BEGIN CFM ADAPTIVE CONTEXT';
const END = '# END CFM ADAPTIVE CONTEXT';
const STATUS = 'CFM adaptive context supervisor';
const LIMIT = 1024 * 1024;
const block = BEGIN + "\nmodel_post_turn_compact_threshold_percent = 80\n" + END + "\n";
const plainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function stripOwnedBlock(input) {
  const start = input.indexOf(BEGIN);
  const end = input.indexOf(END);
  if ((start < 0) !== (end < 0)) throw new Error('Incomplete CFM adaptive TOML block');
  if (start < 0) return { clean: input, owned: false };
  const rx = /^# BEGIN CFM ADAPTIVE CONTEXT\r?\n[\s\S]*?^# END CFM ADAPTIVE CONTEXT(?:\r?\n)?/gm;
  if ([...input.matchAll(rx)].length !== 1) throw new Error('Ambiguous CFM adaptive TOML block');
  const clean = input.replace(rx, '');
  if (clean.includes(BEGIN) || clean.includes(END)) throw new Error('Duplicate CFM adaptive TOML blocks');
  return { clean, owned: true };
}

export function editConfig(input, mode = 'install') {
  const { clean } = stripOwnedBlock(input);
  if (mode === 'uninstall') return clean;
  if (mode !== 'install') throw new Error('Unknown edit mode');
  // Root-level TOML configuration must precede the first [section] header.
  // An existing explicit user setting stays under user control.
  const explicit = clean.match(/^\s*model_post_turn_compact_threshold_percent\s*=\s*([^\r\n#]+)/gm);
  if (explicit?.length > 1) throw new Error('Multiple unmanaged compaction settings');
  if (explicit?.length === 1) {
    if (!/^\s*model_post_turn_compact_threshold_percent\s*=\s*80\s*$/.test(explicit[0])) {
      throw new Error('Unmanaged compaction threshold conflicts with CFM 80-percent policy');
    }
    return clean;
  }
  const bom = clean.startsWith('\uFEFF') ? '\uFEFF' : '';
  const rest = bom ? clean.slice(1) : clean;
  return bom + block + rest;
}

function managedGroup(group) {
  if (!plainObject(group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.length === 1 && plainObject(group.hooks[0])
    && group.hooks[0].type === 'command' && group.hooks[0].statusMessage === STATUS
    && typeof group.hooks[0].command === 'string'
    && group.hooks[0].command.includes('context-cli.js');
}

function quoteWindowsPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /["\r\n\x00]/.test(value)) {
    throw new Error('Unsafe executable or identity path');
  }
  return "\"" + value + "\"";
}
export function commandFor(node, contextCli, identity) {
  return [node, contextCli, identity].map(quoteWindowsPath).join(' ') + ' --global';
}

export function editHooks(input, command, mode = 'install') {
  const root = input.trim() === '' ? { hooks: {} } : JSON.parse(input);
  if (!plainObject(root)) throw new Error('Invalid hooks root object');
  if (root.hooks === undefined) root.hooks = {};
  if (!plainObject(root.hooks)) throw new Error('Invalid hooks events object');
  for (const event of EVENTS) {
    const source = root.hooks[event] ?? [];
    if (!Array.isArray(source)) throw new Error('Invalid hook group collection');
    const old = source.filter((g) => !managedGroup(g));
    // Prevent destructive replacement of unfamiliar handlers that claim our status marker.
    if (old.some((g) => plainObject(g) && Array.isArray(g.hooks)
      && g.hooks.some((h) => plainObject(h) && h.statusMessage === STATUS))) {
      throw new Error('Conflicting CFM hook handler');
    }
    if (mode === 'install') {
      old.push({ hooks: [{
        type: 'command', command, timeout: 15, async: false, statusMessage: STATUS,
      }] });
    }
    if (old.length) root.hooks[event] = old;
    else delete root.hooks[event];
  }
  if (mode === 'uninstall' && Object.keys(root.hooks).length === 0) delete root.hooks;
  return JSON.stringify(root, null, 2) + '\n';
}

function readTarget(target) {
  if (!existsSync(target)) return { exists: false, value: '' };
  const st = lstatSync(target);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > LIMIT) {
    throw new Error('Unsafe or oversized configuration target');
  }
  return { exists: true, value: readFileSync(target, 'utf8') };
}

function atomicWrite(target, value) {
  const tmp = target + ".cfm-" + randomUUID() + ".tmp";
  try {
    writeFileSync(tmp, value, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, target);
  } finally { if (existsSync(tmp)) rmSync(tmp, { force: true }); }
}

export function deploy({ mode, codexHome, node, contextCli, identity }) {
  if (!['install', 'dry-run', 'status', 'uninstall'].includes(mode)) throw new Error('Unknown deployment mode');
  if (![codexHome, node, contextCli, identity].every(x => typeof x === 'string' && path.isAbsolute(x))) {
    throw new Error('Absolute deployment paths required');
  }
  if (!statSync(codexHome).isDirectory() || !statSync(identity).isDirectory()
    || !statSync(node).isFile() || !statSync(contextCli).isFile()) {
    throw new Error('Missing deployment prerequisite');
  }
  const config = path.join(codexHome, 'config.toml');
  const hooks = path.join(codexHome, 'hooks.json');
  const before = [readTarget(config), readTarget(hooks)];
  const command = commandFor(node, contextCli, identity);
  const after = [editConfig(before[0].value, mode === 'uninstall' ? 'uninstall' : 'install'),
    editHooks(before[1].value, command, mode === 'uninstall' ? 'uninstall' : 'install')];
  const changed = after.map((value, i) => value !== before[i].value);
  if (mode === 'status') {
    if (changed.some(Boolean)) throw new Error('Adaptive context registration differs from the expected configuration');
    return { mode, changed: false };
  }
  if (mode === 'dry-run') return { mode, changed: changed.some(Boolean) };
  const targets = [config, hooks];
  const done = [];
  try {
    for (let i = 0; i < targets.length; i++) {
      if (!changed[i]) continue;
      atomicWrite(targets[i], after[i]);
      done.push(i);
    }
  } catch (error) {
    for (const i of done.reverse()) {
      try {
        if (before[i].exists) atomicWrite(targets[i], before[i].value);
        else rmSync(targets[i], { force: true });
      } catch { /* original failure remains authoritative */ }
    }
    throw error;
  }
  return { mode, changed: changed.some(Boolean) };
}

const entrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (entrypoint) {
  try {
    const [mode, codexHome, node, contextCli, identity] = process.argv.slice(2);
    const result = deploy({ mode, codexHome, node, contextCli, identity });
    process.stdout.write("CFM adaptive context " + result.mode + ": " + (result.changed ? "updated" : "ready") + "\n");
  } catch (error) {
    process.stderr.write("CFM adaptive context setup: " + (error instanceof Error ? error.message : "failed") + "\n");
    process.exitCode = 1;
  }
}