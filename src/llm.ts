import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LlmCall {
  cwd: string; // the target repo; file tools are confined to it
  prompt: string;
  schema: object; // JSON Schema the answer must satisfy
  tools: ('Read' | 'Grep' | 'Glob')[]; // read-only by construction; [] = no tools
  model?: string;
  budgetUsd?: number;
  cacheKey: string; // whatever the answer depends on besides the prompt (e.g. repo commit)
  timeoutMs?: number;
}

export interface LlmResult<T> {
  output: T;
  costUsd: number;
  durationMs: number;
  cached: boolean;
}

export const CACHE_DIR = join(import.meta.dirname, '..', '.cache', 'llm');

/**
 * Runs one headless Claude Code call, isolated from the target repo's own configuration:
 * the repo's CLAUDE.md, settings, hooks, skills, plugins and MCP servers are never loaded,
 * no code-running tools exist, and nothing can prompt for permission.
 */
export function isolationArgs(tools: string[]): string[] {
  return [
    '-p',
    '--safe-mode', // no CLAUDE.md auto-discovery, skills, plugins, hooks, MCP
    '--restricted', // no Bash/code-running tools or WebFetch; ignores user/project/local settings files
    '--strict-mcp-config',
    '--permission-prompts', 'none',
    '--no-session-persistence',
    '--tools', tools.join(','),
    '--output-format', 'json',
  ];
}

export async function runClaude<T>(call: LlmCall): Promise<LlmResult<T>> {
  const key = createHash('sha256')
    .update(JSON.stringify([call.prompt, call.schema, call.tools, call.model ?? '', call.cacheKey]))
    .digest('hex');
  const cacheFile = join(CACHE_DIR, `${key}.json`);
  try {
    return { ...JSON.parse(readFileSync(cacheFile, 'utf8')), cached: true };
  } catch {
    // not cached
  }
  const args = [
    ...isolationArgs(call.tools),
    '--json-schema', JSON.stringify(call.schema),
    '--max-budget-usd', String(call.budgetUsd ?? 2),
    ...(call.model ? ['--model', call.model] : []),
  ];
  const started = Date.now();
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('claude', args, { cwd: call.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), call.timeoutMs ?? 15 * 60_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!out.trim()) reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
      else resolve(out);
    });
    child.stdin.end(call.prompt); // prompt via stdin: no argv size limit, never parsed as flags
  });
  const res = JSON.parse(stdout);
  if (res.is_error || res.structured_output === undefined) {
    throw new Error(`claude call failed: ${String(res.result ?? res.subtype).slice(0, 500)}`);
  }
  const result: LlmResult<T> = {
    output: res.structured_output as T,
    costUsd: res.total_cost_usd ?? 0,
    durationMs: res.duration_ms ?? Date.now() - started,
    cached: false,
  };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ output: result.output, costUsd: result.costUsd, durationMs: result.durationMs }));
  return result;
}
