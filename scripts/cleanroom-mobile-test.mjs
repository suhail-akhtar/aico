/**
 * Mobile reconstruction over adb (ADR 0041), proven against a SIMULATED adb.
 *
 * WHY simulated: there is no Android device or emulator on the machines that run
 * this suite. scripts/fixtures/fake-adb.mjs answers the exact commands the
 * adapter sends (uiautomator dump, input tap/text/keyevent/swipe, am start,
 * pm grant, cmd notification post, settings put, dumpsys window, screencap) for a
 * tiny two-screen app and logs each command. So this proves the adapter's command
 * shapes, its XML parsing, the explorer/spec/twin wiring for a screen-based
 * target, and its error paths. It does NOT prove a real Android answers the same
 * way; the first run against an emulator is the real check (the ADR says so).
 */
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from '../dist-test/test-exports.js';

const C = T.cleanroom;
let passed = 0, failed = 0;
const ok = (c, m, d) => { if (c) { passed++; console.log(`  ok    ${m}`); } else { failed++; console.log(`  FAIL  ${m}`, d === undefined ? '' : JSON.stringify(d).slice(0, 600)); } };
const section = (t) => console.log(`\n── ${t} ──`);

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, 'fixtures', 'fake-adb.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanroom-mobile-test-'));
const log = path.join(base, 'adb.log');
const adbFor = (variant, name) => `"${process.execPath}" "${fake}" --state "${path.join(base, name + '.json')}" --log "${log}" --variant ${variant}`;
const launch = (variant, name) => ({ kind: 'mobile', appId: 'com.example.greeter', adb: adbFor(variant, name), name: 'greeter', timeoutMs: 8000 });
const commands = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

section('the XML parser');
const xml = `<?xml version='1.0'?><hierarchy rotation="0"><node text="" resource-id="" class="android.widget.FrameLayout" package="p" content-desc="" clickable="false" enabled="true" scrollable="false" bounds="[0,0][1080,1920]"><node text="A &amp; B" resource-id="p:id/x" class="android.widget.Button" package="p" content-desc="d" clickable="true" enabled="false" scrollable="false" bounds="[10,20][110,220]"/><node text="t" resource-id="" class="android.widget.TextView" package="p" content-desc="" clickable="false" enabled="true" scrollable="true" bounds="[0,300][50,340]"/></node></hierarchy>`;
const nodes = C.parseUiXml(xml);
ok(nodes.length === 3 && nodes[0].depth === 0 && nodes[1].depth === 1 && nodes[2].depth === 1, 'nesting depth survives self-closing nodes', nodes.map(n => n.depth));
ok(nodes[1].text === 'A & B' && nodes[1].id === 'p:id/x' && nodes[1].desc === 'd' && nodes[1].clickable && !nodes[1].enabled && nodes[1].bounds.join() === '10,20,110,220', 'text entities, ids, descriptions, flags and bounds are read', nodes[1]);
ok(nodes[2].scrollable && C.parseUiXml('not xml').length === 0, 'scrollable is read, and garbage yields no nodes');

section('the sandbox: tree, controls, actions, system events');
const sb = new C.MobileSandbox();
await sb.start(launch('target', 'a'));
ok(commands().some(c => c === 'get-state') && commands().some(c => /^shell monkey -p com\.example\.greeter /.test(c)), 'it checks the device and launches the app by package', commands().slice(0, 4));
let o = await sb.observe();
ok(o.kind === 'mobile' && o.title === 'MainActivity', 'the title is the focused activity', o.title);
ok(/EditText/.test(o.tree) && /Button "Greet"/.test(o.tree) && /\(clickable\)/.test(o.tree), 'the accessibility tree is the outline of the screen', o.tree);
const by = (n) => o.controls.find(c => c.name === n);
ok(by('Greet')?.selector === 'id:com.example.greeter:id/greetBtn' && by('About')?.role === 'button' && o.controls.some(c => c.role === 'textbox'), 'clickable views and fields are controls with selectors that find them again', o.controls);
ok(['system: Back', 'system: rotate', 'system: background and resume'].every(n => by(n)?.selector.startsWith('sys:')), 'system events are offered as controls so the explorer exercises them');
ok(o.style.viewport.width === 1080 && o.style.viewport.height === 1920 && o.style.layout.length > 0, 'the screen size and layout boxes are measured', o.style.viewport);
ok(o.frame && o.frame.length > 50 && o.style.colors.background.length > 0, 'a screenshot is taken and its dominant colours measured', o.style.colors);

