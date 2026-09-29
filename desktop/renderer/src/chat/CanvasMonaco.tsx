/**
 * Monaco as a canvas's code editor — the desktop lends it to the shared
 * canvas through the host, in place of the highlighted textarea the browser
 * and the VS Code panel use.
 *
 * The agent's writes arrive as a new `value`; they are applied as an edit, not
 * by replacing the model, so the person's undo history and cursor survive a
 * change they did not make.
 *
 * @module desktop/renderer/chat/CanvasMonaco
 */

import React, { useEffect, useRef } from 'react';
import type { CanvasCodeEditorProps } from '@aico/ui';
import { canvasExtension } from '@aico/shared/ui/canvas/core';
import { useDesk } from '@/state/desk';
import { applyEditorTheme, languageFor, monaco } from '@/ide/monaco';

export function CanvasMonaco({ value, language, readOnly = false, onChange, onSelection, onSave }: CanvasCodeEditorProps): React.ReactElement {
  const host = useRef<HTMLDivElement | null>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const applying = useRef(false);
  const callbacks = useRef({ onChange, onSelection, onSave });
  callbacks.current = { onChange, onSelection, onSave };
  const mode = useDesk(s => s.mode);
  const codeFont = useDesk(s => s.prefs.codeFont);

  useEffect(() => {
    applyEditorTheme();
    const model = monaco.editor.createModel(value, languageFor(`canvas.${canvasExtension('code', language)}`));
    const e = monaco.editor.create(host.current!, {
      model, readOnly, automaticLayout: true, theme: 'aico', fontFamily: codeFont, fontSize: 13.5, lineHeight: 21,
      minimap: { enabled: false }, scrollBeyondLastLine: false, smoothScrolling: true, tabSize: 2, padding: { top: 10 },
      bracketPairColorization: { enabled: true }, renderWhitespace: 'selection', wordWrap: 'off',
    });
    editor.current = e;
    const changed = model.onDidChangeContent(() => { if (!applying.current) callbacks.current.onChange(model.getValue()); });
    const selected = e.onDidChangeCursorSelection(() => {
      const sel = e.getSelection();
      callbacks.current.onSelection?.(sel && !sel.isEmpty() ? model.getValueInRange(sel) : '');
    });
    e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave?.());
    return () => { changed.dispose(); selected.dispose(); e.dispose(); model.dispose(); editor.current = null; };
    // Created once; value and options are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const model = editor.current?.getModel();
    if (!model || model.getValue() === value) return;
    applying.current = true;
    try { model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null); }
    finally { applying.current = false; }
  }, [value]);

  useEffect(() => { editor.current?.updateOptions({ readOnly }); }, [readOnly]);
  useEffect(() => { applyEditorTheme(); }, [mode]);

  return <div ref={host} className="acv-monaco" />;
}
