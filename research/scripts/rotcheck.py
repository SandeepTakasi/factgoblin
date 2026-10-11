"""Throwaway: measure rot in root CLAUDE.md / AGENTS.md of public repos.

Checks only references that are mechanically verifiable against HEAD:
  - file paths (inline code + markdown links)
  - package-manager scripts (npm/pnpm/yarn/bun) and make/just targets
Lenient on purpose: a path counts as existing if any tracked path ends with it.
ponytail: regex heuristics, expect false positives; findings get hand-reviewed.
"""
import json, os, re, subprocess, sys, fnmatch
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.abspath(__file__))
REPOS = os.path.join(ROOT, "repos")
EXT = {"ts","tsx","js","jsx","mjs","cjs","py","md","mdx","json","toml","yaml","yml","go","rs","sh",
       "rb","java","kt","swift","c","h","cc","cpp","hpp","cs","sql","css","scss","html","vue","svelte",
       "lock","txt","cfg","ini","proto","zig","ex","exs","php","lua","r","R","ipynb","gradle","xml","env"}
SKIP_SEG = {"node_modules","dist","build","out","target",".next","coverage",".venv","venv","__pycache__",
            ".git","tmp",".cache",".turbo","~"}
SKIP_FIRST = {"feat","fix","chore","origin","refs","text","application","image","video","audio","multipart","HEAD"}
PNPM_BUILTIN = {"install","i","add","remove","rm","update","up","exec","dlx","create","init","link","unlink",
                "publish","pack","list","ls","outdated","why","store","config","audit","import","rebuild",
                "prune","env","setup","fetch","patch","patch-commit","deploy","licenses","approve-builds",
                "recursive","-r","run","workspace","workspaces","info","upgrade","dedupe","cache","version",
                "npm","node","plugin","constraints","set","login","logout","whoami","help","x","bin","root",
                "self-update","outdated","changeset","tsc","vitest","jest","eslint","prettier","biome","nx",
                "turbo","playwright","lerna","tsx","next","vite","wrangler","prisma","drizzle-kit"}


def sh(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=900)


def fetch(repo):
    d = os.path.join(REPOS, repo.replace("/", "__"))
    if not os.path.isdir(d):
        r = sh("git", "clone", "--depth", "1", "--filter=blob:none", "--no-checkout", "--quiet",
               f"https://github.com/{repo}.git", d)
        if r.returncode:
            return repo, None, r.stderr.strip()[:200]
    if True:
        sh("git", "sparse-checkout", "set", "--no-cone", "/*.md", "/.gitignore", "**/package.json",
           "**/Makefile", "**/Makefile.*", "**/*.mk", "**/*.just", "**/justfile", "**/Justfile", cwd=d)
        sh("git", "checkout", "--quiet", cwd=d)
    return repo, d, None


def tracked(d):
    files, links = set(), {}
    for line in sh("git", "ls-tree", "-r", "HEAD", cwd=d).stdout.splitlines():
        meta, path = line.split("\t", 1)
        files.add(path)
        if meta.startswith("120000"):
            links[path] = meta.split()[2]
    dirs = {p.rsplit("/", i)[0] for p in files for i in range(1, p.count("/") + 1)}
    return files, dirs, links


def gitignored(path, patterns):
    for p in patterns:
        p = p.strip("/")
        if fnmatch.fnmatch(path, p) or fnmatch.fnmatch(path, p + "/*"):
            return True
        if "/" not in p and any(fnmatch.fnmatch(seg, p) for seg in path.split("/")):
            return True
    return False


def candidates(text):
    """Yield (kind, ref) pairs from inline code, links and fenced shell lines."""
    fenced = re.findall(r"```[^\n]*\n(.*?)```", text, re.S)
    body = re.sub(r"```.*?```", "", text, flags=re.S)
    body = re.sub(r"\[[^\]]*\]\(https?://[^)]*\)", "", body)
    spans = re.findall(r"`([^`\n]+)`", body)
    links = [m for m in re.findall(r"\]\(([^)\s]+)\)", body) if "://" not in m and not m.startswith(("#", "mailto:"))]
    for s in spans + links:
        s = s.split("#")[0].strip().rstrip(".,:;")
        s = re.sub(r":\d+(:\d+)?$", "", s)
        if s.startswith("./"):
            s = s[2:]
        if re.fullmatch(r"[\w@.\-/()\[\]+]+", s) and s.strip("/"):
            yield "path", s.rstrip("/")
    for line in spans + [l for f in fenced for l in f.splitlines()]:
        for m in re.finditer(r"(?:^|&&|;|\$)\s*(npm|pnpm|yarn|bun|make|just)\s+([^&|;#\n]*)", line.strip()):
            yield "cmd", (m.group(1), m.group(2).split())


def script_of(tool, toks):
    """Return the script/target name a command invokes, or None if it's a builtin/unparseable."""
    i = 0
    while i < len(toks) and toks[i].startswith("-"):
        i += 2 if toks[i] in ("--filter", "-F", "-C", "--dir", "--cwd", "-w", "--workspace", "--prefix") else 1
    if i >= len(toks):
        return None
    t = toks[i]
    if tool in ("make", "just"):
        return t if re.fullmatch(r"[\w.\-]+", t) and "=" not in t else None
    if tool in ("npm", "bun"):
        if t in ("run", "run-script"):
            return toks[i + 1] if i + 1 < len(toks) else None
        return t if (tool == "npm" and t in ("test", "start")) else None
    if t == "run":
        return toks[i + 1] if i + 1 < len(toks) else None
    if t in PNPM_BUILTIN or t.startswith(("<", "$", "@")) or "/" in t or "." in t:
        return None
    return t


