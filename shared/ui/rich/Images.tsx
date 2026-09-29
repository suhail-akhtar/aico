/**
 * ```images — a carousel of pictures with a lightbox.
 *
 * An image that fails to load is dropped from the row rather than shown as a
 * broken icon: a search for pictures always returns a few dead links, and a
 * gallery with holes in it reads as broken when it is not.
 *
 * @module shared/ui/rich/Images
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Arriving, Carousel, ExtLink, Icon, Overlay, useParsed } from './common';
import { parseImages, type ImageItem, type ImagesSpec } from './specs';
import { mediaUrl } from '../media';

export function Images({ source, streaming = false }: { source: string; streaming?: boolean }): React.ReactElement {
  const { spec, waiting } = useParsed(source, streaming, parseImages);
  if (waiting || !spec) return <Arriving what="Images" />;
  return <Gallery spec={spec} />;
}

function Gallery({ spec }: { spec: ImagesSpec }): React.ReactElement {
  const [failed, setFailed] = useState<ReadonlySet<number>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const shown = spec.images.filter(i => !failed.has(i.id));
  const fail = useCallback((id: number) => setFailed(prev => new Set(prev).add(id)), []);
  const close = useCallback(() => setOpen(null), []);
  const single = spec.images.length === 1;

  return (
    <div className="aw aw-images">
      {spec.title && <div className="aw-heading">{spec.title}</div>}
      {shown.length === 0 ? (
        <p className="aw-note">None of these images could be loaded.</p>
      ) : single ? (
        <Tile image={shown[0]!} onOpen={() => setOpen(0)} onFail={fail} single />
      ) : (
        <Carousel label={spec.title ?? 'Images'}>
          {shown.map((img, i) => <Tile key={img.id} image={img} onOpen={() => setOpen(i)} onFail={fail} />)}
        </Carousel>
      )}
      {open !== null && shown[open] && (
        <Lightbox images={shown} index={open} onIndex={setOpen} onClose={close} />
      )}
    </div>
  );
}

function Tile({ image, onOpen, onFail, single = false }: {
  image: ImageItem; onOpen: () => void; onFail: (id: number) => void; single?: boolean;
}): React.ReactElement {
  return (
    <figure className={`aw-img-tile${single ? ' is-single' : ''}`} role="listitem">
      <button type="button" className="aw-img-frame" onClick={onOpen} aria-label={`View ${image.caption ?? image.alt ?? 'image'} larger`}>
        <img
          src={mediaUrl(image.url)}
          alt={image.alt ?? image.caption ?? ''}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => onFail(image.id)}
        />
      </button>
      {(image.caption || image.source) && (
        <figcaption>
          {image.caption && <span className="aw-img-caption" title={image.caption}>{image.caption}</span>}
          {image.source && (
            <ExtLink href={image.link ?? (image.url.startsWith('http') ? image.url : undefined)} className="aw-source-chip">
              {image.source}
            </ExtLink>
          )}
        </figcaption>
      )}
    </figure>
  );
}

function Lightbox({ images, index, onIndex, onClose }: {
  images: ImageItem[]; index: number; onIndex: (i: number) => void; onClose: () => void;
}): React.ReactElement {
  const img = images[index]!;
  const many = images.length > 1;
  const step = useCallback((d: number) => onIndex((index + d + images.length) % images.length), [index, images.length, onIndex]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);
  const href = img.link ?? (img.url.startsWith('http') ? img.url : undefined);
  return (
    <Overlay onClose={onClose} className="aw-lightbox" label="Image viewer">
      <div className="aw-lightbox-backdrop" onClick={onClose} />
      <div className="aw-lightbox-top">
        {many && <span className="aw-lightbox-count">{index + 1} / {images.length}</span>}
        <span className="aw-grow" />
        {href && <ExtLink href={href} className="aw-lightbox-btn"><Icon name="external" size={14} /> Open source</ExtLink>}
        {!href && img.url.startsWith('/') && (
          <a href={mediaUrl(img.url)} download={downloadName(img)} className="aw-lightbox-btn"><Icon name="download" size={14} /> Download</a>
        )}
        <button type="button" className="aw-lightbox-btn" onClick={onClose} aria-label="Close (Esc)"><Icon name="close" size={16} /></button>
      </div>
      <img className="aw-lightbox-img" src={mediaUrl(img.url)} alt={img.alt ?? img.caption ?? ''} referrerPolicy="no-referrer" />
      {many && (
        <>
          <button type="button" className="aw-lightbox-nav is-prev" onClick={() => step(-1)} aria-label="Previous image"><Icon name="chevron-left" size={22} /></button>
          <button type="button" className="aw-lightbox-nav is-next" onClick={() => step(1)} aria-label="Next image"><Icon name="chevron-right" size={22} /></button>
        </>
      )}
      {(img.caption || img.source) && (
        <div className="aw-lightbox-caption">
          {img.caption && <span>{img.caption}</span>}
          {img.source && <span className="aw-lightbox-source">{img.source}</span>}
        </div>
      )}
    </Overlay>
  );
}

/** A file name for saving an engine-served image: its caption, else "image". */
function downloadName(img: ImageItem): string {
  const base = (img.caption ?? img.alt ?? 'image').replace(/[^\w\- ]+/g, '').trim().slice(0, 60).replace(/\s+/g, '-') || 'image';
  return `${base}.png`;
}
