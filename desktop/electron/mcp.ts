/**
 * The desktop's MCP endpoint — how the agent drives this IDE and its browser.
 *
 * A small JSON-RPC-over-HTTP server on 127.0.0.1 with a per-run bearer token,
 * handed to the engine through `AICO_HOST_MCP` so it is connected for this run
 * only and never written to settings. Its tools appear to the agent as
 * `mcp__aico-desktop__ide_*` and `mcp__aico-desktop__browser_*`, and its
 * `instructions` (the IDE's manual, plus any instructions enabled plugins
 * contribute) ride in the agent's prompt.
 *
 * Every call is bounded well under the engine's 30-second MCP timeout; the one
 * thing that can take minutes — waiting for a person to sign in — is split
 * into `browser_handoff` (ask) and `browser_handoff_wait` (poll).
 *
 * @module desktop/electron/mcp
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from './context';
import { listUserPlugins, readPluginFile, removePlugin, savePlugin, setPluginEnabled } from './plugins';
import type { Target } from './browser';
import { PLUGIN_API_VERSION, ICON_NAMES } from '../shared/plugin-types';

export const MCP_NAME = 'aico-desktop';

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
}

const TARGET_PROPS = {
  ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. "e12". Preferred.' },
  selector: { type: 'string', description: 'CSS selector, when there is no ref.' },
  text: { type: 'string', description: 'Visible text of the element, when there is no ref.' },
};

function target(a: Record<string, unknown>): Target {
  return {
    ...(typeof a.ref === 'string' ? { ref: a.ref } : {}),
    ...(typeof a.selector === 'string' ? { selector: a.selector } : {}),
    ...(typeof a.text === 'string' ? { text: a.text } : {}),
  };
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

/** The manual the agent reads. Static facts only; live state comes from ide_describe. */
function manual(ctx: DesktopContext): string {
  const pluginInstructions = listUserPlugins(ctx)
    .filter(p => p.enabled && !p.error)
    .flatMap(p => (p.manifest.contributes.instructions ?? []).map(i => `- [${p.manifest.name}] ${i.text}`));
  return [
    'You are running inside AICO Desktop, a desktop IDE the user is looking at. Besides your normal tools you can drive the IDE and its built-in browser through the aico-desktop tools.',
    '',
    'IDE: call ide_describe first when asked about the IDE — it returns the live state (current view, projects, plugins and their pages/commands, theme). ide_navigate opens any view by id (chat, chats, library, scheduled, plugins, projects, project {path}, group {id}, files {root, open}, git {path}, github {path}, browser {url}, apps, activity, changes {id}, trajectory {id}, or a plugin page "<pluginId>:<viewId>"). ide_run_command runs any palette command. ide_set_appearance changes theme/colours/font size/width; ide_set_layout shows or hides the sidebar, bottom panel and side browser. ide_open_file opens a file in the editor. ide_notify shows the user a notification. ide_terminal_run starts a command in a visible terminal tab (use it for dev servers the user should watch; use your own shell tool for quick commands).',
    '',
    `PLUGINS: the IDE is customised with plugins, never by editing its code. To add or change a feature, write a plugin with ide_plugin_save. A manifest is JSON: { "id": "lower.case-id", "name": "Name", "version": "0.1.0", "description": "...", "icon": one of [${ICON_NAMES.join(', ')}], "category": "...", "contributes": { ... } }. Contribution kinds:`,
    '- navItems: [{ id, title, icon, view, placement: "primary"|"more", order }] — sidebar entries; view is a page id of this plugin (or any view id).',
    '- views: pages. { id, title, icon, kind: "markdown", markdown } (full chat Markdown: tables, math, ```chart/```widgets/```mermaid fences all render); { kind: "prompt-board", description, prompts: [{ title, prompt, icon }] }; { kind: "links", links: [{ title, url, description }] }; { kind: "frame", entry: "view.html" } for a custom HTML/JS page in a sandbox (pass the HTML in files). A frame talks to the host with postMessage({ type: "aico:call", id, method, params }, "*") and receives { type: "aico:reply", id, result|error } and { type: "aico:init", theme }. Methods: composer.prefill {text}, chat.ask {prompt, newChat}, view.open {view}, browser.open {url}, notify {title, body, kind}, theme.get, storage.get {key}, storage.set {key, value}. Frame plugins need the user to trust them once.',
    '- commands: [{ id, title, category, icon, keybinding, action }] with action one of { type: "prompt", prompt, newChat, send } | { type: "open-view", view } | { type: "open-url", url } | { type: "browse", url } | { type: "terminal", command, cwd } (the user confirms) | { type: "command", command } | { type: "theme", theme }.',
    '- themes: [{ id, label, mode: "light"|"dark", background, foreground, accent }] (#hex).',
    '- prompts: [{ id, title, prompt, icon, home: true }] — quick prompts on the home screen.',
    '- statusItems: [{ id, text, tooltip, command, align }].',
    '- widgets: [{ language, entry }] — a chat fence language drawn by the plugin\'s own HTML (it receives the fence body in aico:init payload).',
    '- instructions: [{ id, text }] — standing instructions added to every chat while the plugin is on.',
    `Plugins live in ${ctx.paths.pluginsDir}. Built-in features are plugins too (aico.chats, aico.library, aico.scheduled, aico.projects, aico.files, aico.git, aico.github, aico.browser, aico.terminal, aico.apps, aico.activity, aico.statusbar, aico.starters) and can be switched off with ide_plugin_set_enabled. Plugin API version ${PLUGIN_API_VERSION}.`,
    '',
    'BROWSER: a real Chromium browser inside the IDE, with its own profile. For web QA and automation: browser_open a URL, browser_snapshot to read the page (interactive elements get refs like [e7]), then browser_click / browser_type / browser_select / browser_press by ref. Take a new snapshot after anything that changes the page. browser_wait waits for text or a selector; browser_screenshot saves a PNG (read it to look at it); browser_console and browser_network show errors and requests. Never solve a CAPTCHA and never type a password you were not given: use browser_handoff to ask the user to do it, then poll browser_handoff_wait. Test local apps at http://localhost:<port>.',
    ...(pluginInstructions.length ? ['', 'INSTRUCTIONS FROM ENABLED PLUGINS:', ...pluginInstructions] : []),
  ].join('\n');
}

