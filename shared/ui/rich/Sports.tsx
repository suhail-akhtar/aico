/**
 * ```sports — a scoreboard: one card per game, a league table, or both.
 *
 * Each card shows both sides with their crests (or a letter badge), the
 * score, and the state: a pulsing LIVE pill with the clock, FINAL, or the
 * start in the reader's own time. Many games become a sideways row; the table
 * scrolls sideways on a phone with the team column pinned. The data is the
 * block's (usually the SportsScores tool's), so where it came from and how
 * old it is are always shown under it.
 *
 * @module shared/ui/rich/Sports
 */

import React, { useState } from 'react';
import { Arriving, Carousel, ExtLink, SafeImg, useParsed } from './common';
import {
  homeFirst, initialOf, parseSports, relativeDate, startLabel,
  type SportsGame, type SportsSide, type SportsSpec, type SportsStandings,
} from './specs';

/** Up to this many cards sit side by side; more become a carousel. */
const GRID_MAX = 3;
const TABLE_FIRST = 12;

export function Sports({ source, streaming = false }: { source: string; streaming?: boolean }): React.ReactElement {
  const { spec, waiting } = useParsed(source, streaming, parseSports);
  if (waiting || !spec) return <Arriving what="Scores" />;
  return <SportsView spec={spec} />;
}

function SportsView({ spec }: { spec: SportsSpec }): React.ReactElement {
  const live = spec.games.filter(g => g.status === 'live').length;
  const title = spec.title ?? spec.league ?? (spec.standings ? 'Standings' : 'Scores');
  const sub = [spec.title && spec.league && !spec.title.includes(spec.league) ? spec.league : undefined, dateLabel(spec.date)].filter(Boolean).join(' · ');
  const cards = spec.games.map(g => <GameCard key={g.id} game={g} sport={spec.sport} />);
  const updated = spec.updatedAt ? relativeDate(spec.updatedAt) : undefined;

  return (
    <div className="aw aw-sports">
      <div className="aw-sp-head">
        <div className="aw-sp-titles">
          <b className="aw-sp-title">{title}</b>
          {sub && <span className="aw-muted">{sub}</span>}
        </div>
        {live > 0 && <span className="aw-sp-live is-head"><span className="aw-sp-dot" />{live} live</span>}
      </div>

      {spec.games.length > 0 && (spec.games.length > GRID_MAX
        ? <Carousel label="Games" className="aw-sp-row">{cards}</Carousel>
        : <div className="aw-sp-grid" role="list" aria-label="Games">{cards}</div>)}

      {spec.standings && <Standings table={spec.standings} spaced={spec.games.length > 0} />}

      <div className="aw-source">
        {[spec.source ? `Source: ${spec.source}` : 'Scores as given',
          updated ? `updated ${updated}` : undefined,
          spec.games.some(g => g.status === 'live') ? 'live scores may lag' : undefined].filter(Boolean).join(' · ')}
      </div>
    </div>
  );
}

/** "Tue, 29 Sep" for a YYYY-MM-DD, read as a calendar date. */
function dateLabel(date: string | undefined): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function GameCard({ game, sport }: { game: SportsGame; sport?: string }): React.ReactElement {
  const sides = homeFirst(sport) ? [game.home, game.away] : [game.away, game.home];
  const decided = game.status === 'final' && (game.home.winner || game.away.winner);
  return (
    <ExtLink href={game.url} className={`aw-sp-card is-${game.status}`} title={game.venue}>
      <div className="aw-sp-status">
        <StatusPill game={game} />
        {game.note && <span className="aw-sp-note aw-ellipsis" title={game.note}>{game.note}</span>}
      </div>
      {sides.map((s, i) => <SideRow key={i} side={s} dim={decided && !s.winner} showScore={game.status !== 'scheduled'} />)}
      {game.venue && <div className="aw-sp-venue aw-ellipsis">{game.venue}</div>}
    </ExtLink>
  );
}

function StatusPill({ game }: { game: SportsGame }): React.ReactElement {
  switch (game.status) {
    case 'live':
      return <span className="aw-sp-live"><span className="aw-sp-dot" />LIVE{game.clock ? <span className="aw-sp-clock">{game.clock}</span> : null}</span>;
    case 'final':
      return <span className="aw-sp-state">{game.clock && !/^final$/i.test(game.clock) ? game.clock : 'Final'}</span>;
    case 'postponed':
      return <span className="aw-sp-state is-off">{game.clock ?? 'Postponed'}</span>;
    default:
      return <span className="aw-sp-state is-soon">{startLabel(game.start) ?? game.clock ?? 'Scheduled'}</span>;
  }
}

function SideRow({ side, dim, showScore }: { side: SportsSide; dim: boolean; showScore: boolean }): React.ReactElement {
  return (
    <div className={`aw-sp-side${side.winner ? ' is-winner' : ''}${dim ? ' is-dim' : ''}`}>
      <Crest logo={side.logo} name={side.name} size={24} />
      <span className="aw-sp-name">
        <span className="aw-ellipsis" title={side.name}>{side.name}</span>
        {side.record && <span className="aw-sp-record">{side.record}</span>}
      </span>
      {showScore && <span className="aw-sp-score">{side.score ?? '–'}</span>}
    </div>
  );
}

function Crest({ logo, name, size }: { logo?: string; name: string; size: number }): React.ReactElement {
  const letter = <span className="aw-sp-badge" style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}>{initialOf(name)}</span>;
  return (
    <span className="aw-sp-crest" style={{ width: size, height: size }}>
      <SafeImg src={logo} alt="" fallback={letter} />
    </span>
  );
}

function Standings({ table, spaced }: { table: SportsStandings; spaced: boolean }): React.ReactElement {
  const [all, setAll] = useState(false);
  // Each group is cut on its own, so a second conference is never hidden
  // entirely behind the first; a group only a few rows over the cut shows whole.
  const visible = (n: number): number => (all || n <= TABLE_FIRST + 4 ? n : TABLE_FIRST);
  const total = table.groups.reduce((n, g) => n + g.rows.length, 0);
  const shown = table.groups.reduce((n, g) => n + visible(g.rows.length), 0);
  return (
    <div className={`aw-sp-standings${spaced ? ' is-spaced' : ''}`}>
      {table.groups.map((g, gi) => {
        const rows = g.rows.slice(0, visible(g.rows.length));
        return (
          <div key={gi} className="aw-sp-group">
            {g.name && table.groups.length > 1 && <div className="aw-sp-group-name">{g.name}</div>}
            <div className="aw-sp-scroll">
              <table className="aw-sp-table">
                <thead>
                  <tr>
                    <th className="aw-sp-pos" scope="col">#</th>
                    <th className="aw-sp-team" scope="col">Team</th>
                    {table.columns.map((c, i) => <th key={i} scope="col">{c}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td className="aw-sp-pos">{i + 1}</td>
                      <td className="aw-sp-team">
                        <span className="aw-sp-team-cell">
                          <Crest logo={r.logo} name={r.team} size={18} />
                          <span className="aw-ellipsis" title={r.team}>{r.team}</span>
                        </span>
                      </td>
                      {table.columns.map((c, k) => (
                        <td key={k} className={/^(pts|points)$/i.test(c) ? 'is-key' : undefined}>{r.values[k] ?? '–'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      {shown < total && (
        <button type="button" className="aw-more" onClick={() => setAll(true)}>Show all {table.groups.length > 1 ? `${total} rows` : `${total} teams`}</button>
      )}
    </div>
  );
}
