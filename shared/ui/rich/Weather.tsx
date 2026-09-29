/**
 * ```weather — current conditions, the next hours and the week, from data the
 * block carries (the engine's Weather tool fills it from Open-Meteo).
 *
 * Icons are inline SVG drawn here, keyed by WMO weather code, so there is no
 * icon font and nothing to fetch. °C/°F converts on the spot; the data is not
 * refetched.
 *
 * @module shared/ui/rich/Weather
 */

import React, { useState } from 'react';
import { Arriving, Icon, useParsed } from './common';
import {
  convertTemp, convertWind, parseWeather, upcomingHours, wallTime, weekday, wmo, type WeatherIcon, type WeatherSpec,
} from './specs';

type Units = 'metric' | 'imperial';

export function Weather({ source, streaming = false }: { source: string; streaming?: boolean }): React.ReactElement {
  const { spec, waiting } = useParsed(source, streaming, parseWeather);
  if (waiting || !spec) return <Arriving what="Weather" />;
  return <WeatherView spec={spec} />;
}

function WeatherView({ spec }: { spec: WeatherSpec }): React.ReactElement {
  const [units, setUnits] = useState<Units>(spec.units);
  const t = (v: number): string => `${Math.round(convertTemp(v, spec.units, units))}°`;
  const c = spec.current;
  const now = c ? wmo(c.code) : spec.daily[0] ? wmo(spec.daily[0].code) : wmo(undefined);
  const hours = upcomingHours(spec.hourly, c?.time, 24);
  const days = spec.daily.slice(0, 7);
  const lo = Math.min(...days.map(d => d.min)), hi = Math.max(...days.map(d => d.max));
  const today = spec.daily[0];

  return (
    <div className="aw aw-weather">
      <div className="aw-wx-now">
        <div className="aw-wx-main">
          <div className="aw-wx-place">
            <b>{spec.location}</b>
            <span className="aw-muted">
              {c?.time ? `${weekday(c.time, undefined, 'long')} ${wallTime(c.time) ?? ''}` : today ? weekday(today.date, undefined, 'long') : ''}
            </span>
          </div>
          <div className="aw-wx-hero">
            <WxIcon icon={now.icon} night={c ? !c.isDay : false} size={64} />
            <span className="aw-wx-temp">{c ? t(c.temp) : today ? t(today.max) : '—'}</span>
            <div className="aw-units" role="group" aria-label="Units">
              <button type="button" className={units === 'metric' ? 'is-on' : ''} aria-pressed={units === 'metric'} onClick={() => setUnits('metric')}>°C</button>
              <button type="button" className={units === 'imperial' ? 'is-on' : ''} aria-pressed={units === 'imperial'} onClick={() => setUnits('imperial')}>°F</button>
            </div>
          </div>
        </div>
        <div className="aw-wx-side">
          <div className="aw-wx-cond">{now.label}</div>
          {today && <div className="aw-muted">H {t(today.max)} · L {t(today.min)}</div>}
          <div className="aw-wx-facts">
            {c?.feels !== undefined && <span><Icon name="drop" size={12} className="aw-wx-fact-icon" />Feels {t(c.feels)}</span>}
            {c?.humidity !== undefined && <span><Icon name="humidity" size={12} className="aw-wx-fact-icon" />{Math.round(c.humidity)}%</span>}
            {c?.wind !== undefined && (
              <span><Icon name="wind" size={12} className="aw-wx-fact-icon" />
                {Math.round(convertWind(c.wind, spec.units, units))} {units === 'metric' ? 'km/h' : 'mph'}</span>
            )}
            {today?.sunrise && <span><Icon name="sunrise" size={12} className="aw-wx-fact-icon" />{wallTime(today.sunrise)}</span>}
            {today?.sunset && <span><Icon name="sunset" size={12} className="aw-wx-fact-icon" />{wallTime(today.sunset)}</span>}
          </div>
        </div>
      </div>

      {hours.length > 0 && (
        <div className="aw-wx-hours" role="list" aria-label="Hourly forecast">
          {hours.map((h, i) => {
            const hour = Number(wallTime(h.time)?.slice(0, 2) ?? 12);
            return (
              <div key={h.time} className="aw-wx-hour" role="listitem">
                <span className="aw-muted">{i === 0 && c ? 'Now' : wallTime(h.time)}</span>
                <WxIcon icon={wmo(h.code).icon} night={hour < 6 || hour >= 19} size={26} />
                <b>{t(h.temp)}</b>
                <span className="aw-wx-precip">{h.precip !== undefined && h.precip > 0 ? `${Math.round(h.precip)}%` : ' '}</span>
              </div>
            );
          })}
        </div>
      )}

      {days.length > 0 && (
        <div className="aw-wx-days" role="list" aria-label="Daily forecast">
          {days.map((d, i) => {
            const w = wmo(d.code);
            const left = hi > lo ? ((d.min - lo) / (hi - lo)) * 100 : 0;
            const width = hi > lo ? Math.max(6, ((d.max - d.min) / (hi - lo)) * 100) : 100;
            return (
              <div key={d.date} className="aw-wx-day" role="listitem" title={w.label}>
                <span className="aw-wx-dayname">{i === 0 ? 'Today' : weekday(d.date)}</span>
                <WxIcon icon={w.icon} size={30} />
                <span className="aw-wx-precip">{d.precip !== undefined && d.precip > 0 ? `${Math.round(d.precip)}%` : ' '}</span>
                <span className="aw-wx-range">
                  <b>{t(d.max)}</b>
                  <span className="aw-muted">{t(d.min)}</span>
                </span>
                <span className="aw-wx-bar" aria-hidden="true"><span style={{ left: `${left}%`, width: `${Math.min(100 - left, width)}%` }} /></span>
              </div>
            );
          })}
        </div>
      )}

      <div className="aw-source">
        {spec.source ?? 'Forecast data'}{spec.timezone ? ` · times in ${spec.timezone}` : ''}
      </div>
    </div>
  );
}

