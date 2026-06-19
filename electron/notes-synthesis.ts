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
const MAX_TOPIC_CHARS = 12_000;      // Pass 2: split a topic larger than this (smaller = more faithful on small models)
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

/** Whitespace-flexible substring test (lowercased inputs). */
function phraseInText(lowerText: string, phrase: string): boolean {
  const p = phrase.trim().replace(/\s+/g, ' ');
  if (!p) return false;
  if (lowerText.indexOf(p) >= 0) return true;
  try {
    const re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
    return re.test(lowerText);
  } catch {
    return false;
  }
}

/**
 * Precision gate for decisions: a decision only survives if its evidence quote
 * can actually be located in the transcript. Tolerates slight paraphrase by
 * accepting any run of ≥4 consecutive quoted words. Fabricated or absent quotes
 * fail — which is the point: small models over-promote discussion to decisions,
 * and this makes "show me the words" non-negotiable.
 */
function evidenceFound(lowerTranscript: string, quote: string): boolean {
  const words = quote
    .toLowerCase()
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words.length < 3) return false;
  if (phraseInText(lowerTranscript, words.join(' '))) return true;
  for (let n = Math.min(8, words.length - 1); n >= 4; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      if (phraseInText(lowerTranscript, words.slice(i, i + n).join(' '))) return true;
    }
  }
  return false;
}

/**
 * Reject evidence that is itself a proposal, a question, or a conditional/deferred
 * remark — the linguistic signature of "discussed, not decided". The gate above
 * only proves the words exist; this proves they aren't merely someone floating or
 * deferring an idea (e.g. "what if we set up a board venmo", "I'd want to run it
 * by the auditor first"), which is the residual way contested topics leak in.
 */
function isProposalOrConditional(quote: string): boolean {
  const q = quote.toLowerCase().replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  if (!q) return true;
  if (q.includes('?')) return true;
  const openers = [
    'what if', 'could we', 'should we', 'can we', 'maybe we', 'maybe',
    'is there', 'how about', 'do we want', 'would it', 'what about', 'i wonder',
  ];
  if (openers.some((s) => q.startsWith(s))) return true;
  const deferrals = [
    'run it by', 'run that by', 'check with', "i'd want to", 'i would want to',
    'think about it', 'look into', 'continue to think', 'brainstorm',
    'due diligence', 'not sure', "we'd need to", 'we would need to',
  ];
  return deferrals.some((c) => q.includes(c));
}

const SECTION_RE = /^(Summary|Key points|Open questions|Action items|Decisions)\s*:/i;

