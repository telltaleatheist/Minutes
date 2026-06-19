/**
 * Component Catalog — the components BoardNotes can download, verify, and resolve.
 * Ships in-app (later remote-fetchable). Sizes are approximate (UI + disk gate);
 * sha256 is left empty for now (verification is skipped with a warning until the
 * hashes are pinned).
 */

import { llamaCudaComponent } from './llama-cuda';
import { whisperCudaComponent } from './whisper-cuda';
import type { OptionalComponent } from './component-types';

const MB = 1024 * 1024;
const diskFor = (bytes: number) => Math.ceil((bytes * 1.3) / MB); // download + extracted/runtime headroom

const IS_WIN = process.platform === 'win32';
const PLATFORM = process.platform as 'win32' | 'darwin' | 'linux';

// Prebuilt native tool binaries (ffmpeg + ffprobe, the whisper.cpp engine, and the
// llama.cpp server) are published as per-platform archives on this repo's own
// release and downloaded into userData/components/ on first run (or whenever
// they're missing). sha256 is pinned to the published artifacts; the per-artifact
// `entry` names the executable inside each archive (its name varies by platform/arch).
const BINARIES_BASE =
  'https://github.com/telltaleatheist/Minutes/releases/download/binaries-v1';

// ─────────────────────────────────────────────────────────────────────────────
// Whisper transcription models — raw ggml .bin files from the whisper.cpp repo
// ─────────────────────────────────────────────────────────────────────────────

const WHISPER_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

interface WhisperSpec {
  id: string;
  name: string;
  model: string; // ggml-<model>.bin
  bytes: number;
  description: string;
  recommended?: boolean;
}

const WHISPER_SPECS: WhisperSpec[] = [
  { id: 'whisper-tiny', name: 'Whisper Tiny', model: 'tiny', bytes: 77_700_000, description: 'Fastest, lowest accuracy. Good for quick drafts.' },
  { id: 'whisper-base', name: 'Whisper Base', model: 'base', bytes: 147_951_465, description: 'Fast, modest accuracy.' },
  { id: 'whisper-small', name: 'Whisper Small', model: 'small', bytes: 487_601_967, description: 'Balanced speed and accuracy. Recommended default.', recommended: true },
  { id: 'whisper-medium', name: 'Whisper Medium', model: 'medium', bytes: 1_533_763_059, description: 'Higher accuracy, noticeably slower on CPU.' },
  { id: 'whisper-large-v3', name: 'Whisper Large v3', model: 'large-v3', bytes: 3_095_000_000, description: 'Best accuracy, heavy. Practical mainly with a GPU.' },
];