// ── Icons ────────────────────────────────────────────────────────────

function Sun({ cx = 12, cy = 12, r = 4.2 }: { cx?: number; cy?: number; r?: number }): React.ReactElement {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    return <line key={i} x1={cx + Math.cos(a) * (r + 2)} y1={cy + Math.sin(a) * (r + 2)} x2={cx + Math.cos(a) * (r + 3.8)} y2={cy + Math.sin(a) * (r + 3.8)} />;
  });
  return <g className="aw-wx-sun"><circle cx={cx} cy={cy} r={r} />{rays}</g>;
}

function Moon({ x = 0, y = 0, s = 1 }: { x?: number; y?: number; s?: number }): React.ReactElement {
  return <path className="aw-wx-moon" transform={`translate(${x} ${y}) scale(${s})`} d="M15.5 3.5a8 8 0 1 0 5 12.8A7 7 0 0 1 15.5 3.5z" />;
}

function Cloud({ x = 0, y = 0, s = 1, dark = false }: { x?: number; y?: number; s?: number; dark?: boolean }): React.ReactElement {
  return (
    <path className={dark ? 'aw-wx-cloud is-dark' : 'aw-wx-cloud'} transform={`translate(${x} ${y}) scale(${s})`}
      d="M7 19h10.5a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.6 10 4.5 4.5 0 0 0 7 19z" />
  );
}

function Drops({ n = 3, y = 20, snow = false, x0 = 8 }: { n?: number; y?: number; snow?: boolean; x0?: number }): React.ReactElement {
  return (
    <g className={snow ? 'aw-wx-snow' : 'aw-wx-rain'}>
      {Array.from({ length: n }, (_, i) => snow
        ? <circle key={i} cx={x0 + i * 4} cy={y + (i % 2) * 1.6} r={1.1} />
        : <line key={i} x1={x0 + i * 4} y1={y} x2={x0 - 1.2 + i * 4} y2={y + 2.8} />)}
    </g>
  );
}

export function WxIcon({ icon, night = false, size = 28 }: { icon: WeatherIcon; night?: boolean; size?: number }): React.ReactElement {
  let art: React.ReactNode;
  switch (icon) {
    case 'clear': art = night ? <Moon x={1} y={1} s={0.9} /> : <Sun />; break;
    case 'mostly-clear': art = <>{night ? <Moon x={0} y={-1} s={0.75} /> : <Sun cx={9.5} cy={9} r={3.6} />}<Cloud x={6} y={5} s={0.7} /></>; break;
    case 'partly': art = <>{night ? <Moon x={-1} y={-2} s={0.7} /> : <Sun cx={8.5} cy={8} r={3.4} />}<Cloud x={3} y={2} s={0.9} /></>; break;
    case 'overcast': art = <><Cloud x={-3} y={-4} s={0.85} dark /><Cloud x={1} y={0} s={0.95} /></>; break;
    case 'fog': art = <><Cloud x={0} y={-3} s={0.95} /><g className="aw-wx-fog"><line x1="4" y1="19.5" x2="20" y2="19.5" /><line x1="6" y1="22" x2="18" y2="22" /></g></>; break;
    case 'drizzle': art = <><Cloud x={0} y={-3} s={0.95} /><Drops n={3} y={18.5} /></>; break;
    case 'rain': art = <><Cloud x={0} y={-3} s={0.95} /><Drops n={3} y={18} /></>; break;
    case 'heavy-rain': art = <><Cloud x={0} y={-3} s={0.95} dark /><Drops n={4} y={18} x0={6} /></>; break;
    case 'freezing': art = <><Cloud x={0} y={-3} s={0.95} /><Drops n={2} y={18} x0={8} /><Drops n={1} y={20} x0={16} snow /></>; break;
    case 'snow': art = <><Cloud x={0} y={-3} s={0.95} /><Drops n={3} y={19} snow /></>; break;
    case 'showers': art = <>{night ? <Moon x={-1} y={-3} s={0.65} /> : <Sun cx={8} cy={7} r={3} />}<Cloud x={2} y={-1} s={0.9} /><Drops n={3} y={19} x0={9} /></>; break;
    case 'snow-showers': art = <>{night ? <Moon x={-1} y={-3} s={0.65} /> : <Sun cx={8} cy={7} r={3} />}<Cloud x={2} y={-1} s={0.9} /><Drops n={3} y={20} x0={9} snow /></>; break;
    case 'thunder': art = <><Cloud x={0} y={-3} s={0.95} dark /><path className="aw-wx-bolt" d="M12.5 15.5 10 19.5h2.5L11 23l4-5h-2.5l1.5-2.5z" /></>; break;
    default: art = <Cloud x={0} y={-1} s={0.95} />;
  }
  return <svg className="aw-wx-icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">{art}</svg>;
}
