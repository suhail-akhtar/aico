/**
 * What "working" means for Python, Java, .NET, PHP and Go projects that have no
 * template to say so.
 *
 * Why this exists: `detectChecks` read npm scripts, Cargo, a bare `pytest -q`
 * and `go build/test`. A custom app in any other stack, or a Maven project the
 * person opened, got *no* checks, so the completion gate had nothing to hold
 * the turn to (ADR 0031 section 7). A template seeds the profile and bypasses
 * this; a custom app and an opened repository do not.
 *
 * Rules it follows: the project's own wrapper beats a global tool (`mvnw`,
 * `gradlew`), and on Windows the wrapper has no `./` (cmd resolves `mvnw.cmd`
 * from the current directory); a runner prefix (`uv run`, `poetry run`) only
 * when its lockfile exists; a lint or typecheck is only claimed when the project
 * configured the tool (an unconfigured `mypy .` fails on every untyped file and
 * would block every turn); never a command that rewrites files. Each stack's
 * *format* and *audit* belong to `style-tools.ts` and `DependencyAudit`, which
 * report honestly when the tool is absent, not to the gate.
 *
 * What it does not do: run anything, or read more than a few small manifests.
 *
 * @module checks-stacks
 */

import fs from 'fs';
import path from 'path';
import type { Check } from './checks.js';

const WEIGHT = { typecheck: 1, lint: 2, build: 3, test: 4 } as const;

/** Project manifest file names that mark a sub-project root (a `*` matches within the file name). */
export const STACK_MANIFESTS: readonly string[] = [
  'pom.xml', 'build.gradle', 'build.gradle.kts', '*.csproj', '*.sln', 'composer.json', 'requirements.txt',
];

function exists(root: string, ...names: string[]): boolean {
  return names.some(n => fs.existsSync(path.join(root, n)));
}

function listDir(root: string): string[] {
  try { return fs.readdirSync(root); } catch { return []; }
}