const box = o.controls.find(c => c.role === 'textbox');
await sb.inject({ type: 'fill', selector: box.selector, value: 'Ana Maria' });
ok(commands().some(c => /^shell input text 'Ana%sMaria'$/.test(c)), 'a space is sent as %s, the way adb input text needs it', commands().filter(c => /input text/.test(c)));
await sb.inject({ type: 'click', selector: by('Greet').selector });
o = await sb.observe();
ok(/Hello, Ana Maria!/.test(o.text), 'a field is filled and a button tapped: the label changes', o.text);
ok(commands().some(c => /^shell input tap 280 520$/.test(c)), 'a tap goes to the centre of the element bounds', commands().filter(c => /input tap/.test(c)));
await sb.inject({ type: 'fill', selector: box.selector, value: 'Bo' });
await sb.inject({ type: 'click', selector: by('Greet').selector });
ok(/Hello, Bo!/.test((await sb.observe()).text), 'filling again clears the old text first');

await sb.inject({ type: 'click', selector: 'id:com.example.greeter:id/aboutBtn' });
o = await sb.observe();
ok(o.title === 'AboutActivity' && /About Greeter v1/.test(o.text), 'navigating changes the screen', o.title);
const fp1 = await sb.snapshot();
await sb.inject({ type: 'click', selector: 'sys:back' });
o = await sb.observe();
ok(o.title === 'MainActivity' && (await sb.snapshot()) !== fp1, 'the system Back control returns, and the state fingerprint differs between screens');

await sb.inject({ type: 'click', selector: 'sys:rotate' });
o = await sb.observe();
ok(o.style.viewport.width === 1920 && commands().some(c => /user_rotation 1$/.test(c)), 'rotation is sent to the device and the new size observed', o.style.viewport);
await sb.inject({ type: 'rotate', orientation: 'portrait' });
ok((await sb.observe()).style.viewport.width === 1080, 'and back to portrait');

