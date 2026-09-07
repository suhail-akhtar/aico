/**
 * The suggestion helper lives in `shared/` so the engine's learning extractors
 * and the two clients produce the same trigger from the same correction. This
 * module keeps the client's import path.
 *
 * @module knowledge-suggest
 */
export { suggestKnowledge } from '../../shared/knowledge-suggest';
export type { KnowledgeSuggestion } from '../../shared/knowledge-suggest';
