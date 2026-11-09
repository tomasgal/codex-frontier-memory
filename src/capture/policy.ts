import { readFileSync, statSync } from 'node:fs';
import { assertSafeStorage } from '../storage/paths.js';
import type { StoragePaths } from '../storage/paths.js';

export class MemoryAccessError extends Error {
  constructor() {
    super('Memory is OFF or the project is not explicitly authorized by a valid local policy');
    this.name = 'MemoryAccessError';
  }
}

export interface MemoryPolicy {
  version: 1;
  enabled: boolean;
  /** Exact canonical absolute project roots; no globbing or child inheritance. */
  allowedProjects: string[];
}

/** Deliberately uncached. Missing, malformed, unreadable, or revoked policy denies all access. */
export function authorize(paths: StoragePaths, project: string): void {
  try {
    assertSafeStorage(paths, project);
    if (statSync(paths.policy).size > 64 * 1024) throw new MemoryAccessError();
    const policy: unknown = JSON.parse(readFileSync(paths.policy, 'utf8'));
    if (!policy || typeof policy !== 'object') throw new MemoryAccessError();
    const p = policy as Partial<MemoryPolicy>;
    if (p.version !== 1 || p.enabled !== true || !Array.isArray(p.allowedProjects)
        || !p.allowedProjects.every(entry => typeof entry === 'string')
        || !p.allowedProjects.includes(project)) throw new MemoryAccessError();
  } catch {
    throw new MemoryAccessError();
  }
}
