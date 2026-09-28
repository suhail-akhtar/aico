/**
 * Monaco, the editor VS Code is built on — loaded once, with its language
 * workers bundled (no CDN), and themed from the app's own tokens so a custom
 * theme reaches the editor too.
 *
 * @module desktop/renderer/ide/monaco
 */

import * as monaco from 'monaco-editor';
// 0.57 maps 'monaco-editor/<path>' to esm/vs/<path>.js through its package exports.
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import cssWorker from 'monaco-editor/languages/features/css/css.worker?worker';
import htmlWorker from 'monaco-editor/languages/features/html/html.worker?worker';
import tsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

// Project files are not a single TS program here; keep the checker from
// flagging every import it cannot resolve.
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
monaco.typescript.typescriptDefaults.setCompilerOptions({ jsx: monaco.typescript.JsxEmit.React, allowJs: true, target: monaco.typescript.ScriptTarget.ES2020, allowNonTsExtensions: true });

const EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'cpp', hpp: 'cpp',
  php: 'php', swift: 'swift', sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', psm1: 'powershell', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  xml: 'xml', svg: 'xml', dockerfile: 'dockerfile', r: 'r', lua: 'lua', dart: 'dart', scala: 'scala', graphql: 'graphql', gql: 'graphql', bat: 'bat', cmd: 'bat',
};

export function languageFor(file: string): string {
  const base = file.split(/[\\/]/).pop()!.toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const ext = base.includes('.') ? base.split('.').pop()! : '';
  return EXT[ext] ?? 'plaintext';
}

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Define (or redefine) the editor theme from the current app tokens. */
export function applyEditorTheme(): string {
  const dark = document.documentElement.classList.contains('dark');
  const hex = (v: string, fallback: string): string => (/^#[0-9a-f]{6}$/i.test(v) ? v : fallback);
  monaco.editor.defineTheme('aico', {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': hex(css('--aico-bg'), dark ? '#171717' : '#ffffff'),
      'editor.foreground': hex(css('--aico-text-primary'), dark ? '#ececec' : '#0d0d0d'),
      'editorLineNumber.foreground': hex(css('--aico-text-muted'), '#888888'),
      'editorCursor.foreground': hex(css('--aico-accent'), '#3b82f6'),
      'editor.lineHighlightBackground': hex(css('--aico-surface'), dark ? '#1c1c1c' : '#f7f7f7'),
      'editorGutter.background': hex(css('--aico-bg'), dark ? '#171717' : '#ffffff'),
      'minimap.background': hex(css('--aico-bg'), dark ? '#171717' : '#ffffff'),
    },
  });
  monaco.editor.setTheme('aico');
  return 'aico';
}

export { monaco };
