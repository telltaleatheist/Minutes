/**
 * Optional Component System — shared contract for BoardNotes.
 *
 * BoardNotes ships a tiny core and downloads its toolchain (whisper models, the
 * local-AI runtime + GGUF models, ffmpeg, and an optional CUDA accelerator) into
 * userData/components/ on first run. Adapted from bookforge's component system.
 */

export type Platform = 'win32' | 'darwin' | 'linux';
export type Arch = 'x64' | 'arm64';

/** GPU class a component needs/benefits from. */
export type GpuKind = 'none' | 'any' | 'cuda' | 'apple-silicon';

/** UI grouping for the setup wizard. */
export type ComponentCategory = 'whisper' | 'ai' | 'tool' | 'accelerator';

/** How an artifact is materialized on disk. */
export type ArtifactKind =
  | 'file'      // a single raw file (e.g. a .bin/.gguf model) placed as-is
  | 'archive';  // a .zip/.tar.gz extracted into the install dir

export interface ComponentRequirements {
  /** If omitted, all platforms are eligible. */
  platforms?: Platform[];
  /** Default 'none'. */
  gpu?: GpuKind;
  minVramMB?: number;
  minRamMB?: number;
  /** Free disk required to install (download + extracted footprint). */
  minDiskMB?: number;
}

export interface ComponentArtifact {
  platform: Platform;
  arch: Arch;
  /** Disambiguates GPU-specific builds when a component has several. */
  gpu?: GpuKind;
  kind: ArtifactKind;
  url: string;
  /** sha256 for integrity. Empty allowed; when empty, verify is skipped. */
  sha256?: string;
  /** Download size in bytes (UI + disk pre-check). */
  bytes: number;
  /** 'file': filename to save as (defaults to the URL basename).
   *  'archive': not used for saving — see OptionalComponent.entryPath. */
  fileName?: string;
  /** Per-artifact entry path inside the archive, relative to the install dir.
   *  Overrides OptionalComponent.entryPath. Needed when the executable's name
   *  differs by platform/arch (e.g. whisper-cli-arm64 vs whisper-cli.exe) or is
   *  nested in a subfolder. */
  entry?: string;
}

export interface OptionalComponent {
  id: string;                  // e.g. 'whisper-small', 'ffmpeg', 'cogito-3b'
  name: string;                // display name
  description: string;         // one or two lines for the UI
  category: ComponentCategory;
  /** Headline size for the UI (the applicable artifact's bytes). */
  sizeBytes: number;
  /** Marks the suggested default within its category. */
  recommended?: boolean;
  /** Required for the app to function — auto-selected in the setup wizard and
   *  gates the home screen until installed (e.g. ffmpeg, the llama engine). */
  required?: boolean;
  requirements: ComponentRequirements;
  artifacts: ComponentArtifact[];
  /** Path consumers resolve to USE the component, relative to the install dir
   *  (binary → the executable; model → the model file). For archives whose entry
   *  lands in a nested folder, the manager records the real absolute location. */
  entryPath: string;
  /** Version/tag this entry points at. */
  version?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// System profile + compatibility
// ─────────────────────────────────────────────────────────────────────────────

export interface CudaInfo {
  available: boolean;
  name?: string;
  vramMB?: number;
}

export interface SystemProfile {
  platform: Platform;
  arch: Arch;
  appleSilicon: boolean;
  cuda: CudaInfo;
  ramMB: number;
  freeDiskMB: number;
}

export interface Compatibility {
  compatible: boolean;
  /** Runs, but sub-optimally. */
  degraded?: boolean;
  reasons: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Installed record — persisted to userData/components/installed.json
// ─────────────────────────────────────────────────────────────────────────────

export interface InstalledRecord {
  id: string;
  version?: string;
  /** Absolute install directory. */
  path: string;
  /** Absolute resolved entry (executable or model file). */
  entryPath: string;
  sha256?: string;
  bytes?: number;
  installedAt: string;
}

export interface InstalledManifest {
  components: Record<string, InstalledRecord>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime status + install progress
// ─────────────────────────────────────────────────────────────────────────────

export type ComponentState =
  | 'installed'
  | 'available'     // compatible, not installed
  | 'incompatible'  // system cannot run it
  | 'installing'
  | 'error';

export interface ComponentStatus {
  component: OptionalComponent;
  state: ComponentState;
  compatibility: Compatibility;
  installed?: InstalledRecord;
}

export type InstallPhase =
  | 'resolve'
  | 'download'
  | 'verify'
  | 'extract'
  | 'postinstall'
  | 'done'
  | 'error';

export interface InstallProgress {
  id: string;
  phase: InstallPhase;
  /** 0–100 within the current phase. */
  pct: number;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
}

export interface InstallResult {
  id: string;
  ok: boolean;
  record?: InstalledRecord;
  error?: string;
}
