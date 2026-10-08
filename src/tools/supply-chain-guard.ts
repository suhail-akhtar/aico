/**
 * The supply-chain guard: a package an install command names must exist on the
 * public registry, and a brand-new, barely-used or lookalike one needs a person
 * (ADR 0033).
 *
 * WHY A GUARD AND NOT A PROMPT LINE. "Do not invent package names" is a request
 * the model declines exactly when it is confident, which is the case that
 * matters: a hallucinated name that an attacker has registered installs cleanly
 * and runs their install script. The facts needed are public and cheap (does
 * the name exist, how old is it), so the check is in the tool layer, before the
 * install script can run (AGENTS.md section 4.6).
 *
 * Decisions (`package-registry.ts` `judgePackage`):
 *   - the name does not exist  -> DENY, with a message the model can act on;
 *   - exists but new / near-unused / a lookalike of a popular name, or a git /
 *     tarball / URL source -> a PERSON, exactly as shell confinement asks
 *     (ADR 0027): the run's approval card when attended, a refusal plus a
 *     notification when unattended or nobody can be asked; a yes sets the
 *     Sentinel's `HUMAN_APPROVED` so the same call is not asked twice;
 *   - the registry could not be reached, or a PRIVATE registry is configured
 *     -> abstain, and an advisory note rides the tool result. Unknown never
 *     grants and never blocks: refusing offline work would only teach people to
 *     switch the control off.
 *
 * A guard: it can only deny or abstain (ADR 0002). Scoped to its run's agent.
 * Everything it decides is also handed to the finding sink (`safety/finding`).
 *
 * Deliberately not here: lockfile installs, names hidden behind variables or
 * scripts, Maven/Gradle edits (see `package-parse.ts`), and any judgement that a
 * package is *safe* — existing and being old is a signal, not a proof.
 *
 * @module tools/supply-chain-guard
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolPipeline, ToolCallContext } from './pipeline.js';
import { addContext } from './pipeline.js';
import { shellCommandOf } from '../safety.js';
import { pushNotification } from '../background/notifications.js';
import { emit, type FindingSink } from '../security/finding.js';
import { parseInstalls, type DirectRef, type PackageRef, type Ecosystem } from './package-parse.js';
import { isLocalPackage, judgePackage, lookupPackage, privateRegistry, DEFAULT_MIN_AGE_DAYS, type JudgeRule, type PackageFacts } from './package-registry.js';

const LABEL: Record<Ecosystem, string> = { npm: 'npm', pypi: 'PyPI', crates: 'crates.io', go: 'the Go module proxy', nuget: 'NuGet', packagist: 'Packagist', rubygems: 'RubyGems' };
/** `ctx.state` key carrying advisory notes from the guard to the post-execute stage. */
const NOTES = 'supply-chain-notes';
/** More names than this on one line are not all looked up (a generated command, not a decision). */
const MAX_LOOKUPS = 12;

export interface SupplyChainOptions {
  agentId: string;
  cwd: () => string;
  settings?: { supplyChain?: { packageCheck?: boolean; minAgeDays?: number } } | undefined;
  /** Ask a person; undefined when nobody can be asked. */
  ask?: ((title: string, detail: string) => Promise<boolean>) | undefined;
  /** No person attends this run (L4, cron, background, headless). */
  unattended: boolean;
  /** `ctx.state` key a person's approval sets (the Sentinel's `HUMAN_APPROVED`). */
  approvedKey: string;
  sessionId?: string | undefined;
  record?: FindingSink | undefined;
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the registry lookup. */
  lookup?: (ref: PackageRef) => Promise<PackageFacts>;
  now?: () => number;
}

export interface PersonItem { label: string; rule: JudgeRule | 'package-direct-source'; reasons: string[]; subject: string }

export interface Assessment {
  missing: Array<{ ref: PackageRef; text: string }>;
  person: PersonItem[];
  unknown: Array<{ ref: PackageRef; note: string }>;
  /** Names not checked because a private registry is configured. */
  private: Array<{ ref: PackageRef; why: string }>;
  checked: number;
}

