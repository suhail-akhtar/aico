/**
 * Desktop reconstruction on Windows (ADR 0041): a real window, read and driven
 * through UI Automation.
 *
 * The target is a small WinForms application built with PowerShell for this
 * test: a name box, Greet and Clear buttons, and a result label. Proven: the
 * window is found, its accessibility tree is read (roles, names, values), the
 * controls come back with selectors, a field can be filled and a button
 * invoked, the dominant colours and layout boxes are measured, the explorer
 * walks it, the spec describes it without any screenshot, and the twin-test
 * passes an identical clone and catches one with different wording and a
 * different background. Skipped, loudly, on anything but Windows or without an
 * interactive desktop. macOS and Linux are not built.
 */
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as T from '../dist-test/test-exports.js';

const C = T.cleanroom;
let passed = 0, failed = 0;
const ok = (c, m, d) => { if (c) { passed++; console.log(`  ok    ${m}`); } else { failed++; console.log(`  FAIL  ${m}`, d === undefined ? '' : JSON.stringify(d).slice(0, 600)); } };
const section = (t) => console.log(`\n── ${t} ──`);

if (process.platform !== 'win32') {
  console.log('  SKIP  desktop automation is built for Windows only (UI Automation); macOS and Linux adapters are not built');
  console.log('\ncleanroom desktop: 0 passed, 0 failed');
  process.exit(0);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanroom-desktop-test-'));
const form = (variant) => `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Greeter'; $f.Width = 360; $f.Height = 220; $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(120, 120)
$f.BackColor = [System.Drawing.Color]::FromArgb(${variant === 'wrong' ? '255,243,224' : '244,246,251'})
$tb = New-Object System.Windows.Forms.TextBox; $tb.Name = 'nameBox'; $tb.AccessibleName = 'Your name'; $tb.Left = 20; $tb.Top = 20; $tb.Width = 200
$btn = New-Object System.Windows.Forms.Button; $btn.Name = 'greetBtn'; $btn.Text = 'Greet'; $btn.Left = 20; $btn.Top = 60; $btn.Width = 90
$clr = New-Object System.Windows.Forms.Button; $clr.Name = 'clearBtn'; $clr.Text = 'Clear'; $clr.Left = 120; $clr.Top = 60; $clr.Width = 90
$lbl = New-Object System.Windows.Forms.Label; $lbl.Name = 'resultLabel'; $lbl.Left = 20; $lbl.Top = 110; $lbl.Width = 300; $lbl.Text = ''
$btn.Add_Click({ $lbl.Text = '${variant === 'wrong' ? 'Hi' : 'Hello'}, ' + $tb.Text + '!' })
$clr.Add_Click({ $tb.Text = ''; $lbl.Text = '' })
$f.Controls.AddRange(@($tb, $btn, $clr, $lbl))
[void][System.Windows.Forms.Application]::Run($f)
`;
const write = (name, variant) => { const p = path.join(base, name); fs.writeFileSync(p, '﻿' + form(variant)); return p; };
const launch = (file) => ({ kind: 'desktop', command: 'powershell.exe', args: ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', file], name: 'greeter', timeoutMs: 30000 });
const target = write('target.ps1', 'target');

section('the sandbox: window, tree, controls, actions');
const sb = new C.DesktopSandbox();
let started = true;
try { await sb.start(launch(target)); } catch (e) { started = false; console.log('  SKIP  no interactive desktop to open a window on:', String(e.message).slice(0, 120)); }
if (!started) { console.log('\ncleanroom desktop: 0 passed, 0 failed'); process.exit(0); }
let o = await sb.observe();
ok(o.title === 'Greeter', 'the window is found and its title read', o.title);
ok(/"Greet"/.test(o.tree) && /"Clear"/.test(o.tree) && /Window "Greeter"/.test(o.tree), 'the accessibility tree is the outline of what a person perceives', o.tree);
const byName = (n) => o.controls.find(c => c.name === n);
const box = () => o.controls.find(c => c.role === 'textbox');
ok(byName('Greet')?.role === 'button' && byName('Clear')?.role === 'button' && box() && /^(id|name|path):/.test(byName('Greet').selector), 'what the app lets you do decides what is a control, even when it exposes plain panes; each has a selector that finds it again', o.controls);
ok(o.style.layout.length > 0 && o.style.viewport.width > 300, 'the layout boxes and the window size are measured', o.style);
ok(o.style.colors.background.length > 0 && o.frame && o.frame.length > 1000, 'a screenshot is taken and its dominant colours measured', o.style.colors);
await sb.inject({ type: 'fill', selector: box().selector, value: 'Ana' });
await sb.inject({ type: 'click', selector: byName('Greet').selector });
o = await sb.observe();
ok(/Hello, Ana!/.test(o.text), 'a field is filled and a button invoked: the label changes', o.text);
await sb.inject({ type: 'click', selector: 'id:nothingHere' });
ok(/no element matches/.test((await sb.observe()).error ?? ''), 'a selector that matches nothing is reported, not thrown');
await sb.inject({ type: 'click', selector: byName('Clear').selector });
o = await sb.observe();
ok(!/Hello/.test(o.text), 'Clear resets it');
await sb.stop();

section('explore and synthesize');
const j = await C.explore('desktop-greeter', launch(target), { maxSteps: 6, maxDepth: 2 });
const spec = C.synthesize(j, undefined, C.readExplorerState('desktop-greeter'));
ok(j.steps[0].stimulus.type === 'wait' && j.steps.length >= 4, 'the landing state is recorded, then clicks (with the name box filled first)', j.steps.map(s => `${s.stimulus.type}:${s.stimulus.selector ?? ''}`));
ok(j.steps.some(s => s.stimulus.type === 'fill') && j.steps.some(s => s.stimulus.type === 'click' && /Greet/.test(s.stimulus.selector)), 'a form-like window is filled before its buttons are pressed');
ok(spec.kind === 'desktop' && spec.web.routes.some(r => r.path === 'window:Greeter'), 'a window is a route in the spec', spec.web.routes);
ok(spec.web.states.some(s => /Hello, probe!/.test(s.summary)), 'the state after Greet shows the greeting', spec.web.states.map(s => s.summary));
ok(spec.web.tokens.colors.background.length > 0 && spec.web.layout.length > 0, 'the measured colours and layout are in the spec as values');
const specText = JSON.stringify(spec);
ok(!specText.includes('"frame"') && !specText.includes(base), 'no screenshot and no path to the target in the spec');
ok(spec.unknowns.some(u => /only the main window was explored/.test(u)), 'the spec says what was not explored');

section('twin-test a desktop clone');
const same = write('same.ps1', 'target');
const wrong = write('wrong.ps1', 'wrong');
const tSame = await C.twinTest({ journey: j, clone: launch(same), maxSteps: 4 });
ok(tSame.parity === 1, 'an identical window matches on text, controls and pixels', C.renderTwinReport(tSame));
const tWrong = await C.twinTest({ journey: j, clone: launch(wrong), maxSteps: 4 });
ok(tWrong.parity < 1 && tWrong.differences.some(d => d.field === 'frame' || d.field === 'colors') && tWrong.differences.some(d => d.field === 'text'), 'a window with another background and wording is caught visually and in its text', C.renderTwinReport(tWrong));

try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
console.log(`\ncleanroom desktop: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
