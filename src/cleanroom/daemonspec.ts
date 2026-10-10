/**
 * Daemon specs: from a recorded session with a background process to a
 * description of how it behaves.
 *
 * A daemon's behaviour is what it says while starting, what it answers on each
 * channel for each thing it is sent, how it reacts to a signal, and what it does
 * when a file appears in a folder it watches. Each of those is a recorded step;
 * this groups them by channel, signal and file action, in the order they were
 * seen (a daemon is stateful, so order is part of the answer).
 *
 * Honest limits go into `unknowns`: only the channels given were probed (a
 * daemon may speak on others), a protocol is only as known as the probes that
 * were sent, signals are not delivered as signals on Windows, and D-Bus is not
 * covered.
 *
 * @module cleanroom/daemonspec
 */

import type { DaemonSpec, Journey } from './types.js';

export function daemonSpec(j: Journey, unknowns: string[]): DaemonSpec {
  const t = j.target as Extract<Journey['target'], { kind: 'daemon' }>;
  const channels = new Map<string, DaemonSpec['channels'][number]>();
  const signals: DaemonSpec['signals'] = [];
  const files: DaemonSpec['files'] = [];
  let startup = '';
  for (const s of j.steps) {
    const d = s.observation.daemon;
    if (!d) continue;
    const st = s.stimulus;
    if (st.type === 'wait' && !startup) { startup = [d.newStdout, d.newStderr].filter(Boolean).join(''); continue; }
    if (st.type === 'send') {
      const ch = channels.get(st.channel) ?? { channel: st.channel, exchanges: [] };
      ch.exchanges.push({ send: st.data, reply: d.connectError ? `(could not connect: ${d.connectError})` : (d.reply ?? ''), closed: !!d.closed });
      channels.set(st.channel, ch);
    } else if (st.type === 'signal') {
      signals.push({ signal: st.signal, exited: !d.alive, exitCode: d.exitCode ?? null, output: [d.newStdout, d.newStderr].filter(Boolean).join('').trim(), delivery: d.signalDelivery ?? 'signal' });
    } else if (st.type === 'fs-write' || st.type === 'fs-delete') {
      const name = st.path.split(/[\\/]/).pop() ?? st.path;
      const changes = (d.fsChanges ?? []).map(c => `${c.kind} ${c.path}`).join(', ') || 'no change on disk';
      files.push({ action: `${st.type === 'fs-write' ? 'write' : 'delete'} ${name}`, reaction: `${[d.newStdout, d.newStderr].filter(Boolean).join('').trim() || 'no output'} (${changes})` });
    }
  }
  const r = t.ready;
  const readyBy = r?.logMatch ? `its output matches /${r.logMatch}/` : r?.port ? `TCP port ${r.port} accepts a connection` : r?.socket ? `${r.socket} accepts a connection` : 'it has been running for a moment (no ready signal was declared)';
  if (!channels.size) unknowns.push('no channel was probed: the daemon printed no TCP port and none was given with --ipc, so only startup, signals and watched folders are described');
  unknowns.push('only the channels named were probed; the daemon may speak on others');
  unknowns.push('a protocol is only as known as the messages that were sent: commands outside the probe set are not described');
  if (j.platform === 'win32' || signals.some(x => x.delivery === 'forced')) unknowns.push('recorded on Windows: SIGHUP and SIGTERM are not delivered as signals there (the process is ended outright), so reload and graceful-shutdown behaviour is not observed');
  unknowns.push('D-Bus services are not covered');
  return { name: t.name ?? t.command.split(/[\\/]/).pop() ?? 'daemon', startup: { readyBy, output: startup }, channels: [...channels.values()], signals, files };
}