await sb.inject({ type: 'background' });
ok(commands().some(c => c === 'shell input keyevent 3'), 'Home is key 3', commands().filter(c => /keyevent/.test(c)));
await sb.inject({ type: 'resume' });
ok((await sb.observe()).title === 'MainActivity', 'resume brings the app back to the front');
await sb.inject({ type: 'deeplink', url: 'greeter://about' });
ok((await sb.observe()).title === 'AboutActivity' && commands().some(c => /^shell am start -a android\.intent\.action\.VIEW -d 'greeter:\/\/about' com\.example\.greeter$/.test(c)), 'a deep link opens a screen directly');
await sb.inject({ type: 'permission', action: 'grant', permission: 'android.permission.CAMERA' });
await sb.inject({ type: 'notify', title: "It's mail", text: 'hello there' });
ok(commands().some(c => /^shell pm grant com\.example\.greeter android\.permission\.CAMERA$/.test(c)), 'a runtime permission is granted through pm');
ok(commands().some(c => /^shell cmd notification post -S bigtext -t 'It'\\''s mail' cleanroom 'hello there'$/.test(c)), 'a notification is posted, with the quote in the title escaped for the shell', commands().filter(c => /notification/.test(c)));

await sb.inject({ type: 'click', selector: 'id:nothing:id/here' });
ok(/no element matches/.test((await sb.observe()).error ?? ''), 'a selector that matches nothing is reported, not thrown');
await sb.inject({ type: 'press', key: 'Hyper' });
ok(/unknown key/.test((await sb.observe()).error ?? ''), 'an unknown key is reported');
let threw = false;
try { await sb.inject({ type: 'run', command: 'x' }); } catch (e) { threw = /cannot take a "run" stimulus/.test(String(e.message)); }
ok(threw, 'a stimulus that makes no sense on a phone is refused by name');
await sb.stop();
ok(commands().some(c => c === 'shell am force-stop com.example.greeter'), 'stopping force-stops the app');

section('refusals: no device, iOS, a missing app');
let msg = '';
try { await new C.MobileSandbox().start({ kind: 'mobile', appId: 'x.y', platform: 'ios' }); } catch (e) { msg = String(e.message); }
ok(/iOS is not built/.test(msg) && /Xcode/.test(msg), 'iOS is refused by name, with why', msg);
msg = '';
try { await new C.MobileSandbox().start({ kind: 'mobile', appId: 'x.y', adb: path.join(base, 'no-such-adb-binary'), timeoutMs: 2000 }); } catch (e) { msg = String(e.message); }
ok(/no Android device or emulator is connected/.test(msg) && /USB debugging/.test(msg), 'no adb or no device says what to do', msg);
msg = '';
const missing = new C.MobileSandbox();
try { await missing.start({ kind: 'mobile', appId: 'com.not.installed', adb: adbFor('target', 'b'), timeoutMs: 1500 }); } catch (e) { msg = String(e.message); }
ok(/did not come to the front/.test(msg) && /installed/.test(msg), 'an app that never appears is reported, not waited on forever', msg);

section('explore and synthesize');
const j = await C.explore('mobile-greeter', launch('target', 'c'), { maxSteps: 14, maxDepth: 3 });
const spec = C.synthesize(j, undefined, C.readExplorerState('mobile-greeter'));
ok(j.steps.length >= 4 && j.steps[0].stimulus.type === 'wait', 'the landing screen is recorded first, then actions', j.steps.map(s => `${s.stimulus.type}:${s.stimulus.selector ?? ''}`));
ok(j.steps.some(s => s.stimulus.type === 'fill') && j.steps.some(s => s.stimulus.type === 'click' && /greetBtn/.test(s.stimulus.selector)), 'a form-like screen is filled before its buttons are tapped');
ok(spec.kind === 'mobile' && spec.web.routes.some(r => r.path === 'screen:MainActivity') && spec.web.routes.some(r => r.path === 'screen:AboutActivity'), 'a screen is a route in the spec', spec.web.routes.map(r => r.path));
ok(spec.web.states.some(s => /Hello, /.test(s.summary)), 'the state after Greet shows the greeting', spec.web.states.map(s => s.summary));
ok(spec.unknowns.some(u => /haptic|push-notification|multi-touch/.test(u)), 'the spec says what adb cannot observe', spec.unknowns);
const specText = JSON.stringify(spec);
ok(!specText.includes('"frame"') && !specText.includes(base), 'no screenshot and no path on this machine in the spec');

section('twin-test a mobile clone');
const tSame = await C.twinTest({ journey: j, clone: launch('target', 'd'), maxSteps: 8 });
ok(tSame.parity === 1, 'an identical app matches on text, controls and pixels', C.renderTwinReport(tSame));
const tWrong = await C.twinTest({ journey: j, clone: launch('wrong', 'e'), maxSteps: 8 });
ok(tWrong.parity < 1 && tWrong.differences.some(d => d.field === 'text'), 'an app with other wording is caught', C.renderTwinReport(tWrong));
ok(tWrong.differences.some(d => d.field === 'frame' || d.field === 'colors'), 'and one with another background is caught visually', tWrong.differences.map(d => d.field));

try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
console.log(`\ncleanroom mobile: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
