// ============================================================================
// Shared renderer domain types
// ============================================================================
// The component-system types here MIRROR the canonical definitions in
// electron/components/component-types.ts (the main-process source of truth).
// Keep them in sync when the catalog contract changes.

export type AiProvider = 'local' | 'ollama' | 'claude' | 'openai';

/** A named, reusable set of attendees. `members` is a comma-separated name list
 *  (the value format the chip input reads/writes). */
export interface ParticipantGroup {
  id: string;
  name: string;
  members: string;
}

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
  /** Saved attendee lists (e.g. "Development Committee", "Full Board"). The user
   *  loads one on the main screen, then trims anyone absent. Action items are only
   *  attributed to the loaded names; off-roster names are stripped. */
  participantGroups?: ParticipantGroup[];
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
export const DEFAULT_NOTES_PROMPT = `You are an expert meeting-notes writer. You will be given notes already extracted from a meeting, organized by topic and pre-sorted into labeled parts (Summary, Key points, Open questions, Action items, Decisions). Combine them into a single, clear set of meeting minutes.

FORMAT FOR EMAIL: format for easy copying into an email — clear section headers, bullet points (•) for lists, indentation for sub-items, and a blank line between sections.

Structure the minutes as:
1. SUMMARY — a 2-4 sentence overview of the whole meeting
2. KEY DISCUSSION POINTS — the main topics discussed, organized by topic
3. ACTION ITEMS — consolidated across the meeting, with an owner only when the words name one; merge duplicates
4. DECISIONS MADE — only items the extracts explicitly labeled as "Decisions"
5. FOLLOW-UP ITEMS — open questions and things to revisit (draw these from the extracts' "Open questions")

Rules:
- Use only information present in the provided notes. Do not infer or invent.
- TRUST THE CLASSIFICATION. The extracts already sorted content into parts. Keep it sorted: something listed under "Key points" or "Open questions" is NOT a decision — never upgrade it. Route every extracted "Open questions" item to FOLLOW-UP ITEMS, not DECISIONS.
- DECISIONS MADE must contain ONLY items that appear under a "Decisions:" label in the extracts. Most meetings have very few, or none. If the extracts contain no decisions, omit DECISIONS MADE entirely. Never manufacture a decision out of discussion.
- A decision is a choice to act or a commitment the group settled on — NOT a clarification, a fact, a status update, or a goal someone floated. Keep those under KEY DISCUSSION POINTS.
- Do not list the same item under both DECISIONS MADE and FOLLOW-UP ITEMS. Each item belongs in exactly one place.
- PRESERVE each speaker's stance. If the notes say someone was not worried about something, keep it that way — never flip it into the opposite.
- An action item is a task someone committed to do. Do NOT list floated ideas ("consider…", "look into…", "we could…", "maybe…") as action items — those belong under KEY DISCUSSION POINTS or FOLLOW-UP ITEMS.
- The transcript does not identify speakers. Give an action item an owner only when the words explicitly name who is responsible ("Kevin will…", "Owen, can you…"). Never infer the speaker; a WRONG owner is worse than none, so if no name is clearly given, leave the item unattributed.
- Do not attribute a statement, opinion, or past action to a named person in SUMMARY or KEY DISCUSSION POINTS unless the notes clearly name who said it. Prefer neutral phrasing ("a member noted…", "someone reached out…"). A name appearing near a remark does not mean that person made it.
- Keep FOLLOW-UP ITEMS tight: merge questions that ask the same thing, and never list the same open question more than once.
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
  participantGroups: [],
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
  /** Known participants for this meeting (comma/newline-separated). Constrains
   *  action-item attribution to these names. */
  participants?: string;
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
