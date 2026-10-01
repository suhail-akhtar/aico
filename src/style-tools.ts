/**
 * The project's own formatter and linter, found from the files that configure them.
 *
 * A lint *script* was already a check (`checks.ts` reads `npm run lint`), but a
 * project whose linter is configured and not scripted — an `eslint.config.js`
 * with no `lint` entry, a `[tool.ruff]` table, a `biome.json` — had nothing,
 * and no project had a way to say "format this the way this repo formats".
 * The model then either skipped formatting or reached for whatever formatter
 * it knew best, which in a repo that does not use it rewrites every file.
 *
 * **Evidence, never preference.** A tool is offered only when the project
 * shows it uses that tool: its config file, its `package.json` key or script,
 * its `pyproject.toml` table, its pre-commit hook. The two exceptions are the
 * languages whose formatter *is* the language convention and ships with the
 * toolchain — `gofmt` for a `go.mod`, `cargo fmt` for a `Cargo.toml`. Nothing
 * here installs anything: JavaScript tools run through `npx --no`, which
 * refuses to download a package the project does not already have.
 *
 * **Check by default, fix on request.** Every tool has a check form that
 * changes nothing (`--check`, `--verify-no-changes`, `gofmt -l`); the fix form
 * runs only when a caller asks for it (`RunChecks fix: true`).
 *
 * **Not part of the completion gate.** A configured formatter is not proof the
 * codebase is formatted — plenty of repos carry a `.prettierrc` and a thousand
 * unformatted files — and a gate the model cannot satisfy without reformatting
 * the world is a gate that gets switched off. Projects that *enforce* lint do
 * so with a `lint` script, which the gate already runs.
 *
 * @module style-tools
 */

import fs from 'fs';
import path from 'path';
import { scriptRunner, type Check } from './checks.js';

export type StyleKind = 'format' | 'lint';

export interface StyleTool {
  kind: StyleKind;
  /** The tool, for the report: `prettier`, `ruff`, `npm script format:check`. */
  tool: string;
  /** Changes nothing; fails when something is unformatted or a rule is broken. */
  check: string;
  /** Rewrites files. Absent when the project gives no safe way to. */
  fix?: string;
  /** The check exits 0 either way and lists offending files instead (`gofmt -l`). */
  failOnOutput?: boolean;
  /** What showed the project uses it, so the choice can be questioned. */
  evidence: string;
}

const exists = (root: string, ...names: string[]): string | undefined =>
  names.find(n => fs.existsSync(path.join(root, n)));

function readText(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function readPkg(root: string): { scripts: Record<string, string>; deps: Record<string, string>; raw: Record<string, unknown> } | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    const deps = { ...(raw.dependencies as Record<string, string> ?? {}), ...(raw.devDependencies as Record<string, string> ?? {}) };
    return { scripts: (raw.scripts ?? {}) as Record<string, string>, deps, raw };
  } catch { return undefined; }
}

/** Script names that mean "check formatting" and "apply formatting", most specific first. */
const FORMAT_CHECK_SCRIPTS = ['format:check', 'check:format', 'fmt:check', 'prettier:check', 'lint:format'];
const FORMAT_FIX_SCRIPTS = ['format:fix', 'format:write', 'format', 'fmt', 'prettier'];
const LINT_FIX_SCRIPTS = ['lint:fix', 'fix:lint', 'eslint:fix'];

/**
 * Every formatter and linter this project shows it uses, format first.
 *
 * One per tool, so a monorepo with a Prettier front end and a Black back end
 * gets both, each run where its config is (the root).
 */
