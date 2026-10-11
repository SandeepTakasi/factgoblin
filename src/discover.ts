import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { trackedFiles } from './git.ts';
import type { InstructionFile } from './types.ts';

const INSTRUCTION_FILE = [
  /(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$/i,
  /^\.github\/copilot-instructions\.md$/,
  /(^|\/)\.cursorrules$/,
  /(^|\/)\.cursor\/rules\/.+\.mdc$/,
  /(^|\/)\.(agents|claude|github|codex|opencode|cursor)\/.*SKILL\.md$/,
];

// Vendored code and test fixtures carry other projects' instruction files.
const SKIP = /(^|\/)(node_modules|vendor|third_party|third-party|\.venv|venv|dist|build|external|fixtures|__fixtures__|testdata)\//;

export function discover(repo: string): InstructionFile[] {
  const byContent = new Map<string, { real: string; paths: string[] }>();
  for (const p of trackedFiles(repo)) {
    if (SKIP.test(p) || !INSTRUCTION_FILE.some((re) => re.test(p))) continue;
    let real: string;
    try {
      real = realpathSync(join(repo, p));
    } catch {
      continue; // broken symlink
    }
    const hash = createHash('sha256').update(readFileSync(real)).digest('hex');
    const group = byContent.get(hash) ?? { real, paths: [] };
    group.paths.push(p);
    byContent.set(hash, group);
  }
  const root = realpathSync(repo);
  return [...byContent.values()].map(({ real, paths }) => {
    const canonical = relative(root, real);
    const path = paths.includes(canonical) ? canonical : paths.sort()[0];
    return { path, aliases: paths.filter((p) => p !== path).sort() };
  }).sort((a, b) => a.path.localeCompare(b.path));
}
