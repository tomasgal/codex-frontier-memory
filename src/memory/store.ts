import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { authorize } from '../capture/policy.js';
import { bounded, digest, normalize, provenance, text } from '../capture/normalize.js';
import { openDatabase } from '../storage/database.js';
import { assertSafeStorage, projectIdentity, resolveStoragePaths } from '../storage/paths.js';
import type { MemoryInput, MemoryKind, MemoryRecord, Provenance } from './types.js';

/** Local manual storage API. All recalled content is untrusted reference data. */
export class MemoryStore {
  readonly #paths = resolveStoragePaths();
  readonly #project: string;
  readonly #projectKey: string;
  #db: DatabaseSync | undefined;
  #closed = false;

  constructor(projectRoot: string) {
    this.#project = projectIdentity(projectRoot);
    this.#projectKey = digest([this.#paths.domain, this.#project]);
  }

  #access(): DatabaseSync {
    if (this.#closed) throw new Error('Memory store is closed');
    try {
      authorize(this.#paths, this.#project);
    } catch (error) {
      this.#db?.close();
      this.#db = undefined;
      throw error;
    }
    if (!this.#db) {
      mkdirSync(this.#paths.directory, { recursive: true, mode: 0o700 });
      assertSafeStorage(this.#paths, this.#project);
      try {
        closeSync(openSync(this.#paths.database, 'wx', 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      assertSafeStorage(this.#paths, this.#project);
      this.#db = openDatabase(this.#paths.database, this.#paths.domain);
    }
    return this.#db;
  }

  #transaction<T>(db: DatabaseSync, action: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  #get(db: DatabaseSync, id: string, sourceLimit = -1): MemoryRecord | undefined {
    const row = db.prepare('SELECT * FROM records WHERE project = ? AND id = ?').get(this.#projectKey, id);
    if (!row) return undefined;
    const body = JSON.parse(row['body'] as string) as Omit<MemoryInput, 'provenance'>;
    const sources = db.prepare('SELECT body FROM sources WHERE project = ? AND record_id = ? ORDER BY event_id LIMIT ?')
      .all(this.#projectKey, id, sourceLimit).map(source => JSON.parse(source['body'] as string) as Provenance);
    return {
      ...body, id, originalStatus: body.status,
      status: row['superseded_by'] ? 'superseded' : body.status,
      provenance: sources, createdAt: row['created_at'] as string, untrusted: true,
      ...(row['superseded_by'] ? {
        supersededBy: row['superseded_by'] as string,
        supersession: JSON.parse(row['supersession'] as string) as NonNullable<MemoryRecord['supersession']>,
      } : {}),
    };
  }

  put(input: MemoryInput): { record: MemoryRecord; deduplicated: boolean } {
    const db = this.#access();
    const normalized = normalize(input);
    const { provenance: source, ...body } = normalized;
    const fingerprint = digest(body);
    return this.#transaction(db, () => {
      if (normalized.kind === 'fix') {
        const error = this.#get(db, normalized.errorId);
        if (!error || error.kind !== 'error') throw new Error('Fix must reference an error in this project');
      }
      const event = db.prepare('SELECT record_id, body FROM sources WHERE project = ? AND event_id = ?')
        .get(this.#projectKey, source.eventId);
      const existing = db.prepare('SELECT id FROM records WHERE project = ? AND fingerprint = ?')
        .get(this.#projectKey, fingerprint);
      if (event && (!existing || event['record_id'] !== existing['id'] || event['body'] !== JSON.stringify(source))) {
        throw new Error('Event ID conflicts with existing content or provenance');
      }
      const id = existing ? existing['id'] as string : randomUUID();
      if (!existing) {
        db.prepare(`INSERT INTO records (id, project, fingerprint, kind, original_status, body, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          id, this.#projectKey, fingerprint, body.kind, body.status, JSON.stringify(body), new Date().toISOString(),
        );
      }
      if (!event) {
        db.prepare('INSERT INTO sources (project, event_id, record_id, body) VALUES (?, ?, ?, ?)')
          .run(this.#projectKey, source.eventId, id, JSON.stringify(source));
      }
      return { record: this.#get(db, id)!, deduplicated: !!existing };
    });
  }

  get(id: string): MemoryRecord | undefined {
    const db = this.#access();
    return this.#get(db, text(id, 128));
  }

  list(options: { kind?: MemoryKind; includeSuperseded?: boolean; limit?: number } = {}): MemoryRecord[] {
    const db = this.#access();
    const { kind, includeSuperseded = false, limit = 100 } = options;
    if ((kind !== undefined && !['error', 'fix', 'decision'].includes(kind))
        || typeof includeSuperseded !== 'boolean' || !Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Invalid list options (limit must be 1..500)');
    }
    return db.prepare(`SELECT id FROM records WHERE project = ? AND (? IS NULL OR kind = ?)
      AND (? = 1 OR superseded_by IS NULL) ORDER BY created_at, id LIMIT ?`)
      .all(this.#projectKey, kind ?? null, kind ?? null, includeSuperseded ? 1 : 0, limit)
      .map(row => this.#get(db, row['id'] as string)!);
  }

  /** Bounded substring search; provenance is capped and explicitly marked as partial. */
  search(query: string, limit: number, includeSuperseded: boolean): { record: MemoryRecord; provenancePartial: boolean }[] {
    const db = this.#access();
    const term = text(query, 256);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10 || typeof includeSuperseded !== 'boolean') throw new Error('Invalid search options');
    return db.prepare(`SELECT id, (SELECT count(*) FROM sources s WHERE s.project = records.project AND s.record_id = records.id) AS source_count
      FROM records WHERE project = ? AND (? = 1 OR superseded_by IS NULL)
      AND instr(lower(body), lower(?)) > 0 ORDER BY created_at DESC, id LIMIT ?`)
      .all(this.#projectKey, includeSuperseded ? 1 : 0, term, limit)
      .map(row => ({ record: this.#get(db, row['id'] as string, 5)!, provenancePartial: Number(row['source_count']) > 5 }));
  }

  supersede(id: string, replacementId: string, reason: string, source: Provenance): MemoryRecord {
    const db = this.#access();
    bounded({ id, replacementId, reason, source });
    const oldId = text(id, 128);
    const newId = text(replacementId, 128);
    const explanation = text(reason);
    const origin = provenance(source);
    return this.#transaction(db, () => {
      const old = this.#get(db, oldId);
      const replacement = this.#get(db, newId);
      if (!old || !replacement || oldId === newId || old.kind !== replacement.kind
          || (old.kind === 'fix' && old.errorId !== replacement.errorId)) {
        throw new Error('Supersession requires distinct compatible records in this project');
      }
      if (old.supersededBy) {
        if (old.supersededBy === newId && old.supersession?.reason === explanation
            && JSON.stringify(old.supersession.source) === JSON.stringify(origin)) return old;
        throw new Error('Record already superseded');
      }
      if (replacement.status === 'superseded') throw new Error('Replacement must be active');
      const supersession = { reason: explanation, source: origin, at: new Date().toISOString() };
      db.prepare('UPDATE records SET superseded_by = ?, supersession = ? WHERE project = ? AND id = ?')
        .run(newId, JSON.stringify(supersession), this.#projectKey, oldId);
      return this.#get(db, oldId)!;
    });
  }

  close(): void {
    this.#db?.close();
    this.#db = undefined;
    this.#closed = true;
  }
}
