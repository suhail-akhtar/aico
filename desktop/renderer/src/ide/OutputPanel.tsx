/**
 * Output: the engine's own log, live. What the engine printed is what you
 * would read in a terminal running `aico serve` — useful when a provider
 * misbehaves or an MCP server will not start.
 *
 * @module desktop/renderer/ide/OutputPanel
 */

import React, { useEffect, useRef, useState } from 'react';
import { desktop } from '@/desktop';
import { Icon } from '@/lib/icons';

export function OutputPanel(): React.ReactElement {
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let live = true;
    const load = (): void => { void desktop.engine.log().then(l => { if (live) setLines(l); }).catch(() => {}); };
    load();
    const t = setInterval(load, 2000);
    return () => { live = false; clearInterval(t); };
  }, []);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines]);
  const shown = filter ? lines.filter(l => l.toLowerCase().includes(filter.toLowerCase())) : lines;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-aico-border-subtle px-3 py-1.5">
        <span className="text-[12px] text-aico-muted">AICO engine</span>
        <div className="flex-1" />
        <input className="input h-7 w-56 py-0 text-[12px]" placeholder="Filter" value={filter} onChange={e => setFilter(e.target.value)} />
        <button className="icon-btn-sm" onClick={() => void navigator.clipboard.writeText(lines.join('\n'))} title="Copy" aria-label="Copy output"><Icon name="copy" size={13} /></button>
      </div>
      <pre ref={box} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[12px] text-aico-secondary selectable">
        {shown.length ? shown.join('\n') : 'Nothing yet.'}
      </pre>
    </div>
  );
}
