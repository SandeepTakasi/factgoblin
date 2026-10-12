import { execFileSync } from 'node:child_process';

export function git(repo: string, args: string[]): string {
  // stderr is captured (and attached to the error on failure) instead of leaking into our output.
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Like git(), but returns null instead of throwing (git grep exits 1 on no match). */
export function gitMaybe(repo: string, args: string[]): string | null {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}

const trackedCache = new Map<string, string[]>();

/** Tracked files with exact case. Symlinks are listed as files. */
export function trackedFiles(repo: string): string[] {
  let files = trackedCache.get(repo);
  if (!files) {
    files = git(repo, ['ls-files', '-z']).split('\0').filter(Boolean);
    trackedCache.set(repo, files);
  }
  return files;
}

export function isIgnored(repo: string, path: string): boolean {
  return gitMaybe(repo, ['check-ignore', '-q', '--no-index', path]) !== null;
}