export function createTools(ctx: DesktopContext): Tool[] {
  const renderer = (): NonNullable<DesktopContext['services']['renderer']> => {
    if (!ctx.services.renderer) throw new Error('The interface is not ready.');
    return ctx.services.renderer;
  };
  const browser = async (): Promise<NonNullable<DesktopContext['services']['browser']>> => {
    const b = ctx.services.browser;
    if (!b) throw new Error('The built-in browser is not available.');
    // Make sure the page is on screen so it lays out and paints.
    await renderer().call('ensureBrowserVisible', {}, 5000).catch(() => { /* works headless too */ });
    return b;
  };
  const json = (v: unknown): string => JSON.stringify(v, null, 2);

  const tools: Tool[] = [
    {
      name: 'ide_describe',
      description: 'Describe AICO Desktop right now: the current view, open chat, projects, every view and command you can open or run, installed plugins (built-in and user) with enabled state, theme and layout. Call this before changing the IDE.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const state = await renderer().call<Record<string, unknown>>('state');
        const user = listUserPlugins(ctx).map(p => ({ id: p.manifest.id, name: p.manifest.name, enabled: p.enabled, error: p.error, dir: p.dir, contributes: Object.fromEntries(Object.entries(p.manifest.contributes).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])) }));
        return json({ ...state, userPluginFolders: user, pluginsDir: ctx.paths.pluginsDir });
      },
    },
    {
      name: 'ide_navigate',
      description: 'Open a view in the IDE. view: a view id from ide_describe (e.g. "files", "git", "browser", "project", "plugins", "<pluginId>:<viewId>"). params: route parameters (project {path}, group {id}, files {root, open, line}, browser {url}, git {path}). For a chat, view "chat" with sessionId.',
      inputSchema: { type: 'object', properties: { view: { type: 'string' }, params: { type: 'object', additionalProperties: { type: 'string' } }, sessionId: { type: 'string' } }, required: ['view'] },
      run: async (a) => json(await renderer().call('navigate', a)),
    },
    {
      name: 'ide_run_command',
      description: 'Run a command from the command palette by id (see ide_describe → commands), e.g. "theme.toggle", "terminal.new", "sidebar.toggle".',
      inputSchema: { type: 'object', properties: { command: { type: 'string' }, args: {} }, required: ['command'] },
      run: async (a) => json(await renderer().call('runCommand', a)),
    },
    {
      name: 'ide_notify',
      description: 'Show the user an in-app notification.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, kind: { type: 'string', enum: ['info', 'success', 'warning', 'error'] } }, required: ['title'] },
      run: async (a) => json(await renderer().call('notify', a)),
    },
    {
      name: 'ide_set_appearance',
      description: 'Change how the IDE looks. theme: system|light|dark. contrast: default|strong. fontSize: 12-18. conversationWidth: default|wide|full. light / dark: { preset?, background?, foreground?, accent? } with #RRGGBB colours. contributedTheme: id of a plugin theme to apply.',
      inputSchema: {
        type: 'object',
        properties: {
          theme: { type: 'string', enum: ['system', 'light', 'dark'] }, contrast: { type: 'string', enum: ['default', 'strong'] },
          fontSize: { type: 'number' }, conversationWidth: { type: 'string', enum: ['default', 'wide', 'full'] },
          light: { type: 'object', properties: { preset: { type: 'string' }, background: { type: 'string' }, foreground: { type: 'string' }, accent: { type: 'string' } } },
          dark: { type: 'object', properties: { preset: { type: 'string' }, background: { type: 'string' }, foreground: { type: 'string' }, accent: { type: 'string' } } },
          contributedTheme: { type: 'string' },
        },
      },
      run: async (a) => json(await renderer().call('setAppearance', a)),
    },
    {
      name: 'ide_set_layout',
      description: 'Show or hide parts of the window: sidebarCollapsed, bottomPanel (terminal), sideDock (browser beside the chat).',
      inputSchema: { type: 'object', properties: { sidebarCollapsed: { type: 'boolean' }, bottomPanel: { type: 'boolean' }, sideDock: { type: 'boolean' } } },
      run: async (a) => json(await renderer().call('setLayout', a)),
    },
    {
      name: 'ide_open_file',
      description: 'Open a file in the IDE editor, optionally at a line.',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path' }, line: { type: 'number' }, root: { type: 'string', description: 'Project folder for the explorer' } }, required: ['path'] },
      run: async (a) => json(await renderer().call('openFile', a)),
    },
    {
      name: 'ide_terminal_run',
      description: 'Start a command in a new, visible terminal tab of the IDE (e.g. a dev server the user should watch). Returns the terminal id; read its output with ide_terminal_read.',
      inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] },
      run: async (a) => {
        const t = ctx.services.terminal;
        if (!t) throw new Error('Terminals are not available.');
        const r = t.run(String(a.command), a.cwd ? String(a.cwd) : undefined);
        return json({ ...r, note: 'Started in a visible terminal tab. Poll ide_terminal_read for output.' });
      },
    },
    {
      name: 'ide_terminal_read',
      description: 'Read the recent output of an IDE terminal (or list terminals when no id is given).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, maxChars: { type: 'number' } } },
      run: async (a) => {
        const t = ctx.services.terminal;
        if (!t) throw new Error('Terminals are not available.');
        if (!a.id) return json(t.list());
        const tail = stripAnsi(t.tail(String(a.id)));
        const max = Math.min(40_000, Number(a.maxChars) || 8000);
        return tail.slice(-max) || '(no output yet)';
      },
    },
    {
      name: 'ide_plugin_list',
      description: 'List user plugins with their manifests and enabled state (built-in plugins are listed by ide_describe).',
      inputSchema: { type: 'object', properties: {} },
      run: async () => json(listUserPlugins(ctx).map(p => ({ manifest: p.manifest, enabled: p.enabled, hasScript: p.hasScript, trusted: p.trusted, error: p.error, dir: p.dir }))),
    },
    {
      name: 'ide_plugin_read',
      description: 'Read one user plugin: its manifest, its files, or one file.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, file: { type: 'string' } }, required: ['id'] },
      run: async (a) => {
        const p = listUserPlugins(ctx).find(x => x.manifest.id === a.id);
        if (!p) throw new Error(`No user plugin "${a.id}".`);
        if (a.file) return readPluginFile(ctx, String(a.id), String(a.file));
        const files = p.dir ? fs.readdirSync(p.dir, { recursive: true }).map(String) : [];
        return json({ manifest: p.manifest, files, enabled: p.enabled, error: p.error });
      },
    },
    {
      name: 'ide_plugin_save',
      description: 'Create or replace a user plugin (see the PLUGINS section of your instructions for the manifest format). files: extra files by relative name, e.g. { "view.html": "<!doctype html>…" }. The manifest is validated; the IDE reloads it at once. Tell the user what you added and where it shows up.',
      inputSchema: { type: 'object', properties: { manifest: { type: 'object' }, files: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['manifest'] },
      run: async (a) => {
        const m = savePlugin(ctx, a.manifest, (a.files ?? {}) as Record<string, string>);
        setPluginEnabled(ctx, m.id, true);
        return json({ saved: m.id, contributes: Object.fromEntries(Object.entries(m.contributes).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])), note: 'Installed and enabled. Frame views and widgets ask the user to trust them the first time.' });
      },
    },
    {
      name: 'ide_plugin_set_enabled',
      description: 'Switch a plugin on or off — a user plugin or a built-in feature (e.g. "aico.github").',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['id', 'enabled'] },
      run: async (a) => json(await renderer().call('setPluginEnabled', a)),
    },
    {
      name: 'ide_plugin_remove',
      description: 'Remove a user plugin (its folder goes to the system trash, so it can be recovered).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: async (a) => { await removePlugin(ctx, String(a.id)); return `Removed ${a.id}.`; },
    },

    // ── Browser ──
    {
      name: 'browser_open',
      description: 'Open a URL in the IDE\'s built-in browser (the user sees it). Use newTab to keep the current page.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' }, newTab: { type: 'boolean' } }, required: ['url'] },
      run: async (a) => json(await (await browser()).open(String(a.url), { newTab: Boolean(a.newTab) })),
    },
    {
      name: 'browser_snapshot',
      description: 'Read the current page: title, URL, headings, every visible interactive element with a ref ([e1], [e2]…) to use with click/type/select, and the visible text. full: include more elements and text.',
      inputSchema: { type: 'object', properties: { full: { type: 'boolean' } } },
      run: async (a) => (await browser()).snapshot({ full: Boolean(a.full) }),
    },
    {
      name: 'browser_click',
      description: 'Click an element (trusted mouse input). Give ref (best), selector, or visible text.',
      inputSchema: { type: 'object', properties: { ...TARGET_PROPS, double: { type: 'boolean' }, button: { type: 'string', enum: ['left', 'right'] } } },
      run: async (a) => (await browser()).click(target(a), { double: Boolean(a.double), button: a.button === 'right' ? 'right' : 'left' }),
    },
    {
      name: 'browser_type',
      description: 'Type into a field (replaces what is there unless clear is false). submit presses Enter after.',
      inputSchema: { type: 'object', properties: { ...TARGET_PROPS, value: { type: 'string', description: 'What to type' }, clear: { type: 'boolean' }, submit: { type: 'boolean' } }, required: ['value'] },
      run: async (a) => (await browser()).type(target(a), String(a.value ?? ''), { clear: a.clear !== false, submit: Boolean(a.submit) }),
    },
    {
      name: 'browser_select',
      description: 'Choose an option in a <select> by its value or visible text.',
      inputSchema: { type: 'object', properties: { ...TARGET_PROPS, value: { type: 'string' } }, required: ['value'] },
      run: async (a) => (await browser()).select(target(a), String(a.value)),
    },
    {
      name: 'browser_press',
      description: 'Press a key or chord: Enter, Tab, Escape, ArrowDown, PageDown, Ctrl+A, Shift+Tab…',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      run: async (a) => (await browser()).press(String(a.key)),
    },
    {
      name: 'browser_hover',
      description: 'Move the mouse over an element (menus, tooltips).',
      inputSchema: { type: 'object', properties: TARGET_PROPS },
      run: async (a) => (await browser()).hover(target(a)),
    },
    {
      name: 'browser_scroll',
      description: 'Scroll the page (direction and amount in px) or scroll an element into view (ref/selector/text).',
      inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number' }, ...TARGET_PROPS } },
      run: async (a) => {
        const t = target(a);
        return (await browser()).scroll({ direction: a.direction as 'down' | undefined, amount: typeof a.amount === 'number' ? a.amount : undefined, target: Object.keys(t).length ? t : undefined });
      },
    },
    {
      name: 'browser_wait',
      description: 'Wait until text or a selector appears (timeoutMs up to 25000), or just wait ms.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' }, selector: { type: 'string' }, ms: { type: 'number' }, timeoutMs: { type: 'number' } } },
      run: async (a) => (await browser()).waitFor({ text: a.text as string | undefined, selector: a.selector as string | undefined, ms: a.ms as number | undefined, timeoutMs: a.timeoutMs as number | undefined }),
    },
    {
      name: 'browser_text',
      description: 'The full text of the page, or of one element.',
      inputSchema: { type: 'object', properties: TARGET_PROPS },
      run: async (a) => { const t = target(a); return (await browser()).text(Object.keys(t).length ? t : undefined); },
    },
    {
      name: 'browser_evaluate',
      description: 'Run a JavaScript expression in the page and return its (JSON) value. For reading state; prefer click/type for actions.',
      inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
      run: async (a) => json(await (await browser()).evaluate(String(a.expression))),
    },
    {
      name: 'browser_screenshot',
      description: 'Save a PNG of the page (fullPage for the whole scroll height) and return its path. Read the file to look at it.',
      inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' } } },
      run: async (a) => {
        const s = await (await browser()).screenshot({ fullPage: Boolean(a.fullPage) });
        return json({ path: s.path, width: s.width, height: s.height });
      },
    },
    {
      name: 'browser_console',
      description: 'Console messages of the current page (errors first-class). clear empties the log after reading.',
      inputSchema: { type: 'object', properties: { clear: { type: 'boolean' } } },
      run: async (a) => (await browser()).consoleLog(Boolean(a.clear)),
    },
    {
      name: 'browser_network',
      description: 'Recent network requests of the current page: status, method, type, URL.',
      inputSchema: { type: 'object', properties: { clear: { type: 'boolean' } } },
      run: async (a) => (await browser()).networkLog(Boolean(a.clear)),
    },
    {
      name: 'browser_tabs',
      description: 'List, select, open or close browser tabs.',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'select', 'close', 'new'] }, id: { type: 'string' }, url: { type: 'string' } }, required: ['action'] },
      run: async (a) => {
        const b = await browser();
        if (a.action === 'select' && a.id) b.selectTab(String(a.id));
        if (a.action === 'close') b.closeTab(a.id ? String(a.id) : undefined);
        if (a.action === 'new') await b.open(String(a.url ?? 'about:blank'), { newTab: true });
        return json(b.tabs());
      },
    },
    {
      name: 'browser_navigate',
      description: 'Back, forward or reload.',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['back', 'forward', 'reload'] } }, required: ['action'] },
      run: async (a) => {
        const b = await browser();
        return a.action === 'back' ? b.back() : a.action === 'forward' ? b.forward() : b.reload();
      },
    },
    {
      name: 'browser_handoff',
      description: 'Ask the user to do something in the browser that you must not — sign in, enter an MFA code, solve a CAPTCHA, approve a payment. Shows them a banner with your message and a Done button. Then poll browser_handoff_wait.',
      inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      run: async (a) => {
        const b = await browser();
        const id = crypto.randomUUID();
        handoffs.set(id, { done: false });
        void b.handoff(String(a.message)).then((answer) => { handoffs.set(id, { done: true, answer }); });
        return json({ handoffId: id, note: 'The user has been asked. Call browser_handoff_wait with this id until it reports done.' });
      },
    },
    {
      name: 'browser_handoff_wait',
      description: 'Wait up to `seconds` (max 25) for the user to finish a hand-over. Returns done or still waiting.',
      inputSchema: { type: 'object', properties: { handoffId: { type: 'string' }, seconds: { type: 'number' } }, required: ['handoffId'] },
      run: async (a) => {
        const id = String(a.handoffId);
        const deadline = Date.now() + Math.min(25, Number(a.seconds) || 20) * 1000;
        while (Date.now() < deadline) {
          const h = handoffs.get(id);
          if (!h) throw new Error('Unknown hand-over id.');
          if (h.done) { handoffs.delete(id); return `Done: ${h.answer}`; }
          await new Promise(r => setTimeout(r, 500));
        }
        return 'Still waiting for the user. Call browser_handoff_wait again, or tell the user what you are waiting for.';
      },
    },
  ];
  return tools;
}

