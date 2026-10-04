/**
 * Types for `rules.mjs` — the security patterns shared by the repository's
 * gates (plain node, no build) and the engine (bundled). See that file's header.
 */

export interface SecretPattern { name: string; re: RegExp; entropy?: number; strict?: boolean }
export interface SecretFinding { name: string; line: number; preview: string; length: number }
export interface RuleContext {
  file: string; text: string; lines: string[]; index: number; lang: 'js' | 'py' | 'go'; code: string;
}
export interface CodeRule {
  id: string;
  severity: 'high' | 'medium' | 'low';
  langs: Array<'js' | 'py' | 'go'>;
  files?: RegExp;
  test: (line: string, ctx: RuleContext) => boolean;
  message: string;
  fix: string;
}
export interface CodeFinding {
  rule: string; severity: 'high' | 'medium' | 'low'; line: number; source: string; message: string; fix: string;
}

export const SECRET_PATTERNS: SecretPattern[];
export const PLACEHOLDER: RegExp;
export const SECRET_FILES: RegExp;
export function shannon(s: string): number;
export function findSecrets(text: string, opts?: { allowMarker?: RegExp }): SecretFinding[];
export function languageOf(file: string): 'js' | 'py' | 'go' | null;
export function codeOnly(line: string): string;
export const GENERIC_RULES: CodeRule[];
export function isWaived(lines: string[], index: number, id: string): boolean;
export function scanCode(file: string, text: string, rules?: CodeRule[]): CodeFinding[];
