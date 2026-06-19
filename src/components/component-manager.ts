/**
 * Component Manager — orchestrates download → verify → extract → record for the
 * catalog, persists installed state to userData/components/installed.json, and
 * resolves entry paths for the rest of the app to use.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';

import { downloadFile, verifySha256, extractArchive, findFile } from './downloader';
import { profile, evaluate } from './system-probe';
import { getCatalog, getComponent } from './catalog';
import { downloadLlamaCudaInto, LLAMA_CUDA_ID } from './llama-cuda';
import type {
  ComponentArtifact,
  ComponentState,
  ComponentStatus,
  InstalledManifest,
  InstalledRecord,
  InstallProgress,
  InstallResult,
  OptionalComponent,
  SystemProfile,
} from './component-types';

// ─────────────────────────────────────────────────────────────────────────────
// Paths + installed manifest
// ─────────────────────────────────────────────────────────────────────────────

function componentsDir(): string {
  return path.join(app.getPath('userData'), 'components');
}

function installDirFor(id: string): string {
  return path.join(componentsDir(), id);
}

function installedManifestPath(): string {
  return path.join(componentsDir(), 'installed.json');
}

function readInstalled(): InstalledManifest {
  try {
    const p = installedManifestPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (data && typeof data === 'object' && data.components) return data;
    }
  } catch (err) {
    console.warn('[COMPONENTS] Could not read installed.json:', err);
  }
  return { components: {} };
}

function writeInstalled(manifest: InstalledManifest): void {
  const p = installedManifestPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2), 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

export async function listStatus(): Promise<ComponentStatus[]> {
  const prof = await profile();
  const installed = readInstalled();

  return getCatalog().map((component) => {
    const rec = installed.components[component.id];
    const compatibility = evaluate(component, prof);

    let state: ComponentState;
    if (rec && fs.existsSync(rec.entryPath)) {
      state = 'installed';
    } else if (!compatibility.compatible) {
      state = 'incompatible';
    } else {
      state = 'available';
    }

    return { component, state, compatibility, installed: rec };
  });
}

export async function getStatus(id: string): Promise<ComponentStatus | null> {
  const all = await listStatus();
  return all.find((s) => s.component.id === id) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Install
// ─────────────────────────────────────────────────────────────────────────────

const activeInstalls = new Map<string, AbortController>();

/** Pick the best artifact for this machine: matching platform+arch, preferring a
 *  GPU-specific build when the GPU is present, else a non-GPU build. */
function pickArtifact(component: OptionalComponent, prof: SystemProfile): ComponentArtifact | null {
  const candidates = component.artifacts.filter(
    (a) => a.platform === prof.platform && a.arch === prof.arch
  );
  if (candidates.length === 0) return null;

  const cudaPreferred = prof.cuda.available;
  candidates.sort((a, b) => {
    const aCuda = a.gpu === 'cuda' ? 1 : 0;
    const bCuda = b.gpu === 'cuda' ? 1 : 0;
    return cudaPreferred ? bCuda - aCuda : aCuda - bCuda;
  });
  return candidates[0];
}

function basenameFromUrl(url: string, fallback: string): string {
  try {
    const base = path.basename(new URL(url).pathname);
    return base || fallback;
  } catch {
    return fallback;
  }
}