def check(repo, d):
    files, dirs, links = tracked(d)
    ignore = []
    if os.path.exists(os.path.join(d, ".gitignore")):
        ignore = [l.strip() for l in open(os.path.join(d, ".gitignore"), errors="ignore")
                  if l.strip() and not l.startswith(("#", "!"))]
    scripts, targets = set(), set()
    managers = {n for n, f in [("pnpm", "pnpm-lock.yaml"), ("yarn", "yarn.lock"), ("bun", "bun.lockb"),
                               ("bun", "bun.lock"), ("npm", "package-lock.json")] if f in files}
    for f in files:
        p = os.path.join(d, f)
        if not os.path.isfile(p):
            continue
        base = os.path.basename(f)
        if base == "package.json":
            try:
                scripts |= set(json.load(open(p)).get("scripts", {}))
            except Exception:
                pass
        elif base in ("Makefile", "justfile", "Justfile") or base.startswith("Makefile.") or base.endswith((".mk", ".just")):
            txt = open(p, errors="ignore").read()
            for line in re.findall(r"^([\w.\- ]+?)\s*:(?![=:])", txt, re.M):
                targets |= set(line.split())
            targets |= set(re.findall(r"^alias\s+([\w\-]+)\s*:=", txt, re.M))
            targets |= set(re.findall(r"^@?([\w\-]+)[^\n:=]*:(?!=)", txt, re.M)) if base.lower() == "justfile" else set()
    by_base = {}
    for p in files | dirs:
        by_base.setdefault(p.rsplit("/", 1)[-1], set()).add(p)

    def exists(ref):
        if ref in files or ref in dirs:
            return True
        tail = ref.rsplit("/", 1)[-1]
        return any(p == ref or p.endswith("/" + ref) for p in by_base.get(tail, ()))

    seen_text, out = set(), []
    for name in sorted(files):
        if "/" in name or name.lower() not in ("claude.md", "agents.md"):
            continue
        if name in links:
            continue  # symlink to the other file, checked there
        text = open(os.path.join(d, name), errors="ignore").read()
        if text in seen_text:
            continue
        seen_text.add(text)
        refs = set()
        for kind, ref in candidates(text):
            if kind == "path":
                segs = ref.split("/")
                ext = ref.rsplit(".", 1)[-1] if "." in segs[-1] else ""
                strong = "/" in ref and ext in EXT
                weak_dir = "/" in ref and not ext
                bare = "/" not in ref and ext in EXT
                if not (strong or weak_dir or bare) or ref.startswith(("@", "/", "~", "http")):
                    continue
                if segs[0] in SKIP_FIRST or SKIP_SEG & set(segs) or segs[-1].startswith(".env"):
                    continue
                if any(c in ref for c in "*<>{}$") or "..." in ref or gitignored(ref, ignore):
                    continue
                if ref.startswith("../"):
                    continue
                tier = "path" if strong else ("dir" if weak_dir else "bare")
                key = (tier, ref)
                if key not in refs and not exists(ref):
                    refs.add(key)
                    out.append({"file": name, "tier": tier, "ref": ref})
            else:
                tool, toks = ref
                s = script_of(tool, toks)
                if not s or not re.fullmatch(r"[\w:.\-]+", s):
                    continue
                pool = targets if tool in ("make", "just") else scripts
                key = ("cmd", f"{tool} {s}")
                if key in refs:
                    continue
                if s not in pool:
                    refs.add(key)
                    out.append({"file": name, "tier": "cmd", "ref": f"{tool} {' '.join(toks[:4])}",
                                "why": f"no '{s}' {'target' if tool in ('make','just') else 'script'} found"})
                if tool in ("npm", "pnpm", "yarn", "bun") and managers and tool not in managers \
                        and ("mgr", tool) not in refs:
                    refs.add(("mgr", tool))
                    out.append({"file": name, "tier": "mgr", "ref": tool,
                                "why": f"repo lockfile says {sorted(managers)}"})
    return {"repo": repo, "issues": out}


def main():
    sample = json.load(open(os.path.join(ROOT, "sample.json")))
    os.makedirs(REPOS, exist_ok=True)
    allrepos = [(g, r) for g in sample for r in sample[g]]
    with ThreadPoolExecutor(6) as ex:
        fetched = dict((r, (d, e)) for r, d, e in ex.map(fetch, [r for _, r in allrepos]))
    results = []
    for g, r in allrepos:
        d, err = fetched[r]
        if err:
            print(f"skip {r}: {err}", file=sys.stderr)
            continue
        res = check(r, d)
        res["group"] = g
        results.append(res)
    json.dump(results, open(os.path.join(ROOT, "results.json"), "w"), indent=1)
    for res in results:
        tiers = {}
        for i in res["issues"]:
            tiers[i["tier"]] = tiers.get(i["tier"], 0) + 1
        print(f"{res['group']:5} {res['repo']:45} {tiers}")


if __name__ == "__main__":
    main()
