/**
 * Syntax-highlighting grammars, chosen rather than bundled wholesale.
 *
 * `react-syntax-highlighter`'s full Prism build registers roughly 290 grammars
 * and dominates the bundle. This is the set an agentic coding session actually
 * produces — the languages of the files it edits, plus the shells and config
 * formats its tool output arrives in.
 *
 * Anything not listed still renders: it falls back to plain monospace text
 * inside the same code block, which is legible, just uncoloured. That is a much
 * better trade than half a megabyte of grammars for languages nobody in this
 * session will type.
 *
 * @module shared/ui/languages
 */

import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import graphql from 'react-syntax-highlighter/dist/esm/languages/prism/graphql';
import ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php';
import powershell from 'react-syntax-highlighter/dist/esm/languages/prism/powershell';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift';
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';

/**
 * Keyed by the token used in a fenced code block. Aliases are listed because
 * models write ```sh and ```ts as often as ```bash and ```typescript, and an
 * unregistered alias silently loses highlighting.
 */
export const HIGHLIGHT_LANGUAGES: Record<string, unknown> = {
  bash, sh: bash, shell: bash, zsh: bash,
  c,
  cpp, 'c++': cpp,
  csharp, cs: csharp,
  css,
  diff, patch: diff,
  docker, dockerfile: docker,
  go, golang: go,
  graphql,
  ini,
  java,
  javascript, js: javascript,
  json, jsonc: json,
  jsx,
  kotlin, kt: kotlin,
  markdown, md: markdown,
  php,
  powershell, ps1: powershell, pwsh: powershell,
  python, py: python,
  ruby, rb: ruby,
  rust, rs: rust,
  scss,
  sql,
  swift,
  toml,
  tsx,
  typescript, ts: typescript,
  yaml, yml: yaml,
};

/**
 * Display names for fence tokens whose id is not what a reader would call it.
 *
 * Also the home of the languages that have *no* Prism grammar but are worth
 * labelling anyway: a block of Excel formulas or a LaTeX fragment renders as
 * plain monospace, and saying so is more useful than showing the raw token or
 * silently calling it "text".
 */
export const LANGUAGE_LABELS: Record<string, string> = {
  js: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  tsx: 'TSX',
  py: 'Python',
  rb: 'Ruby',
  rs: 'Rust',
  sh: 'Shell',
  bash: 'Bash',
  zsh: 'Shell',
  ps1: 'PowerShell',
  pwsh: 'PowerShell',
  cs: 'C#',
  cpp: 'C++',
  md: 'Markdown',
  yml: 'YAML',
  json: 'JSON',
  jsonc: 'JSON',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  // No Prism grammar; labelled so the block is still self-describing.
  excel: 'Excel formula',
  formula: 'Formula',
  xlsx: 'Spreadsheet',
  latex: 'LaTeX',
  tex: 'TeX',
  math: 'Math',
  mermaid: 'Diagram',
  text: 'Text',
  txt: 'Text',
  '': 'Text',
};
