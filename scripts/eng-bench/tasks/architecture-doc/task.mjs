/**
 * Task 4 — an architecture and stack decision, written as a design document.
 * SOFT: there is no single right design, so this task's score is a rubric,
 * not a test suite, and it should be read as a trend signal across runs.
 *
 * Two layers, both stated in the report:
 *   1. Mechanical rubric (free, deterministic). The required sections exist,
 *      and the requirements that make this brief hard are actually engaged
 *      with rather than skipped — an offline conflict strategy, a named
 *      real-time mechanism, reporting kept off the operational database,
 *      object storage and a retention plan for ~460 TB of photos, numbers
 *      instead of adjectives, a diagram. The prompt names only the minimum
 *      sections, so the content checks measure judgement, not obedience.
 *   2. An LLM judge with a fixed rubric (six criteria, 1-5), run on a model
 *      different from the agent's by default to limit self-preference. It is
 *      one sample from a stochastic grader: treat ±0.5 as noise.
 */
import fs from 'fs';
import path from 'path';
import { gitInit, gitChanged, readText } from '../../lib/util.mjs';

export const JUDGE_CRITERIA = {
  requirements_coverage: 'Addresses every stated requirement: offline work and sync, concurrent edits, live dispatch board, reporting isolation, SAP billing, 7-year retention, photo volume, 10k users.',
  architecture_soundness: 'The components and their interactions would actually work at this scale; offline sync and conflict handling are specified concretely, not hand-waved.',
  stack_justification: 'Each major technology choice is justified against the constraints (6 TypeScript engineers, tight budget, 6 months) with credible rejected alternatives.',
  data_model: 'The data model names the real entities, keys and relationships, including what offline sync and auditing need (versions, timestamps, tombstones or equivalent).',
  tradeoffs_and_risks: 'Trade-offs are honest and specific; risks are real for this project and each has a concrete mitigation.',
  delivery_plan: 'The phased plan is realistic for 6 engineers in 6 months, sequences risk early, and defines what ships in each phase.',
};

const JUDGE_PROMPT = (requirements, doc) => [
  'You are reviewing a software design document as a principal engineer. Grade it strictly against the rubric.',
  'Use no tools. Reply with ONLY a JSON object, no prose before or after, of the form:',
  '{"scores": {"<criterion>": <integer 1-5>, ...}, "notes": {"<criterion>": "<one sentence>", ...}}',
  '',
  'Scale: 1 = missing or wrong, 2 = superficial, 3 = adequate, 4 = strong, 5 = exemplary (rare).',
  '',
  'Criteria:',
  ...Object.entries(JUDGE_CRITERIA).map(([k, v]) => `- ${k}: ${v}`),
  '',
  '=== REQUIREMENTS GIVEN TO THE AUTHOR ===',
  requirements,
  '',
  '=== DESIGN DOCUMENT ===',
  doc,
].join('\n');

const PROMPT = [
  'We need a design before we commit a team to building this. Write it as docs/DESIGN.md in this project. This is a',
  'document only; do not build the system.',
  '',
  'The system: FieldOps, a field-service platform for a regional utilities contractor.',
  '- About 10,000 users: roughly 9,000 field technicians on Android and iOS phones, 800 dispatchers and office staff',
  '  on desktop browsers, and 200 managers.',
  '- Technicians often have no connectivity for hours (basements, rural sites). Offline they must still see the day\'s',
  '  assigned jobs, fill in inspection forms (with photos), record parts used and capture the customer\'s signature;',
  '  everything syncs when they are back online. A dispatcher may re-assign or change a job while its technician is',
  '  offline.',
  '- Dispatchers need a live board of technician status and location and of job assignment, updating within a few',
  '  seconds.',
  '- Managers need reporting (SLA compliance, first-time-fix rate, jobs per technician; daily, weekly, monthly)',
  '  without slowing down the operational system.',
  '- Billing lives in the company\'s existing SAP system; completed jobs must reach it (a nightly batch is acceptable).',
  '- Records must be kept for 7 years for regulatory audits. Photos are about 2 MB each, about 6 per job, and there',
  '  are about 15,000 jobs a day.',
  '- The team is 6 engineers, mostly experienced in TypeScript; the budget is tight; the first version must be live',
  '  in 6 months.',
  '',
  'The document must cover at least: the components and how they interact; the data model; the chosen technology',
  'stack with a justification for each major choice and the alternatives you rejected; trade-offs; risks and their',
  'mitigations; and a phased delivery plan. Be concrete and quantitative where it matters.',
].join('\n');

