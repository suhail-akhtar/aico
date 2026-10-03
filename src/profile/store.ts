/**
 * The facts "About you" keeps, and the rules for changing them (ADR 0018).
 *
 * One file, `aicoHome()/profile/facts.json`. Each fact is one short line in
 * one of nine categories, with the evidence behind it (source, count, when
 * last seen), a confidence derived from that evidence, a status and an
 * origin:
 *   - `inferred` — learned; used only at confidence ≥ 0.7;
 *   - `confirmed` — the person said yes; always used;
 *   - `hidden` — the person said no; never used, kept so it is not re-shown;
 *   - forgotten facts are deleted and leave only fingerprints (of their
 *     subject key and of their words), so the same thing is not learned again.
 *
 * Merging is deterministic and the person always wins: a rerun may add
 * evidence to a fact the person edited, confirmed or hid, but never changes
 * its words or status. Only facts the learner wrote and nobody touched take
 * the learner's new wording. Learned facts not seen for 90 days lapse.
 *
 * Pure over the store object it is given (the caller loads and saves), so the
 * tests can drive it without a disk. The history list is capped.
 *
 * @module profile/store
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { aicoHome } from '../home.js';
import { meaningfulWords } from '../knowledge/match.js';
import { scrub } from '../learning/signals.js';
import { isFactCategory, refuseFact, type FactCategory } from './sensitive.js';

export type FactStatus = 'inferred' | 'confirmed' | 'hidden';
export type FactSource = 'work' | 'browsing' | 'preferences' | 'you';

export interface FactEvidence { source: FactSource; label: string; count: number; lastSeen: number }

export interface ProfileFact {
  id: string;
  /** What the fact is about, stable across runs ("lang:typescript"); `user:<id>` for a fact the person wrote. */
  key: string;
  category: FactCategory;
  text: string;
  evidence: FactEvidence[];
  confidence: number;
  status: FactStatus;
  created: number;
  updated: number;
  origin: 'auto' | 'user';
  /** The person changed its words: later runs keep them. */
  edited?: boolean;
  /** Other subject keys the model merged into this fact; they find it on later runs. */
  aliases?: string[];
}

export interface ProfileRun {
  at: number;
  via: 'model' | 'deterministic' | 'skipped';
  model?: string;
  provider?: string;
  costUsd?: number;
  facts: number;
  added: number;
  note?: string;
}

export interface ProfileStore {
  v: 1;
  facts: ProfileFact[];
  forgotten: string[];
  history: Array<{ at: number; id: string; action: string; text?: string }>;
  lastRun?: ProfileRun;
  /** Spend on the learner's model call, per local day. */
  spend: { day: string; usd: number };
}

/** A fact as the code (or the model's phrasing of it) proposes it, before merging. */
export interface FactCandidate {
  key: string;
  category: FactCategory;
  text: string;
  evidence: FactEvidence[];
  /** Keys merged into this one (the model may phrase several candidates as one fact). */
  aliases?: string[];
}

export const MAX_FACTS = 120;
export const MAX_FACT_CHARS = 160;
const MAX_HISTORY = 200;
const MAX_FORGOTTEN = 500;
const LAPSE_MS = 90 * 86_400_000;
export const USE_CONFIDENCE = 0.7;

export function profileDir(): string { return path.join(aicoHome(), 'profile'); }
export function factsFile(): string { return path.join(profileDir(), 'facts.json'); }

export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function emptyStore(): ProfileStore {
  return { v: 1, facts: [], forgotten: [], history: [], spend: { day: '', usd: 0 } };
}

/** Read defensively: a damaged file is an empty profile, never a crash. */
export function loadProfileStore(): ProfileStore {
  try {
    const raw = JSON.parse(fs.readFileSync(factsFile(), 'utf8')) as Partial<ProfileStore>;
    const facts = (Array.isArray(raw.facts) ? raw.facts : []).filter((f): f is ProfileFact =>
      !!f && typeof f.id === 'string' && typeof f.text === 'string' && typeof f.key === 'string' && isFactCategory(f.category));
    return {
      v: 1,
      facts,
      forgotten: Array.isArray(raw.forgotten) ? raw.forgotten.filter(x => typeof x === 'string') : [],
      history: Array.isArray(raw.history) ? raw.history : [],
      ...(raw.lastRun && typeof raw.lastRun === 'object' ? { lastRun: raw.lastRun } : {}),
      spend: raw.spend && typeof raw.spend.day === 'string' && typeof raw.spend.usd === 'number' ? raw.spend : { day: '', usd: 0 },
    };
  } catch {
    return emptyStore();
  }
}

