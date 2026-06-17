// ============================================================================
// Shared renderer domain types
// ============================================================================
// The component-system types here MIRROR the canonical definitions in
// electron/components/component-types.ts (the main-process source of truth).
// Keep them in sync when the catalog contract changes.

export type AiProvider = 'local' | 'ollama' | 'claude' | 'openai';

export interface AppConfig {
  aiProvider: AiProvider;
  /** Cloud model id (claude/openai) when a cloud provider is selected. */
  aiModel: string;
  ollamaHost: string;
  /** Whisper model name, e.g. 'base', 'small'. */
  whisperModel: string;
  /** Installed local-AI component id used for generation. */
  localAiModel: string;
  setupComplete: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  aiProvider: 'local',
  aiModel: '',
  ollamaHost: 'http://127.0.0.1:11434',
  whisperModel: 'base',
  localAiModel: '',
  setupComplete: false,
};

// ─── Component system (mirror of electron/components/component-types.ts) ──────

export type ComponentCategory = 'whisper' | 'ai' | 'tool' | 'accelerator';
export type ComponentState =
  | 'installed'
  | 'available'
  | 'incompatible'
  | 'installing'
  | 'error';

export interface OptionalComponent {
  id: string;
  name: string;
  description: string;
  category: ComponentCategory;
  sizeBytes: number;
  recommended?: boolean;
  required?: boolean;
}

export interface Compatibility {
  compatible: boolean;
  degraded?: boolean;
  reasons: string[];
}

export interface ComponentStatus {
  component: OptionalComponent;
  state: ComponentState;
  compatibility: Compatibility;
}

export interface CudaInfo {
  available: boolean;
  name?: string;
  vramMB?: number;
}

export interface SystemProfile {
  platform: string;
  arch: string;
  appleSilicon: boolean;
  cuda: CudaInfo;
  ramMB: number;
  freeDiskMB: number;
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
  pct: number;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
}

export interface InstallResult {
  id: string;
  ok: boolean;
  error?: string;
}

// ─── IPC result shapes ───────────────────────────────────────────────────────

export interface ApiKeysStatus {
  claudeApiKey?: string;
  openaiApiKey?: string;
}

export interface OllamaResult {
  connected: boolean;
  models: { id: string; name: string }[];
}

export interface TranscribeResult {
  success: boolean;
  transcript: string;
}

export interface GenerateConfig {
  provider: AiProvider;
  model: string;
  localModel: string;
  ollamaHost: string;
}

export interface GenerateResult {
  success: boolean;
  notes: string;
  provider: string;
  model: string;
}

export interface SaveResult {
  success: boolean;
  error?: string;
}

export interface TranscriptionProgress {
  percent: number;
  processedSec?: number;
  totalSec?: number | null;
  elapsedSec?: number;
  etaSec?: number | null;
}
