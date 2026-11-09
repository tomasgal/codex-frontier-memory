import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface StoragePaths {
  domain: 'win32' | 'linux';
  directory: string;
  policy: string;
  database: string;
}

/** Pure resolver, also usable to test each OS independently without opening files. */
export function resolveStoragePaths(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): StoragePaths {
  if (platform !== 'win32' && platform !== 'linux') throw new Error('Unsupported memory platform');
  const p = platform === 'win32' ? path.win32 : path.posix;
  const base = platform === 'win32' ? env.LOCALAPPDATA : (env.XDG_STATE_HOME || p.join(home, '.local', 'state'));
  if (!base || !p.isAbsolute(base)) throw new Error('OS-local storage requires an absolute data directory');
  const directory = p.join(base, 'codex-frontier-memory', platform);
  assertLocalPath(directory, platform);
  return { domain: platform, directory, policy: p.join(directory, 'policy.json'), database: p.join(directory, 'memory.sqlite') };
}

export function assertLocalPath(value: string, platform: string): void {
  if (platform === 'win32') {
    if (!/^[a-z]:\\/i.test(value)) throw new Error('Shared or UNC memory paths are forbidden');
  } else if (/^\/(?:mnt|media)(?:\/|$)|^\/run\/desktop\/mnt(?:\/|$)/.test(value)) {
    throw new Error('Mounted Windows or shared memory paths are forbidden');
  }
}

/** Resolve existing ancestors as well, so a symlink cannot hide repository storage. */
export function canonicalPath(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('An absolute path is required');
  let cursor = path.resolve(value);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error('Cannot resolve storage path');
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const result = path.join(realpathSync.native(cursor), ...missing);
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

export function projectIdentity(projectRoot: string): string {
  const project = canonicalPath(projectRoot);
  if (!statSync(project).isDirectory()) throw new Error('Project root must be an existing directory');
  return project;
}

export function assertSafeStorage(paths: StoragePaths, project: string): void {
  const directory = canonicalPath(paths.directory);
  assertLocalPath(directory, paths.domain);
  const relative = path.relative(project, directory);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Runtime memory must be outside the project');
  }
  let cursor = directory;
  while (true) {
    if (existsSync(path.join(cursor, '.git'))) throw new Error('Runtime memory must be outside Git repositories');
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const file of [paths.policy, paths.database]) {
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Memory files must be local regular files without links');
    }
  }
}
