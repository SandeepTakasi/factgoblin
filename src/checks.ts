import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { gitMaybe, isIgnored, trackedFiles } from './git.ts';
import type { Anchor, CheckResult } from './types.ts';

// Same vendored/fixture dirs discover() skips: their manifests aren't this project's.
const SKIP = /(^|\/)(node_modules|vendor|third_party|third-party|\.venv|venv|external|fixtures|__fixtures__|testdata)\//;

export function check(repo: string, fromFile: string, anchor: Anchor): CheckResult {
  const v = anchor.value.trim();
  const r = (status: CheckResult['status'], detail: string): CheckResult => ({ anchor, status, detail });
  if (!v || /[<>{}$]|\.\.\./.test(v)) return r('unknown', 'placeholder or templated value');
  switch (anchor.type) {
    case 'path': return checkPath(repo, fromFile, v, r);
    case 'script': return checkScript(repo, v, r);
    case 'make_target': return checkMake(repo, v, r);
    case 'just_recipe': return checkJust(repo, v, r);
    case 'package': return checkPackage(repo, v, r);
    case 'symbol':
    case 'api': return checkSymbol(repo, v, anchor.type === 'api', r);
    default: return r('unknown', 'needs semantic verification');
  }
}

type R = (status: CheckResult['status'], detail: string) => CheckResult;

function dirsOf(files: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const f of files) for (let i = f.indexOf('/'); i !== -1; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i));
  return dirs;
}

/** Walks segment by segment so a case-insensitive filesystem can't hide a wrong-case path. */
function existsExactCase(repo: string, rel: string): boolean {
  let dir = repo;
  for (const seg of rel.split('/')) {
    try {
      if (!statSync(dir).isDirectory() || !readdirSync(dir).includes(seg)) return false;
    } catch {
      return false;
    }
    dir = posix.join(dir, seg);
  }
  return existsSync(dir); // follows symlinks; false for broken ones
}