export async function install(
  id: string,
  onProgress?: (p: InstallProgress) => void
): Promise<InstallResult> {
  const component = getComponent(id);
  if (!component) return { id, ok: false, error: `Unknown component: ${id}` };

  const prof = await profile();
  const compatibility = evaluate(component, prof);
  if (!compatibility.compatible) {
    return { id, ok: false, error: compatibility.reasons.join(' ') || 'Incompatible with this system' };
  }

  const emit = (p: InstallProgress) => {
    try {
      onProgress?.(p);
    } catch {
      /* ignore listener errors */
    }
  };

  const ac = new AbortController();
  activeInstalls.set(id, ac);
  const installDir = installDirFor(id);

  try {
    fs.mkdirSync(installDir, { recursive: true });
    emit({ id, phase: 'resolve', pct: 0, message: 'Preparing…' });

    let entryAbs: string;
    let bytes = 0;
    let sha = '';

    if (id === LLAMA_CUDA_ID) {
      // Special multi-archive installer (CUDA build + cudart + VC++ runtime).
      await downloadLlamaCudaInto(installDir, emit, ac.signal);
      entryAbs = path.join(installDir, component.entryPath);
      bytes = component.sizeBytes;
    } else {
      const artifact = pickArtifact(component, prof);
      if (!artifact || !artifact.url) {
        throw new Error('No download available for this system yet');
      }
      bytes = artifact.bytes;
      sha = artifact.sha256 ?? '';

      if (artifact.kind === 'file') {
        // Raw file (model): download straight into the install dir.
        const fileName = artifact.fileName || basenameFromUrl(artifact.url, component.entryPath);
        const dest = path.join(installDir, fileName);
        const tmp = `${dest}.part`;
        await downloadFile(artifact.url, tmp, id, emit, ac.signal);
        await verifySha256(tmp, artifact.sha256, id, emit);
        fs.renameSync(tmp, dest);
        entryAbs = dest;
      } else {
        // Archive: download to temp, verify, extract into the install dir.
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `boardnotes-${id}-`));
        const archivePath = path.join(tmpRoot, basenameFromUrl(artifact.url, 'artifact'));
        try {
          await downloadFile(artifact.url, archivePath, id, emit, ac.signal);
          await verifySha256(archivePath, artifact.sha256, id, emit);
          emit({ id, phase: 'extract', pct: 0, message: 'Extracting…' });
          await extractArchive(archivePath, installDir, artifact.url);
          emit({ id, phase: 'extract', pct: 100, message: 'Extracted' });
        } finally {
          try {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
        // Resolve the entry: prefer the artifact's own entry (its name/location
        // can differ per platform+arch), else the component default; fall back to
        // a basename search (archives often nest the binary under a subfolder).
        const entryRel = artifact.entry || component.entryPath;
        const direct = path.join(installDir, entryRel);
        const wantBase = path.basename(entryRel).toLowerCase();
        entryAbs = fs.existsSync(direct)
          ? direct
          : findFile(installDir, (f) => f.toLowerCase() === wantBase) || direct;
      }
    }

    if (ac.signal.aborted) throw new Error('Install cancelled');
    if (!fs.existsSync(entryAbs)) {
      throw new Error(`Entry not found after install: ${component.entryPath}`);
    }

    // macOS/Linux: ensure the extracted binary is executable. tar -xzf usually
    // preserves the mode, but downloaded-then-extracted files can lose it, and a
    // model 'file' artifact is fine to chmod harmlessly too.
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(entryAbs, 0o755);
      } catch (err) {
        console.warn(`[COMPONENTS] Could not chmod ${entryAbs}:`, err);
      }
    }

    const record: InstalledRecord = {
      id,
      version: component.version,
      path: installDir,
      entryPath: entryAbs,
      sha256: sha || undefined,
      bytes: bytes || undefined,
      installedAt: new Date().toISOString(),
    };
    const manifest = readInstalled();
    manifest.components[id] = record;
    writeInstalled(manifest);

    emit({ id, phase: 'done', pct: 100, message: 'Installed' });
    return { id, ok: true, record };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ id, phase: 'error', pct: 0, message });
    // Leave the (possibly partial) install dir for inspection/retry; a fresh
    // install() overwrites it. Only the recorded manifest entry marks "installed".
    return { id, ok: false, error: message };
  } finally {
    activeInstalls.delete(id);
  }
}

/** Abort an in-flight install (no-op if none running). */
export function cancel(id: string): void {
  activeInstalls.get(id)?.abort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve + uninstall
// ─────────────────────────────────────────────────────────────────────────────

/** Absolute entry path for an installed component, else null. */
export function resolveEntry(id: string): string | null {
  const rec = readInstalled().components[id];
  if (rec && fs.existsSync(rec.entryPath)) return rec.entryPath;
  return null;
}

export async function uninstall(id: string): Promise<void> {
  const manifest = readInstalled();
  delete manifest.components[id];
  writeInstalled(manifest);
  try {
    fs.rmSync(installDirFor(id), { recursive: true, force: true });
  } catch (err) {
    console.warn(`[COMPONENTS] Could not remove install dir for ${id}:`, err);
  }
}
