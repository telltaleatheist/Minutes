/**
 * Local AI runtime — supervises a llama-server.exe child process and talks to its
 * OpenAI-compatible endpoint.
 *
 * The component system downloads the engine (`llama` CPU build, optional
 * `llama-cuda` GPU build) and the GGUF models (`cogito-3b`, etc.). This module is
 * the missing half: it launches the engine against a chosen model, waits for it to
 * become healthy, and exposes a chat-completion call. One server runs at a time;
 * requesting a different model transparently restarts it.
 */

import * as net from 'net';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

import { resolveEntry } from './components/component-manager';
import { LLAMA_CUDA_ID } from './components/llama-cuda';
import { getComponent } from './components/catalog';
import { profile } from './components/system-probe';

const LLAMA_CPU_ID = 'llama';

// Context window bounds. We never use the model's full 131K trained context
// (its KV cache alone is ~16 GB); instead we size the window to the actual
// prompt so a short transcript allocates a small KV cache. MAX caps very long
// meetings; MIN keeps a floor for tiny inputs.
const MIN_CTX_SIZE = 2048;
const MAX_CTX_SIZE = 32768;
const CTX_OUTPUT_RESERVE = 4096; // room for the generated notes + a little slack

/** Estimate the context window (tokens) needed for one generation: the prompt
 *  plus room for the response, clamped and rounded up. ~3.5 chars/token is a
 *  deliberately conservative (over-)estimate so the transcript isn't truncated;
 *  no tokenizer is available in the main process. */
export function estimateCtxSize(systemPrompt: string, userPrompt: string, maxTokens = 4000): number {
  const promptTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 3.5);
  const needed = promptTokens + Math.max(maxTokens, CTX_OUTPUT_RESERVE) + 512;
  const clamped = Math.min(MAX_CTX_SIZE, Math.max(MIN_CTX_SIZE, needed));
  return Math.ceil(clamped / 1024) * 1024; // round up to a tidy multiple
}

// Transformer layer counts for the local models, used to size partial GPU
// offload. Keyed by catalog id; falls back to all-or-nothing when unknown.
const MODEL_LAYERS: Record<string, number> = {
  'cogito-3b': 28,  // Llama 3.2 3B
  'cogito-8b': 32,  // Llama 3.1 8B
  'cogito-14b': 48, // Qwen 2.5 14B
};

/**
 * Decide how many layers to offload to the GPU. Full offload of a model that
 * doesn't fit in VRAM makes llama-server crash on startup (0xC0000005), so size
 * it to the available VRAM: full if it fits, partial if it nearly does, else CPU.
 */
async function computeNgl(modelId: string, preferCpu: boolean): Promise<{ ngl: number; note: string }> {
  if (preferCpu) return { ngl: 0, note: 'CPU mode' };
  if (process.platform === 'darwin') return { ngl: 99, note: 'Metal (unified memory): full offload' };

  const prof = await profile();
  const vramMB = prof.cuda?.vramMB;
  if (!prof.cuda?.available || !vramMB || vramMB < 4096) {
    return { ngl: 0, note: 'no usable CUDA VRAM → CPU' };
  }

  const sizeGB = (getComponent(modelId)?.sizeBytes ?? 0) / 1e9;
  const vramGB = vramMB / 1024;
  const HEADROOM_GB = 1.8; // display + KV cache (8K ctx) + compute buffers
  const budget = vramGB - HEADROOM_GB;

  if (sizeGB <= 0) return { ngl: 99, note: 'unknown model size → full offload' };
  if (sizeGB <= budget) {
    return { ngl: 99, note: `full offload (${sizeGB.toFixed(1)}GB ≤ ${budget.toFixed(1)}GB VRAM budget)` };
  }
  const layers = MODEL_LAYERS[modelId] ?? 0;
  if (layers > 0 && budget > 0) {
    const n = Math.max(0, Math.min(layers, Math.floor(layers * (budget / sizeGB))));
    if (n <= 0) return { ngl: 0, note: `${sizeGB.toFixed(1)}GB model too big for ${vramGB.toFixed(0)}GB VRAM → CPU` };
    if (n >= layers) return { ngl: 99, note: 'full offload' };
    return { ngl: n, note: `partial offload ${n}/${layers} layers (${sizeGB.toFixed(1)}GB model, ${vramGB.toFixed(0)}GB VRAM)` };
  }
  return { ngl: 0, note: `${sizeGB.toFixed(1)}GB model exceeds ${vramGB.toFixed(0)}GB VRAM → CPU` };
}

