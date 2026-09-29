/**
 * ```news — headlines with their source, age, picture and a line of summary.
 *
 * A list rather than a carousel: headlines are read, top to bottom, and a
 * sideways row hides all but the first two of them.
 *
 * @module shared/ui/rich/News
 */

import React, { useState } from 'react';
import { Arriving, ExtLink, Favicon, SafeImg, useParsed } from './common';
import { parseNews, relativeDate, type NewsSpec } from './specs';

const FIRST = 5;

export function News({ source, streaming = false }: { source: string; streaming?: boolean }): React.ReactElement {
  const { spec, waiting } = useParsed(source, streaming, parseNews);
  if (waiting || !spec) return <Arriving what="News" />;
  return <NewsView spec={spec} />;
}

function NewsView({ spec }: { spec: NewsSpec }): React.ReactElement {
  const [all, setAll] = useState(false);
  const items = all ? spec.items : spec.items.slice(0, FIRST);
  const hidden = spec.items.length - items.length;
  return (
    <div className="aw aw-news">
      {spec.title && <div className="aw-heading">{spec.title}</div>}
      <div className="aw-news-list" role="list">
        {items.map(item => {
          const when = relativeDate(item.date);
          return (
            <ExtLink key={item.id} href={item.url} className="aw-news-item">
              <div className="aw-news-text">
                <div className="aw-news-source">
                  <Favicon host={item.host} name={item.source} size={16} />
                  <span className="aw-ellipsis">{item.source ?? 'Unknown source'}</span>
                  {when && <><span className="aw-dot">·</span><time dateTime={item.date} title={item.date}>{when}</time></>}
                </div>
                <div className="aw-news-title">{item.title}</div>
                {item.summary && <div className="aw-news-summary">{item.summary}</div>}
              </div>
              {item.image && (
                <div className="aw-news-thumb">
                  <SafeImg src={item.image} alt="" />
                </div>
              )}
            </ExtLink>
          );
        })}
      </div>
      {hidden > 0 && (
        <button type="button" className="aw-more" onClick={() => setAll(true)}>Show {hidden} more</button>
      )}
    </div>
  );
}
