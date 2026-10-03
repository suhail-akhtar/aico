/**
 * AICO Sheets, tested offline: the formula engine against Excel's answers
 * (precedence, coercion, blanks, errors, lookups, dates, cycles, cross-sheet),
 * formula rewriting (fill, insert/delete, rename), the workbook operations
 * the grid and the tool share, the .xlsx writer validated by unzipping it and
 * reading it back with xlsx-lite, CSV/XLSX import (shared formulas included),
 * the Canvas tool's sheet actions with their version checks, and the canvas
 * and artifacts routes.
 *
 * Why a script of its own: the engine is shared code (`shared/ui/canvas/
 * sheet-*.ts`) that the harness's canvas block does not exercise, and the
 * cases are many and table-shaped. Part of `npm test`. No model, no network.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

import {
  SheetModel as M, SheetFormula as F, bookToXlsx, xlsxToBook, csvToBook, importSheetFile, exportSheet, numFmtCode,
  readWorkbook, runInContext, canvasTool, createCanvas, getCanvas, writeCanvas, renameCanvas, onCanvasChange,
  listArtifacts, handleArtifactRoute, handleCanvasRoute,
} from '../dist-test/test-exports.js';

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 900)}` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const errOf = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };
const TODAY = F.dateSerial(2026, 10, 3);

/** Evaluate formulas on a one-sheet book seeded with `seed` cells; returns {ref: value}. */
function calc(seed, formulas, more = []) {
  let b = M.emptyBook('Data');
  b = M.applyOp(b, { op: 'set', sheet: 'Data', cells: seed });
  for (const op of more) b = M.applyOp(b, op);
  const cells = {};
  Object.entries(formulas).forEach(([k, f], i) => { cells[k] = f; void i; });
  b = M.applyOp(b, { op: 'set', sheet: 'Data', cells });
  const c = M.computeBook(b, { today: TODAY });
  return Object.fromEntries(Object.keys(formulas).map(k => [k, c.get('s1', k)]));
}
const v = (x) => (x && typeof x === 'object' && 'error' in x ? x.error : x);

