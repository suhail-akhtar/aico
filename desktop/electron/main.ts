/**
 * AICO Desktop — the Electron main process.
 *
 * Starts the engine in a utility process, serves the interface from
 * `aico://app/`, and wires the desktop-only services (window, tray,
 * notifications, files, terminal, GitHub, the built-in browser, plugins, and
 * the MCP endpoint through which the agent drives all of them).
 *
 * @module desktop/electron/main
 */

import { app, BrowserWindow, Menu, nativeTheme, screen, Tray, nativeImage } from 'electron';
import { session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EngineHost } from './engine-host';
import { attachEmbedReferer, handleProtocol, registerSchemePrivileges, APP_ORIGIN } from './protocol';
import { PrefsStore } from './prefs';
import { makeHandle, type DesktopContext } from './context';
import { applyPowerPrefs, registerCoreIpc } from './core-ipc';
import { registerFeatures } from './features';
import { startMcp, MCP_NAME } from './mcp';
import { eventRoute } from './browser-window-core';
import { openExternalLink } from './external-link';

const distDir = __dirname;
const aicoHome = process.env.AICO_HOME || path.join(os.homedir(), '.aico');
const desktopDir = path.join(aicoHome, 'desktop');
const pluginsDir = path.join(desktopDir, 'plugins');
fs.mkdirSync(pluginsDir, { recursive: true });

