/**
 * CUDA acceleration pack for the local-AI engine (llama-server).
 * Ported from bookforge (electron/components/llama-cuda.ts), adapted to copy the
 * VC++ runtime from BoardNotes' bundled utilities/bin.
 *
 * On a Windows machine with an NVIDIA GPU this downloads the CUDA build of
 * llama-server.exe + its CUDA DLLs + the cudart redistributable into
 * userData/components/llama-cuda/. The llama runtime then prefers this GPU binary.
 *
 * Two archives are fetched (the llama.cpp release splits them this way):
 *   - llama-<ver>-bin-win-cuda-<tag>-x64.zip   → llama-server.exe + ggml/cublas
 *   - cudart-llama-bin-win-cuda-<tag>-x64.zip  → cudart64_*.dll, cublas runtime
 * Their contents are flattened side-by-side into the install dir, plus the VC++
 * runtime DLLs copied from the bundled utilities/bin.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { downloadFile, extractArchive, sha256File, findFile } from './downloader';
import type { OptionalComponent, InstallProgress } from './component-types';

// Pins — KEEP IN SYNC with catalog.ts (LLAMA_CPP_VERSION). The CPU and CUDA
// builds must come from the same llama.cpp release.
const LLAMA_CPP_VERSION = 'b7482';
const WIN_CUDA_TAG = '12.4';

const GH_REL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}`;
const OWEN_MIRROR = 'https://owenmorgan.com/bookforge/llama';

const BUILD_ZIP = `llama-${LLAMA_CPP_VERSION}-bin-win-cuda-${WIN_CUDA_TAG}-x64.zip`;
const CUDART_ZIP = `cudart-llama-bin-win-cuda-${WIN_CUDA_TAG}-x64.zip`;

// sha256 of each zip — byte-identical across upstream and the mirror.
const BUILD_SHA256 = '18a52829b58666825fc31563bd10cc9fce793c7668d39710a87898a09cfe2dee';
const CUDART_SHA256 = '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6';

const BUILD_BYTES = 204_029_366;
const CUDART_BYTES = 391_443_627;
const TOTAL_BYTES = BUILD_BYTES + CUDART_BYTES;

export const LLAMA_CUDA_ID = 'llama-cuda';

const VCRUNTIME_DLLS = [
  'MSVCP140.dll',
  'MSVCP140_CODECVT_IDS.dll',
  'VCRUNTIME140.dll',
  'VCRUNTIME140_1.dll',
];

function sourcesFor(fileName: string): string[] {
  return [`${GH_REL}/${fileName}`, `${OWEN_MIRROR}/${fileName}`];
}

function expectedSha(fileName: string): string {
  if (fileName === BUILD_ZIP) return BUILD_SHA256;
  if (fileName === CUDART_ZIP) return CUDART_SHA256;
  return '';
}

export function llamaCudaComponent(): OptionalComponent {
  return {
    id: LLAMA_CUDA_ID,
    name: 'GPU Acceleration (CUDA)',
    description:
      'Uses your NVIDIA graphics card to run local AI models much faster than the CPU. ~570 MB download (~1 GB on disk). Windows + NVIDIA only.',
    category: 'accelerator',
    sizeBytes: TOTAL_BYTES,
    requirements: { platforms: ['win32'], gpu: 'cuda', minDiskMB: 1100 },
    artifacts: [
      {
        platform: 'win32',
        arch: 'x64',
        gpu: 'cuda',
        kind: 'archive',
        url: `${GH_REL}/${BUILD_ZIP}`,
        sha256: BUILD_SHA256,
        bytes: TOTAL_BYTES,
      },
    ],
    entryPath: 'llama-server.exe',
    version: LLAMA_CPP_VERSION,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VC++ runtime — copied from BoardNotes' bundled utilities/bin
// ─────────────────────────────────────────────────────────────────────────────

/** Locate the bundled utilities/bin dir (dev or packaged), or null. */
function bundledBinDir(): string | null {
  const resourcesPath = (process as any).resourcesPath || '';
  const roots = [
    path.join(resourcesPath, 'utilities', 'bin'),
    // dist/src/components → project root
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
    console.warn('[COMPONENTS] llama-cuda: bundled utilities/bin not found; VC++ runtime not copied');
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
      console.warn(`[COMPONENTS] llama-cuda: could not copy ${dll}:`, err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Download + extract
// ─────────────────────────────────────────────────────────────────────────────

async function downloadZipWithFallback(
  fileName: string,
  archivePath: string,
  priorBytes: number,
  emit: (p: InstallProgress) => void,
  signal: AbortSignal
): Promise<void> {
  const onProgress = (p: InstallProgress) => {
    const global = priorBytes + (p.receivedBytes ?? 0);
    emit({
      id: LLAMA_CUDA_ID,
      phase: 'download',
      pct: Math.min(100, Math.round((global / TOTAL_BYTES) * 100)),
      receivedBytes: global,
      totalBytes: TOTAL_BYTES,
      message: 'Downloading GPU acceleration…',
    });
  };

  const want = expectedSha(fileName);
  let lastErr: unknown = null;

  for (const url of sourcesFor(fileName)) {
    if (signal.aborted) throw new Error('Install cancelled');
    try {
      await downloadFile(url, archivePath, LLAMA_CUDA_ID, onProgress, signal);
      if (want) {
        const got = await sha256File(archivePath);
        if (got.toLowerCase() !== want.toLowerCase()) {
          throw new Error(`checksum mismatch (expected ${want}, got ${got})`);
        }
      }
      return;
    } catch (err) {
      if (signal.aborted) throw err;
      lastErr = err;
      console.warn(
        `[COMPONENTS] llama-cuda: ${url} failed (${err instanceof Error ? err.message : err}); trying next source`
      );
    }
  }
  throw new Error(
    `All download sources failed for ${fileName}: ${lastErr instanceof Error ? lastErr.message : lastErr}`
  );
}

/** Fetch the CUDA build + cudart zips, extract, and flatten llama-server.exe +
 *  every CUDA/ggml DLL + the cudart runtime + the bundled VC++ runtime into
 *  destDir. Throws on failure or if the server exe is missing afterwards. */
export async function downloadLlamaCudaInto(
  destDir: string,
  emit: (p: InstallProgress) => void,
  signal: AbortSignal
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boardnotes-llama-cuda-'));

  try {
    // 1. CUDA build zip → llama-server.exe + ggml/cublas DLLs
    const buildZip = path.join(tmp, BUILD_ZIP);
    await downloadZipWithFallback(BUILD_ZIP, buildZip, 0, emit, signal);
    if (signal.aborted) throw new Error('Install cancelled');

    emit({ id: LLAMA_CUDA_ID, phase: 'extract', pct: 0, message: 'Extracting GPU engine…' });
    const buildDir = path.join(tmp, 'build');
    await extractArchive(buildZip, buildDir, BUILD_ZIP);
    const serverSrc = findFile(buildDir, (f) => f.toLowerCase() === 'llama-server.exe');
    if (!serverSrc) throw new Error('llama-server.exe not found in the CUDA build archive');
    const buildBinDir = path.dirname(serverSrc);
    fs.copyFileSync(serverSrc, path.join(destDir, 'llama-server.exe'));
    copyDlls(buildBinDir, destDir);

    // 2. cudart redistributable → cudart64_*.dll + cublas runtime
    const cudartZip = path.join(tmp, CUDART_ZIP);
    await downloadZipWithFallback(CUDART_ZIP, cudartZip, BUILD_BYTES, emit, signal);
    if (signal.aborted) throw new Error('Install cancelled');

    emit({ id: LLAMA_CUDA_ID, phase: 'extract', pct: 50, message: 'Extracting CUDA runtime…' });
    const cudartDir = path.join(tmp, 'cudart');
    await extractArchive(cudartZip, cudartDir, CUDART_ZIP);
    const cudartDll = findFile(cudartDir, (f) => f.toLowerCase().endsWith('.dll'));
    copyDlls(cudartDll ? path.dirname(cudartDll) : cudartDir, destDir);

    // 3. VC++ runtime from the bundled utilities/bin
    copyBundledVcRuntime(destDir);
    emit({ id: LLAMA_CUDA_ID, phase: 'extract', pct: 100, message: 'Extracted' });

    if (!fs.existsSync(path.join(destDir, 'llama-server.exe'))) {
      throw new Error('llama-server.exe missing after extraction');
    }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
