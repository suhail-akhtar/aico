/**
 * Multi-layer validation stack.
 * Runs: tsc → build → test suite.
 * Browser QA is handled by the qa sub-agent (requires Playwright MCP tools).
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ── Types ────────────────────────────────────────────────────────────────────

export type ErrorType =
  | 'typescript-error'
  | 'missing-dependency'
  | 'module-not-found'
  | 'type-mismatch'
  | 'test-failure'
  | 'build-error'
  | 'browser-console-error'
  | 'server-crash'
  | 'lint-error'
  | 'unknown';

export interface ValidationLayer {
  name: string;
  passed: boolean;
  output: string;
  errorType?: ErrorType;
  durationMs: number;
}

export interface ValidationResult {
  pass: boolean;
  layers: ValidationLayer[];
  firstFailure?: ValidationLayer;
  errorType?: ErrorType;
  errorSummary: string;
}

// ── Error classification ──────────────────────────────────────────────────────

const ERROR_CLASSIFIERS: Array<[RegExp, ErrorType]> = [
  [/Cannot find module|Module not found|Cannot find name/i,  'missing-dependency'],
  [/error TS\d+/i,                                           'typescript-error'],
  [/Type '.*' is not assignable to type/i,                   'type-mismatch'],
  [/Expected \d+ arguments|Property '.*' does not exist/i,   'type-mismatch'],
  [/ENOENT|no such file or directory/i,                      'module-not-found'],
  [/\d+ (test|spec)s? failed|AssertionError/i,               'test-failure'],
  [/SyntaxError|Unexpected token|Unexpected end of input/i,  'build-error'],
  [/TypeError|ReferenceError/i,                              'browser-console-error'],
  [/ECONNREFUSED|listen EADDRINUSE|address already in use/i, 'server-crash'],
  [/eslint|prettier|Lint/i,                                  'lint-error'],
];

export function classifyError(output: string): ErrorType {
  for (const [pattern, type] of ERROR_CLASSIFIERS) {
    if (pattern.test(output)) return type;
  }
  return 'unknown';
}

/** Build a targeted fix prompt based on error type */
export function buildFixPrompt(errorType: ErrorType, errors: string, projectDir: string): string {
  const prompts: Record<ErrorType, string> = {
    'typescript-error':
      `Fix TypeScript errors in ${projectDir}. Read each file mentioned in the error output. Fix the type issues precisely — do not use \`any\` or \`@ts-ignore\`. Run \`npx tsc --noEmit\` to verify.`,

    'missing-dependency':
      `Missing package(s) detected. Run \`npm install <package-name>\` in ${projectDir} for each missing package, then fix the import statements. Check package.json to ensure dependencies were added.`,

    'module-not-found':
      `Module path resolution error. Check: (1) file exists at the imported path, (2) casing matches exactly (case-sensitive on Linux), (3) path alias (@/) is configured in tsconfig.json. Fix the import paths.`,

    'type-mismatch':
      `Type mismatch errors. Read the files with errors. Fix interfaces and type annotations to match actual data shapes. Use \`as const\` for literals, proper union types for variants. No \`any\`.`,

    'test-failure':
      `Test failures detected. Read each failing test. Fix the implementation to match the test expectations — do not change the tests unless they are wrong. Run \`npm test\` to verify.`,

    'build-error':
      `Build/syntax error. Check: unclosed brackets, invalid syntax, missing exports. Run \`npx tsc --noEmit\` first to locate exact positions. Fix the syntax errors.`,

    'browser-console-error':
      `Browser console errors in the application. Start the dev server and trace each error to its source component/hook. Common causes: undefined access on null data, missing null checks, invalid prop types. Fix in source.`,

    'server-crash':
      `Server crash on startup. Check: port already in use (kill the process on that port), missing env variables, incorrect database connection string. Ensure .env has all required variables.`,

    'lint-error':
      `Linting errors. Run \`npm run lint -- --fix\` to auto-fix. For remaining issues, fix manually. Common: unused variables (remove or use \`void\`), missing return types (add them), console.log (remove).`,

    'unknown':
      `Build errors detected. Read the error output carefully. Identify root cause. Fix the specific files mentioned. Run \`npx tsc --noEmit\` and \`npm run build\` to verify.`,
  };

  return `${prompts[errorType]}\n\nError output:\n\`\`\`\n${errors.slice(0, 1500)}\n\`\`\``;
}

// ── Command runner ────────────────────────────────────────────────────────────

