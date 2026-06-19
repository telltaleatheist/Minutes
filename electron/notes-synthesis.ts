/**
 * Meeting-notes synthesis — a self-contained, multi-pass protocol tuned to work
 * well even on the smallest local model.
 *
 *   Clean  : collapse repeated phrases (transcription loops) before anything.
 *   Pass 1 : split the transcript into its major topics (hidden orchestration
 *            prompt). Tiny opening/noise sections are merged away.
 *   Pass 2 : per topic, EXTRACT the substance — a constrained, faithful task the
 *            small model handles reliably (hidden prompt).
 *   Pass 3 : COMPOSE the final, consolidated minutes from those extracts using
 *            the USER'S editable Settings prompt (dedupes across topics).
 *
 * Only the compose prompt is user-facing; topic-finding and extraction prompts
 * are internal.
 */

// ── Tunables ──────────────────────────────────────────────────────────────────
const BOUNDARY_CHUNK_CHARS = 24_000; // Pass 1 excerpt size (~6k tokens)
const MAX_TOPIC_CHARS = 24_000;      // Pass 2: split a topic larger than this
const MIN_TOPIC_CHARS = 600;         // merge a section shorter than this into the next

export type CallModel = (systemPrompt: string, userPrompt: string) => Promise<string>;
export type OnProgress = (percent: number, message: string) => void;

interface Boundary {
  offset: number;
  title: string;
}

// ── Transcript cleanup ────────────────────────────────────────────────────────

/**
 * Collapse consecutive repeated word-runs — Whisper loops like
 * "i think that's a really good point" ×12 or a sentence echoed verbatim.
 * Scans largest windows first so long repeats collapse before short ones.
 */
export function cleanTranscript(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    let collapsed = false;
    for (let n = 12; n >= 3; n--) {
      if (i + 2 * n > words.length) continue;
      const a = words.slice(i, i + n).join(' ').toLowerCase();
      if (a.length <= 8) continue;
      if (a !== words.slice(i + n, i + 2 * n).join(' ').toLowerCase()) continue;
      // Skip every further consecutive copy, keep one.
      let j = i + n;
      while (j + n <= words.length && words.slice(j, j + n).join(' ').toLowerCase() === a) j += n;
      for (let k = i; k < i + n; k++) out.push(words[k]);
      i = j;
      collapsed = true;
      break;
    }
    if (!collapsed) out.push(words[i++]);
  }
  return out.join(' ');
}

// ── Pass 1: topic-boundary detection (hidden) ─────────────────────────────────

function buildBoundaryPrompt(chunkText: string, previousTopic: string, isFirst: boolean): string {
  const prev = previousTopic ? `\nThe previous excerpt ended while discussing: "${previousTopic}".\n` : '';
  const firstRule = isFirst
    ? '- Include the opening topic first, with "start_phrase": null. Skip pure greetings/setup chatter — start at the first real subject.'
    : '- Do NOT include the continuing topic from the previous excerpt; list only NEW topics that begin here.';
  return `You are segmenting a meeting transcript into its MAJOR discussion topics.
Mark only significant subject changes — merge closely related discussion into a single topic. A typical meeting has a handful of topics, not many.
${prev}
Return ONLY JSON:
{
  "topics": [
    { "title": "<3-6 word topic name>", "start_phrase": "<exact 4-10 word phrase copied verbatim from the transcript where this topic begins, or null>" }
  ],
  "end_topic": "<what the conversation is discussing at the very end of this excerpt>"
}

Rules:
- "start_phrase" MUST be copied exactly from the transcript so it can be located.
${firstRule}
- If no significant new topic begins in this excerpt, return "topics": [].

Transcript excerpt:
${chunkText}`;
}

function extractJson(text: string): any | null {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sliceForBoundaries(transcript: string): { start: number; text: string }[] {
  const slices: { start: number; text: string }[] = [];
  let pos = 0;
  while (pos < transcript.length) {
    let end = Math.min(pos + BOUNDARY_CHUNK_CHARS, transcript.length);
    if (end < transcript.length) {
      const ws = transcript.lastIndexOf(' ', end);
      if (ws > pos) end = ws;
    }
    slices.push({ start: pos, text: transcript.slice(pos, end) });
    pos = end;
  }
  return slices.length ? slices : [{ start: 0, text: transcript }];
}

function findPhraseOffset(lowerTranscript: string, phrase: string, from: number, to: number): number {
  const p = phrase.trim().toLowerCase();
  if (!p) return -1;
  const window = lowerTranscript.slice(from, to);
  const direct = window.indexOf(p);
  if (direct >= 0) return from + direct;
  try {
    const re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
    const m = re.exec(window);
    if (m) return from + m.index;
  } catch {
    /* ignore */
  }
  return -1;
}

async function detectTopics(transcript: string, callModel: CallModel, onProgress?: OnProgress): Promise<Boundary[]> {
  const lower = transcript.toLowerCase();
  const slices = sliceForBoundaries(transcript);
  const boundaries: Boundary[] = [];
  let firstTitle = '';
  let previousTopic = '';

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];
    onProgress?.(Math.round((i / slices.length) * 18) + 2, `Finding topics (${i + 1}/${slices.length})…`);
    let parsed: any = null;
    try {
      parsed = extractJson(await callModel(buildBoundaryPrompt(slice.text, previousTopic, i === 0), 'Return the JSON now.'));
    } catch {
      parsed = null;
    }
    if (!parsed || !Array.isArray(parsed.topics)) continue;
    if (typeof parsed.end_topic === 'string') previousTopic = parsed.end_topic;

    for (const t of parsed.topics) {
      const title = (t?.title || '').toString().trim() || 'Discussion';
      const phrase = t?.start_phrase;
      if (i === 0 && (phrase == null || phrase === '')) {
        firstTitle = title;
        continue;
      }
      if (typeof phrase !== 'string' || !phrase.trim()) continue;
      const offset = findPhraseOffset(lower, phrase, slice.start, slice.start + slice.text.length);
      if (offset >= 0 && !boundaries.some((b) => Math.abs(b.offset - offset) < 40)) {
        boundaries.push({ offset, title });
      }
    }
  }

  boundaries.push({ offset: 0, title: firstTitle || 'Discussion' });
  boundaries.sort((a, b) => a.offset - b.offset);
  const deduped: Boundary[] = [];
  for (const b of boundaries) {
    if (!deduped.length || b.offset > deduped[deduped.length - 1].offset + 40) deduped.push(b);
  }
  return deduped;
}

