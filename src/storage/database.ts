import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE records (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('error', 'fix', 'decision')),
    original_status TEXT NOT NULL CHECK (original_status IN
      ('observed_error', 'proposed_fix', 'tested_fix', 'user_decision', 'inferred_decision')),
    body TEXT NOT NULL CHECK (json_valid(body)),
    created_at TEXT NOT NULL,
    superseded_by TEXT REFERENCES records(id),
    supersession TEXT CHECK (supersession IS NULL OR json_valid(supersession)),
    UNIQUE (project, fingerprint),
    UNIQUE (project, id)
  ) STRICT;
  CREATE INDEX records_project ON records(project, created_at, id);
  CREATE TABLE sources (
    project TEXT NOT NULL,
    event_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    body TEXT NOT NULL CHECK (json_valid(body)),
    PRIMARY KEY (project, event_id),
    FOREIGN KEY (project, record_id) REFERENCES records(project, id)
  ) STRICT;
`;

/** Internal: never exported from the package entrypoint; callers must authorize first. */
export function openDatabase(file: string, domain: string): DatabaseSync {
  const db = new DatabaseSync(file, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: 5000,
  });
  try {
    db.exec('PRAGMA trusted_schema = OFF; BEGIN IMMEDIATE');
    const version = db.prepare('PRAGMA user_version').get()!['user_version'];
    if (version === 0) {
      db.exec(SCHEMA);
      db.prepare('INSERT INTO metadata VALUES (?, ?)').run('domain', domain);
      db.exec('PRAGMA user_version = 1');
    } else if (version !== 1) {
      throw new Error('Unsupported memory schema version');
    }
    if (db.prepare('SELECT value FROM metadata WHERE key = ?').get('domain')?.['value'] !== domain) {
      throw new Error('Memory database belongs to another OS domain');
    }
    db.exec('COMMIT');
    return db;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    throw error;
  }
}
