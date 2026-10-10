/**
 * A simulated adb, for testing the mobile sandbox without a device.
 *
 * WHY: there is no emulator on the build machines, and the mobile adapter must
 * still be proven against the exact command shapes it sends (`uiautomator dump`,
 * `input tap`, `am start ...`) and the exact output shapes it parses. This
 * program answers those commands for a tiny two-screen app ("Greeter": a name
 * box, Greet and About buttons, a result label; an About screen with Back) and
 * appends every command it receives to a log so a test can assert on them.
 *
 * What it does NOT prove: that a real Android answers the same way. The first
 * live run against an emulator is the real check, and the ADR says so.
 *
 * Usage: node fake-adb.mjs --state <file> [--log <file>] [--variant wrong] <adb args...>
 * State (current screen, field text, result, rotation, foreground) lives in a JSON
 * file so successive invocations see each other's effects, like a device would.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const take = (flag) => { const i = argv.indexOf(flag); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const statePath = take('--state');
const logPath = take('--log');
const variant = take('--variant') ?? 'target';
const PKG = 'com.example.greeter';

const load = () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return { screen: 'main', field: '', result: '', rotation: 0, foreground: false, perms: {}, notes: [] }; } };
const save = (s) => fs.writeFileSync(statePath, JSON.stringify(s));
const log = (line) => { if (logPath) fs.appendFileSync(logPath, line + '\n'); };

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const node = (o, children = '') => `<node index="0" text="${esc(o.text ?? '')}" resource-id="${o.id ?? ''}" class="${o.cls}" package="${PKG}" content-desc="${esc(o.desc ?? '')}" checkable="false" checked="false" clickable="${!!o.click}" enabled="true" focusable="${!!o.click}" focused="${!!o.focused}" scrollable="false" password="false" selected="false" bounds="[${o.b[0]},${o.b[1]}][${o.b[2]},${o.b[3]}]">${children}</node>`;

function screenNodes(s) {
  const land = s.rotation === 1;
  const W = land ? 1920 : 1080, H = land ? 1080 : 1920;
  const hello = variant === 'wrong' ? 'Hi' : 'Hello';
  let body;
  if (s.screen === 'about') {
    body = node({ cls: 'android.widget.TextView', text: variant === 'wrong' ? 'About this app' : 'About Greeter v1', b: [60, 120, 1020, 240] })
      + node({ cls: 'android.widget.Button', text: 'Back', id: `${PKG}:id/backBtn`, click: true, b: [60, 300, 500, 420] });
  } else {
    body = node({ cls: 'android.widget.TextView', text: 'Greeter', b: [60, 120, 1020, 240] })
      + node({ cls: 'android.widget.EditText', text: s.field, id: `${PKG}:id/name`, click: true, focused: true, b: [60, 300, 1020, 420] })
      + node({ cls: 'android.widget.Button', text: 'Greet', id: `${PKG}:id/greetBtn`, click: true, b: [60, 460, 500, 580] })
      + node({ cls: 'android.widget.Button', text: 'About', id: `${PKG}:id/aboutBtn`, click: true, b: [520, 460, 1020, 580] })
      + node({ cls: 'android.widget.TextView', text: s.result, id: `${PKG}:id/resultText`, b: [60, 620, 1020, 740] });
  }
  void hello;
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="${s.rotation}">${node({ cls: 'android.widget.FrameLayout', b: [0, 0, W, H] }, body)}</hierarchy>`;
  return xml;
}

function pngOf(rgb, size = 96) {
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const nodesOf = (xml) => [...xml.matchAll(/<node [^>]*>/g)].map(m => { const t = m[0]; const g = (k) => (new RegExp(`${k}="([^"]*)"`).exec(t) ?? [])[1] ?? ''; const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(t).slice(1).map(Number); return { id: g('resource-id'), text: g('text'), click: g('clickable') === 'true', b }; });

function tap(s, x, y) {
  const hit = nodesOf(screenNodes(s)).filter(n => n.click && x >= n.b[0] && x <= n.b[2] && y >= n.b[1] && y <= n.b[3]).pop();
  if (!hit) return;
  const hello = variant === 'wrong' ? 'Hi' : 'Hello';
  if (hit.id.endsWith('greetBtn')) s.result = `${hello}, ${s.field}!`;
  else if (hit.id.endsWith('aboutBtn')) s.screen = 'about';
  else if (hit.id.endsWith('backBtn')) s.screen = 'main';
}

function shell(cmd) {
  const s = load();
  log(`shell ${cmd}`);
  let out = '';
  let m;
  if (/^am force-stop /.test(cmd)) { s.foreground = false; s.screen = 'main'; s.field = ''; s.result = ''; }
  else if (/^monkey /.test(cmd) || /^am start -n /.test(cmd)) s.foreground = true;
  else if (/^uiautomator dump /.test(cmd)) { /* the dump is served by exec-out cat */ }
  else if ((m = /^input tap (\d+) (\d+)$/.exec(cmd))) tap(s, Number(m[1]), Number(m[2]));
  else if ((m = /^input text '(.*)'$/.exec(cmd))) s.field += m[1].replace(/%s/g, ' ').replace(/'\\''/g, "'");
  else if ((m = /^input keyevent (.+)$/.exec(cmd))) {
    for (const k of m[1].split(' ').map(Number)) {
      if (k === 67) s.field = s.field.slice(0, -1);
      else if (k === 4) { if (s.screen === 'about') s.screen = 'main'; else s.foreground = false; }
      else if (k === 3) s.foreground = false;
    }
  }
  else if (/^input swipe /.test(cmd)) { /* no scrollable content */ }
  else if ((m = /^settings put system user_rotation (\d)$/.exec(cmd))) s.rotation = Number(m[1]);
  else if (/^settings put system accelerometer_rotation/.test(cmd)) { /* accepted */ }
  else if ((m = /^am start -a android\.intent\.action\.VIEW -d '(.*)' /.exec(cmd))) { s.foreground = true; if (/about/.test(m[1])) s.screen = 'about'; }
  else if ((m = /^pm (grant|revoke) \S+ (\S+)$/.exec(cmd))) s.perms[m[2]] = m[1] === 'grant';
  else if (/^cmd notification post /.test(cmd)) s.notes.push(cmd);
  else if (/^dumpsys window/.test(cmd)) out = `  mCurrentFocus=Window{1a2b3c u0 ${PKG}/${PKG}.${s.screen === 'about' ? 'AboutActivity' : 'MainActivity'}}\n`;
  else { process.stderr.write(`fake-adb: unknown shell command: ${cmd}\n`); process.exit(1); }
  save(s);
  process.stdout.write(out);
}

const [cmd, ...rest] = argv;
if (cmd === 'get-state') { log('get-state'); process.stdout.write('device\n'); }
else if (cmd === 'shell') shell(rest.join(' '));
else if (cmd === 'exec-out') {
  log(`exec-out ${rest.join(' ')}`);
  const s = load();
  if (rest[0] === 'cat') process.stdout.write(s.foreground ? screenNodes(s) : `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.launcher" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" password="false" selected="false" bounds="[0,0][1080,1920]"/></hierarchy>`);
  else if (rest[0] === 'screencap') process.stdout.write(pngOf(variant === 'wrong' ? [255, 243, 224] : s.screen === 'about' ? [230, 236, 250] : [244, 246, 251]));
}
else { process.stderr.write(`fake-adb: unknown command ${cmd}\n`); process.exit(1); }