/** Whether `dir` holds any of the stack manifests (globs matched against the directory listing). */
export function hasStackManifest(dir: string): boolean {
  const names = listDir(dir);
  return STACK_MANIFESTS.some(m => m.includes('*')
    ? names.some(n => new RegExp(`^${m.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(n))
    : names.includes(m));
}

function read(root: string, name: string): string {
  try { return fs.readFileSync(path.join(root, name), 'utf8'); } catch { return ''; }
}

/** The project's wrapper (`mvnw`, `gradlew`) as it is typed on this platform, or the global tool. */
export function wrapper(root: string, name: 'mvn' | 'gradle', platform: string): string {
  const w = name === 'mvn' ? 'mvnw' : 'gradlew';
  if (exists(root, w, `${w}.cmd`, `${w}.bat`)) return platform === 'win32' ? w : `./${w}`;
  return name;
}

function pythonRunner(root: string): string {
  if (exists(root, 'uv.lock')) return 'uv run ';
  if (exists(root, 'poetry.lock')) return 'poetry run ';
  return '';
}

/** Checks for the non-Node stacks this directory is a project of, cheapest first. May be empty. */
export function detectStackChecks(root: string, platform: string = process.platform): Check[] {
  const found: Check[] = [];

  // Python: tests are claimed when there are tests; lint and types only when the project configured the tool.
  if (exists(root, 'pyproject.toml', 'setup.py', 'requirements.txt')) {
    const run = pythonRunner(root);
    const pyproject = read(root, 'pyproject.toml');
    if (exists(root, 'ruff.toml', '.ruff.toml') || /\[tool\.ruff/.test(pyproject)) {
      found.push({ name: 'lint', command: `${run}ruff check .`, weight: WEIGHT.lint });
    }
    if (exists(root, 'mypy.ini', '.mypy.ini') || /\[tool\.mypy/.test(pyproject)) {
      found.push({ name: 'typecheck', command: `${run}mypy ${exists(root, 'src') ? 'src' : '.'}`, weight: WEIGHT.typecheck });
    } else if (exists(root, 'pyrightconfig.json') || /\[tool\.pyright/.test(pyproject)) {
      found.push({ name: 'typecheck', command: `${run}pyright`, weight: WEIGHT.typecheck });
    }
    if (run && (exists(root, 'pytest.ini', 'tests', 'test') || /\[tool\.pytest/.test(pyproject))) {
      found.push({ name: 'test', command: `${run}pytest -q`, weight: WEIGHT.test });
    }
  }

  // Maven / Gradle.
  if (exists(root, 'pom.xml')) {
    const mvn = wrapper(root, 'mvn', platform);
    found.push({ name: 'build', command: `${mvn} -B -ntp -q compile`, weight: WEIGHT.build });
    found.push({ name: 'test', command: `${mvn} -B -ntp test`, weight: WEIGHT.test });
  } else if (exists(root, 'build.gradle', 'build.gradle.kts')) {
    const g = wrapper(root, 'gradle', platform);
    found.push({ name: 'build', command: `${g} --console=plain -q classes`, weight: WEIGHT.build });
    found.push({ name: 'test', command: `${g} --console=plain test`, weight: WEIGHT.test });
  }

  // .NET: a solution or project file in the root.
  if (listDir(root).some(n => /\.(sln|slnx|csproj|fsproj)$/i.test(n))) {
    found.push({ name: 'build', command: 'dotnet build --nologo -v q', weight: WEIGHT.build });
    found.push({ name: 'test', command: 'dotnet test --nologo', weight: WEIGHT.test });
  }

  // PHP / Composer. Composer scripts first (the project's own words), then the conventional tools.
  if (exists(root, 'composer.json')) {
    let scripts: Record<string, unknown> = {};
    try { scripts = (JSON.parse(read(root, 'composer.json')).scripts ?? {}) as Record<string, unknown>; } catch { /* no scripts */ }
    const has = (...names: string[]): string | undefined => names.find(n => scripts[n] !== undefined);
    const lint = has('lint');
    const analyse = has('analyse', 'analyze', 'stan', 'phpstan');
    const test = has('test');
    if (analyse) found.push({ name: 'typecheck', command: `composer ${analyse}`, weight: WEIGHT.typecheck });
    else if (exists(root, 'phpstan.neon', 'phpstan.neon.dist')) found.push({ name: 'typecheck', command: 'php vendor/bin/phpstan analyse --no-progress', weight: WEIGHT.typecheck });
    if (lint) found.push({ name: 'lint', command: `composer ${lint}`, weight: WEIGHT.lint });
    if (test) found.push({ name: 'test', command: `composer ${test}`, weight: WEIGHT.test });
    else if (exists(root, 'artisan')) found.push({ name: 'test', command: 'php artisan test', weight: WEIGHT.test });
    else if (exists(root, 'phpunit.xml', 'phpunit.xml.dist')) found.push({ name: 'test', command: 'php vendor/bin/phpunit', weight: WEIGHT.test });
  }

  // Go: vet is the cheap static check the existing build/test pair lacked.
  if (exists(root, 'go.mod')) found.push({ name: 'typecheck', command: 'go vet ./...', weight: WEIGHT.typecheck });

  return found;
}

/** A one-line stack label and package manager for the manifests of the non-Node stacks, or nothing. */
export function detectStackLabel(root: string): { stack: string; packageManager: string } | undefined {
  if (exists(root, 'pom.xml')) {
    const pom = read(root, 'pom.xml');
    return { stack: /spring-boot/.test(pom) ? 'Java / Spring Boot (Maven)' : 'Java (Maven)', packageManager: 'maven' };
  }
  if (exists(root, 'build.gradle', 'build.gradle.kts')) {
    const g = read(root, 'build.gradle.kts') + read(root, 'build.gradle');
    return { stack: /org\.springframework\.boot/.test(g) ? 'Java / Spring Boot (Gradle)' : /kotlin/.test(g) ? 'Kotlin (Gradle)' : 'Java (Gradle)', packageManager: 'gradle' };
  }
  const proj = listDir(root).find(n => /\.csproj$/i.test(n));
  if (proj || listDir(root).some(n => /\.sln$/i.test(n))) {
    const text = proj ? read(root, proj) : '';
    return { stack: /Microsoft\.NET\.Sdk\.Web/.test(text) ? 'C# / ASP.NET Core' : 'C# / .NET', packageManager: 'nuget' };
  }
  if (exists(root, 'composer.json')) {
    const c = read(root, 'composer.json');
    return {
      stack: /laravel\/framework/.test(c) ? 'PHP / Laravel' : /symfony\//.test(c) ? 'PHP / Symfony' : 'PHP',
      packageManager: 'composer',
    };
  }
  return undefined;
}

/** Python and Go get a framework in the label when the manifest names one. */
export function refineLabel(root: string, base: string): string {
  if (base === 'Python') {
    const text = read(root, 'pyproject.toml') + read(root, 'requirements.txt');
    if (/fastapi/i.test(text)) return 'Python / FastAPI';
    if (/django/i.test(text)) return 'Python / Django';
    if (/flask/i.test(text)) return 'Python / Flask';
  }
  if (base === 'Go') {
    const text = read(root, 'go.mod');
    if (/gin-gonic\/gin/.test(text)) return 'Go / Gin';
    if (/go-chi\/chi/.test(text)) return 'Go / chi';
    if (/labstack\/echo/.test(text)) return 'Go / Echo';
  }
  return base;
}
