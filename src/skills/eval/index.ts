/**
 * Skill evaluation and optimisation, as one import.
 *
 * @module skills/eval
 */

export type { Check, CheckResult, EvalReport, EvalTask, TaskResult } from './types.js';
export { grade, hashFiles, runCheck } from './grade.js';
export { BUILTIN_CORPUS, assignSplits, corpusFor, splitOf, userCorpusDir } from './corpus.js';
export { evalSkill, materialise, renderTask, runTask, type RunOptions } from './run.js';
export {
  applyEdits, buildProposalPrompt, defaultBudget, optimizeSkill, parseProposal,
  type EditBudget, type OptimizeOptions, type OptimizeResult, type OptimizeStep,
  type RejectedProposal, type SkillEdit,
} from './optimize.js';