export function saveProfileStore(store: ProfileStore): void {
  const file = factsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out: ProfileStore = {
    ...store,
    facts: store.facts.slice(0, MAX_FACTS),
    forgotten: store.forgotten.slice(-MAX_FORGOTTEN),
    history: store.history.slice(-MAX_HISTORY),
  };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Erase every fact, the history, the last run and the spend record. The
 * forget fingerprints stay (they are hashes, not data): what the person told
 * AICO to forget stays forgotten after a wipe. The settings stay too.
 */
export function wipeProfileStore(): void {
  const { forgotten } = loadProfileStore();
  if (!forgotten.length) { fs.rmSync(factsFile(), { force: true }); return; }
  saveProfileStore({ ...emptyStore(), forgotten });
}

// ── Text, fingerprints, confidence ──────────────────────────────────────────

/** The text as it may be stored, or the reason it may not. */
export function cleanFactText(raw: string, category?: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  let text = scrub(String(raw)).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().replace(/^[-*•]\s*/, '');
  if (text.length < 4) return { ok: false, reason: 'too short' };
  if (text.length > MAX_FACT_CHARS) text = `${text.slice(0, MAX_FACT_CHARS - 1).replace(/\s+\S*$/, '')}…`;
  const why = refuseFact(text, category);
  if (why) return { ok: false, reason: why };
  if (!/[.!?…)]$/.test(text)) text += '.';
  return { ok: true, text: text[0]!.toUpperCase() + text.slice(1) };
}

const hash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 16);
export function keyFingerprint(key: string): string { return `k:${hash(key.toLowerCase())}`; }
export function textFingerprint(text: string): string { return `t:${hash([...meaningfulWords(text)].sort().join(' '))}`; }

/**
 * Confidence from evidence alone: more sightings, more sources and recent
 * sightings mean more confidence. 3 sightings ≈ 0.6, 8 ≈ 0.78, 20 or more 0.95 (the cap).
 */
export function confidenceOf(evidence: readonly FactEvidence[], now: number): number {
  const count = evidence.reduce((n, e) => n + Math.max(0, e.count), 0);
  if (count <= 0) return 0;
  const sources = new Set(evidence.map(e => e.source)).size;
  const last = Math.max(...evidence.map(e => e.lastSeen));
  let c = 0.3 + 0.15 * Math.log2(1 + count);
  if (sources > 1) c += 0.05;
  if (now - last > 30 * 86_400_000) c *= 0.8;
  return Math.round(Math.min(0.95, c) * 100) / 100;
}

function factId(key: string, now: number): string {
  return `fact-${hash(`${key}|${now}|${Math.random()}`).slice(0, 10)}`;
}

function note(store: ProfileStore, at: number, id: string, action: string, text?: string): void {
  store.history.push({ at, id, action, ...(text ? { text } : {}) });
  if (store.history.length > MAX_HISTORY) store.history = store.history.slice(-MAX_HISTORY);
}

function mergeEvidence(a: readonly FactEvidence[], b: readonly FactEvidence[]): FactEvidence[] {
  const out = new Map<string, FactEvidence>();
  for (const e of [...a, ...b]) {
    const k = `${e.source}|${e.label}`;
    const prev = out.get(k);
    // The same label seen again is the same evidence re-counted, not more of it.
    out.set(k, prev ? { ...e, count: Math.max(prev.count, e.count), lastSeen: Math.max(prev.lastSeen, e.lastSeen) } : { ...e });
  }
  return [...out.values()].sort((x, y) => y.lastSeen - x.lastSeen).slice(0, 6);
}

// ── Merging ─────────────────────────────────────────────────────────────────

export interface MergeOutcome { added: ProfileFact[]; updated: ProfileFact[]; refused: Array<{ key: string; reason: string }>; lapsed: number }

/**
 * Fold a run's candidates into the store. The person's decisions win:
 * a confirmed, hidden, edited or user-written fact keeps its words and
 * status; only an untouched learned fact takes new wording.
 */