const heading = (doc, re) => doc.split('\n').some((l) => /^#{1,4}\s/.test(l) && re.test(l));

/** The mechanical rubric, exported so test-graders.mjs can prove it on sample documents. */
export function rubric(doc, check) {
  const words = doc.split(/\s+/).filter(Boolean).length;
  check('doc: docs/DESIGN.md exists with substance (1,200-9,000 words)', words >= 1200 && words <= 9000, `${words} words`);
  check('section: components / architecture', heading(doc, /component|architecture|overview|system design/i));
  check('section: data model', heading(doc, /data model|schema|entit|domain model/i));
  check('section: technology stack', heading(doc, /stack|technolog|tooling/i));
  check('section: trade-offs', heading(doc, /trade-?offs?/i));
  check('section: risks', heading(doc, /risk/i));
  check('section: phased plan', heading(doc, /phase|plan|roadmap|delivery|milestone/i));
  check('content: rejected alternatives are named', /\b(alternatives?|rejected|instead of|considered|over\s+\w+\s+because)\b/i.test(doc));
  check('content: offline conflict-resolution strategy', /conflict/i.test(doc)
    && /(last[- ]write|\bLWW\b|CRDT|vector clock|version(ed|ing| number)?\b|merge|server[- ]wins|field[- ]level|optimistic concurrency|operation log|op[- ]log)/i.test(doc));
  check('content: real-time mechanism named', /(websockets?|server-sent events|\bSSE\b|socket\.io|\bMQTT\b|pub\/?sub)/i.test(doc));
  check('content: reporting kept off the operational DB', /(read replica|replica|warehouse|\bOLAP\b|\bETL\b|\bELT\b|\bCDC\b|change data capture|materiali[sz]ed view|analytics (db|database|store)|columnar|ClickHouse|BigQuery|Redshift|Snowflake|DuckDB)/i.test(doc));
  check('content: photos in object storage', /(\bS3\b|object storage|blob storage|\bGCS\b|Azure Blob|MinIO|R2\b)/i.test(doc));
  check('content: SAP integration designed', /\bSAP\b/.test(doc) && /(batch|nightly|export|idempoten|reconcil|retry)/i.test(doc));
  check('content: 7-year retention / lifecycle addressed', /(7[- ]years?|seven[- ]years?)/i.test(doc) && /(retention|archiv|lifecycle|glacier|cold (storage|tier))/i.test(doc));
  check('content: storage volume quantified (GB/TB)', /\d[\d,.]*\s*(GB|TB|PB)\b/.test(doc));
  check('content: load quantified (connections / requests per second)', /\d[\d,.]*\s*(k\s*)?(concurrent|connections|req(uests)?\s*\/\s*s(ec)?|requests per second|rps|QPS|messages?\s*\/\s*s|writes?\s*\/\s*s)/i.test(doc));
  check('content: a diagram', /```mermaid|┌|└|─{2,}>|-{2,}>|\+-{3,}\+|\[[^\]]+\]\s*-+>/.test(doc));
  check('content: stack fits the TypeScript team', /TypeScript/.test(doc));
  return words;
}

export default {
  id: 'architecture-doc',
  title: 'Architecture & stack decision (design doc)',
  soft: true,

  setup(project) {
    fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(project, 'README.md'), '# FieldOps\n\nDesign workspace. The design goes in docs/DESIGN.md.\n');
    gitInit(project);
  },

  prompt: PROMPT,

  async grade({ project, check, askModel }) {
    const doc = readText(path.join(project, 'docs', 'DESIGN.md'));
    const words = rubric(doc, check);
    const changed = gitChanged(project);
    // `.aico/` is AICO's own project memory (profile, decisions), not system code.
    const code = changed.filter((f) => !f.startsWith('.aico/') && !/\.(md|txt|mmd|puml|drawio|svg|png)$/i.test(f));
    check('scope: stayed a design (no system code written)', code.length === 0, code.slice(0, 8).join(', '));

    const judge = { model: null, scores: null, mean: null, notes: null, usage: null, costUsd: null, error: null };
    if (!doc) {
      judge.error = 'no document';
    } else if (!askModel) {
      judge.error = 'judge not run (no model available to the grader)';
    } else {
      const r = await askModel(JUDGE_PROMPT(PROMPT, doc));
      judge.model = r.model;
      judge.usage = r.usage;
      judge.costUsd = r.costUsd;
      try {
        const json = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1));
        const scores = {};
        for (const k of Object.keys(JUDGE_CRITERIA)) {
          const v = Number(json.scores?.[k]);
          if (!(v >= 1 && v <= 5)) throw new Error(`no score for ${k}`);
          scores[k] = v;
        }
        judge.scores = scores;
        judge.notes = json.notes ?? null;
        judge.mean = Math.round((Object.values(scores).reduce((a, b) => a + b, 0) / Object.keys(scores).length) * 100) / 100;
      } catch (e) {
        judge.error = `unparseable judge reply: ${e.message}; ${r.text.slice(0, 300)}`;
      }
    }
    check('judge: mean score >= 3.5 / 5', judge.mean !== null && judge.mean >= 3.5,
      judge.mean !== null ? `${judge.mean} (${judge.model})` : judge.error);
    return { words, judge };
  },
};
