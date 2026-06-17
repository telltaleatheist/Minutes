/**
 * Component Catalog — the components BoardNotes can download, verify, and resolve.
 * Ships in-app (later remote-fetchable). Sizes are approximate (UI + disk gate);
 * sha256 is left empty for now (verification is skipped with a warning until the
 * hashes are pinned).
 */

import { llamaCudaComponent } from './llama-cuda';
import type { OptionalComponent } from './component-types';

const MB = 1024 * 1024;
const diskFor = (bytes: number) => Math.ceil((bytes * 1.3) / MB); // download + extracted/runtime headroom

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
  { id: 'whisper-medium', name: 'Whisper Medium', model: 'medium', bytes: 1_533_000_000, description: 'Higher accuracy, noticeably slower on CPU.' },
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
    artifacts: [
      {
        platform: 'win32',
        arch: 'x64',
        kind: 'file',
        url: `${WHISPER_BASE_URL}/ggml-${w.model}.bin`,
        sha256: '',
        bytes: w.bytes,
        fileName: `ggml-${w.model}.bin`,
      },
    ],
    entryPath: `ggml-${w.model}.bin`,
    version: 'whisper.cpp',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// ffmpeg — extracts audio from video and normalizes to 16 kHz mono WAV for whisper
// ─────────────────────────────────────────────────────────────────────────────

const ffmpeg: OptionalComponent = {
  id: 'ffmpeg',
  name: 'FFmpeg',
  description:
    'Extracts audio from video and converts any input to the 16 kHz mono WAV whisper needs. Required for video and most compressed audio.',
  category: 'tool',
  required: true,
  sizeBytes: 90_000_000,
  requirements: { platforms: ['win32'], gpu: 'none', minDiskMB: diskFor(90_000_000) },
  artifacts: [
    {
      platform: 'win32',
      arch: 'x64',
      kind: 'archive',
      // BtbN publishes a rolling "latest" GPL build; ffmpeg.exe sits in bin/.
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
      sha256: '',
      bytes: 90_000_000,
    },
  ],
  entryPath: 'ffmpeg.exe', // nested under .../bin/ — manager records the real path
  version: 'latest',
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
  required: true,
  sizeBytes: 45_000_000,
  requirements: { platforms: ['win32'], gpu: 'none', minDiskMB: diskFor(45_000_000) },
  artifacts: [
    {
      platform: 'win32',
      arch: 'x64',
      kind: 'archive',
      url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}/llama-${LLAMA_CPP_VERSION}-bin-win-cpu-x64.zip`,
      sha256: '',
      bytes: 45_000_000,
    },
  ],
  entryPath: 'llama-server.exe',
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
    artifacts: [
      {
        platform: 'win32',
        arch: 'x64',
        kind: 'file',
        url: `${HF_BASE}/${a.repo}/resolve/main/${a.file}`,
        sha256: '',
        bytes: a.bytes,
        fileName: `${a.id}.gguf`,
      },
    ],
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
    llama,
    ...aiComponents(),
    llamaCudaComponent(),
  ];
}

export function getComponent(id: string): OptionalComponent | undefined {
  return getCatalog().find((c) => c.id === id);
}
