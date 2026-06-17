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

const LLAMA_CPU_ID = 'llama';

// How long to wait for the server's /health to report ready. Large models on CPU
// can take a while to memory-map and warm up.
const HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_POLL_MS = 500;

interface RunningServer {
  proc: ChildProcess;
  modelId: string;
  port: number;
  baseUrl: string;
}

let current: RunningServer | null = null;
// Serializes concurrent ensureServer() calls so we never spawn two servers.
let starting: Promise<RunningServer> | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Engine + model resolution
// ─────────────────────────────────────────────────────────────────────────────

/** The llama-server.exe to use, preferring the CUDA build when installed. */
function resolveServerExe(): { exe: string; cuda: boolean } | null {
  const cuda = resolveEntry(LLAMA_CUDA_ID);
  if (cuda) return { exe: cuda, cuda: true };
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

async function startServer(modelId: string): Promise<RunningServer> {
  const engine = resolveServerExe();
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
    '--ctx-size', '0', // use the model's trained context length
  ];
  if (engine.cuda) {
    args.push('--n-gpu-layers', '99'); // offload all layers to the GPU
  }

  console.log(`[LLAMA] Starting ${engine.cuda ? 'CUDA' : 'CPU'} server: ${modelId} on port ${port}`);

  const proc = spawn(engine.exe, args, {
    cwd: path.dirname(engine.exe), // sibling ggml/cublas/cudart DLLs must resolve
    windowsHide: true,
  });

  proc.stdout?.on('data', (d) => console.log(`[llama-server] ${String(d).trim()}`));
  proc.stderr?.on('data', (d) => console.log(`[llama-server] ${String(d).trim()}`));

  const server: RunningServer = {
    proc,
    modelId,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
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
async function ensureServer(modelId: string): Promise<RunningServer> {
  if (current && current.modelId === modelId && current.proc.exitCode === null) {
    return current;
  }
  if (starting) {
    const s = await starting;
    if (s.modelId === modelId && s.proc.exitCode === null) return s;
  }

  // Different model (or nothing running): stop the old one, start fresh.
  stop();
  starting = startServer(modelId);
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
  opts: { maxTokens?: number; temperature?: number } = {}
): Promise<LocalChatResult> {
  if (!modelId) {
    throw new Error('No local AI model selected. Choose one in setup or settings.');
  }
  const axios = require('axios');
  const server = await ensureServer(modelId);

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