export interface SupplyChain {
  /** Judge the packages a command names. Empty for anything that is not an install. */
  assess(name: string, args: Record<string, unknown>): Promise<Assessment | undefined>;
  /** Register the `supply-chain` guard and its advisory stage. Returns the disposer. */
  install(pipeline: ToolPipeline): () => void;
}

const subject = (ref: Pick<PackageRef, 'ecosystem' | 'name'>): string => `${ref.ecosystem}:${ref.name}`;

/** Whether `npx foo` would run a binary the project already has. */
function hasLocalBin(cwd: string, name: string): boolean {
  const bin = name.startsWith('@') ? name.split('/')[1] ?? '' : name;
  if (!bin) return false;
  let dir = path.resolve(cwd);
  for (let i = 0; i < 6; i++) {
    for (const f of [bin, `${bin}.cmd`, `${bin}.ps1`]) { try { if (fs.existsSync(path.join(dir, 'node_modules', '.bin', f))) return true; } catch { /* unreadable: not local */ } }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}

export function createSupplyChain(o: SupplyChainOptions): SupplyChain {
  const env = o.env ?? process.env;
  const lookup = o.lookup ?? ((ref: PackageRef) => lookupPackage(ref));
  const minAgeDays = typeof o.settings?.supplyChain?.minAgeDays === 'number' ? o.settings.supplyChain.minAgeDays : DEFAULT_MIN_AGE_DAYS;

  const assess: SupplyChain['assess'] = async (name, args) => {
    const command = shellCommandOf(name, args);
    if (command === undefined) return undefined;
    const parsed = parseInstalls(command);
    if (!parsed.packages.length && !parsed.direct.length) return undefined;
    const a: Assessment = { missing: [], person: [], unknown: [], private: [], checked: 0 };
    const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : o.cwd();

    for (const d of parsed.direct as DirectRef[]) {
      a.person.push({
        label: `\`${d.source}\` (${d.manager}) comes from ${d.reason === 'git' ? 'a git repository' : 'a URL'}`,
        rule: 'package-direct-source', subject: `${d.ecosystem}:${d.source.slice(0, 80)}`,
        reasons: ['no registry vouches for a git or URL source, and its install script runs with your permissions'],
      });
    }

    const refs = parsed.packages.slice(0, MAX_LOOKUPS);
    await Promise.all(refs.map(async ref => {
      if (ref.viaExec && hasLocalBin(cwd, ref.name)) return; // a binary the project already has
      if (isLocalPackage(ref, cwd)) return; // the project's own package (a workspace member, its own module)
      const priv = privateRegistry(ref, { cwd, env });
      if (priv) { a.private.push({ ref, why: priv }); return; }
      a.checked++;
      const facts = await lookup(ref);
      const verdict = judgePackage(ref, facts, { minAgeDays, ...(o.now ? { now: o.now() } : {}) });
      if (verdict.verdict === 'missing') {
        a.missing.push({
          ref,
          text: `\`${ref.name}\` is not on ${LABEL[ref.ecosystem]} — it may be a hallucinated name (models invent plausible package names, and anyone can register one). `
            + 'Check the spelling, or look up the real name in the project\'s docs or on the registry\'s site.',
        });
      } else if (verdict.verdict === 'person') {
        a.person.push({
          label: `\`${ref.name}\` (${LABEL[ref.ecosystem]})`, rule: verdict.reasons[0]!.rule, subject: subject(ref),
          reasons: verdict.reasons.map(r => r.text),
        });
      } else if (verdict.verdict === 'unknown') {
        a.unknown.push({ ref, note: facts.note ?? 'no answer' });
      }
    }));
    if (parsed.packages.length > refs.length) {
      a.unknown.push({ ref: parsed.packages[MAX_LOOKUPS]!, note: `${parsed.packages.length - refs.length} more package name(s) on this command were not looked up` });
    }
    return a;
  };

  const install = (pipeline: ToolPipeline): (() => void) => {
    const offGuard = pipeline.onGuard('supply-chain', async (ctx: ToolCallContext) => {
      if (ctx.agentId !== o.agentId) return { kind: 'abstain' };
      if (o.settings?.supplyChain?.packageCheck === false) return { kind: 'abstain' };
      let a: Assessment | undefined;
      try { a = await assess(ctx.name, ctx.arguments ?? {}); } catch { return { kind: 'abstain' }; } // a bug here must not block work
      if (!a) return { kind: 'abstain' };

      const notes: string[] = [];
      for (const u of a.unknown) {
        notes.push(`could not verify \`${u.ref.name}\` (${u.ref.ecosystem}): ${u.note}. The install was not blocked; check the name yourself.`);
        emit(o.record, { control: 'supply-chain', rule: 'package-unverified', severity: 'info', outcome: 'advisory', subject: subject(u.ref), detail: u.note });
      }
      for (const p of a.private) {
        notes.push(`\`${p.ref.name}\` was not checked against the public registry because a private one is configured (${p.why}).`);
        emit(o.record, { control: 'supply-chain', rule: 'package-unverified', severity: 'info', outcome: 'advisory', subject: subject(p.ref), detail: `private registry configured: ${p.why}` });
      }
      if (notes.length) ctx.state.set(NOTES, notes);

      if (a.missing.length) {
        for (const m of a.missing) {
          emit(o.record, { control: 'supply-chain', rule: 'package-missing', severity: 'high', outcome: 'denied', subject: subject(m.ref), detail: `not on ${LABEL[m.ref.ecosystem]}` });
        }
        return {
          kind: 'deny',
          reason: `BLOCKED (supply-chain check): ${a.missing.map(m => m.text).join(' ')} The install did not run. `
            + 'If this is a private package, the person can configure the private registry (.npmrc `registry`, PIP_INDEX_URL, GOPRIVATE…) and this check steps aside. '
            + 'Do not install it from a URL or another registry to get around this.',
        };
      }
      if (!a.person.length) return { kind: 'abstain' };

      const summary = a.person.map(p => `${p.label}: ${p.reasons.join('; ')}`).join('\n- ');
      const fix = 'Prefer an established package that does the same job, or ask the person to confirm this one by name.';
      const record = (outcome: 'denied' | 'approved-by-person'): void => {
        for (const p of a.person) {
          emit(o.record, { control: 'supply-chain', rule: p.rule, severity: 'medium', outcome, subject: p.subject, detail: p.reasons.join('; ') });
        }
      };
      if (o.unattended || !o.ask) {
        pushNotification({
          title: `Stopped an install of an unfamiliar package`,
          body: `${a.person.map(p => p.label).join(', ')}. Nobody was there to approve it, so it did not run.`,
          level: 'warning',
          sourceId: `supply-chain:${o.sessionId ?? o.agentId}`,
        });
        record('denied');
        return {
          kind: 'deny',
          reason: `BLOCKED (supply-chain check): this install needs a person, and nobody is available to approve it in this run, so it did not run.\n- ${summary}\n${fix} `
            + 'Finish everything else and say in your final report that this step needs a person.',
        };
      }
      let command = '';
      try { command = String(shellCommandOf(ctx.name, ctx.arguments) ?? ''); } catch { /* the summary still names the packages */ }
      const detail = [
        'An install names a package this check could not vouch for:',
        `- ${summary}`,
        'It needs your approval in every mode, full autonomy included.',
        command.length > 600 ? `${command.slice(0, 600)}…` : command,
      ].join('\n');
      let yes = false;
      try { yes = await o.ask(`Install an unfamiliar package: ${ctx.name}`, detail); } catch { yes = false; }
      if (yes) { record('approved-by-person'); ctx.state.set(o.approvedKey, true); return { kind: 'abstain' }; }
      record('denied');
      return { kind: 'deny', reason: `The person did not approve this install. It was not run.\n- ${summary}\n${fix} Do not try to install the same package another way.` };
    });

    // Advisory notes ride the result's `additionalContexts`, never a rewrite of the result (see repeat-guard).
    const offPost = pipeline.onPostExecute('supply-chain-advisory', async (ctx, next) => {
      const notes = ctx.state.get(NOTES);
      if (!Array.isArray(notes) || !notes.length) return next();
      return addContext(() => next(), [{ content: `Supply-chain check: ${notes.join(' ')}`, source: { kind: 'plugin', plugin: 'supply-chain' } }]);
    });
    return () => { offGuard(); offPost(); };
  };

  return { assess, install };
}