console.log('\n══ AICO Sheets: formula engine (Excel parity) ══');
{
  const seed = {
    A1: 10, A2: 20, A3: 'text', A4: true, A5: null, A6: "'5", B1: 'Cement', B2: 'Sand', B3: 'cement mix', B4: 'Steel',
    C1: 100, C2: 200, C3: 300, C4: 400,
  };
  const r = calc(seed, {
    Z1: '=-2^2', Z2: '=2^3^2', Z3: '=2+3*4', Z4: '="a"&1', Z5: '="A"="a"', Z6: '=1<"a"', Z7: '="a"<TRUE', Z8: '=A5+1',
    Z9: '=A5&"x"', Z10: '="3"+1', Z11: '="x"+1', Z12: '=SUM(A1:A6)', Z13: '=SUM("x")', Z14: '=SUM("3",TRUE)',
    Z15: '=AVERAGE(D1:D3)', Z16: '=MIN(D1:D3)', Z17: '=COUNT(A1:A6)', Z18: '=COUNTA(A1:A6)', Z19: '=COUNTIF(C1:C4,">150")',
    Z20: '=COUNTIF(B1:B4,"c*")', Z21: '=COUNTIF(A1:A6,"")', Z22: '=SUMIF(B1:B4,"cement*",C1:C4)', Z23: '=IF(TRUE,1,1/0)',
    Z24: '=IF(FALSE,1)', Z25: '=IFERROR(1/0,"none")', Z26: '=AND(A1>5,A2>5)', Z27: '=OR(A1>50,A2>50)', Z28: '=AND("x")',
    Z29: '=ROUND(2.5,0)', Z30: '=ROUND(-2.5,0)', Z31: '=ROUND(1.005,2)', Z32: '=ROUND(1234.5,-2)', Z33: '=INT(-1.5)',
    Z34: '=MOD(-3,2)', Z35: '=ABS(-4)', Z36: '=1/0', Z37: '=A3*2', Z38: '=FOO(1)', Z39: '=notaname', Z40: '=10%',
    Z41: '=COUNTIF(C1:C4,150*2)', Z42: '=SUMPRODUCT(A1:A2,C1:C2)', Z43: '=CONCAT(B1," & ",B2)', Z44: '=LEN("abc")',
    Z45: '=UPPER("ab")', Z46: '=1=1.0', Z47: '=COUNTIF(A1:A6,"<>")', Z48: '=MAX(A1:A6)', Z49: '=SUM(A:A)', Z50: '=(1+2)*3',
  });
  const expect = {
    Z1: 4, Z2: 64, Z3: 14, Z4: 'a1', Z5: true, Z6: true, Z7: true, Z8: 1, Z9: 'x', Z10: 4, Z11: '#VALUE!', Z12: 30, Z13: '#VALUE!',
    Z14: 4, Z15: '#DIV/0!', Z16: 0, Z17: 2, Z18: 5, Z19: 3, Z20: 2, Z21: 1, Z22: 400, Z23: 1, Z24: false, Z25: 'none', Z26: true,
    Z27: false, Z28: '#VALUE!', Z29: 3, Z30: -3, Z31: 1.01, Z32: 1200, Z33: -2, Z34: 1, Z35: 4, Z36: '#DIV/0!', Z37: '#VALUE!',
    Z38: '#NAME?', Z39: '#NAME?', Z40: 0.1, Z41: 1, Z42: 5000, Z43: 'Cement & Sand', Z44: 3, Z45: 'AB', Z46: true, Z47: 5, Z48: 20,
    Z49: 30, Z50: 9,
  };
  const wrong = Object.keys(expect).filter(k => !eq(v(r[k]), expect[k])).map(k => `${k}: got ${JSON.stringify(v(r[k]))}, want ${JSON.stringify(expect[k])}`);
  ok(wrong.length === 0, `50 Excel-parity cases (precedence, coercion, blanks, aggregates, criteria, logic, rounding, errors)`, wrong);
}
{
  const seed = { A1: 'Apple', B1: 1.5, A2: 'Banana', B2: 0.5, A3: 'Cherry', B3: 3, D1: 0, E1: 'F', D2: 50, E2: 'C', D3: 70, E3: 'B', D4: 90, E4: 'A' };
  const r = calc(seed, {
    Z1: '=VLOOKUP("banana",A1:B3,2,FALSE)', Z2: '=VLOOKUP("Kiwi",A1:B3,2,FALSE)', Z3: '=VLOOKUP(75,D1:E4,2)', Z4: '=VLOOKUP(10,D1:E4,3,TRUE)',
    Z5: '=VLOOKUP(-1,D1:E4,2)', Z6: '=XLOOKUP("Cherry",A1:A3,B1:B3)', Z7: '=XLOOKUP("Kiwi",A1:A3,B1:B3)', Z8: '=XLOOKUP("Kiwi",A1:A3,B1:B3,"n/a")',
    Z9: '=XLOOKUP(75,D1:D4,E1:E4,,-1)', Z10: '=XLOOKUP(75,D1:D4,E1:E4,,1)', Z11: '=XLOOKUP("B*",A1:A3,B1:B3,,2)', Z12: '=VLOOKUP("b*",A1:B3,2,FALSE)',
    Z13: '=XLOOKUP("Apple",A1:A3,A1:B3)', Z14: '=SUM(XLOOKUP("Apple",A1:A3,A1:B3))',
  });
  const expect = { Z1: 0.5, Z2: '#N/A', Z3: 'B', Z4: '#REF!', Z5: '#N/A', Z6: 3, Z7: '#N/A', Z8: 'n/a', Z9: 'B', Z10: 'A', Z11: 0.5, Z12: 0.5, Z13: '#VALUE!', Z14: 1.5 };
  const wrong = Object.keys(expect).filter(k => !eq(v(r[k]), expect[k])).map(k => `${k}: got ${JSON.stringify(v(r[k]))}, want ${JSON.stringify(expect[k])}`);
  ok(wrong.length === 0, 'VLOOKUP (exact, approximate, #N/A, #REF!, wildcards) and XLOOKUP (not found, if_not_found, next smaller/larger, wildcard, row return)', wrong);
}
{
  const r = calc({ A1: 46298 }, {
    Z1: '=DATE(2026,10,3)', Z2: '=DATE(2026,13,1)', Z3: '=DATE(1900,3,1)', Z4: '=DATE(1900,2,28)', Z5: '=TODAY()', Z6: '=TEXT(DATE(2026,10,3),"yyyy-mm-dd")',
    Z7: '=TEXT(DATE(2026,10,3),"dddd d mmmm yyyy")', Z8: '=TEXT(1234.567,"#,##0.00")', Z9: '=TEXT(0.256,"0.0%")', Z10: '=TEXT(-5,"$#,##0")',
    Z11: '=TEXT(5,"0.00 ""kg""")', Z12: '=TEXT("abc","0")', Z13: '=DATE(26,1,1)', Z14: '=TODAY()+30',
  });
  const expect = {
    Z1: 46298, Z2: F.dateSerial(2027, 1, 1), Z3: 61, Z4: 59, Z5: TODAY, Z6: '2026-10-03', Z7: 'Saturday 3 October 2026', Z8: '1,234.57',
    Z9: '25.6%', Z10: '-$5', Z11: '5.00 kg', Z12: 'abc', Z13: F.dateSerial(1926, 1, 1), Z14: TODAY + 30,
  };
  const wrong = Object.keys(expect).filter(k => !eq(v(r[k]), expect[k])).map(k => `${k}: got ${JSON.stringify(v(r[k]))}, want ${JSON.stringify(expect[k])}`);
  ok(wrong.length === 0, 'dates in Excel\'s 1900 system (incl. the phantom 29 Feb 1900), TODAY injected, TEXT number and date codes', wrong);
  ok(M.isoDate(46298) === '2026-10-03' && M.isoDate(59) === '1900-02-28' && M.isoDate(61) === '1900-03-01' && M.isoDate(1) === '1900-01-01', 'serials either side of the phantom day');
}
{
  // Cycles: self, two-cell, three-cell; a reader of the cycle inherits the error; unrelated cells still compute.
  const r = calc({ A1: 1 }, { B1: '=B1+1', C1: '=D1', D1: '=C1', E1: '=F1+1', F1: '=G1', G1: '=E1', H1: '=C1*2', I1: '=A1+1' });
  ok(['B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'H1'].every(k => r[k]?.error === '#REF!') && r.I1 === 2, 'cycles are #REF!, readers inherit it, the rest computes', r);
  ok(/circular reference: .*E1.*F1.*G1|circular reference: .*G1.*F1.*E1/.test(r.E1.detail) && /B1 → B1/.test(r.B1.detail), 'the detail names the loop', [r.E1.detail, r.B1.detail]);
  // A 5,000-cell chain: dependency order, not recursion.
  const cells = { A1: 1 };
  for (let i = 2; i <= 5000; i++) cells[`A${i}`] = `=A${i - 1}+1`;
  let b = M.applyOp(M.emptyBook(), { op: 'set', sheet: 'Sheet1', cells });
  const t0 = Date.now();
  const c = M.computeBook(b);
  ok(c.get('s1', 'A5000') === 5000, `a 5,000-formula chain computes without a stack overflow (${Date.now() - t0} ms)`);
  b = M.applyOp(b, { op: 'set', sheet: 'Sheet1', cells: { A1: '=A5000' } });
  ok(M.computeBook(b).get('s1', 'A2500')?.error === '#REF!', 'closing the chain into a 5,000-cell loop is detected');
}
{
  // Cross-sheet references, quoted names, a missing sheet.
  let b = M.emptyBook('Rates');
  b = M.applyOp(b, { op: 'set', sheet: 'Rates', cells: { A1: 'Cement', B1: 12.5 } });
  b = M.applyOp(b, { op: 'add_sheet', name: 'Bill of Quantities' });
  b = M.applyOp(b, { op: 'set', sheet: 'Bill of Quantities', cells: { A1: 4, B1: '=A1*Rates!B1', C1: '=VLOOKUP("cement",Rates!A1:B1,2,FALSE)', D1: '=Nope!A1' } });
  b = M.applyOp(b, { op: 'add_sheet', name: 'Summary' });
  b = M.applyOp(b, { op: 'set', sheet: 'Summary', cells: { A1: "='Bill of Quantities'!B1+1" } });
  const c = M.computeBook(b);
  ok(c.get('s2', 'B1') === 50 && c.get('s2', 'C1') === 12.5 && c.get('s2', 'D1')?.error === '#REF!' && c.get('s3', 'A1') === 51,
    'cross-sheet refs (plain and quoted), lookups across sheets, a missing sheet is #REF!');
  const renamed = M.applyOp(b, { op: 'rename_sheet', sheet: 'Bill of Quantities', name: 'BOQ' });
  ok(renamed.sheets[2].cells.A1.f === 'BOQ!B1+1' && M.computeBook(renamed).get('s3', 'A1') === 51, 'renaming a sheet rewrites the formulas that name it');
  const re2 = M.applyOp(b, { op: 'rename_sheet', sheet: 'Rates', name: 'Unit rates' });
  ok(re2.sheets[1].cells.B1.f === "A1*'Unit rates'!B1", 'a new name with a space is quoted', re2.sheets[1].cells.B1.f);
  ok(/does not parse/.test(await errOf(() => M.applyOp(b, { op: 'set', sheet: 'Rates', cells: { C1: '=SUM(A1' } }))), 'a formula that does not parse is refused with the reason');
}

console.log('\n══ AICO Sheets: formula rewriting ══');
{
  ok(F.shiftFormula('A1+$B$1+$C2+D$3+SUM(E1:E3)', 2, 1) === 'B3+$B$1+$C4+E$3+SUM(F3:F5)', 'fill moves relative parts only');
  ok(F.shiftFormula('A1*2', -1, 0) === '#REF!*2', 'moving off the sheet is #REF!');
  ok(F.shiftFormula('"A1"&A1', 1, 0) === '"A1"&A2', 'text that looks like a ref is not touched');
  ok(F.adjustFormula('SUM(A2:A10)+B5', 'S', 'S', 'row', 4, 2) === 'SUM(A2:A12)+B7', 'insert rows: refs after the point move, ranges grow');
  ok(F.adjustFormula('SUM(A2:A10)+B5', 'S', 'S', 'row', 4, -1) === 'SUM(A2:A9)+#REF!', 'delete a row: a ref to it is #REF!, a range shrinks');
  ok(F.adjustFormula('$C$1*D1', 'S', 'S', 'col', 2, 1) === '$D$1*E1', 'insert a column moves anchored refs too');
  ok(F.adjustFormula('Other!A5+A5', 'Other', 'S', 'row', 0, 1) === 'Other!A6+A5', 'only references into the changed sheet move');
  ok(F.mapFunctionNames('XLOOKUP(A1,B:B,C:C)+sum(1)', n => n === 'XLOOKUP' ? '_xlfn.XLOOKUP' : n) === '_xlfn.XLOOKUP(A1,B:B,C:C)+sum(1)', 'function names map for the file format');
  ok(F.parseFormula('LOG10(1)').k === 'call' && F.parseFormula('A1:B2').k === 'range' && F.parseFormula('A:A').whole === 'col', 'LOG10( is a function, A1:B2 a range, A:A a whole column');
}

console.log('\n══ AICO Sheets: workbook model and operations ══');
{
  const p = (x) => M.parseInput(x);
  ok(eq(p('1,234.5'), { cell: { v: 1234.5 } }) && eq(p('12.5%'), { cell: { v: 0.125 }, style: { num: 'percent', dp: 1 } })
    && eq(p('£1,200'), { cell: { v: 1200 }, style: { num: 'currency', cur: 'GBP' } }) && eq(p('2026-10-03'), { cell: { v: 46298 }, style: { num: 'date' } })
    && eq(p('=B2*C2'), { cell: { f: 'B2*C2' } }) && eq(p("'=not a formula"), { cell: { v: '=not a formula' } }) && eq(p('true'), { cell: { v: true } })
    && eq(p(''), { cell: null }) && eq(p('1,23'), { cell: { v: '1,23' } }), 'typed input: numbers, %, currency, ISO dates, formulas, literal text, booleans');
  ok(M.formatValue(1234.5, { num: 'currency', cur: 'GBP' }) === '£1,234.50' && M.formatValue(-1234.567, { num: 'number' }) === '-1,234.57'
    && M.formatValue(0.125, { num: 'percent', dp: 1 }) === '12.5%' && M.formatValue(46298, { num: 'date' }) === '2026-10-03'
    && M.formatValue(0.1 + 0.2) === '0.3' && M.formatValue({ error: '#N/A' }) === '#N/A' && M.formatValue(true) === 'TRUE', 'number formats display like a spreadsheet');
  ok(M.editText({ v: 46298, s: { num: 'date' } }) === '2026-10-03' && M.editText({ f: 'A1+1' }) === '=A1+1' && M.editText({ v: '123' }) === "'123"
    && M.editText({ v: 0.15, s: { num: 'percent' } }) === '15%', 'the formula bar shows an editable spelling');

  let b = M.emptyBook('BOQ');
  b = M.applyOp(b, { op: 'set', sheet: 'BOQ', cells: M.gridCells([['Item', 'Qty', 'Rate', 'Amount'], ['Cement', 10, 5.5, '=B2*C2'], ['Sand', 4, 12, '=B3*C3'], ['Gravel', '', 7, '=B4*C4']], { r: 0, c: 0 }) });
  b = M.applyOp(b, { op: 'set', sheet: 'BOQ', cells: { D5: '=SUM(D2:D4)' } });
  const text = M.serializeBook(b);
  ok(text.split('\n').filter(l => /^"[A-Z]+\d+":/.test(l)).length === Object.keys(b.sheets[0].cells).length && eq(M.parseBook(text), b),
    'serialised one cell per line and parsed back unchanged');
  ok(/aicoSheet/.test(await errOf(() => M.parseBook('# not a sheet'))) && /aicoSheet/.test(await errOf(() => M.parseBook('{"sheets":[]}'))), 'text that is not a workbook is refused');
  const fixed = M.parseBook('{"aicoSheet":1,"sheets":[{"name":"x:y","cells":{"A1":{"v":1},"ZZZZ9":{"v":2},"B1":{"bad":1},"C1":{"v":3,"s":{"fill":"red","b":true}}}}]}');
  ok(eq(Object.keys(fixed.sheets[0].cells), ['A1', 'C1']) && fixed.sheets[0].name === 'x y' && eq(fixed.sheets[0].cells.C1.s, { b: true }), 'malformed cells and styles are dropped, names cleaned');

  const ins = M.applyOp(b, { op: 'insert', sheet: 'BOQ', axis: 'row', at: 2, count: 1 });
  ok(ins.sheets[0].cells.D6.f === 'SUM(D2:D5)' && ins.sheets[0].cells.D4.f === 'B4*C4' && !ins.sheets[0].cells.A3, 'insert a row: cells move down, formulas follow');
  const del = M.applyOp(b, { op: 'delete', sheet: 'BOQ', axis: 'row', at: 1, count: 1 });
  ok(del.sheets[0].cells.D4.f === 'SUM(D2:D3)' && M.computeBook(del).get('s1', 'D4') === 48, 'delete a row: the total shrinks to the rows left');
  const delCol = M.applyOp(M.applyOp(b, { op: 'width', sheet: 'BOQ', col: 'D', px: 140 }), { op: 'delete', sheet: 'BOQ', axis: 'col', at: 1, count: 1 });
  ok(delCol.sheets[0].cells.C2.f === '#REF!*B2' && delCol.sheets[0].cols.C === 140, 'delete a column: refs to it are #REF!, widths move with their column', delCol.sheets[0].cells.C2);
  const sorted = M.applyOp(b, { op: 'sort', sheet: 'BOQ', range: 'A1:D4', col: 3, desc: true, header: true });
  const sc = M.computeBook(sorted);
  ok(sorted.sheets[0].cells.A2.v === 'Cement' && sorted.sheets[0].cells.D2.f === 'B2*C2' && sorted.sheets[0].cells.A3.v === 'Sand'
    && sorted.sheets[0].cells.A4.v === 'Gravel' && sc.get('s1', 'D3') === 48, 'sort by amount desc with a header: formulas follow their row, zero/blank amounts last');
  const asc = M.applyOp(b, { op: 'sort', sheet: 'BOQ', range: 'A2:D4', col: 0 });
  ok(['Cement', 'Gravel', 'Sand'].every((name, i) => asc.sheets[0].cells[`A${i + 2}`].v === name), 'sort by text ascending, case-insensitive');
  let f = M.applyOp(M.emptyBook(), { op: 'set', sheet: 'Sheet1', cells: { A1: 1, A2: 2, A3: 3, B1: '=A1*$C$1', C1: 10 } });
  f = M.applyOp(f, { op: 'fill', sheet: 'Sheet1', range: 'B1:B3' });
  ok(f.sheets[0].cells.B3.f === 'A3*$C$1' && M.computeBook(f).get('s1', 'B3') === 30, 'fill down adjusts relative refs and keeps anchors');
  const rows = M.parseDelimited('Item\tQty\tNote\nCement\t10\t"two\nlines"\n');
  const csv = M.parseDelimited('a,"b,c","say ""hi"""\n1,2,3');
  ok(eq(rows, [['Item', 'Qty', 'Note'], ['Cement', '10', 'two\nlines']]) && eq(csv, [['a', 'b,c', 'say "hi"'], ['1', '2', '3']]), 'paste: tab-separated from Excel, CSV with quotes and embedded newlines');
  let st = M.applyOp(b, { op: 'style', sheet: 'BOQ', range: 'C2:D5', style: { num: 'currency', cur: 'GBP', b: true } });
  st = M.applyOp(st, { op: 'style', sheet: 'BOQ', range: 'D5', style: { b: null, fill: '#FFF2CC' } });
  ok(eq(st.sheets[0].cells.C3.s, { num: 'currency', cur: 'GBP', b: true }) && eq(st.sheets[0].cells.D5.s, { num: 'currency', cur: 'GBP', fill: '#fff2cc' }), 'styles merge; null clears one key');
  const typed = M.applyOp(st, { op: 'set', sheet: 'BOQ', cells: { C2: '7.25' } });
  ok(typed.sheets[0].cells.C2.s.num === 'currency' && typed.sheets[0].cells.C2.v === 7.25, 'typing into a formatted cell keeps its format');
  ok(/at least one sheet/.test(await errOf(() => M.applyOp(b, { op: 'delete_sheet', sheet: 'BOQ' }))) && /already a sheet/.test(await errOf(() => M.applyOp(b, { op: 'add_sheet', name: 'boq' }))), 'the last sheet cannot go; names are unique ignoring case');
  const cond = M.applyOp(b, { op: 'cond', sheet: 'BOQ', rules: [{ range: 'D2:D4', op: 'gt', value: 50, fill: '#FDE2E2' }, { range: 'D2:D4', op: 'error', fill: '#cccccc' }] });
  const cc = M.computeBook(cond);
  ok(M.condFill(cond.sheets[0], 1, 3, cc.at('s1', 1, 3)) === '#fde2e2' && M.condFill(cond.sheets[0], 2, 3, cc.at('s1', 2, 3)) === undefined, 'conditional fill: the first matching rule colours the cell');
  ok(/conditional rule 1/.test(await errOf(() => M.applyOp(b, { op: 'cond', sheet: 'BOQ', rules: [{ range: 'D2', op: 'gt', fill: 'red' }] }))), 'a malformed rule is refused with the shape');
  const ch = M.applyOp(b, { op: 'chart', sheet: 'BOQ', chart: { id: 'c1', range: 'A1:B4', type: 'bar', title: 'Qty' } });
  const data = M.chartData(ch.sheets[0], 'A1:B4', M.computeBook(ch));
  ok(eq(data.categories, ['Cement', 'Sand', 'Gravel']) && eq(data.series, [{ name: 'Qty', data: [10, 4, 0] }]), 'a chart from a range: first column categories, header names the series');
  const mine = [{ op: 'set', sheet: 'BOQ', cells: { B2: 12 } }];
  const theirs = M.applyOp(b, { op: 'insert', sheet: 'BOQ', axis: 'row', at: 1, count: 1 });
  const replayed = M.replay(theirs, mine);
  ok(replayed.book.sheets[0].cells.B2.v === 12 && replayed.book.sheets[0].cells.B3.v === 10 && replayed.skipped === 0, 'the grid\'s pending ops replay onto a newer version');
  const view = M.describeRange(b, b.sheets[0], undefined, M.computeBook(b));
  ok(/D2: =B2\*C2 → 55/.test(view) && /D5: =SUM\(D2:D4\) → 103/.test(view) && /A1="Item"/.test(view), 'the agent\'s compact view', view);
}

console.log('\n══ AICO Sheets: .xlsx export (unzipped, re-read with xlsx-lite) ══');
{
  let b = M.emptyBook('BOQ');
  b = M.applyOp(b, { op: 'set', sheet: 'BOQ', cells: M.gridCells([
    ['Item', 'Qty', 'Rate', 'Amount', 'Due'], ['Cement & lime <bulk>', 10, 5.5, '=B2*C2', '2026-10-03'], ['Sand', 4, 12, '=B3*C3', null],
  ], { r: 0, c: 0 }) });
  b = M.applyOp(b, { op: 'set', sheet: 'BOQ', cells: { D4: '=SUM(D2:D3)', A5: 'Share', B5: '=D2/D4', A6: '=A2&" total"', B6: '=1/0', C6: '=B2>5', D6: '=XLOOKUP("Sand",A2:A3,D2:D3)' } });
  b = M.applyOp(b, { op: 'style', sheet: 'BOQ', range: 'C2:D4', style: { num: 'currency', cur: 'GBP' } });
  b = M.applyOp(b, { op: 'style', sheet: 'BOQ', range: 'B5', style: { num: 'percent', dp: 1 } });
  b = M.applyOp(b, { op: 'style', sheet: 'BOQ', range: 'A1:E1', style: { b: true, fill: '#DDEBF7', align: 'center' } });
  b = M.applyOp(b, { op: 'width', sheet: 'BOQ', col: 'A', px: 220 });
  b = M.applyOp(b, { op: 'freeze', sheet: 'BOQ', rows: 1 });
  b = M.applyOp(b, { op: 'filter', sheet: 'BOQ', on: true });
  b = M.applyOp(b, { op: 'cond', sheet: 'BOQ', rules: [{ range: 'D2:D3', op: 'gt', value: 50, fill: '#FDE2E2' }, { range: 'A2:A3', op: 'contains', value: 'sand', fill: '#E2EFDA' }] });
  b = M.applyOp(b, { op: 'add_sheet', name: 'Summary sheet' });
  b = M.applyOp(b, { op: 'set', sheet: 'Summary sheet', cells: { A1: 'Total', B1: '=BOQ!D4*1.2' } });
  // A broken formula as it could arrive from an old file: stored, never written as a formula.
  b.sheets[0].cells.E6 = { f: 'SUM(A1' };
  const bytes = bookToXlsx(b, { today: TODAY, title: 'BOQ' });
  const files = unzipSync(bytes);
  const x = (n) => strFromU8(files[n]);
  const wb = x('xl/workbook.xml'); const s1 = x('xl/worksheets/sheet1.xml'); const styles = x('xl/styles.xml');
  ok(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'].every(n => files[n]),
    'the package has its parts', Object.keys(files));
  ok(/<sheet name="BOQ"/.test(wb) && /<sheet name="Summary sheet"/.test(wb) && /fullCalcOnLoad="1"/.test(wb) && /_xlnm\._FilterDatabase/.test(wb), 'workbook: sheets, recalc on open, the filter name');
  ok(/<c r="D2" s="\d+"><f>B2\*C2<\/f><v>55<\/v><\/c>/.test(s1) && /<f>SUM\(D2:D3\)<\/f><v>103<\/v>/.test(s1), 'formulas are written with their cached values', s1.slice(0, 1500));
  ok(/<c r="A6" t="str"><f>A2&amp;&quot; total&quot;<\/f><v>Cement &amp; lime &lt;bulk&gt; total<\/v>/.test(s1) && /<c r="B6" t="e"><f>1\/0<\/f><v>#DIV\/0!<\/v>/.test(s1)
    && /<c r="C6" t="b"><f>B2&gt;5<\/f><v>1<\/v>/.test(s1), 'text, error and boolean results carry their types, escaped');
  ok(/<f>_xlfn\.XLOOKUP\(&quot;Sand&quot;,A2:A3,D2:D3\)<\/f><v>48<\/v>/.test(s1), 'XLOOKUP is written _xlfn.XLOOKUP');
  ok(/<c r="E6" t="inlineStr"><is><t xml:space="preserve">=SUM\(A1<\/t>/.test(s1), 'a formula that does not parse is written as text, not a formula');
  ok(/state="frozen"/.test(s1) && /ySplit="1"/.test(s1) && /<col min="1" max="1" width="30.71" customWidth="1"\/>/.test(s1) && /<autoFilter ref="A1:E6"\/>/.test(s1),
    'frozen header, column width, autoFilter', s1.slice(0, 600));
  ok(/cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>50<\/formula>/.test(s1) && /containsText/.test(s1) && /<dxfs count="2">/.test(styles), 'conditional fills are live rules with dxf fills');
  ok(styles.includes('formatCode="&quot;£&quot;#,##0.00;-&quot;£&quot;#,##0.00"') && styles.includes('formatCode="0.0%"') && styles.includes('formatCode="yyyy-mm-dd"')
    && /<fgColor rgb="FFDDEBF7"\/>/.test(styles) && /<alignment horizontal="center"\/>/.test(styles), 'number formats, fills and alignment in styles.xml');
  const s2 = x('xl/worksheets/sheet2.xml');
  ok(/<f>BOQ!D4\*1\.2<\/f><v>123\.6<\/v>/.test(s2), 'a cross-sheet formula with its cached value');
  // Read it back with the engine's own reader.
  const back = readWorkbook(bytes);
  const rows = back.rows('BOQ');
  ok(eq(back.sheets, ['BOQ', 'Summary sheet']) && rows.get(2)[3] === '55' && rows.get(2)[4] === '2026-10-03' && rows.get(1)[0] === 'Item' && rows.get(4)[3] === '103',
    'xlsx-lite reads the cached values, dates as dates', [...rows]);
  const cells = back.cells('BOQ');
  ok(cells.find(c => c.ref === 'D2')?.formula === 'B2*C2' && cells.find(c => c.ref === 'E2')?.type === 'd', 'xlsx-lite.cells() reads formulas and date types');
  const round = xlsxToBook(bytes);
  ok(round.sheets[0].cells.D6.f === 'XLOOKUP("Sand",A2:A3,D2:D3)' && round.sheets[0].cells.E2.s?.num === 'date' && round.sheets[0].cells.E2.v === 46298
    && M.computeBook(round).get('s2', 'B1') === 123.6, 'import of our own export: formulas (prefix dropped), dates, cross-sheet values');
  ok(numFmtCode({ num: 'number', dp: 0 }) === '#,##0' && numFmtCode({ num: 'text' }) === '@' && numFmtCode(undefined) === undefined, 'format codes');
  const out = path.join(os.tmpdir(), `aico-sheets-${process.pid}.xlsx`);
  fs.writeFileSync(out, bytes);
  console.log(`        (wrote ${out} — ${bytes.length} bytes)`);
}

console.log('\n══ AICO Sheets: import (.xlsx with shared formulas, .csv) ══');
{
  // A hand-made workbook the way Excel writes a filled-down column: shared formulas, shared strings.
  const sheet = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>2</v></c><c r="C1"><f t="shared" ref="C1:C3" si="0">A1&amp;B1</f><v>x2</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>3</v></c><c r="C2"><f t="shared" si="0"/><v>y3</v></c></row>'
    + '<row r="3"><c r="B3"><v>4</v></c><c r="C3"><f t="shared" si="0"/><v>4</v></c><c r="D3"><f>_xlfn.CONCAT(A1,A2)</f></c></row></sheetData></worksheet>';
  const bytes = zipSync({
    'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="Imported" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8('<sst><si><t>x</t></si><si><t>y</t></si></sst>'),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  });
  const book = xlsxToBook(bytes);
  const s = book.sheets[0];
  ok(s.name === 'Imported' && s.cells.C2.f === 'A2&B2' && s.cells.C3.f === 'A3&B3' && s.cells.D3.f === 'CONCAT(A1,A2)' && s.cells.A1.v === 'x' && s.cells.B2.v === 3,
    'shared formulas are translated to each cell; _xlfn. is dropped', s.cells);
  ok(M.computeBook(book).get('s1', 'C2') === 'y3', 'and compute');
  const csv = csvToBook('\ufeffItem,Qty,Rate,Note\r\nCement,"1,000",£5.50,=HYPERLINK("x")\r\nSand,4,12%,"a, b"\r\n', 'BOQ');
  const c = csv.sheets[0];
  ok(c.cells.B2.v === 1000 && c.cells.C2.v === 5.5 && c.cells.C2.s.num === 'currency' && c.cells.C3.v === 0.12 && c.cells.D2.v === '=HYPERLINK("x")' && c.cells.D2.f === undefined
    && c.cells.D3.v === 'a, b' && c.freeze?.rows === 1 && c.cells.A1.s?.b === true, 'CSV: typed values, a header row frozen and bold, a leading = stays text (no CSV injection)', c.cells);
  ok(/xlsx, \.csv/.test(await errOf(() => importSheetFile('x.pdf', new Uint8Array(4)))) && /not a readable/.test(await errOf(() => importSheetFile('x.xlsx', new Uint8Array([1, 2, 3])))), 'other files are refused with what to import');
  const out = exportSheet(csv, 'csv').toString('utf8');
  ok(out.startsWith('\ufeffItem,Qty,Rate,Note\r\nCement,1000,5.5,"=HYPERLINK(""x"")"\r\n') && out.includes('Sand,4,12%,"a, b"'), 'CSV export: BOM, raw numbers, RFC 4180 quoting', out);
}

console.log('\n══ AICO Sheets: the Canvas tool (version-checked small writes) ══');
{
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aico-sheets-')));
  const sid = 'sheets-session';
  const settings = {};
  const ctx = { settings, cwd: project, sessionId: sid };
  const run = (fn) => runInContext({ cwd: project, sessionId: sid, settings }, fn);
  const tool = (input) => run(() => canvasTool(input));
  const heard = [];
  const stop = onCanvasChange(c => heard.push(c));
  try {
    const created = await tool({ action: 'create', kind: 'sheet', title: 'BOQ', tabs: [{ title: 'BOQ' }], range: 'A1',
      values: [['Item', 'Qty', 'Rate', 'Amount'], ['Cement', 10, 5.5, '=B2*C2'], ['Sand', 4, 12, '=B3*C3']] });
    const id = /```canvas\n(\{.*\})\n```/.exec(created) && JSON.parse(/```canvas\n(\{.*\})\n```/.exec(created)[1]).id;
    ok(/Created sheet canvas cv-/.test(created) && /D2: =B2\*C2 → 55/.test(created) && /"kind":"sheet"/.test(created), 'create kind sheet with values reports computed cells and a sheet card', created);
    const doc = await getCanvas(ctx, id);
    ok(doc.kind === 'sheet' && M.looksLikeBook(doc.content) && heard.at(-1)?.kind === 'sheet', 'stored as a sheet canvas; announced with its kind');
    const r1 = await tool({ action: 'set_cells', id, version: 1, cells: { D4: '=SUM(D2:D3)', A4: 'Total' } });
    ok(/now version 2/.test(r1) && /D4: =SUM\(D2:D3\) → 103/.test(r1), 'set_cells returns the new version and the computed total', r1);
    const stale = await errOf(() => tool({ action: 'set_cells', id, version: 1, cells: { B2: 11 } }));
    ok(/NOT APPLIED/.test(stale) && /version 2/.test(stale) && /D4: =SUM/.test(stale), 'a stale version is refused with a compact current view', stale);
    // The person edits in the grid meanwhile (a save with the JSON), then the agent's stale write is refused.
    const cur = await getCanvas(ctx, id);
    const mine = M.applyOp(M.parseBook(cur.content), { op: 'set', sheet: 'BOQ', cells: { B3: 5 } });
    const saved = await writeCanvas(ctx, id, { content: M.serializeBook(mine), baseVersion: 2, author: 'user' });
    ok(saved.ok && saved.canvas.version === 3, 'the person\'s grid save is a version like any other');
    ok(/The user edited it/.test(await errOf(() => tool({ action: 'set_cells', id, version: 2, cells: { B2: 11 } }))), 'and the agent is told the user edited it');
    const bad = await errOf(() => writeCanvas(ctx, id, { content: '# Markdown', baseVersion: 3, author: 'user' }));
    ok(/not a workbook/.test(bad), 'a sheet\'s tab only accepts a workbook', bad);
    const err = await tool({ action: 'set_cells', id, version: 3, cells: { E2: '=D2/0', F2: '=F3', F3: '=F2' } });
    ok(/Formula errors in the workbook/.test(err) && /E2 #DIV\/0!/.test(err) && /circular reference/.test(err), 'errors anywhere in the workbook are reported after a write', err);
    const fmt = await tool({ action: 'format_cells', id, version: 4, range: 'C2:D4', style: { num: 'currency', currency: 'gbp', bold: false },
      layout: { widths: { A: 200 }, freeze: { rows: 1 }, conditional: [{ range: 'D2:D3', op: 'gt', value: 50, fill: '#FDE2E2' }], chart: { range: 'A1:B3', type: 'bar', title: 'Qty' } } });
    ok(/now version 5/.test(fmt) && /header row frozen/.test(fmt) && /C currency GBP/.test(fmt) && /1 chart/.test(fmt), 'format_cells: style aliases, widths, freeze, conditional, chart', fmt);
    const add = await tool({ action: 'add_sheet', id, version: 5, title: 'Summary' });
    const sum = await tool({ action: 'set_cells', id, version: 6, sheet: 'Summary', cells: { A1: 'Grand total', B1: '=BOQ!D4*1.2' } });
    ok(/Added sheet "Summary"/.test(add) && /B1: =BOQ!D4\*1\.2 → 138(?!\.)/.test(sum), 'add_sheet, then a cross-sheet formula', sum);
    const grid = await tool({ action: 'grid_op', id, version: 7, operation: { type: 'insert_rows', at: '3', count: 1 } });
    const after = M.parseBook((await getCanvas(ctx, id)).content);
    ok(/now version 8/.test(grid) && after.sheets[0].cells.D5.f === 'SUM(D2:D4)' && after.sheets[1].cells.B1.f === 'BOQ!D5*1.2', 'grid_op insert_rows: formulas on every sheet follow', grid);
    const read = await tool({ action: 'read', id, range: 'A1:D5', sheet: 'BOQ' });
    ok(/version 8/.test(read) && /D5: =SUM\(D2:D4\) → £115\.00/.test(read) && !/"aicoSheet"/.test(read), 'read: a compact table with formats, not the JSON', read);
    ok(/is a sheet — change it with set_cells/.test(await errOf(() => tool({ action: 'update', id, version: 8, content: 'x' }))), 'update/edit on a sheet points at set_cells');
    ok(/not a sheet/.test(await errOf(async () => {
      const d = await tool({ action: 'create', title: 'Notes', kind: 'document', content: 'hi' });
      const did = JSON.parse(/```canvas\n(\{.*\})\n```/.exec(d)[1]).id;
      await tool({ action: 'set_cells', id: did, version: 1, cells: { A1: 1 } });
    })), 'set_cells on a document is refused');
    const exp = await tool({ action: 'export', id, format: 'xlsx' });
    const file = /: (.+\.xlsx)\n/.exec(exp)?.[1];
    ok(file && fs.existsSync(file) && strFromU8(unzipSync(fs.readFileSync(file))['xl/worksheets/sheet1.xml']).includes('<f>SUM(D2:D4)</f>'), 'export xlsx writes a real workbook into the artifacts folder', exp);
    const expCsv = await tool({ action: 'export', id, format: 'csv', sheet: 'Summary' });
    ok(/as csv/.test(expCsv) && /A sheet exports as xlsx or csv/.test(await errOf(() => tool({ action: 'export', id, format: 'docx' }))), 'export csv (one sheet); docx is refused for a sheet');
    fs.writeFileSync(path.join(project, 'rates.csv'), 'Item,Rate\nCement,5.5\nSand,12\n');
    const imp = await tool({ action: 'import', path: 'rates.csv' });
    ok(/Imported rates\.csv as sheet canvas cv-/.test(imp) && /"Sheet1"|"rates"/.test(imp), 'import a workspace CSV as a new sheet canvas', imp);
    ok(/outside|escapes|not allowed|inside/i.test(await errOf(() => tool({ action: 'import', path: '../../etc/passwd' }))), 'import refuses a path outside the workspace');
    const renamed = await renameCanvas(ctx, id, 'BOQ v2');
    ok(renamed.title === 'BOQ v2' && heard.at(-1)?.action === 'rename' && renamed.version === 8, 'rename: title only, announced, no content version');

    // ── Routes ──
    const call = async (handler, route, { method = 'GET', query = {}, body } = {}) => {
      const url = new URL(`http://x/api/${route}?${new URLSearchParams({ session: sid, ...query })}`);
      const out = { status: 0, body: undefined, headers: {}, bytes: undefined };
      const res = { writeHead(s, h) { out.status = s; out.headers = h; }, end(b) { out.bytes = b; } };
      await handler(route, { method, headers: {} }, res, url, {
        resolveCwd: async () => project, readJson: async () => ({ session: sid, ...body }), send: (_r, s, b) => { out.status = s; out.body = b; },
      });
      return out;
    };
    const list = await call(handleArtifactRoute, 'artifacts/list');
    const kinds = list.body.artifacts.map(a => `${a.kind}:${a.title}`);
    ok(list.status === 200 && kinds.includes('sheet:BOQ v2') && kinds.includes('document:Notes') && list.body.artifacts.some(a => a.kind === 'file' && a.title === 'boq.xlsx' && a.topic === 'Files'),
      'artifacts/list: the sheet, the document and the exported files', kinds);
    const listed = await listArtifacts({ cwd: project, sessionId: sid });
    ok(listed.length === list.body.artifacts.length && listed[0].updatedAt >= listed.at(-1).updatedAt, 'newest first');
    const got = await call(handleArtifactRoute, 'artifacts/file', { query: { path: 'boq.xlsx' } });
    ok(got.status === 200 && got.headers['Content-Type'].includes('spreadsheetml') && /attachment/.test(got.headers['Content-Disposition']) && got.bytes.length > 500, 'artifacts/file serves a file as a download');
    const trav = await Promise.all(['../canvas', '../../x', path.join(project, 'rates.csv'), 'C:/Windows/win.ini', 'nope.txt'].map(p => call(handleArtifactRoute, 'artifacts/file', { query: { path: p } })));
    ok(trav.every(t => t.status === 404), 'traversal, absolute paths and missing files are 404', trav.map(t => t.status));
    const rn = await call(handleArtifactRoute, 'artifacts/rename', { method: 'POST', body: { path: 'boq.xlsx', name: 'Bill of quantities' } });
    const rnBad = await call(handleArtifactRoute, 'artifacts/rename', { method: 'POST', body: { path: 'Bill of quantities.xlsx', name: '../evil.xlsx' } });
    ok(rn.status === 200 && rn.body.path === 'Bill of quantities.xlsx' && rnBad.status === 400, 'artifacts/rename keeps the extension, refuses a separator', [rn.body, rnBad.body]);
    // A topic: an export named after a canvas groups with it.
    fs.writeFileSync(path.join(path.dirname(file), 'notes.docx'), 'PK');
    const topical = (await listArtifacts({ cwd: project, sessionId: sid })).find(a => a.title === 'notes.docx');
    ok(topical?.kind === 'export' && topical.topic === 'Notes', 'an export named after a canvas is grouped under it', topical);
    const files = (await listArtifacts({ cwd: project, sessionId: sid })).filter(a => a.source !== 'canvas');
    ok(files.length > 0 && files.every(a => path.isAbsolute(a.path ?? '') && fs.existsSync(a.path)), 'files carry their absolute path (Reveal / Copy path)', files.map(a => a.path));
    const pv = await call(handleArtifactRoute, 'artifacts/preview', { query: { path: 'Bill of quantities.xlsx' } });
    const pvSheet = pv.body?.sheets?.[0];
    ok(pv.status === 200 && pv.body.type === 'table' && pvSheet?.name === 'BOQ' && pvSheet.rows.length >= 4 && pvSheet.rows.every(r => r.length === pvSheet.rows[0].length),
      'artifacts/preview: an .xlsx as rectangular rows per sheet', pv.body);
    fs.writeFileSync(path.join(path.dirname(file), 'readme.txt'), 'plain');
    const pvBad = await Promise.all([{ path: '../canvas' }, { path: 'notes.docx' }, { path: 'rates.csv' }, { attachment: 'nope' }, { path: 'readme.txt' }].map(q => call(handleArtifactRoute, 'artifacts/preview', { query: q })));
    ok(pvBad[0].status === 404 && pvBad[1].status === 400 && pvBad[2].status === 404 && pvBad[3].status === 404 && pvBad[4].status === 415,
      'artifacts/preview: traversal and unknown ids are 404; a broken .docx is a 400, not a crash; a text file is the client\'s to show (415)', pvBad.map(p => [p.status, p.body?.error]));
    const xl = await call(handleCanvasRoute, `canvas/${id}/export`, { query: { format: 'xlsx' } });
    const xlBad = await call(handleCanvasRoute, `canvas/${id}/export`, { query: { format: 'pdf' } });
    ok(xl.status === 200 && /boq-v2\.xlsx/.test(xl.headers['Content-Disposition']) && xlBad.status === 400, 'export route: a sheet as xlsx; pdf refused');
    const imported = await call(handleCanvasRoute, 'canvas/import', { method: 'POST', body: { name: 'prices.csv', data: Buffer.from('A,B\n1,2\n').toString('base64') } });
    ok(imported.status === 200 && imported.body.canvas.kind === 'sheet' && imported.body.canvas.title === 'prices', 'canvas/import: a CSV upload becomes a sheet canvas');
    const ren = await call(handleCanvasRoute, 'canvas/rename', { method: 'POST', body: { id, title: 'Final BOQ' } });
    ok(ren.status === 200 && ren.body.canvas.title === 'Final BOQ', 'canvas/rename');
    const mk = await call(handleCanvasRoute, 'canvas/create', { method: 'POST', body: { title: 'Blank', kind: 'sheet' } });
    ok(mk.status === 200 && mk.body.canvas.kind === 'sheet' && M.parseBook(mk.body.canvas.content).sheets.length === 1, 'canvas/create kind sheet starts an empty workbook');
    const tabRefused = await call(handleCanvasRoute, 'canvas/tabs', { method: 'POST', body: { id, op: 'add', title: 'x' } });
    ok(tabRefused.status === 400 && /add a sheet/.test(tabRefused.body.error), 'a sheet canvas has no document tabs');
  } finally {
    stop();
  }
}

console.log(`\nSheets: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