function checkPath(repo: string, fromFile: string, raw: string, r: R): CheckResult {
  if (/[*?]/.test(raw)) return r('unknown', 'glob pattern');
  if (raw.startsWith('/') || raw.startsWith('~') || /^[a-z]+:\/\//i.test(raw)) return r('unknown', 'outside the repo');
  const v = raw.replace(/#.*$/, '').replace(/:\d+(:\d+)?$/, '').replace(/^\.\//, '').replace(/\/+$/, '');
  const files = trackedFiles(repo);
  const tracked = new Set(files);
  const dirs = dirsOf(files);
  const candidates = [...new Set([posix.normalize(v), posix.normalize(posix.join(posix.dirname(fromFile), v))])]
    .filter((c) => !c.startsWith('..'));
  for (const c of candidates) {
    if (tracked.has(c) || dirs.has(c)) return r('pass', `exists: ${c}`);
    if (existsExactCase(repo, c)) return r('pass', `exists (untracked or through a symlink): ${c}`);
  }
  for (const c of candidates) {
    const lower = c.toLowerCase();
    const other = files.find((f) => f.toLowerCase() === lower) ?? [...dirs].find((d) => d.toLowerCase() === lower);
    if (other) return r('fail', `only exists with different case: ${other}`);
  }
  if (candidates.some((c) => isIgnored(repo, c))) return r('unknown', 'path is gitignored (likely generated)');
  const base = posix.basename(v);
  const similar = [...files, ...dirs]
    .filter((f) => !SKIP.test(f + '/') && (f.endsWith('/' + v) || posix.basename(f) === base))
    .slice(0, 5);
  if (similar.length) return r('unknown', `not at that path; similar: ${similar.join(', ')}`);
  return r('fail', `no file or directory ${candidates.join(' or ')}`);
}

function manifests(repo: string, re: RegExp): string[] {
  return trackedFiles(repo).filter((f) => re.test(f) && !SKIP.test(f));
}

function readJson(repo: string, f: string): any {
  try {
    return JSON.parse(readFileSync(posix.join(repo, f), 'utf8'));
  } catch {
    return null;
  }
}

function checkScript(repo: string, v: string, r: R): CheckResult {
  const pkgs = manifests(repo, /(^|\/)package\.json$/);
  if (!pkgs.length) return r('unknown', 'no package.json in repo');
  const hits = pkgs.filter((f) => readJson(repo, f)?.scripts?.[v] !== undefined);
  if (hits.length) return r('pass', `script "${v}" in ${hits.slice(0, 3).join(', ')}`);
  // Say what does exist (root package.json first) so a fix can be written without guessing.
  const root = pkgs.includes('package.json') ? ['package.json'] : pkgs.slice(0, 1);
  const available = Object.keys(readJson(repo, root[0])?.scripts ?? {}).slice(0, 15);
  return r('fail', `no package.json defines script "${v}" (checked ${pkgs.length}); ${root[0]} scripts: ${available.join(', ') || 'none'}`);
}

function checkMake(repo: string, v: string, r: R): CheckResult {
  const files = manifests(repo, /(^|\/)(GNUmakefile|[Mm]akefile(\.[^/]+)?|[^/]+\.mk)$/);
  if (!files.length) return r('fail', 'no Makefile in repo');
  let dynamic = false;
  for (const f of files) {
    const text = readFileSync(posix.join(repo, f), 'utf8');
    for (const m of text.matchAll(/^([^\s#:=][^:=\n]*?)\s*::?(?!=)/gm)) {
      if (m[1].split(/\s+/).includes(v)) return r('pass', `target in ${f}`);
    }
    if (/\$\((eval|call)\b|^[^\s#:=]*%[^:=\n]*:/m.test(text)) dynamic = true;
  }
  if (dynamic) return r('unknown', 'target not found literally, but Makefiles generate targets ($(eval)/$(call)/pattern rules)');
  const targets = [...new Set(files.flatMap((f) => [...readFileSync(posix.join(repo, f), 'utf8').matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?![=:])/gm)].map((m) => m[1])))];
  return r('fail', `no target "${v}" in ${files.length} Makefile(s); targets include: ${targets.slice(0, 15).join(', ')}`);
}

function checkJust(repo: string, v: string, r: R): CheckResult {
  const files = manifests(repo, /(^|\/)(\.?[Jj]ustfile|[^/]+\.just)$/);
  if (!files.length) return r('fail', 'no justfile in repo');
  let imports = false;
  for (const f of files) {
    const text = readFileSync(posix.join(repo, f), 'utf8');
    const names = [
      ...[...text.matchAll(/^@?([A-Za-z0-9_-]+)(?:\s[^:=\n]*)?:(?!=)/gm)].map((m) => m[1]),
      ...[...text.matchAll(/^alias\s+([A-Za-z0-9_-]+)\s*:=/gm)].map((m) => m[1]),
    ];
    if (names.includes(v)) return r('pass', `recipe in ${f}`);
    if (/^(import|mod)\s/m.test(text)) imports = true;
  }
  return imports ? r('unknown', 'recipe not found, but justfiles import others') : r('fail', `no recipe "${v}"`);
}

function checkPackage(repo: string, v: string, r: R): CheckResult {
  const names = new Set<string>();
  const pkgs = manifests(repo, /(^|\/)package\.json$/);
  for (const f of pkgs) {
    const j = readJson(repo, f);
    if (!j) continue;
    if (j.name) names.add(j.name);
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const d of Object.keys(j[k] ?? {})) names.add(d);
    }
  }
  for (const f of manifests(repo, /(^|\/)(Cargo\.toml|pyproject\.toml)$/)) {
    const text = readFileSync(posix.join(repo, f), 'utf8');
    for (const m of text.matchAll(/^name\s*=\s*"([^"]+)"/gm)) names.add(m[1]);
    for (const m of text.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)) names.add(m[1]);
  }
  if (names.has(v)) return r('pass', `package "${v}" is defined or depended on`);
  const looksNpm = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(v);
  if (pkgs.length && looksNpm) return r('fail', `no workspace package or dependency named "${v}"`);
  return r('unknown', 'package not found in manifests this checker reads');
}

const DEFINITION = (name: string) =>
  new RegExp(`(function|class|const|let|var|def|fn|func|type|interface|enum|struct)\\s+${name}\\b|\\b${name}\\s*[:=]\\s*(async\\b|function\\b|\\()`);

function checkSymbol(repo: string, raw: string, isApi: boolean, r: R): CheckResult {
  const name = raw.replace(/\(.*\)$/, '').split(/[.:#]/).pop()!;
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return r('unknown', 'not a plain identifier');
  const hits = gitMaybe(repo, ['grep', '-n', '-w', '-F', name, '--', ':!*.md', ':!*.mdx', ':!*.mdc']);
  if (!hits) return r('fail', `"${name}" does not appear anywhere outside markdown`);
  if (!isApi) return r('pass', `"${name}" is referenced in code`);
  const def = DEFINITION(name.replace(/\$/g, '\\$'));
  for (const line of hits.split('\n')) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!m || !def.test(m[3])) continue;
    const lines = readFileSync(posix.join(repo, m[1]), 'utf8').split('\n');
    // Walk up through the doc comment / decorators directly above the definition.
    for (let i = Number(m[2]) - 2; i >= 0 && /^\s*(\*|\/\*\*|\/\/|#|@|\*\/)/.test(lines[i]); i--) {
      if (/@deprecated|#\[deprecated|\bDeprecationWarning\b/i.test(lines[i])) {
        return r('fail', `${name} is marked deprecated at ${m[1]}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
  return r('pass', `"${name}" exists and its definition is not marked deprecated`);
}
