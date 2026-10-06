/**
 * A stand-in for the `docker` command, so the container fallback and the compose
 * path are tested without Docker (ADR 0031).
 *
 * It records every invocation (one JSON line of argv in $FAKE_DOCKER_LOG) and
 * behaves the way the engine needs: `info` answers, `run` publishes the mapped
 * host port and answers 200 on it like a dev server, `compose up` succeeds,
 * `compose logs -f` prints one line per service and stays alive, `rm` and
 * `compose down` succeed. What it deliberately does not do: parse mounts or
 * images — the tests read the recorded argv for that.
 */
import fs from 'node:fs';
import http from 'node:http';

const args = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify(args)}\n`);

const [cmd, ...rest] = args;
if (cmd === 'info') { console.log('27.0.0'); process.exit(0); }
if (cmd === 'rm') process.exit(0);
if (cmd === 'compose') {
  const sub = rest.find(a => ['up', 'down', 'logs', 'ps'].includes(a));
  if (sub === 'up') { console.log('Container proj-api-1  Started'); process.exit(0); }
  if (sub === 'down') process.exit(0);
  if (sub === 'logs') {
    console.log('api-1  | hello from api');
    console.log('web-1  | hello from web');
    setInterval(() => {}, 1000);
  } else process.exit(0);
} else if (cmd === 'run') {
  const p = rest[rest.indexOf('-p') + 1];
  const host = Number(/^127\.0\.0\.1:(\d+):(\d+)$/.exec(p ?? '')?.[1]);
  if (host) {
    http.createServer((_req, res) => { res.end('ok'); }).listen(host, '127.0.0.1', () => {
      console.log('Uvicorn running on http://0.0.0.0:8000');
    });
  } else {
    // A one-shot (a check): run to completion.
    console.log('check ran in a container');
    process.exit(0);
  }
  process.on('SIGTERM', () => process.exit(0));
} else {
  process.exit(0);
}
