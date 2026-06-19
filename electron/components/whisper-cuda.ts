/**
 * CUDA acceleration pack for the transcription engine (whisper-cli).
 * Models on llama-cuda.ts, but whisper.cpp ships a single self-contained cuBLAS
 * archive (it bundles the CUDA runtime DLLs), so there's no separate cudart zip.
 *
 * On a Windows machine with an NVIDIA GPU this downloads the cuBLAS build of
 * whisper-cli.exe + ggml-cuda.dll + the CUDA runtime (cublas/cudart/nvrtc) into
 * userData/components/whisper-cuda/. The transcription path then prefers this
 * GPU binary when the user selects GPU mode in Settings.
 *
 * The archive lacks the VC++ runtime, so (as with llama-cuda) we copy the VC++
 * DLLs from the bundled utilities/bin alongside the binary.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { downloadFile, extractArchive, sha256File, findFile } from './downloader';
import type { OptionalComponent, InstallProgress } from './component-types';

// Pinned to a whisper.cpp release that publishes a CUDA 12.4 Windows build.
// Models are format-stable across versions, so this need not match the CPU build.
const WHISPER_CPP_VERSION = 'v1.9.0';
const WIN_CUDA_TAG = '12.4.0';

const GH_REL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_VERSION}`;
// Mirror on this repo's own release for resilience (see llama-cuda's pattern).
const MINUTES_MIRROR = 'https://github.com/telltaleatheist/Minutes/releases/download/binaries-v1';

const BUILD_ZIP = `whisper-cublas-${WIN_CUDA_TAG}-bin-x64.zip`;
const BUILD_SHA256 = '9c18e266aa428f643462485f2d45223320480b5fd09b320bb7fc5b9c7fda4e92';
const BUILD_BYTES = 461_124_610;

export const WHISPER_CUDA_ID = 'whisper-cuda';

const VCRUNTIME_DLLS = [
  'MSVCP140.dll',
  'MSVCP140_CODECVT_IDS.dll',
  'VCRUNTIME140.dll',
  'VCRUNTIME140_1.dll',
];

function sourcesFor(fileName: string): string[] {
  return [`${GH_REL}/${fileName}`, `${MINUTES_MIRROR}/${fileName}`];
}

export function whisperCudaComponent(): OptionalComponent {
  return {
    id: WHISPER_CUDA_ID,
    name: 'Faster Transcription (CUDA)',
    description:
      'Uses your NVIDIA graphics card to transcribe audio much faster than the processor, especially with the larger Whisper models. ~440 MB download (~1 GB on disk). Windows + NVIDIA only.',
    category: 'accelerator',
    sizeBytes: BUILD_BYTES,
    requirements: { platforms: ['win32'], gpu: 'cuda', minDiskMB: 1100 },
    artifacts: [
      {
        platform: 'win32',
        arch: 'x64',
        gpu: 'cuda',
        kind: 'archive',
        url: `${GH_REL}/${BUILD_ZIP}`,
        sha256: BUILD_SHA256,
        bytes: BUILD_BYTES,
      },
    ],
    entryPath: 'whisper-cli.exe',
    version: WHISPER_CPP_VERSION,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VC++ runtime — copied from the bundled utilities/bin (same as llama-cuda)
// ─────────────────────────────────────────────────────────────────────────────

/** Locate the bundled utilities/bin dir (dev or packaged), or null. */
function bundledBinDir(): string | null {
  const resourcesPath = (process as any).resourcesPath || '';
  const roots = [
    path.join(resourcesPath, 'utilities', 'bin'),
    // dist/electron/components → project root
    path.join(__dirname, '..', '..', '..', 'utilities', 'bin'),
  ];
  for (const root of roots) {
    try {
      if (fs.existsSync(root)) return root;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function copyDlls(srcDir: string, destDir: string): number {
  let n = 0;
  for (const f of fs.readdirSync(srcDir)) {
    if (f.toLowerCase().endsWith('.dll')) {
      fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f));
      n++;
    }
  }
  return n;
}

function copyBundledVcRuntime(destDir: string): void {
  const binDir = bundledBinDir();
  if (!binDir) {
    console.warn('[COMPONENTS] whisper-cuda: bundled utilities/bin not found; VC++ runtime not copied');
    return;
  }
  for (const dll of VCRUNTIME_DLLS) {
    const src = path.join(binDir, dll);
    const dest = path.join(destDir, dll);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
      }
    } catch (err) {
      console.warn(`[COMPONENTS] whisper-cuda: could not copy ${dll}:`, err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Download + extract
// ─────────────────────────────────────────────────────────────────────────────

async function downloadZipWithFallback(
  fileName: string,
  archivePath: string,
  emit: (p: InstallProgress) => void,
  signal: AbortSignal
): Promise<void> {
  const onProgress = (p: InstallProgress) => {
    emit({
      id: WHISPER_CUDA_ID,
      phase: 'download',
      pct: Math.min(100, Math.round(((p.receivedBytes ?? 0) / BUILD_BYTES) * 100)),
      receivedBytes: p.receivedBytes ?? 0,
      totalBytes: BUILD_BYTES,
      message: 'Downloading GPU transcription…',
    });
  };

  let lastErr: unknown = null;
  for (const url of sourcesFor(fileName)) {
    if (signal.aborted) throw new Error('Install cancelled');
    try {
      await downloadFile(url, archivePath, WHISPER_CUDA_ID, onProgress, signal);
      const got = await sha256File(archivePath);
      if (got.toLowerCase() !== BUILD_SHA256.toLowerCase()) {
        throw new Error(`checksum mismatch (expected ${BUILD_SHA256}, got ${got})`);
      }
      return;
    } catch (err) {
      if (signal.aborted) throw err;
      lastErr = err;
      console.warn(
        `[COMPONENTS] whisper-cuda: ${url} failed (${err instanceof Error ? err.message : err}); trying next source`
      );
    }
  }
  throw new Error(
    `All download sources failed for ${fileName}: ${lastErr instanceof Error ? lastErr.message : lastErr}`
  );
}

/** Fetch the cuBLAS build zip, extract, and flatten whisper-cli.exe + every
 *  CUDA/ggml DLL + the bundled VC++ runtime into destDir. Throws on failure or
 *  if the CLI is missing afterwards. */
export async function downloadWhisperCudaInto(
  destDir: string,
  emit: (p: InstallProgress) => void,
  signal: AbortSignal
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minutes-whisper-cuda-'));

  try {
    const buildZip = path.join(tmp, BUILD_ZIP);
    await downloadZipWithFallback(BUILD_ZIP, buildZip, emit, signal);
    if (signal.aborted) throw new Error('Install cancelled');

    emit({ id: WHISPER_CUDA_ID, phase: 'extract', pct: 0, message: 'Extracting GPU engine…' });
    const buildDir = path.join(tmp, 'build');
    await extractArchive(buildZip, buildDir, BUILD_ZIP);

    // whisper-cli.exe is nested under Release/; copy it and every sibling DLL.
    const cliSrc = findFile(buildDir, (f) => f.toLowerCase() === 'whisper-cli.exe');
    if (!cliSrc) throw new Error('whisper-cli.exe not found in the cuBLAS build archive');
    const cliBinDir = path.dirname(cliSrc);
    fs.copyFileSync(cliSrc, path.join(destDir, 'whisper-cli.exe'));
    copyDlls(cliBinDir, destDir);

    // VC++ runtime from the bundled utilities/bin (archive doesn't include it).
    copyBundledVcRuntime(destDir);
    emit({ id: WHISPER_CUDA_ID, phase: 'extract', pct: 100, message: 'Extracted' });

    if (!fs.existsSync(path.join(destDir, 'whisper-cli.exe'))) {
      throw new Error('whisper-cli.exe missing after extraction');
    }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
