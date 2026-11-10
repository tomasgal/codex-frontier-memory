import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { authorize } from '../capture/policy.js';
import { projectIdentity, resolveStoragePaths, assertSafeStorage } from '../storage/paths.js';

const MAX_TAIL_BYTES = 1024 * 1024;
const MAX_TEXT_ID = 4096;
const CHECK_EVERY = 10;
const NOTICE = 'CFM context checkpoint: preserve only important, verified fixes, explicit user decisions, active constraints and unresolved blockers through the existing memory_record tool when appropriate. Keep summaries short and sanitized; omit raw logs, secrets and speculation. Continue the task normally. Native Codex compaction manages the context window.';

export type ContextAction = 'none' | 'review' | 'checkpoint' | 'urgent';
export type ContextHookEvent = {
  hook_event_name: 'UserPromptSubmit' | 'PreCompact' | 'PostCompact';
  session_id: string;
  turn_id: string;
  cwd: string;
  model: string;
  transcript_path?: string | null;
  prompt?: string;
  trigger?: string;
};
export type ContextResult = { action: ContextAction; prompts: number; percent: number | null; duplicate: boolean };

const sha = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_ID;
const inDirectory = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
};

/**
 * Best-effort read of Codex rollout token telemetry, never transcript content.
 * A failed or stale reading is treated as unknown. Codex itself is the only
 * authority for native compaction: this number cannot prevent overflow.
 */
export function sampleContextPercent(transcript: string | null | undefined): number | null {
  if (typeof transcript !== 'string' || !path.isAbsolute(transcript)) return null;
  let handle: number | undefined;
  try {
    const home = realpathSync.native(path.resolve(process.env.CODEX_HOME || path.join(homedir(), '.codex')));
    const sessionRoot = realpathSync.native(path.join(home, 'sessions'));
    const file = realpathSync.native(transcript);
    if (!inDirectory(sessionRoot, file) || !file.endsWith('.jsonl')) return null;
    const fileStat = lstatSync(transcript);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) return null;
    const size = statSync(file).size;
    if (size < 1) return null;
    const length = Math.min(size, MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    handle = openSync(file, 'r');
    const bytes = readSync(handle, buffer, 0, length, size - length);
    if (bytes !== length) return null;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (size > length) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('"token_count"')) continue;
      let item: unknown;
      try { item = JSON.parse(line); } catch { continue; }
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      if (obj['type'] !== 'event_msg') continue;
      const payload = obj['payload'];
      if (!payload || typeof payload !== 'object') continue;
      const ev = payload as Record<string, unknown>;
      if (ev['type'] !== 'token_count') continue;
      const info = ev['info'];
      if (!info || typeof info !== 'object') continue;
      const data = info as Record<string, unknown>;
      const last = data['last_token_usage'];
      if (!last || typeof last !== 'object') continue;
      const used = (last as Record<string, unknown>)['total_tokens'];
      const window = data['model_context_window'];
      if (typeof used !== 'number' || typeof window !== 'number'
        || !Number.isFinite(used) || !Number.isFinite(window) || used < 0 || window <= 0) continue;
      return Math.min(100, Math.max(0, Math.round(100 * used / window)));
    }
  } catch {
    // Telemetry is optional. Do not leak file paths or transcript content.
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
  return null;
}

/** The 10-prompt cadence is a review/checkpoint cadence, not a compaction timer. */
export function decideContextAction(prompts: number, percent: number | null, lastNotice: number): ContextAction {
  if (percent !== null && percent >= 80 && prompts - lastNotice >= 2) return 'urgent';
  if (prompts % CHECK_EVERY !== 0) return 'none';
  if (percent === null) return 'review';
  if (percent >= 75) return 'checkpoint';
  if (percent >= 50) return 'review';
  return 'none';
}

function validateEvent(value: unknown): ContextHookEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid event');
  const e = value as Record<string, unknown>;
  if (!['UserPromptSubmit', 'PreCompact', 'PostCompact'].includes(String(e['hook_event_name']))
    || !isText(e['session_id']) || !isText(e['turn_id']) || !isText(e['cwd']) || !isText(e['model'])) {
    throw new Error('Invalid context hook event');
  }
  if (e['hook_event_name'] === 'UserPromptSubmit') {
    if (typeof e['prompt'] !== 'string' || !(e['transcript_path'] === null
      || typeof e['transcript_path'] === 'string')) throw new Error('Invalid prompt event');
  } else if (!isText(e['trigger'])) {
    throw new Error('Invalid compaction event');
  }
  return e as ContextHookEvent;
}

/**
 * Separate OS-local metadata store, not a migration of CFM memory.sqlite.
 * Persists hashes, counts and pressure only; no prompts, code or summaries.
 */
export class ContextSupervisor {
  readonly #paths = resolveStoragePaths();
  readonly #scope: string;
  readonly #global: boolean;
  readonly #dbPath: string;
  #db: DatabaseSync | undefined;

