/**
 * "Shall I continue?" is not an answer to "do it end to end".
 *
 * A big build (a browser, a platform) ran a few phases, ended its turn with
 * "Shall I proceed to phase 3?", and when the person said "do it end to end"
 * did the same again. The todo gate cannot see this: the finished phase left
 * nothing open, so the turn was accepted as done. This recognises the closing
 * question in code, so the loop can answer it with "continue" instead of
 * leaving the person to type it after every phase.
 *
 * Deliberately narrow: only a closing request for *permission to carry on*.
 * A real question ("which database?", "what is the API key?") is not matched
 * and still ends the turn. The loop caps the nudges (agent.ts), and a person
 * who wants check-ins says so ("ask me before…"), which {@link wantsCheckIns}
 * honours.
 *
 * @module continue-gate
 */

const PERMISSION_TO_CONTINUE = [
  /\b(?:shall|should|may|can) i (?:go ahead|proceed|continue|move on|move forward|carry on|start|begin|keep going|go on)\b/i,
  /\b(?:would|do) you (?:like|want|wish) me to (?:go ahead|proceed|continue|move on|move forward|carry on|start|begin|keep going|implement|build|tackle|do)\b/i,
  /\blet me know (?:if|when|whether) (?:you(?:'d| would)? (?:like|want) me to|to) (?:go ahead|proceed|continue|move on|start|begin|keep going)\b/i,
  /\b(?:ready|happy) to (?:proceed|continue|move on|go ahead)\b[^.?!]*\b(?:when you|if you|on your)\b/i,
  /\bsay (?:the word|"?(?:continue|go|proceed)"?)\b/i,
  /\bwaiting for (?:your|the) (?:go-?ahead|confirmation|approval|green light)\b/i,
];

/** Only the closing stretch of a message counts: a question buried mid-report is not the turn's last word. */
const TAIL_CHARS = 420;

/** Whether the message ends by asking leave to carry on with work already agreed. */
export function asksPermissionToContinue(text: string): boolean {
  const tail = text.trim().slice(-TAIL_CHARS);
  return tail.length > 0 && PERMISSION_TO_CONTINUE.some(re => re.test(tail));
}

/** The person asked to be consulted between steps; the gate stays out of the way. */
export function wantsCheckIns(userMessages: readonly string[]): boolean {
  return userMessages.some(m => /\b(?:ask me|check with me|confirm with me|wait for my|pause (?:after|between|for)|stop after each|one phase at a time|phase by phase with my)\b/i.test(m));
}

/** What the loop says in answer. One decision rule, so the model is not left to weigh it. */
export const CONTINUE_NUDGE =
  'Do not ask permission to continue: the request covers the whole job. ' +
  'Carry on with the next phase now, and finish the remaining phases in this turn. ' +
  'Stop only for something that cannot be inferred or that only the person can do (a credential, a payment, a choice between genuinely different products); ' +
  'then ask that one specific question, not "shall I continue".';