function whisperComponents(): OptionalComponent[] {
  return WHISPER_SPECS.map((w) => ({
    id: w.id,
    name: w.name,
    description: w.description,
    category: 'whisper',
    sizeBytes: w.bytes,
    recommended: w.recommended,
    requirements: { gpu: 'none', minDiskMB: diskFor(w.bytes) },
    // The ggml .bin model files are platform-neutral; offer them on every OS/arch.
    artifacts: ([
      { platform: 'win32', arch: 'x64' },
      { platform: 'darwin', arch: 'arm64' },
      { platform: 'darwin', arch: 'x64' },
      { platform: 'linux', arch: 'x64' },
    ] as const).map((p) => ({
      platform: p.platform,
      arch: p.arch,
      kind: 'file' as const,
      url: `${WHISPER_BASE_URL}/ggml-${w.model}.bin`,
      sha256: '',
      bytes: w.bytes,
      fileName: `ggml-${w.model}.bin`,
    })),
    entryPath: `ggml-${w.model}.bin`,
    version: 'whisper.cpp',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// ffmpeg — extracts audio from video and normalizes to 16 kHz mono WAV for whisper
// ─────────────────────────────────────────────────────────────────────────────

const ffmpeg: OptionalComponent = {
  id: 'ffmpeg',
  name: 'FFmpeg & FFprobe',
  description:
    'Extracts audio from video and converts any input to the 16 kHz mono WAV whisper needs. Required for video and most compressed audio.',
  category: 'tool',
  // Downloadable on Windows and macOS; on Linux we fall back to a system ffmpeg,
  // so it isn't required there and doesn't gate setup.
  required: PLATFORM === 'win32' || PLATFORM === 'darwin',
  sizeBytes: 47_474_181,
  requirements: { platforms: ['win32', 'darwin'], gpu: 'none', minDiskMB: diskFor(47_474_181) },
  artifacts: [
    {
      platform: 'darwin',
      arch: 'arm64',
      kind: 'archive',
      url: `${BINARIES_BASE}/ffmpeg-tools-darwin-arm64.tar.gz`,
      sha256: '802d14109e0ac0dc37c06cb9c95db8e0e69c848f9e911b2f6b093c752c09aa84',
      bytes: 24_148_420,
      entry: 'ffmpeg',
    },
    {
      platform: 'darwin',
      arch: 'x64',
      kind: 'archive',
      url: `${BINARIES_BASE}/ffmpeg-tools-darwin-x64.tar.gz`,
      sha256: 'aa3f9be5d07e00e95e526af48cc8a41f8deff3bf9ba15b76d23387847a2e61f5',
      bytes: 47_474_181,
      entry: 'ffmpeg',
    },
    {
      platform: 'win32',
      arch: 'x64',
      kind: 'archive',
      url: `${BINARIES_BASE}/ffmpeg-tools-win32-x64.zip`,
      sha256: '041a4a887ac47ba9e2713e3b3b48df7041471ade0d31e79daad1be8f7b0dd989',
      bytes: 51_174_807,
      entry: 'ffmpeg.exe',
    },
  ],
  // Fallback only; each artifact's `entry` names the real binary inside its archive.
  entryPath: IS_WIN ? 'ffmpeg.exe' : 'ffmpeg',
  version: 'binaries-v1',
};

// ─────────────────────────────────────────────────────────────────────────────
// whisper.cpp engine — the CLI that turns audio into text on-device. Downloaded
// on first run on both Windows and macOS (the Windows archive bundles the ggml
// DLLs and the VC++ runtime alongside whisper-cli.exe); on Linux we fall back to
// a system whisper.cpp.
// ─────────────────────────────────────────────────────────────────────────────

const whisperEngine: OptionalComponent = {
  id: 'whisper',
  name: 'Whisper (speech-to-text engine)',
  description:
    'The whisper.cpp engine that transcribes audio to text on-device. Required to transcribe.',
  category: 'tool',
  required: PLATFORM === 'win32' || PLATFORM === 'darwin',
  sizeBytes: 1_982_464,
  requirements: { platforms: ['win32', 'darwin'], gpu: 'none', minDiskMB: diskFor(1_982_464) },
  artifacts: [
    {
      platform: 'darwin',
      arch: 'arm64',
      kind: 'archive',
      url: `${BINARIES_BASE}/whisper-darwin-arm64.tar.gz`,
      sha256: '8562cb5f1e0329a8ec69b173576e265d52551fd46b880000c784544a62afaf7d',
      bytes: 864_993,
      entry: 'whisper-cli-arm64',
    },
    {
      platform: 'darwin',
      arch: 'x64',
      kind: 'archive',
      url: `${BINARIES_BASE}/whisper-darwin-x64.tar.gz`,
      sha256: 'acad8080ffa3a3d0f8b2ce47eaa0f91f8dbeec9e271872867e96250901d1b908',
      bytes: 1_160_425,
      entry: 'whisper-cli-x64',
    },
    {
      platform: 'win32',
      arch: 'x64',
      kind: 'archive',
      url: `${BINARIES_BASE}/whisper-win32-x64.zip`,
      sha256: '703dbf6419dd4273b2e60ac72cf4980d2be72b4d4338401e5241451a20af420e',
      bytes: 1_982_464,
      entry: 'whisper-cli.exe',
    },
  ],
  entryPath: IS_WIN ? 'whisper-cli.exe' : 'whisper-cli',
  version: 'binaries-v1',
};

// ─────────────────────────────────────────────────────────────────────────────
// Local AI engine — llama.cpp CPU server (OpenAI-compatible endpoint)
// Pins KEPT IN SYNC with llama-cuda.ts so the CPU and CUDA builds match.
// ─────────────────────────────────────────────────────────────────────────────

const LLAMA_CPP_VERSION = 'b7482';

const llama: OptionalComponent = {
  id: 'llama',
  name: 'Local AI Engine (llama.cpp)',
  description:
    'Runs downloaded AI models on-device via llama-server (OpenAI-compatible). Required to use any local AI model. CPU build — pairs with the optional CUDA accelerator.',
  category: 'tool',
  // Required on Windows (no system fallback there); optional on macOS, where
  // Ollama and the Claude / OpenAI APIs are also available.
  required: IS_WIN,
  sizeBytes: 45_000_000,
  requirements: { platforms: ['win32', 'darwin'], gpu: 'none', minDiskMB: diskFor(45_000_000) },
  artifacts: [
    {
      platform: 'darwin',
      arch: 'arm64',
      kind: 'archive',
      url: `${BINARIES_BASE}/llama-darwin-arm64.tar.gz`,
      sha256: '973966715f3e1a89432b768ce5c1c6f542352aead14921c2b43807a490be8381',
      bytes: 4_857_599,
      entry: 'llama-server-arm64',
    },
    {
      platform: 'darwin',
      arch: 'x64',
      kind: 'archive',
      url: `${BINARIES_BASE}/llama-darwin-x64.tar.gz`,
      sha256: '84ae70b693253a3e244e10adc68728d4649a4873274106c8754b5f7c486b0b40',
      bytes: 5_012_902,
      entry: 'llama-server-x64',
    },
    {
      platform: 'win32',
      arch: 'x64',
      kind: 'archive',
      // Windows keeps the ggml-org CPU build pinned to LLAMA_CPP_VERSION so it
      // stays in lockstep with the CUDA accelerator (llama-cuda.ts).
      url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}/llama-${LLAMA_CPP_VERSION}-bin-win-cpu-x64.zip`,
      sha256: '',
      bytes: 45_000_000,
      entry: 'llama-server.exe',
    },
  ],
  entryPath: IS_WIN ? 'llama-server.exe' : 'llama-server',
  version: LLAMA_CPP_VERSION,
};

// ─────────────────────────────────────────────────────────────────────────────
// AI models — Cogito v1 preview GGUF (local, via llama.cpp). Q4_K_M quants from
// bartowski on HuggingFace, the common source for GGUF builds. Note the 14B is
// Qwen-based; the 3B/8B are Llama-based. Saved locally as <id>.gguf so entryPath
// stays simple. sha256 left empty until pinned.
// ─────────────────────────────────────────────────────────────────────────────

interface AiSpec {
  id: string;
  name: string;
  repo: string; // HuggingFace GGUF repo
  file: string; // exact Q4_K_M filename in that repo
  bytes: number;
  minRamMB: number;
  description: string;
  recommended?: boolean;
}

const AI_SPECS: AiSpec[] = [
  {
    id: 'cogito-3b',
    name: 'Cogito 3B',
    repo: 'bartowski/deepcogito_cogito-v1-preview-llama-3B-GGUF',
    file: 'deepcogito_cogito-v1-preview-llama-3B-Q4_K_M.gguf',
    bytes: 2_240_000_000,
    minRamMB: 6000,
    description: 'Smallest Cogito (Llama-based). Fast on CPU, good enough for structured notes. Recommended default.',
    recommended: true,
  },
  {
    id: 'cogito-8b',
    name: 'Cogito 8B',
    repo: 'bartowski/deepcogito_cogito-v1-preview-llama-8B-GGUF',
    file: 'deepcogito_cogito-v1-preview-llama-8B-Q4_K_M.gguf',
    bytes: 4_920_000_000,
    minRamMB: 10000,
    description: 'Better quality (Llama-based), slower on CPU. Great with the CUDA accelerator.',
  },
  {
    id: 'cogito-14b',
    name: 'Cogito 14B',
    repo: 'bartowski/deepcogito_cogito-v1-preview-qwen-14B-GGUF',
    file: 'deepcogito_cogito-v1-preview-qwen-14B-Q4_K_M.gguf',
    bytes: 8_990_000_000,
    minRamMB: 16000,
    description: 'Highest quality of the three (Qwen-based); wants a GPU or lots of RAM.',
  },
];

const HF_BASE = 'https://huggingface.co';

function aiComponents(): OptionalComponent[] {
  return AI_SPECS.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    category: 'ai',
    sizeBytes: a.bytes,
    recommended: a.recommended,
    requirements: { gpu: 'none', minRamMB: a.minRamMB, minDiskMB: diskFor(a.bytes) },
    // GGUF model files are platform-neutral (served from HuggingFace); offer them
    // on every OS/arch, same as the whisper .bin models. llama-server runs them on
    // CPU everywhere and on Metal (macOS) / CUDA (Windows) when GPU mode is on.
    artifacts: ([
      { platform: 'win32', arch: 'x64' },
      { platform: 'darwin', arch: 'arm64' },
      { platform: 'darwin', arch: 'x64' },
      { platform: 'linux', arch: 'x64' },
    ] as const).map((p) => ({
      platform: p.platform,
      arch: p.arch,
      kind: 'file' as const,
      url: `${HF_BASE}/${a.repo}/resolve/main/${a.file}`,
      sha256: '',
      bytes: a.bytes,
      fileName: `${a.id}.gguf`,
    })),
    entryPath: `${a.id}.gguf`,
    version: 'cogito-v1-preview',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

export function getCatalog(): OptionalComponent[] {
  return [
    ...whisperComponents(),
    ffmpeg,
    whisperEngine,
    llama,
    ...aiComponents(),
    whisperCudaComponent(),
    llamaCudaComponent(),
  ];
}

export function getComponent(id: string): OptionalComponent | undefined {
  return getCatalog().find((c) => c.id === id);
}