  constructor(scopeRoot: string, options: { global?: boolean } = {}) {
    this.#scope = projectIdentity(scopeRoot);
    this.#global = options.global === true;
    this.#dbPath = path.join(this.#paths.directory, 'context.sqlite');
  }

  #access(): DatabaseSync {
    try { authorize(this.#paths, this.#scope); } catch (e) {
      this.close();
      throw e;
    }
    if (!this.#db) {
      mkdirSync(this.#paths.directory, { recursive: true, mode: 0o700 });
      assertSafeStorage(this.#paths, this.#scope);
      if (!existsSync(this.#dbPath)) {
        try { closeSync(openSync(this.#dbPath, 'wx', 0o600)); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      }
      const stat = lstatSync(this.#dbPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe context store');
      const db = new DatabaseSync(this.#dbPath, {
        enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false, timeout: 5000,
      });
      try {
        db.exec('PRAGMA trusted_schema = OFF; BEGIN IMMEDIATE');
        const version = db.prepare('PRAGMA user_version').get()!['user_version'];
        if (version === 0) {
          db.exec([
            'CREATE TABLE sessions (key TEXT PRIMARY KEY, prompts INTEGER NOT NULL, last_notice INTEGER NOT NULL,',
            'compactions INTEGER NOT NULL, percent INTEGER, updated_at TEXT NOT NULL) STRICT;',
            'CREATE TABLE seen (session_key TEXT NOT NULL, kind TEXT NOT NULL, turn_key TEXT NOT NULL,',
            'PRIMARY KEY (session_key, kind, turn_key)) STRICT;',
            'CREATE TABLE checkpoints (session_key TEXT NOT NULL, kind TEXT NOT NULL, turn_key TEXT NOT NULL,',
            'prompts INTEGER NOT NULL, percent INTEGER, created_at TEXT NOT NULL,',
            'PRIMARY KEY (session_key, kind, turn_key)) STRICT;',
          ].join(' '));
          db.exec('PRAGMA user_version = 1');
        } else if (version !== 1) throw new Error('Unsupported context schema');
        db.exec('COMMIT');
        this.#db = db;
      } catch (e) {
        if (db.isTransaction) db.exec('ROLLBACK');
        db.close();
        throw e;
      }
    }
    return this.#db;
  }

  handle(input: unknown): ContextResult {
    const event = validateEvent(input);
    const cwd = projectIdentity(event.cwd);
    if (!this.#global && cwd !== this.#scope) throw new Error('Context scope mismatch');
    const db = this.#access();
    const key = sha(this.#paths.domain, this.#scope, cwd, event.session_id);
    const turnKey = sha(event.turn_id);
    const kind = event.hook_event_name;
    const percent = kind === 'UserPromptSubmit' ? sampleContextPercent(event.transcript_path) : null;
    const at = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO sessions VALUES (?, 0, 0, 0, NULL, ?)').run(key, at);
      const current = db.prepare('SELECT prompts, last_notice, percent FROM sessions WHERE key = ?').get(key)!;
      const prompts = Number(current['prompts']);
      const exists = db.prepare('SELECT 1 FROM seen WHERE session_key = ? AND kind = ? AND turn_key = ?')
        .get(key, kind, turnKey);
      if (exists) {
        db.exec('COMMIT');
        return { action: 'none', prompts, percent: current['percent'] as number | null, duplicate: true };
      }
      db.prepare('INSERT INTO seen VALUES (?, ?, ?)').run(key, kind, turnKey);
      if (kind === 'UserPromptSubmit') {
        const next = prompts + 1;
        const action = decideContextAction(next, percent, Number(current['last_notice']));
        const notice = action !== 'none' ? next : Number(current['last_notice']);
        db.prepare('UPDATE sessions SET prompts = ?, last_notice = ?, percent = ?, updated_at = ? WHERE key = ?')
          .run(next, notice, percent, at, key);
        if (action !== 'none') {
          db.prepare('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?)')
            .run(key, action, turnKey, next, percent, at);
        }
        db.exec('COMMIT');
        return { action, prompts: next, percent, duplicate: false };
      }
      db.prepare('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?)').run(key, kind, turnKey, prompts, null, at);
      db.prepare('UPDATE sessions SET compactions = compactions + ?, percent = NULL, last_notice = ?, updated_at = ? WHERE key = ?')
        .run(kind === 'PostCompact' ? 1 : 0, prompts, at, key);
      db.exec('COMMIT');
      return { action: 'none', prompts, percent: null, duplicate: false };
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.#db?.close();
    this.#db = undefined;
  }
}

/** Output is valid only for UserPromptSubmit; native compaction hooks emit nothing. */
export function contextHookOutput(result: ContextResult): string {
  if (result.action === 'none' || result.duplicate) return '';
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: NOTICE },
  });
}