async function runValidationCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ success: boolean; output: string; durationMs: number }> {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,  // 5MB
      env: { ...process.env, FORCE_COLOR: '0', CI: 'true' },
    });
    const output = [stdout, stderr].filter(Boolean).join('\n');
    return { success: true, output, durationMs: Date.now() - start };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
    return { success: false, output, durationMs: Date.now() - start };
  }
}

// ── Validation stack ──────────────────────────────────────────────────────────

export interface ValidationOpts {
  /** Skip the test layer (e.g., when running validation mid-implementation) */
  skipTests?: boolean;
  /** Skip the full build layer (use only tsc for speed) */
  skipBuild?: boolean;
  /** npm test command override */
  testCommand?: string;
  /** npm build command override */
  buildCommand?: string;
}

export async function runValidationStack(
  projectDir: string,
  opts: ValidationOpts = {},
): Promise<ValidationResult> {
  const layers: ValidationLayer[] = [];
  let firstFailure: ValidationLayer | undefined;

  // ── Layer 1: TypeScript type check (fast, ~3-5s) ───────────────────────────
  const tcResult = await runValidationCommand(
    'npx tsc --noEmit 2>&1',
    projectDir,
    60_000,
  );

  const tcLayer: ValidationLayer = {
    name: 'TypeScript',
    passed: tcResult.success,
    output: tcResult.output,
    errorType: tcResult.success ? undefined : classifyError(tcResult.output),
    durationMs: tcResult.durationMs,
  };
  layers.push(tcLayer);

  if (!tcLayer.passed) {
    firstFailure = tcLayer;
    return buildResult(layers, firstFailure);
  }

  // ── Layer 2: Full build (slower, ~10-30s) ─────────────────────────────────
  if (!opts.skipBuild) {
    const buildCmd = opts.buildCommand ?? 'npm run build 2>&1';
    const buildResult = await runValidationCommand(buildCmd, projectDir, 300_000);

    const buildLayer: ValidationLayer = {
      name: 'Build',
      passed: buildResult.success,
      output: buildResult.output,
      errorType: buildResult.success ? undefined : classifyError(buildResult.output),
      durationMs: buildResult.durationMs,
    };
    layers.push(buildLayer);

    if (!buildLayer.passed) {
      firstFailure = buildLayer;
      return buildResult2(layers, firstFailure);
    }
  }

  // ── Layer 3: Test suite ───────────────────────────────────────────────────
  if (!opts.skipTests) {
    const testCmd = opts.testCommand ?? 'npm test -- --run 2>&1';
    const testResult = await runValidationCommand(testCmd, projectDir, 120_000);

    const testLayer: ValidationLayer = {
      name: 'Tests',
      passed: testResult.success,
      output: testResult.output,
      errorType: testResult.success ? undefined : classifyError(testResult.output),
      durationMs: testResult.durationMs,
    };
    layers.push(testLayer);

    if (!testLayer.passed) {
      firstFailure = testLayer;
      return buildResult2(layers, firstFailure);
    }
  }

  return buildResult(layers, undefined);
}

function buildResult(layers: ValidationLayer[], firstFailure?: ValidationLayer): ValidationResult {
  const pass = !firstFailure;
  const errorSummary = firstFailure
    ? `${firstFailure.name} failed: ${firstFailure.output.split('\n').slice(0, 5).join(' | ')}`
    : 'All validation layers passed';

  return {
    pass,
    layers,
    firstFailure,
    errorType: firstFailure?.errorType,
    errorSummary,
  };
}

// Alias to avoid collision with variable name
const buildResult2 = buildResult;

/** Quick type-check only (no build, no tests) — used between Ralph Loop iterations */
export async function runTypeCheck(projectDir: string): Promise<{ pass: boolean; errors: string[] }> {
  const result = await runValidationCommand('npx tsc --noEmit 2>&1', projectDir, 60_000);
  if (result.success) return { pass: true, errors: [] };

  const errors = result.output
    .split('\n')
    .filter(line => line.includes('error TS') || line.includes('Error:'))
    .slice(0, 20);

  return { pass: false, errors };
}

/** Format validation result for display in terminal */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];
  for (const layer of result.layers) {
    const icon = layer.passed ? '✅' : '✖';
    const time = `${(layer.durationMs / 1000).toFixed(1)}s`;
    lines.push(`  ${icon} ${layer.name.padEnd(12)} ${time}`);
  }
  if (!result.pass && result.firstFailure) {
    lines.push('');
    lines.push(`  Error type: ${result.errorType}`);
    lines.push(`  ${result.errorSummary.slice(0, 120)}`);
  }
  return lines.join('\n');
}