export function mergeFacts(store: ProfileStore, candidates: readonly FactCandidate[], now = Date.now()): MergeOutcome {
  const result: MergeOutcome = { added: [], updated: [], refused: [], lapsed: 0 };
  const forgotten = new Set(store.forgotten);
  for (const c of candidates) {
    const clean = cleanFactText(c.text, c.category);
    if (!clean.ok) { result.refused.push({ key: c.key, reason: clean.reason }); continue; }
    const keys = [c.key, ...(c.aliases ?? [])];
    if (keys.some(k => forgotten.has(keyFingerprint(k))) || forgotten.has(textFingerprint(clean.text))) { result.refused.push({ key: c.key, reason: 'you asked AICO to forget this' }); continue; }
    const existing = store.facts.find(f => keys.includes(f.key) || keys.some(k => f.aliases?.includes(k)));
    if (existing) {
      const aliases = [...new Set([...(existing.aliases ?? []), ...keys])].filter(k => k !== existing.key).slice(0, 12);
      if (aliases.length) existing.aliases = aliases;
      existing.evidence = mergeEvidence(existing.evidence, c.evidence);
      existing.confidence = confidenceOf(existing.evidence, now);
      const touched = existing.origin === 'user' || existing.edited || existing.status !== 'inferred';
      if (!touched && existing.text !== clean.text) { existing.text = clean.text; existing.category = c.category; }
      existing.updated = now;
      result.updated.push(existing);
      continue;
    }
    const fact: ProfileFact = {
      id: factId(c.key, now), key: c.key, category: c.category, text: clean.text,
      evidence: mergeEvidence([], c.evidence), confidence: 0, status: 'inferred', created: now, updated: now, origin: 'auto',
      ...(c.aliases?.length ? { aliases: c.aliases.slice(0, 12) } : {}),
    };
    fact.confidence = confidenceOf(fact.evidence, now);
    store.facts.push(fact);
    result.added.push(fact);
    note(store, now, fact.id, 'learned', fact.text);
  }
  // Learned facts nobody touched and nothing has shown for a long time lapse.
  const before = store.facts.length;
  store.facts = store.facts.filter(f => f.origin === 'user' || f.edited || f.status !== 'inferred'
    || Math.max(0, ...f.evidence.map(e => e.lastSeen)) > now - LAPSE_MS);
  result.lapsed = before - store.facts.length;
  if (store.facts.length > MAX_FACTS) {
    // Keep the person's own and confirmed facts first, then the most confident.
    const rank = (f: ProfileFact): number => (f.origin === 'user' || f.status === 'confirmed' ? 2 : f.status === 'hidden' ? 1 : 0) + f.confidence;
    store.facts = [...store.facts].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_FACTS);
  }
  return result;
}

export type FactAction =
  | { action: 'confirm' | 'hide' | 'forget' | 'unhide'; id: string }
  | { action: 'edit'; id: string; text: string };

/** What a person did on the page. Pure over the store; the caller saves. */
export function applyFactAction(store: ProfileStore, act: FactAction, now = Date.now()): { ok: true; fact?: ProfileFact } | { ok: false; error: string } {
  const fact = store.facts.find(f => f.id === act.id);
  if (!fact) return { ok: false, error: `no fact "${act.id}"` };
  switch (act.action) {
    case 'confirm': fact.status = 'confirmed'; break;
    case 'hide': fact.status = 'hidden'; break;
    case 'unhide': fact.status = fact.origin === 'user' ? 'confirmed' : 'inferred'; break;
    case 'forget':
      store.forgotten.push(keyFingerprint(fact.key), ...(fact.aliases ?? []).map(keyFingerprint), textFingerprint(fact.text));
      store.facts = store.facts.filter(f => f.id !== fact.id);
      // Its words go from the history too: forgetting leaves fingerprints, not text.
      store.history = store.history.filter(h => h.id !== fact.id);
      note(store, now, fact.id, 'forgotten');
      return { ok: true };
    case 'edit': {
      const clean = cleanFactText(act.text, fact.category);
      if (!clean.ok) return { ok: false, error: `Not saved: it ${clean.reason}.` };
      fact.text = clean.text;
      fact.edited = true;
      // Saying it in your own words is saying it is true.
      if (fact.status === 'inferred') fact.status = 'confirmed';
      break;
    }
  }
  fact.updated = now;
  note(store, now, fact.id, act.action, act.action === 'edit' ? fact.text : undefined);
  return { ok: true, fact };
}

/** A fact the person wrote: confirmed at once. */
export function addUserFact(store: ProfileStore, category: unknown, text: string, now = Date.now()): { ok: true; fact: ProfileFact } | { ok: false; error: string } {
  if (!isFactCategory(category)) return { ok: false, error: 'category must be one of the About you categories' };
  const clean = cleanFactText(text, category);
  if (!clean.ok) return { ok: false, error: `Not kept: it ${clean.reason}.` };
  const id = factId(`user:${clean.text}`, now);
  const fact: ProfileFact = {
    id, key: `user:${id}`, category, text: clean.text, evidence: [{ source: 'you', label: 'you wrote this', count: 1, lastSeen: now }],
    confidence: 1, status: 'confirmed', created: now, updated: now, origin: 'user',
  };
  store.facts.push(fact);
  note(store, now, id, 'added', fact.text);
  return { ok: true, fact };
}

/** Facts the agent may be told: confirmed, or learned with enough confidence. Never hidden. */
export function usableFacts(store: Pick<ProfileStore, 'facts'>): ProfileFact[] {
  return store.facts.filter(f => f.status === 'confirmed' || (f.status === 'inferred' && f.confidence >= USE_CONFIDENCE));
}
