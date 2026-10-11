"""Shortlist popular, active repos whose root CLAUDE.md/AGENTS.md has gone stale.

staleness = commits to the repo since the instruction file was last touched.
ponytail: one GitHub API pass, no caching beyond scan2.json.
"""
import json, re, subprocess, sys, time, os
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
SINCE30 = "2026-09-10"
SKIP = {"denoland/deno", "malforge/mdk2", "grafana/grafana", "cloudflare/workers-sdk", "TanStack/router",
        "getsentry/sentry"}
CANDIDATES = """
microsoft/vscode vercel/next.js langchain-ai/langchain astral-sh/ruff astral-sh/uv biomejs/biome sveltejs/svelte
vercel/ai supabase/supabase n8n-io/n8n PostHog/posthog apache/airflow oven-sh/bun excalidraw/excalidraw
calcom/cal.com mastra-ai/mastra modelcontextprotocol/typescript-sdk huggingface/transformers zed-industries/zed
withastro/astro prisma/prisma microsoft/playwright facebook/react openai/codex pnpm/pnpm nodejs/node
home-assistant/core immich-app/immich payloadcms/payload medusajs/medusa ollama/ollama open-webui/open-webui
langfuse/langfuse continuedev/continue cline/cline browser-use/browser-use microsoft/autogen pydantic/pydantic-ai
run-llama/llama_index comfyanonymous/ComfyUI vllm-project/vllm sgl-project/sglang huggingface/diffusers
gradio-app/gradio streamlit/streamlit tldraw/tldraw outline/outline go-gitea/gitea hashicorp/terraform
shadcn-ui/ui TanStack/query remix-run/react-router nuxt/nuxt vuejs/core angular/angular electron/electron
tauri-apps/tauri expo/expo microsoft/typescript-go oxc-project/oxc rolldown/rolldown vercel/turborepo nrwl/nx
storybookjs/storybook vitest-dev/vitest tailwindlabs/tailwindcss prettier/prettier eslint/eslint
typescript-eslint/typescript-eslint facebook/docusaurus mermaid-js/mermaid appsmithorg/appsmith
activepieces/activepieces langgenius/dify lobehub/lobe-chat danny-avila/LibreChat Mintplex-Labs/anything-llm
firecrawl/firecrawl unslothai/unsloth ray-project/ray duckdb/duckdb ClickHouse/ClickHouse temporalio/temporal
dagster-io/dagster PrefectHQ/prefect airbytehq/airbyte dbt-labs/dbt-core apache/superset metabase/metabase
umami-software/umami documenso/documenso formbricks/formbricks twentyhq/twenty novuhq/novu triggerdotdev/trigger.dev
inngest/inngest better-auth/better-auth drizzle-team/drizzle-orm colinhacks/zod Effect-TS/effect pola-rs/polars
astral-sh/ty biomejs/biome-vscode vitejs/vite honojs/hono trpc/trpc elysiajs/elysia withastro/starlight
mui/material-ui ant-design/ant-design chakra-ui/chakra-ui radix-ui/primitives lucide-icons/lucide
pytorch/ao huggingface/trl huggingface/peft huggingface/smolagents openai/openai-agents-python
anthropics/anthropic-sdk-python anthropics/anthropic-sdk-typescript openai/openai-python googleapis/python-genai
google-gemini/gemini-cli QwenLM/qwen-code sst/opencode charmbracelet/crush block/goose RooCodeInc/Roo-Code
Kilo-Org/kilocode microsoft/markitdown docling-project/docling unstructured-io/unstructured
""".split()


def gh(*args):
    r = subprocess.run(["gh", "api", *args], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def last_page_count(url):
    r = subprocess.run(["gh", "api", "-i", url], capture_output=True, text=True)
    if r.returncode:
        return None
    m = re.search(r'[?&]page=(\d+)>; rel="last"', r.stdout)
    if m:
        return int(m.group(1))
    return 1 if '"sha"' in r.stdout else 0


def probe(repo):
    meta = gh(f"repos/{repo}", "--jq", "[.stargazers_count,.pushed_at,.archived,.default_branch]")
    if not meta:
        return None
    stars, pushed, archived, branch = json.loads(meta)
    if archived or stars < 5000:
        return None
    files = []
    for f in ("AGENTS.md", "CLAUDE.md"):
        info = gh(f"repos/{repo}/contents/{f}?ref={branch}", "--jq", "[.type,.size,.target // \"\"]")
        if not info:
            continue
        typ, size, target = json.loads(info)
        if typ != "file" or size < 2500:  # skip stubs / symlinks / one-line @imports
            continue
        last = gh(f"repos/{repo}/commits?path={f}&sha={branch}&per_page=1", "--jq", ".[0].commit.committer.date")
        last = (last or "").strip()
        since = last_page_count(f"repos/{repo}/commits?sha={branch}&since={last}&per_page=1") if last else None
        files.append({"file": f, "bytes": size, "last_touched": last[:10], "commits_since": since})
    if not files:
        return None
    return {"repo": repo, "stars": stars, "files": files}


def main():
    repos = [r for r in dict.fromkeys(CANDIDATES) if r not in SKIP]
    with ThreadPoolExecutor(8) as ex:
        rows = [r for r in ex.map(probe, repos) if r]
    # merged PRs in last 30 days, via search API (30 req/min)
    for r in rows:
        q = f"repo:{r['repo']} is:pr is:merged merged:>{SINCE30}"
        out = gh("-X", "GET", "search/issues", "-f", f"q={q}", "-f", "per_page=1", "--jq", ".total_count")
        r["merged_30d"] = int(out) if out else None
        time.sleep(2.2)
    for r in rows:
        best = max(r["files"], key=lambda f: (f["commits_since"] or 0))
        r["file"], r["staleness"] = best["file"], best["commits_since"] or 0
    rows.sort(key=lambda r: (r["staleness"]), reverse=True)
    json.dump(rows, open(os.path.join(HERE, "scan2.json"), "w"), indent=1)
    print(f"{'repo':40} {'stars':>7} {'merged30':>8} file       bytes  last_touched commits_since")
    for r in rows:
        for f in r["files"]:
            print(f"{r['repo']:40} {r['stars']:>7} {str(r['merged_30d']):>8} {f['file']:10} {f['bytes']:>6} "
                  f"{f['last_touched']:12} {f['commits_since']}")


if __name__ == "__main__":
    main()
