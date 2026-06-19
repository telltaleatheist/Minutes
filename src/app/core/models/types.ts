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
  /** Measured transcription real-time factor (elapsed ÷ audio seconds), keyed by
   *  `<model>|<gpu|cpu>`. Self-calibrates the dropdown speed estimates. */
  transcriptionRtf?: Record<string, number>;
  setupComplete: boolean;
}

/**
 * Built-in meeting-notes system prompt. Mirrors DEFAULT_NOTES_PROMPT in
 * electron/main.ts — keep the two in sync. Shown on the Settings page so the
 * user can edit it or reset to this.
 */
export const DEFAULT_NOTES_PROMPT = `You are an expert meeting-notes writer. You will be given notes extracted from a meeting, organized by topic. Combine them into a single, clear set of meeting minutes.

FORMAT FOR EMAIL: format for easy copying into an email — clear section headers, bullet points (•) for lists, indentation for sub-items, and a blank line between sections.

Structure the minutes as:
1. SUMMARY — a 2-4 sentence overview of the whole meeting
2. KEY DISCUSSION POINTS — the main topics discussed, organized by topic
3. ACTION ITEMS — consolidated across the meeting, with an owner only when the words name one; merge duplicates
4. DECISIONS MADE — only decisions or agreements the group EXPLICITLY reached
5. FOLLOW-UP ITEMS — open questions or things to revisit later

Rules:
- Use only information present in the provided notes. Do not infer or invent.
- A decision is only something the group clearly agreed on or settled. Anything merely proposed, debated, pushed back on, or left unresolved is NOT a decision — keep it under Key Discussion Points. If nothing was firmly decided, omit DECISIONS MADE entirely.
- Follow-up items are open questions or things to revisit — do not repeat anything already listed as an Action Item.
- The transcript does not identify speakers. Give an action item an owner only when the words explicitly name who is responsible ("Kevin will…", "Owen, can you…"). Never infer the speaker; if no name is given, leave the item unattributed.
- Omit any section that has no content — do not write "None".
- Do not include an "Attendees" section.
- Output only the meeting notes — no preamble or commentary (e.g. do not begin with "Here are the notes").`;

export const DEFAULT_CONFIG: AppConfig = {
  aiProvider: 'local',
  aiModel: '',
  ollamaHost: 'http://127.0.0.1:11434',
  whisperModel: 'base',
  localAiModel: '',
  useGpu: false,
  notesPrompt: '',
  transcriptionRtf: {},
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

export interface GenerationProgress {
  percent: number;
  message: string;
}