/** Turn boundary offsets into {title, text} spans, merging sections that are too
 *  short (e.g. intro chatter) into the following one. */
function boundariesToSpans(transcript: string, boundaries: Boundary[]): { title: string; text: string }[] {
  const raw = boundaries.map((b, i) => ({
    title: b.title,
    text: transcript.slice(b.offset, i < boundaries.length - 1 ? boundaries[i + 1].offset : transcript.length).trim(),
  }));
  const spans: { title: string; text: string }[] = [];
  let carry = '';
  for (let i = 0; i < raw.length; i++) {
    const combined = carry ? `${carry} ${raw[i].text}` : raw[i].text;
    const isLast = i === raw.length - 1;
    if (combined.length < MIN_TOPIC_CHARS && !isLast) {
      carry = combined; // fold this tiny section into the next, keep the next title
      continue;
    }
    spans.push({ title: raw[i].title, text: combined });
    carry = '';
  }
  if (carry && spans.length) spans[spans.length - 1].text += ` ${carry}`;
  else if (carry) spans.push({ title: 'Discussion', text: carry });
  return spans.filter((s) => s.text.length > 0);
}

// ── Pass 2: per-topic extraction (hidden) ─────────────────────────────────────

const EXTRACTION_PROMPT = `You extract the substance of one portion of a meeting transcript. Be faithful and concise.

Return plain text using ONLY these labeled parts, and OMIT any part that has nothing:
Summary: <1-2 sentences>
Key points:
- <point>
Action items:
- <task> — prefix with a name ONLY if the words say who is responsible (e.g. "Kevin: ...")
Decisions:
- <only an agreement or conclusion the group EXPLICITLY reached>

Rules:
- Use ONLY what is explicitly in the excerpt. Do not infer, guess, or invent.
- Ignore filler, false starts, and repeated phrases — they are transcription artifacts.
- The transcript does NOT identify who is speaking. Name a person for a task ONLY when the words explicitly say who will do it ("Kevin will…", "Owen, can you…"). Never guess the speaker — if someone says "I'll do X" with no name given, record the task with no name.
- A "decision" is ONLY something the group clearly agreed on or settled. Proposals, suggestions, questions, ideas that were debated, pushed back on, or left unresolved are NOT decisions — put those under Key points instead. If nothing was actually decided, omit the Decisions part.
- Output only the labeled parts above. No preamble, no commentary, no headings.`;

function splitTopic(text: string): string[] {
  if (text.length <= MAX_TOPIC_CHARS) return [text];
  const parts: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + MAX_TOPIC_CHARS, text.length);
    if (end < text.length) {
      const ws = text.lastIndexOf(' ', end);
      if (ws > pos) end = ws;
    }
    parts.push(text.slice(pos, end));
    pos = end;
  }
  return parts;
}

// ── Pass 3: compose (user's editable prompt) ──────────────────────────────────

function composeUserPrompt(extracts: string): string {
  return `Below are notes extracted from each part of a meeting, in order. Combine them into a single, polished set of meeting minutes following your instructions. Consolidate and de-duplicate action items and decisions across topics.\n\n${extracts}`;
}

/**
 * Run the full protocol. `notesPrompt` is the user's (Settings) prompt, used for
 * the final compose step. Returns assembled markdown notes.
 */
export async function synthesizeNotes(
  transcript: string,
  notesPrompt: string,
  callModel: CallModel,
  onProgress?: OnProgress,
): Promise<string> {
  const clean = cleanTranscript((transcript || '').trim());
  if (!clean) return '';

  onProgress?.(2, 'Finding topics…');
  const boundaries = await detectTopics(clean, callModel, onProgress);
  const topics = boundariesToSpans(clean, boundaries);

  // Pass 2 — extract substance per topic (20–80%).
  onProgress?.(20, `Summarizing ${topics.length} topic${topics.length === 1 ? '' : 's'}…`);
  const extracts: string[] = [];
  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i];
    const parts = splitTopic(topic.text);
    const pieces: string[] = [];
    for (const part of parts) {
      const ex = (await callModel(EXTRACTION_PROMPT, `Topic: ${topic.title}\n\nTranscript excerpt:\n${part}`)).trim();
      if (ex) pieces.push(ex);
    }
    if (pieces.length) extracts.push(`### ${topic.title}\n${pieces.join('\n')}`);
    onProgress?.(20 + Math.round(((i + 1) / topics.length) * 60), `Summarized topic ${i + 1}/${topics.length}`);
  }

  if (!extracts.length) return '';

  // Pass 3 — compose the final consolidated minutes with the user's prompt.
  onProgress?.(82, 'Composing final notes…');
  const composed = (await callModel(notesPrompt, composeUserPrompt(extracts.join('\n\n')))).trim();
  onProgress?.(100, 'Notes ready');
  return composed;
}
