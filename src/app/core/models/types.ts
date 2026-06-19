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
  /** Use the GPU for transcription / AI analysis (falls back to CPU if no
   *  GPU-capable build is available). */
  useGpu: boolean;
  /** System prompt used when generating meeting notes. Empty = built-in default. */
  notesPrompt: string;
  setupComplete: boolean;
}

/**
 * Built-in meeting-notes system prompt. Mirrors DEFAULT_NOTES_PROMPT in
 * electron/main.ts — keep the two in sync. Shown on the Settings page so the
 * user can edit it or reset to this.
 */
export const DEFAULT_NOTES_PROMPT = `You are an expert meeting note taker.
Your task is to create clear, organized, and comprehensive meeting notes from the provided transcript.

FORMAT FOR EMAIL: The notes should be formatted for easy copying into an email. Use:
- Clear section headers in ALL CAPS or with emphasis markers
- Bullet points (•) for lists
- Indentation for sub-items
- Blank lines between sections for readability

Include these sections:
1. MEETING SUMMARY - A brief 2-3 sentence overview of the meeting
2. KEY DISCUSSION POINTS - Major topics discussed, organized by theme
3. ACTION ITEMS - Any tasks or commitments made, with assignees if mentioned
4. DECISIONS MADE - Any formal decisions or votes
5. FOLLOW-UP ITEMS - Topics to be revisited in future meetings

IMPORTANT: Do NOT include an "Attendees" section - the audio transcript cannot reliably identify who is speaking.

Be thorough but concise. Use bullet points for clarity.
If something is unclear in the transcript, note it as "[unclear]" rather than guessing.`;

export const DEFAULT_CONFIG: AppConfig = {
  aiProvider: 'local',
  aiModel: '',
  ollamaHost: 'http://127.0.0.1:11434',
  whisperModel: 'base',
  localAiModel: '',
  useGpu: false,
  notesPrompt: '',
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
  /** Override system prompt (empty = main-process default). */
  systemPrompt?: string;
  /** Prefer the GPU build for generation. */
  useGpu?: boolean;
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