app.setName('AICO');
if (process.platform === 'win32') app.setAppUserModelId('dev.aico.desktop');
// Keep the agent's own browser profile and the app's data out of each other.
app.setPath('userData', path.join(desktopDir, 'electron'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

registerSchemePrivileges();

const prefs = new PrefsStore(path.join(desktopDir, 'prefs.json'));
// The engine starts inside its own workspace root, so the launch folder and
// the scratch workspace are one entry ("Scratch") rather than a stray project
// named after whatever folder the app happened to start in.
const engineCwd = path.join(aicoHome, 'workspace', 'projects', 'desktop');
fs.mkdirSync(engineCwd, { recursive: true });
const engine = new EngineHost(path.join(distDir, 'engine', 'engine.mjs'), {
  AICO_HOME: aicoHome,
  AICO_DESKTOP: '1',
  AICO_DESKTOP_CWD: engineCwd,
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const show = (w: BrowserWindow): void => {
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
};

const ctx: DesktopContext = {
  services: {},
  window: () => mainWindow,
  browserWindow: () => ctx.services.browserWindow?.window() ?? mainWindow,
  prefs,
  engine,
  paths: { aicoHome, desktopDir, pluginsDir, distDir },
  emit(channel, payload) {
    // While the browser has a window of its own, what it says goes there (browser-window-core.ts).
    const own = ctx.services.browserWindow?.window() ?? null;
    const to = eventRoute(channel, own !== null);
    if (to.main && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    if (to.browser && own && !own.isDestroyed()) own.webContents.send(channel, payload);
  },
  handle: makeHandle(),
  reveal() {
    if (!mainWindow) { createWindow(); return; }
    show(mainWindow);
  },
  revealBrowser() {
    const own = ctx.services.browserWindow?.window();
    if (own) show(own); else ctx.reveal();
  },
};

engine.on('state', (s) => ctx.emit('engine:status', s));
// Prefs can change from outside the window's own controls (the agent's IDE
// tools, a plugin, a second window): the interface follows them.
prefs.on('change', (p) => ctx.emit('prefs:changed', p));

function isDark(): boolean {
  const mode = prefs.get().theme;
  return mode === 'dark' || (mode === 'system' && nativeTheme.shouldUseDarkColors);
}

function appIcon(): Electron.NativeImage | undefined {
  for (const name of ['icon.png', '../build/icon.png']) {
    const p = path.join(distDir, name);
    if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  }
  return undefined;
}

function createWindow(): void {
  const p = prefs.get();
  const bounds = { ...p.window };
  // A window remembered on a monitor that is no longer attached opens off-screen.
  const visible = screen.getAllDisplays().some(d => bounds.x !== undefined && bounds.y !== undefined
    && bounds.x >= d.bounds.x - 50 && bounds.y >= d.bounds.y - 50
    && bounds.x < d.bounds.x + d.bounds.width && bounds.y < d.bounds.y + d.bounds.height);
  const dark = isDark();
  const bg = dark ? p.dark.background : p.light.background;

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(visible ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'AICO',
    icon: appIcon(),
    backgroundColor: bg,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : {
      color: bg,
      symbolColor: dark ? p.dark.foreground : p.light.foreground,
      height: 40,
    },
    webPreferences: {
      preload: path.join(distDir, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      webviewTag: false,
    },
  });
  if (p.window.maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  void mainWindow.loadURL(`${APP_ORIGIN}/`);

  const saveBounds = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    const b = maximized ? prefs.get().window : { ...mainWindow.getBounds(), maximized: false };
    prefs.set({ window: { ...b, maximized } });
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);
  mainWindow.on('maximize', () => { saveBounds(); ctx.emit('win:maximized', true); });
  mainWindow.on('unmaximize', () => { saveBounds(); ctx.emit('win:maximized', false); });
  mainWindow.on('focus', () => { mainWindow?.flashFrame(false); ctx.emit('win:focus', true); });
  mainWindow.on('blur', () => ctx.emit('win:focus', false));

  mainWindow.on('close', (e) => {
    if (!quitting && prefs.get().keepInTray && tray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // Links leave the app; the app never navigates away from itself.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalLink(url, 'window.open').catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      e.preventDefault();
      void openExternalLink(url, 'navigation').catch(() => {});
    }
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') void mainWindow?.loadURL(`${APP_ORIGIN}/`);
  });
}

function createTray(): void {
  const icon = appIcon();
  if (!icon) return;
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('AICO');
  const menu = Menu.buildFromTemplate([
    { label: 'Open AICO', click: () => ctx.reveal() },
    { label: 'New chat', click: () => { ctx.reveal(); ctx.emit('command:run', { id: 'chat.new' }); } },
    { type: 'separator' },
    { label: 'Quit AICO', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => ctx.reveal());
}

/**
 * A hidden application menu: no menu bar is drawn (the interface has its own),
 * but the standard editing and developer accelerators still work.
 */
function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Command palette', accelerator: 'CmdOrCtrl+K', click: () => ctx.emit('command:run', { id: 'palette.open' }) },
        { label: 'Command palette', accelerator: 'CmdOrCtrl+Shift+P', click: () => ctx.emit('command:run', { id: 'palette.open' }), visible: false },
        { label: 'New chat', accelerator: 'CmdOrCtrl+N', click: () => ctx.emit('command:run', { id: 'chat.new' }) },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => ctx.emit('command:run', { id: 'settings.open' }) },
        { label: 'Toggle sidebar', accelerator: 'CmdOrCtrl+B', click: () => ctx.emit('command:run', { id: 'sidebar.toggle' }) },
        { label: 'Search chats', accelerator: 'CmdOrCtrl+Shift+F', click: () => ctx.emit('command:run', { id: 'search.open' }) },
        { type: 'separator' },
        { role: 'reload', accelerator: 'CmdOrCtrl+Shift+R' },
        { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Alt+I' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('second-instance', () => ctx.reveal());

app.whenReady().then(async () => {
  nativeTheme.themeSource = prefs.get().theme;
  handleProtocol({
    rendererDir: path.join(distDir, 'renderer'), pluginDir: () => pluginsDir, engine,
    // A person's Allow on a tool-permission prompt travels over the private port (vault-host.ts).
    decidePermission: (sessionId, id, allow) => ctx.services.vaultHost?.decidePermission(sessionId, id, allow) ?? Promise.resolve(false),
    // A person's "Install and enable" on a skill review, the same way (decision-gate.ts checkHuman).
    mintHumanGrant: () => {
      const nonce = crypto.randomBytes(24).toString('base64url');
      engine.post({ type: 'human/grant', nonce });
      return nonce;
    },
  });
  attachEmbedReferer(session.defaultSession);
  registerCoreIpc(ctx);
  registerFeatures(ctx);
  applyPowerPrefs(ctx);
  // The agent's way into the IDE and browser: connected to this engine only,
  // for this run only (never saved to settings).
  try {
    const mcp = await startMcp(ctx);
    engine.setEnv({ AICO_HOST_MCP: JSON.stringify({ [MCP_NAME]: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } }) });
    // Plugin instructions are part of the endpoint's manual; reconnect so a
    // plugin switched on or off changes what the agent is told.
    let reloadTimer: NodeJS.Timeout | null = null;
    const origEmit = ctx.emit.bind(ctx);
    ctx.emit = (channel, payload) => {
      origEmit(channel, payload);
      if (channel === 'plugins:changed') {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => { void engine.request('mcp/reload', {}).catch(() => {}); }, 1500);
      }
    };
  } catch (err) {
    console.error('Desktop MCP endpoint failed to start:', err);
  }
  engine.start();
  installMenu();
  createWindow();
  createTray();
});

app.on('activate', () => { if (!mainWindow) createWindow(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !(prefs.get().keepInTray && tray)) app.quit();
});

let stopped = false;
app.on('before-quit', (e) => {
  quitting = true;
  prefs.flush();
  if (stopped) return;
  e.preventDefault();
  void engine.stop().finally(() => { stopped = true; app.quit(); });
});