// How long to wait for the server's /health to report ready. Large models on CPU
// can take a while to memory-map and warm up.
const HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_POLL_MS = 500;

interface RunningServer {
  proc: ChildProcess;
  modelId: string;
  port: number;
  baseUrl: string;
  preferCpu: boolean;
  ctxSize: number;
}

let current: RunningServer | null = null;
// Serializes concurrent ensureServer() calls so we never spawn two servers.
let starting: Promise<RunningServer> | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Engine + model resolution
// ─────────────────────────────────────────────────────────────────────────────

/** The llama-server.exe to use, preferring the CUDA build when installed —
 *  unless the caller forces CPU (Settings: "Use CPU for AI"). */
function resolveServerExe(preferCpu = false): { exe: string; cuda: boolean } | null {
  if (!preferCpu) {
    const cuda = resolveEntry(LLAMA_CUDA_ID);
    if (cuda) return { exe: cuda, cuda: true };
  }
  const cpu = resolveEntry(LLAMA_CPU_ID);
  if (cpu) return { exe: cpu, cuda: false };
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Process lifecycle
// ─────────────────────────────────────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('Could not find a free port'))));
    });
  });
}

async function pollHealth(proc: ChildProcess, port: number, timeoutMs: number): Promise<void> {
  const axios = require('axios');
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;

  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`llama-server exited during startup (code ${proc.exitCode})`);
    }
    try {
      const res = await axios.get(`http://127.0.0.1:${port}/health`, {
        timeout: HEALTH_POLL_MS,
        validateStatus: () => true,
      });
      // 200 = ready; 503 = still loading the model.
      if (res.status === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  throw new Error(
    `llama-server did not become ready within ${Math.round(timeoutMs / 1000)}s` +
      (lastErr instanceof Error ? ` (${lastErr.message})` : '')
  );
}

async function startServer(
  modelId: string,
  preferCpu = false,
  // The device the caller asked for — used as the reuse key so a GPU request
  // that fell back to CPU is still reused on the next GPU-mode call.
  requestedCpu = preferCpu,
  ctxSize = MAX_CTX_SIZE,
): Promise<RunningServer> {
  const engine = resolveServerExe(preferCpu);
  if (!engine) {
    throw new Error(
      'The local AI engine is not installed. Download "Local AI Engine (llama.cpp)" in setup.'
    );
  }

  const modelPath = resolveEntry(modelId);
  if (!modelPath) {
    throw new Error(`Local model "${modelId}" is not installed. Download it in setup first.`);
  }

  const port = await findFreePort();
  const args = [
    '--model', modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    // Context window, sized to the prompt (see estimateCtxSize). '0' would use
    // the model's full trained context (131072 for Llama 3.x) → a ~16 GB KV
    // cache that can push a full-offload past VRAM and crash on startup
    // (0xC0000005). Sizing to need keeps the KV cache as small as the job allows.
    '--ctx-size', String(ctxSize),
  ];
  // GPU offload only when the engine can actually do it (a CUDA build on
  // Windows, or any macOS build via Metal). The layer count is sized to VRAM to
  // avoid the full-offload startup crash on cards that can't hold the model.
  const canGpu = engine.cuda || process.platform === 'darwin';
  const { ngl, note } = canGpu ? await computeNgl(modelId, preferCpu) : { ngl: 0, note: 'CPU engine' };
  console.log(`[LLAMA] GPU offload for ${modelId}: -ngl ${ngl} (${note})`);
  if (ngl > 0) {
    args.push('--n-gpu-layers', String(ngl));
  }

  console.log(`[LLAMA] Starting ${engine.cuda ? 'CUDA' : 'CPU'} server: ${modelId} on port ${port} (ctx ${ctxSize})`);

  const engineDir = path.dirname(engine.exe);
  // sibling ggml/cublas/cudart DLLs (Windows) or .dylib files (macOS) must resolve.
  const env = process.platform === 'darwin'
    ? { ...process.env, DYLD_FALLBACK_LIBRARY_PATH: [engineDir, process.env.DYLD_FALLBACK_LIBRARY_PATH].filter(Boolean).join(':') }
    : process.env;
  const proc = spawn(engine.exe, args, {
    cwd: engineDir,
    windowsHide: true,
    env,
  });

  proc.stdout?.on('data', (d) => console.log(`[llama-server] ${String(d).trim()}`));
  proc.stderr?.on('data', (d) => console.log(`[llama-server] ${String(d).trim()}`));

  const server: RunningServer = {
    proc,
    modelId,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    preferCpu: requestedCpu,
    ctxSize,
  };

  // If the process dies, drop our reference so the next call respawns it.
  const onExit = (code: number | null) => {
    console.log(`[LLAMA] server exited (code ${code})`);
    if (current && current.proc === proc) current = null;
  };
  proc.on('exit', onExit);

  // Surface an immediate spawn failure (e.g. missing exe / DLL) instead of
  // hanging on the health poll.
  const spawnError = new Promise<never>((_, reject) => {
    proc.once('error', (err) => reject(new Error(`Failed to launch llama-server: ${err.message}`)));
  });

  current = server;
  try {
    await Promise.race([pollHealth(proc, port, HEALTH_TIMEOUT_MS), spawnError]);
  } catch (err) {
    stop();
    throw err;
  }

  console.log(`[LLAMA] server ready: ${modelId} at ${server.baseUrl}`);
  return server;
}

/** Ensure a server is running for `modelId`, reusing the current one if it
 *  matches and is alive. Returns the running server. */
async function ensureServer(modelId: string, preferCpu = false, needCtx = MAX_CTX_SIZE): Promise<RunningServer> {
  // Reuse only if the running server matches model+device AND already has a big
  // enough context (it's fine to reuse a larger one for a smaller prompt).
  const reusable = (s: RunningServer) =>
    s.modelId === modelId && s.preferCpu === preferCpu && s.ctxSize >= needCtx && s.proc.exitCode === null;

  if (current && reusable(current)) return current;
  if (starting) {
    const s = await starting;
    if (reusable(s)) return s;
  }

  // Different model/device/too-small context (or nothing running): start fresh.
  stop();
  // If a GPU start crashes (e.g. VRAM overflow → 0xC0000005), fall back to CPU
  // once so generation still succeeds instead of surfacing the crash.
  starting = startServer(modelId, preferCpu, preferCpu, needCtx).catch((err) => {
    if (preferCpu) throw err;
    console.warn(`[LLAMA] GPU start failed (${err instanceof Error ? err.message : err}); retrying on CPU`);
    // Force CPU engine, but keep the original (GPU) request as the reuse key.
    return startServer(modelId, true, preferCpu, needCtx);
  });
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/** Stop the running server, if any. Safe to call repeatedly. */
export function stop(): void {
  if (!current) return;
  const { proc } = current;
  current = null;
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generation
// ─────────────────────────────────────────────────────────────────────────────

export interface LocalChatResult {
  text: string;
  modelId: string;
}

/** Run a chat completion against the local engine, starting/switching the server
 *  for `modelId` as needed. */
export async function chat(
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  opts: { maxTokens?: number; temperature?: number; preferCpu?: boolean } = {}
): Promise<LocalChatResult> {
  if (!modelId) {
    throw new Error('No local AI model selected. Choose one in setup or settings.');
  }
  const axios = require('axios');
  const needCtx = estimateCtxSize(systemPrompt, userPrompt, opts.maxTokens);
  const server = await ensureServer(modelId, opts.preferCpu ?? false, needCtx);

  const res = await axios.post(
    `${server.baseUrl}/v1/chat/completions`,
    {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 4000,
      stream: false,
    },
    { timeout: 600_000 } // 10 min — long transcripts on CPU
  );

  const text = res.data?.choices?.[0]?.message?.content ?? '';
  return { text, modelId };
}

/** True if a local engine binary is installed and ready to run models. */
export function isEngineInstalled(): boolean {
  return resolveServerExe() !== null;
}
