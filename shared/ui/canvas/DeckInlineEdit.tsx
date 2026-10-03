/**
 * "Ask AICO" on a slide — the deck editor's inline edit panel and its review.
 * ADR 0024 (deck section).
 *
 * The panel is the document editor's (`InlineEdit`), given what a deck needs
 * instead: targets resolved against the deck (`resolveDeckTarget`), the
 * slide's quick actions (`deckActions`), the real Mermaid parser on a
 * proposed diagram, and a review that shows what a slide edit changes the way
 * people judge slides — the slide before and after, side by side as
 * thumbnails, the words or cells that changed underneath, and whether the
 * slide still fits its layout. The stage itself shows the proposed slide
 * while it is reviewed (the editor passes it), so the edit is seen in place.
 *
 * Nothing here writes: Accept hands the patch back to the editor, which
 * re-applies it to the deck it holds (so a field the person typed meanwhile is
 * kept) as one undoable operation saved as one version.
 *
 * @module shared/ui/canvas/DeckInlineEdit
 */

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { mermaidParseError } from '../Diagram';
import type { CanvasHost } from './host';
import type { Deck, Slide } from './deck-model';
import { layoutSlide } from './deck-layout';
import { deckActions, resolveDeckTarget, withSlide, type DeckPart, type DeckTarget } from './deck-scoped-edit';
import { wordDiff } from './scoped-diff';
import { parseTable } from './visual';
import type { PartEditResponse } from './scoped-edit';
import { InlineEdit, TableChanges, WordChanges, type InlineAccept, type InlineScope } from './InlineEdit';
import { DeckSlide } from './DeckSlide';
import { CvIcon } from './icons';

export interface DeckAskProps {
  host: CanvasHost;
  canvasId: string;
  /** The deck as the editor holds it now. */
  getDeck: () => Deck | null;
  scopes: InlineScope[];
  autoRun?: string;
  saveFirst: () => Promise<boolean>;
  onAccept: (a: InlineAccept) => string | null;
  /** The proposal under review (null when there is none) — the stage draws it in place. */
  onProposal: (res: PartEditResponse | null) => void;
  onScope: (scope: InlineScope) => void;
  onClose: () => void;
}

export function DeckAsk(props: DeckAskProps): React.ReactElement {
  const { getDeck } = props;
  return (
    <InlineEdit
      host={props.host} canvasId={props.canvasId} scopes={props.scopes} {...(props.autoRun ? { autoRun: props.autoRun } : {})}
      where="deck" saveFirst={props.saveFirst} onAccept={props.onAccept} onScope={props.onScope} onClose={props.onClose}
      onReviewing={() => undefined} onProposal={props.onProposal}
      resolvePart={(t) => {
        const d = getDeck();
        return d ? resolveDeckTarget(d, t as DeckTarget) : { ok: false, error: 'the deck is not open' };
      }}
      actionsFor={p => (getDeck() ? deckActions(getDeck()!, p as DeckPart) : [])}
      checkProposal={async (res) => {
        // The engine checks Mermaid syntax; the real parser gets the last word on a changed diagram.
        const d = getDeck();
        const after = res.slide as Slide | undefined;
        const before = d?.slides.find(s => s.id === res.part?.slideId);
        return after?.diagram && after.diagram !== before?.diagram ? mermaidParseError(after.diagram) : null;
      }}
      renderProposal={res => <DeckProposal deck={getDeck()} res={res} />}
    />
  );
}

/** The review: the slide before and after as thumbnails, what changed in the element, and the fit. */
export function DeckProposal({ deck, res }: { deck: Deck | null; res: PartEditResponse }): React.ReactElement | null {
  const box = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(520);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const index = deck && res.part?.slideId ? deck.slides.findIndex(s => s.id === res.part!.slideId) : -1;
  const after = useMemo(() => (deck && index >= 0 && res.slide ? withSlide(deck, index, res.slide as unknown as Slide) : null), [deck, index, res.slide]);
  const fit = useMemo(() => (after ? layoutSlide(after, index).problems.filter(p => p.severity === 'error') : []), [after, index]);
  if (!deck || index < 0 || !after || !res.part || res.after === undefined) return null;
  const k = res.part.kind;
  // Two thumbnails and the arrow on one row: the box's width less the arrow, the gaps and the padding.
  const thumb = Math.max(110, Math.min(300, Math.floor((w - 84) / 2)));
  const ta = k === 'table' || k === 'cells' ? parseTable(res.part.before) : null;
  const tb = ta ? parseTable(res.after) : null;
  const relaid = (res.slide as { layout?: string } | undefined)?.layout !== deck.slides[index]!.layout;
  const drawn = k === 'chart' || k === 'mermaid' || res.part.elementId === 'chart' || res.part.elementId === 'diagram';
  return (
    <div className="aie-proposal adk-proposal" ref={box} aria-label="Proposed change">
      <div className="adk-proposal-slides">
        <figure>
          <figcaption>Before</figcaption>
          <DeckSlide deck={deck} index={index} width={thumb} />
        </figure>
        <span className="adk-proposal-arrow" aria-hidden="true">→</span>
        <figure className="is-after">
          <figcaption>After</figcaption>
          <DeckSlide deck={after} index={index} width={thumb} />
        </figure>
      </div>
      {!drawn && (relaid ? (
        // A new layout: the slides tell the story; the words that moved are there to check, not to read first.
        <details className="adk-proposal-diff">
          <summary>Words and figures, before and after</summary>
          <WordChanges parts={wordDiff(res.part.before, res.after)} />
        </details>
      ) : (
        <div className="adk-proposal-diff">
          {ta && tb ? <TableChanges a={ta} b={tb} /> : <WordChanges parts={wordDiff(res.part.before, res.after)} />}
        </div>
      ))}
      <p className={`adk-proposal-fit${fit.length ? ' is-bad' : ''}`}>
        <CvIcon name={fit.length ? 'warn' : 'check'} size={12} />
        {fit.length ? ` Still does not fit: ${fit.map(p => p.message).join('; ')}` : ' Fits the layout — every other slide and element is unchanged.'}
      </p>
    </div>
  );
}