/** True if a task was merely floated ("consider…", "look into…"), not committed to. */
function taskIsFloated(task: string): boolean {
  const t = task.toLowerCase().replace(/^[a-z][\w'-]*:\s*/, '').trim(); // drop any "name:" prefix
  return /^(consider|look into|maybe|think about|explore|possibly|we could|we should|we might|it could be|would be good)\b/.test(t);
}

/** True if the owner name appears as a whole word inside the evidence quote. */
function nameInQuote(name: string, quote: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  try {
    return new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(quote.toLowerCase());
  } catch {
    return quote.toLowerCase().includes(n);
  }
}

/**
 * Walk one extract, find one labeled section, and rewrite its bullets through
 * `transform` (which returns the kept bullet text, or null to drop it). Drops the
 * section header entirely if nothing survives. Other sections pass through.
 */
function rewriteSection(extract: string, section: string, transform: (body: string) => string | null): string {
  const lines = extract.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = SECTION_RE.exec(lines[i].trim());
    if (m && m[1].toLowerCase() === section.toLowerCase()) {
      const kept: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const bullet = lines[j].trim();
        if (SECTION_RE.test(bullet)) break;
        if (!bullet) continue;
        const r = transform(bullet.replace(/^[-•*]\s*/, ''));
        if (r) kept.push(`- ${r}`);
      }
      if (kept.length) {
        out.push(`${m[1]}:`);
        out.push(...kept);
      }
      i = j;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

/** Keep a decision only when its " :: <quote>" evidence is verifiable and is not
 *  itself a proposal/conditional; strip the quote from the kept line. */
function filterDecisionEvidence(extract: string, lowerTranscript: string): string {
  return rewriteSection(extract, 'Decisions', (body) => {
    const sep = body.lastIndexOf('::');
    if (sep < 0) return null; // no evidence supplied → not a defensible decision
    const decision = body.slice(0, sep).trim();
    const quote = body.slice(sep + 2).trim();
    if (!decision || !evidenceFound(lowerTranscript, quote) || isProposalOrConditional(quote)) return null;
    return decision;
  });
}

/**
 * Tighten action items without gutting the list:
 *  - drop floated ideas ("consider…", "look into…"),
 *  - keep a "Name:" owner ONLY when a verifiable quote actually names that person
 *    AND (when a roster is given) that name is a known participant — this catches
 *    transcription mishearings ("Ania") that pass the in-transcript check,
 *  - otherwise demote to an unattributed task (a wrong name is worse than none),
 *  - leave plain unnamed tasks untouched (no quote required, protects recall).
 */
function filterActionEvidence(extract: string, lowerTranscript: string, roster: string[] = []): string {
  return rewriteSection(extract, 'Action items', (body) => {
    const sep = body.lastIndexOf('::');
    const main = (sep >= 0 ? body.slice(0, sep) : body).trim();
    const quote = sep >= 0 ? body.slice(sep + 2).trim() : '';
    if (!main || taskIsFloated(main)) return null;

    const named = /^([A-Z][a-z]+):\s*(.+)$/.exec(main);
    if (named) {
      const [, name, task] = named;
      const onRoster = !roster.length || roster.includes(name.toLowerCase());
      if (onRoster && quote && evidenceFound(lowerTranscript, quote) && nameInQuote(name, quote)) {
        return `${name}: ${task}`;
      }
      return task; // unverifiable or off-roster owner → keep the task, drop the name
    }
    return main;
  });
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

const EXTRACTION_PROMPT = `You extract the substance of one portion of a meeting transcript, faithfully and conservatively. Record what was actually said — do NOT make the meeting sound more decisive or organized than it was.

Return plain text using ONLY these labeled parts. OMIT any part that has nothing — empty parts are normal and expected.
Summary: <1-2 plain sentences on what this portion was about>
Key points:
- <something stated or discussed>
Open questions:
- <something raised but left unresolved, deferred, debated, or pushed back on — including ideas made conditional, e.g. "we'd need to check with X first">
Action items:
- <a concrete task someone actually committed to do>   (leave unnamed if no one is clearly named)
- <Name>: <task> :: "<exact words naming that person as responsible>"   (use this form ONLY when the words name who is responsible)
Decisions:
- <the decision in a few words> :: "<exact words copied verbatim from THIS excerpt that show the agreement or commitment>"

Core rules:
- Use ONLY what is explicitly in the excerpt. Never infer, guess, or invent. If unsure, leave it out.
- PRESERVE each speaker's stance exactly. If someone says they are NOT worried about something, or do NOT think something is a problem, record it that way — never flip it into the opposite. Watch for "not", "don't", "isn't", "wouldn't", "I'm not sure", "I don't think".
- Ignore filler, false starts, and repeated phrases — they are transcription artifacts.

What counts as a Decision (MOST IMPORTANT):
- A Decision is the group CHOOSING to do something or COMMITTING to a course of action that was settled (e.g. "we'll announce it in July", "we'll split the collection between Ryan and James"). It must be an action/commitment, not a description.
- Most portions contain NO decisions. Omitting the Decisions part is the correct, normal outcome.
- The following are NOT decisions — put them under Key points (or Open questions) instead:
  • a clarification or explanation of how something already works ("the YouTube revenue isn't counted in the Give-Get")
  • a fact, status update, or FYI
  • a goal or target someone floated ("we should try to double it to $4,000") — that is an idea, not a settled commitment
  • a proposal still being debated, or made conditional ("we'd need to run it by the auditor first") → these go under Open questions
- A proposal, suggestion, idea, or question is never a decision by itself, even if it sounds good or no one objected yet.
- EVERY Decision MUST end with " :: " followed by a short quote copied EXACTLY from this excerpt — the actual words showing the group agreed or committed ("yeah that works", "sounds good", "let's do it", "we'll do X"). If you cannot copy such a quote from the excerpt, it is NOT a decision — leave it out. Do not paraphrase or invent the quote.

What counts as an Action item:
- Only a concrete task someone COMMITTED to do ("I'll text Jimmy", "Kevin will set up the account").
- "We should consider X", "maybe look into Y", "it could be good to Z", and other floated ideas are NOT action items — put them under Key points or Open questions.
- Past-tense reporting ("I reached out to him a month ago") is not an action item — it already happened.
- Describing how something ALREADY works ("applicants already get a postcard"), or general advice ("you should let your network know"), is not an action item.

Naming people (applies to action items AND tasks inside decisions):
- The transcript does NOT label who is speaking. Name a person ONLY when the words explicitly say who is responsible ("Kevin will…", "Owen, can you…"). If someone says "I'll do X" with no name attached, record the task with NO name. Never guess the speaker.
- A WRONG name is worse than no name. When in doubt, leave the task unattributed.
- Watch the difference between who is ASSIGNED and who is merely MENTIONED. "Kevin, you'll talk to Jimmy" assigns Kevin; "I reached out to Jimmy" (no name) assigns no one — do not pin it on whoever is named elsewhere in the sentence.
- To attach a name to an action item you MUST add :: followed by the exact words that name that person as responsible. If you cannot quote those words, leave the task unnamed (do not add a name and do not add a quote).
- This applies to the NARRATIVE too. In Summary and Key points, do NOT credit a statement, opinion, or past action to a named person unless the words clearly identify who is speaking. Prefer neutral phrasing: "the group discussed…", "a member noted…", "someone reached out…". Do not turn a name mentioned nearby into the actor (e.g. "Kevin will talk to Jimmy" does NOT mean Kevin already reached out).

Worked examples of the judgment calls:
- "Maybe we set up a shared account?" … "I'd want to run that by the auditor first." → Open questions (conditional, unresolved). NOT a decision.
- "Let's announce it at the July meeting." … "Sounds good." → Decisions: Announce the fundraiser at the July meeting :: "sounds good"
- "For clarity, the YouTube revenue isn't counted in the Give-Get." → Key points (a clarification of existing setup). NOT a decision.
- "Should we try to double the goal to $4,000?" → Open questions (a target floated for discussion). NOT a decision.
- "I'll handle the collection this year, and we can split it between me and James." … "Yeah, I think that works." → Decisions: Split the collection between Ryan and James this year :: "yeah, i think that works"
- "I'm not really worried about the reacquire rate." → Key points: One member is not concerned about the reacquire rate. (Do NOT write that the reacquire rate is a problem.)
- "Kevin, you're going to talk to Jimmy." … "I reached out to him a month ago." → Action items: Kevin: talk to Jimmy. (The "I reached out" is past-tense and unnamed — do NOT add it, and do NOT attribute it to anyone.)
- "We could maybe set up a shared Venmo and look into splitting the time slots." → Open questions (floated ideas). NOT action items.

Output only the labeled parts above. No preamble, no commentary, no extra headings.`;

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

function composeUserPrompt(extracts: string, roster: string[]): string {
  const rosterNote = roster.length
    ? `\n\nThe meeting participants are: ${roster.join(', ')}. Attribute an action item to a person ONLY if their name is one of these participants; if any other name appears, leave that item unattributed. Do not invent attendees.`
    : '';
  return `Below are notes extracted from each part of a meeting, in order. Combine them into a single, polished set of meeting minutes following your instructions. Consolidate and de-duplicate action items and decisions across topics.${rosterNote}\n\n${extracts}`;
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
  participants: string[] = [],
): Promise<string> {
  const clean = cleanTranscript((transcript || '').trim());
  if (!clean) return '';
  const lowerClean = clean.toLowerCase();
  const roster = participants.map((p) => p.trim()).filter(Boolean);
  const lowerRoster = roster.map((p) => p.toLowerCase());

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
    if (pieces.length) {
      const raw = `### ${topic.title}\n${pieces.join('\n')}`;
      extracts.push(filterActionEvidence(filterDecisionEvidence(raw, lowerClean), lowerClean, lowerRoster));
    }
    onProgress?.(20 + Math.round(((i + 1) / topics.length) * 60), `Summarized topic ${i + 1}/${topics.length}`);
  }

  if (!extracts.length) return '';

  // Pass 3 — compose the final consolidated minutes with the user's prompt.
  onProgress?.(82, 'Composing final notes…');
  const composed = (await callModel(notesPrompt, composeUserPrompt(extracts.join('\n\n'), roster))).trim();
  onProgress?.(100, 'Notes ready');
  return composed;
}