export function detectStyleTools(root: string): StyleTool[] {
  const tools: StyleTool[] = [];
  const pkg = readPkg(root);
  const precommit = readText(path.join(root, '.pre-commit-config.yaml'));
  const hook = (id: string) => new RegExp(`id:\\s*${id}\\s*$`, 'm').test(precommit);

  // ── JavaScript / TypeScript ───────────────────────────────────────────
  if (pkg) {
    const run = scriptRunner(root);
    const s = pkg.scripts;
    const checkScript = FORMAT_CHECK_SCRIPTS.find(n => typeof s[n] === 'string')
      ?? (typeof s.format === 'string' && /--check|--verify|--list-different|\s-l\b/.test(s.format) ? 'format' : undefined);
    const fixScript = FORMAT_FIX_SCRIPTS.find(n => typeof s[n] === 'string' && n !== checkScript && !/--check|--verify|--list-different/.test(s[n]!));

    const biome = exists(root, 'biome.json', 'biome.jsonc');
    const prettier = exists(root, '.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml',
      '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.toml', '.prettierrc.json5',
      'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts')
      ?? (pkg.raw.prettier !== undefined ? 'package.json "prettier"' : undefined)
      ?? (pkg.deps.prettier ? 'prettier in devDependencies' : undefined)
      ?? (hook('prettier') ? '.pre-commit-config.yaml' : undefined);
    const eslint = exists(root, 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
      'eslint.config.mts', 'eslint.config.cts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json',
      '.eslintrc.yml', '.eslintrc.yaml')
      ?? (pkg.raw.eslintConfig !== undefined ? 'package.json "eslintConfig"' : undefined);

    // The project's own script outranks a guess at the tool's flags.
    if (checkScript) {
      tools.push({
        kind: 'format', tool: `script ${checkScript}`, check: `${run} ${checkScript}`,
        ...(fixScript ? { fix: `${run} ${fixScript}` } : {}), evidence: `package.json script "${checkScript}"`,
      });
    } else if (biome) {
      tools.push({ kind: 'format', tool: 'biome', check: 'npx --no biome format .', fix: 'npx --no biome format --write .', evidence: biome });
    } else if (prettier) {
      tools.push({ kind: 'format', tool: 'prettier', check: 'npx --no prettier --check .', fix: fixScript ? `${run} ${fixScript}` : 'npx --no prettier --write .', evidence: prettier });
    }

    const lintFix = LINT_FIX_SCRIPTS.find(n => typeof s[n] === 'string');
    if (biome) {
      tools.push({ kind: 'lint', tool: 'biome', check: 'npx --no biome lint .', fix: lintFix ? `${run} ${lintFix}` : 'npx --no biome lint --write .', evidence: biome });
    } else if (eslint) {
      tools.push({ kind: 'lint', tool: 'eslint', check: typeof s.lint === 'string' ? `${run} lint` : 'npx --no eslint .', fix: lintFix ? `${run} ${lintFix}` : 'npx --no eslint . --fix', evidence: eslint });
    } else if (typeof s.lint === 'string') {
      tools.push({ kind: 'lint', tool: 'script lint', check: `${run} lint`, ...(lintFix ? { fix: `${run} ${lintFix}` } : {}), evidence: 'package.json script "lint"' });
    }
  }

  // ── Python ────────────────────────────────────────────────────────────
  const pyproject = readText(path.join(root, 'pyproject.toml'));
  const ruffToml = exists(root, 'ruff.toml', '.ruff.toml');
  const ruffConfig = ruffToml ? readText(path.join(root, ruffToml)) : '';
  const ruff = ruffToml ?? (/^\[tool\.ruff\b/m.test(pyproject) ? 'pyproject.toml [tool.ruff]' : undefined) ?? (hook('ruff') ? '.pre-commit-config.yaml' : undefined);
  const black = /^\[tool\.black\]/m.test(pyproject) ? 'pyproject.toml [tool.black]' : hook('black') ? '.pre-commit-config.yaml' : undefined;
  // Ruff configured for linting is not evidence the repo uses its formatter.
  const ruffFormat = /^\[tool\.ruff\.format\]/m.test(pyproject) ? 'pyproject.toml [tool.ruff.format]'
    : /^\[format\]/m.test(ruffConfig) ? `${ruffToml} [format]`
    : hook('ruff-format') ? '.pre-commit-config.yaml ruff-format' : undefined;
  if (black) tools.push({ kind: 'format', tool: 'black', check: 'black --check .', fix: 'black .', evidence: black });
  else if (ruffFormat) tools.push({ kind: 'format', tool: 'ruff format', check: 'ruff format --check .', fix: 'ruff format .', evidence: ruffFormat });
  if (ruff) tools.push({ kind: 'lint', tool: 'ruff', check: 'ruff check .', fix: 'ruff check --fix .', evidence: ruff });

  // ── Go and Rust: the formatter is the language's ──────────────────────
  if (fs.existsSync(path.join(root, 'go.mod'))) {
    tools.push({ kind: 'format', tool: 'gofmt', check: 'gofmt -l .', fix: 'gofmt -w .', failOnOutput: true, evidence: 'go.mod (gofmt is the Go convention)' });
  }
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    tools.push({ kind: 'format', tool: 'rustfmt', check: 'cargo fmt --check', fix: 'cargo fmt', evidence: exists(root, 'rustfmt.toml', '.rustfmt.toml') ?? 'Cargo.toml (rustfmt ships with the toolchain)' });
  }

  // ── .NET: dotnet format reads .editorconfig; without one it has no house style to hold ──
  const dotnetProject = safeList(root).find(f => /\.(sln|slnx|csproj|fsproj|vbproj)$/i.test(f));
  if (dotnetProject && fs.existsSync(path.join(root, '.editorconfig'))) {
    tools.push({ kind: 'format', tool: 'dotnet format', check: 'dotnet format --verify-no-changes', fix: 'dotnet format', evidence: `${dotnetProject} + .editorconfig` });
  }

  return tools;
}

function safeList(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/**
 * The style tools as checks RunChecks can run, check or fix form.
 *
 * Named by kind — `format`, `lint` — or `format:<tool>` when a kind has more
 * than one, so `only: ["format"]` selects all of them. A lint the gate already
 * runs (a `lint` script) is not offered twice in check form.
 */
export function styleChecks(root: string, gate: readonly Check[], mode: 'check' | 'fix'): Check[] {
  const tools = detectStyleTools(root);
  const out: Check[] = [];
  for (const kind of ['format', 'lint'] as const) {
    let mine = tools.filter(t => t.kind === kind);
    if (mode === 'check' && kind === 'lint' && gate.some(c => c.name === 'lint')) mine = [];
    if (mode === 'fix') mine = mine.filter(t => t.fix);
    for (const t of mine) {
      out.push({
        name: mine.length === 1 ? kind : `${kind}:${t.tool.replace(/^script /, '').replace(/\s+/g, '-')}`,
        command: mode === 'fix' ? t.fix! : t.check,
        weight: kind === 'format' ? 1.5 : 2,
        ...(mode === 'check' && t.failOnOutput ? { failOnOutput: true } : {}),
      });
    }
  }
  return out;
}

/** Whether a requested name selects this check: `format` selects `format:prettier` too. */
export function selects(requested: string, name: string): boolean {
  return name === requested || name.startsWith(`${requested}:`);
}