const handoffs = new Map<string, { done: boolean; answer?: string }>();

export interface McpEndpoint { url: string; token: string; close: () => void }

/** Start the endpoint. Resolves once it is listening. */
export async function startMcp(ctx: DesktopContext): Promise<McpEndpoint> {
  const token = crypto.randomBytes(24).toString('base64url');
  const tools = createTools(ctx);
  const byName = new Map(tools.map(t => [t.name, t]));
  const log = (line: string): void => {
    try {
      fs.mkdirSync(path.join(ctx.paths.desktopDir, 'logs'), { recursive: true });
      fs.appendFileSync(path.join(ctx.paths.desktopDir, 'logs', 'mcp.log'), `${new Date().toISOString()} ${line}\n`);
    } catch { /* logging is best effort */ }
  };

  const server = http.createServer((req, res) => {
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST') { reply(405, { error: 'POST only' }); return; }
    if (req.headers.authorization !== `Bearer ${token}`) { reply(401, { error: 'unauthorised' }); return; }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } }); return; }
      const ok = (result: unknown): void => reply(200, { jsonrpc: '2.0', id: msg.id, result });
      const fail = (message: string, code = -32000): void => reply(200, { jsonrpc: '2.0', id: msg.id, error: { code, message } });
      try {
        switch (msg.method) {
          case 'initialize':
            ok({
              protocolVersion: '2024-11-05',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: MCP_NAME, version: '1.0.0' },
              instructions: manual(ctx),
            });
            return;
          case 'notifications/initialized':
          case 'ping':
            ok({});
            return;
          // Asked of every server; answering with an error marks the whole
          // connection unhealthy in the engine, so answer honestly: none.
          case 'resources/list':
            ok({ resources: [] });
            return;
          case 'prompts/list':
            ok({ prompts: [] });
            return;
          case 'tools/list':
            ok({ tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
            return;
          case 'tools/call': {
            const name = String(msg.params?.name ?? '');
            const tool = byName.get(name);
            if (!tool) { fail(`Unknown tool ${name}`, -32601); return; }
            const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
            const started = Date.now();
            try {
              const text = await Promise.race([
                tool.run(args),
                new Promise<string>((_, reject) => setTimeout(() => reject(new Error(`${name} took longer than 27s and was stopped.`)), 27_000)),
              ]);
              log(`ok ${name} ${Date.now() - started}ms`);
              ctx.emit('activity:tool', { name, ok: true, ms: Date.now() - started });
              ok({ content: [{ type: 'text', text }] });
            } catch (err) {
              log(`error ${name}: ${(err as Error).message}`);
              ok({ content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true });
            }
            return;
          }
          default:
            fail(`Method not found: ${msg.method}`, -32601);
        }
      } catch (err) {
        fail((err as Error).message);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, token, close: () => server.close() };
}
