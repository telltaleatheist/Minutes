/**
 * System Probe — detect machine capabilities and evaluate component compatibility.
 * Ported from bookforge (electron/components/system-probe.ts), trimmed of the
 * conda-env and WSL specifics BoardNotes doesn't need.
 *
 * Detects platform/arch, Apple Silicon, CUDA (+ VRAM via nvidia-smi), RAM, and
 * free disk on the userData volume. `evaluate()` is a pure compatibility check.
 */

import * as os from 'os';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { app } from 'electron';

import type {
  SystemProfile,
  CudaInfo,
  OptionalComponent,
  Compatibility,
  Platform,
  Arch,
} from './component-types';

let cachedProfile: SystemProfile | null = null;

// Sentinel for "couldn't measure disk" — skips the disk gate rather than failing it.
const DISK_SENTINEL_MB = Number.MAX_SAFE_INTEGER;

function normalizePlatform(): Platform {
  const p = os.platform();
  if (p === 'darwin' || p === 'win32' || p === 'linux') return p;
  return 'linux';
}

function normalizeArch(): Arch {
  return os.arch() === 'arm64' ? 'arm64' : 'x64';
}

/** Run a command and return trimmed stdout, or null on error/timeout. Async so it
 *  never blocks the main event loop (nvidia-smi can take seconds). */
function runCmd(cmd: string, args: string[], timeoutMs = 10000): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (v: string | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const child = spawn(cmd, args, { windowsHide: true });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        done(null);
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => chunks.push(d));
      child.on('error', () => {
        clearTimeout(timer);
        done(null);
      });
      child.on('close', () => {
        clearTimeout(timer);
        const s = Buffer.concat(chunks).toString('utf8').trim();
        done(s || null);
      });
    } catch {
      done(null);
    }
  });
}

/** Detect a CUDA GPU via nvidia-smi (Windows/Linux). Returns name + VRAM (MB). */
async function detectCuda(platform: Platform): Promise<CudaInfo> {
  if (platform === 'darwin') return { available: false };
  const out = await runCmd('nvidia-smi', [
    '--query-gpu=name,memory.total',
    '--format=csv,noheader,nounits',
  ]);
  if (!out) return { available: false };
  // One GPU per line: "NVIDIA GeForce RTX 4090, 24564"
  const firstLine = out.split('\n')[0].trim();
  const parts = firstLine.split(',').map((s) => s.trim());
  const name = parts[0] || undefined;
  const vramMB = parts[1] ? parseInt(parts[1], 10) : undefined;
  return { available: true, name, vramMB: Number.isFinite(vramMB as number) ? vramMB : undefined };
}

/** Free disk space (MB) on the userData volume. Best-effort. */
async function detectFreeDiskMB(): Promise<number> {
  let userDataPath = '';
  try {
    userDataPath = app.getPath('userData');
  } catch {
    /* fall back below */
  }
  for (const p of [userDataPath, os.homedir()]) {
    if (!p) continue;
    try {
      const st = await (fs.promises as any).statfs(p);
      return Math.round((st.bavail * st.bsize) / 1024 / 1024);
    } catch {
      /* try the next candidate */
    }
  }
  console.warn('[COMPONENTS] Free-disk detection failed; skipping disk gate');
  return DISK_SENTINEL_MB;
}

export async function profile(force?: boolean): Promise<SystemProfile> {
  if (cachedProfile && !force) return cachedProfile;

  const platform = normalizePlatform();
  const arch = normalizeArch();
  const appleSilicon = platform === 'darwin' && arch === 'arm64';
  const ramMB = Math.round(os.totalmem() / 1024 / 1024);

  // Run the (potentially slow) external probes concurrently and off the event loop.
  const [cuda, freeDiskMB] = await Promise.all([detectCuda(platform), detectFreeDiskMB()]);

  const prof: SystemProfile = { platform, arch, appleSilicon, cuda, ramMB, freeDiskMB };

  console.log(
    `[COMPONENTS] System profile: ${platform}/${arch}` +
      `${appleSilicon ? ' (Apple Silicon)' : ''}` +
      `, CUDA=${cuda.available ? `${cuda.name ?? 'yes'} ${cuda.vramMB ?? '?'}MB` : 'no'}` +
      `, RAM=${ramMB}MB, freeDisk=${freeDiskMB === DISK_SENTINEL_MB ? 'unknown' : `${freeDiskMB}MB`}`
  );

  cachedProfile = prof;
  return prof;
}

/** Pure compatibility check of a component against a system profile. */
export function evaluate(component: OptionalComponent, prof: SystemProfile): Compatibility {
  const reasons: string[] = [];
  let degraded = false;
  const req = component.requirements || {};

  // 1. Platform exclusion.
  if (req.platforms && req.platforms.length > 0 && !req.platforms.includes(prof.platform)) {
    reasons.push(`Not available on ${prof.platform}.`);
    return { compatible: false, reasons };
  }

  // 2. GPU requirement.
  const gpu = req.gpu ?? 'none';
  if (gpu === 'apple-silicon') {
    if (!prof.appleSilicon) {
      reasons.push('Requires Apple Silicon (arm64 Mac).');
      return { compatible: false, reasons };
    }
  } else if (gpu === 'cuda') {
    if (!prof.cuda.available) {
      reasons.push(
        prof.appleSilicon
          ? 'For NVIDIA CUDA GPUs only — not needed on Apple Silicon (uses Metal/MPS).'
          : 'Requires an NVIDIA CUDA GPU.'
      );
      return { compatible: false, reasons };
    }
    if (req.minVramMB !== undefined) {
      const vram = prof.cuda.vramMB;
      if (vram === undefined) {
        reasons.push('Could not read GPU VRAM; the component may be under-resourced.');
        degraded = true;
      } else if (vram < req.minVramMB) {
        reasons.push(`Requires at least ${req.minVramMB} MB VRAM; this GPU has ${vram} MB.`);
        return { compatible: false, reasons };
      }
    }
  }
  // gpu === 'none' or 'any' → no GPU gate.

  // 3. RAM gate.
  if (req.minRamMB !== undefined && prof.ramMB < req.minRamMB) {
    reasons.push(`Requires at least ${req.minRamMB} MB RAM; this machine has ${prof.ramMB} MB.`);
    return { compatible: false, reasons };
  }

  // 4. Disk gate (skipped when freeDiskMB is the sentinel).
  if (
    req.minDiskMB !== undefined &&
    prof.freeDiskMB !== DISK_SENTINEL_MB &&
    prof.freeDiskMB < req.minDiskMB
  ) {
    reasons.push(`Requires at least ${req.minDiskMB} MB free disk; ${prof.freeDiskMB} MB available.`);
    return { compatible: false, reasons };
  }

  return { compatible: true, degraded: degraded || undefined, reasons };
}
