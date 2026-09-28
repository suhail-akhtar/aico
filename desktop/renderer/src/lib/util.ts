/**
 * Small formatting helpers used across the interface.
 * @module desktop/renderer/lib/util
 */

/** "now", "5m", "3h", "2d", "4mo", "1y" — the compact age Antigravity shows beside a chat. */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.round(mo / 12)}y`;
}

/** "Today", "Yesterday", "Previous 7 days", "Previous 30 days", "March 2026". */
export function dayBucket(ts: number, now = Date.now()): string {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (ts >= start.getTime()) return 'Today';
  if (ts >= start.getTime() - day) return 'Yesterday';
  if (ts >= start.getTime() - 7 * day) return 'Previous 7 days';
  if (ts >= start.getTime() - 30 * day) return 'Previous 30 days';
  return new Date(ts).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : p;
}

export function initials(name: string): string {
  const parts = name.replace(/[._-]+/g, ' ').trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase() || '?';
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'chat';
}

export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Match a keyboard event against "Ctrl+Shift+K" style specs (Ctrl = Cmd on macOS). */
export function matchesKey(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.toLowerCase().split('+').map(s => s.trim());
  const key = parts.pop();
  const mac = navigator.platform.toLowerCase().includes('mac');
  const want = { ctrl: false, shift: false, alt: false, meta: false };
  for (const p of parts) {
    if (p === 'ctrl' || p === 'cmdorctrl' || p === 'mod') { if (mac) want.meta = true; else want.ctrl = true; }
    else if (p === 'cmd' || p === 'meta') want.meta = true;
    else if (p === 'shift') want.shift = true;
    else if (p === 'alt' || p === 'option') want.alt = true;
  }
  if (e.ctrlKey !== want.ctrl || e.shiftKey !== want.shift || e.altKey !== want.alt || e.metaKey !== want.meta) return false;
  const k = e.key.toLowerCase();
  return k === key || e.code.toLowerCase() === `key${key}` || (key === 'comma' && k === ',') || (key === 'enter' && k === 'enter');
}

export function prettyKey(spec: string): string {
  const mac = navigator.platform.toLowerCase().includes('mac');
  return spec.split('+').map(p => {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'cmdorctrl' || l === 'mod') return mac ? '⌘' : 'Ctrl';
    if (l === 'shift') return mac ? '⇧' : 'Shift';
    if (l === 'alt') return mac ? '⌥' : 'Alt';
    return p.length === 1 ? p.toUpperCase() : p;
  }).join(mac ? '' : '+');
}
