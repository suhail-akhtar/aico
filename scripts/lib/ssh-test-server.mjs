/**
 * A real SSH server for testing AICO's ops tools, on 127.0.0.1 only, in-process.
 *
 * Why this exists: the ops tools must be proven against an SSH server that
 * does host keys, password and public-key auth, exec channels with stdin,
 * stderr and exit codes, SFTP and port forwarding — without touching the
 * owner's machines and without installing a system service. `ssh2` (already a
 * dependency of the engine) implements the server side of the protocol, so the
 * test runs a genuine SSH handshake against it.
 *
 * What executes the commands is a *backend*:
 *   - `local`  — a POSIX shell on this machine (Git Bash on Windows), in a temp
 *                directory that is the SFTP root. Used by the offline suite.
 *   - `docker` — `docker exec -i` into a throwaway container (`--network none`),
 *                so the live test can create users and set file modes on a
 *                real Linux. SFTP is served by shelling into the same
 *                container, so files and commands see one filesystem.
 * Either way the server is the "remote machine": it may hold its own copy of
 * a password (as a real server's /etc/shadow would) to check what it is sent.
 *
 * A fake `sudo` (POSIX sh) is put first on PATH. It speaks `sudo -S -p PROMPT
 * -- cmd`: prints PROMPT to stderr, reads one line, compares its SHA-256 with
 * FAKE_SUDO_SHA256, re-prompts once on a mismatch, then runs the command.
 * With NOPASSWD=1 it never prompts and never reads stdin — the case where a
 * client that blindly pipes the password would hand it to the command.
 *
 * Every exec request string is recorded (`server.execs`) so tests can assert
 * that no secret value was ever part of one.
 */

import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;

export const FAKE_SUDO = `#!/bin/sh
prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -S) shift ;;
    -p) prompt="$2"; shift 2 ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
if [ -z "$NOPASSWD" ]; then
  printf '%s' "$prompt" >&2
  IFS= read -r pw || exit 1
  if [ "$(printf '%s' "$pw" | sha256sum | cut -d' ' -f1)" != "$FAKE_SUDO_SHA256" ]; then
    printf 'Sorry, try again.\\n' >&2
    printf '%s' "$prompt" >&2
    IFS= read -r pw2
    echo "sudo: 1 incorrect password attempt" >&2
    exit 1
  fi
fi
exec "$@"
`;

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The POSIX shell the local backend runs commands with, or null. */
export function findPosixShell() {
  if (process.platform !== 'win32') return '/bin/sh';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find(c => c && fs.existsSync(c)) ?? null;
}

// ── backends ─────────────────────────────────────────────────────────

export function localBackend() {
  const shell = findPosixShell();
  if (!shell) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-ssh-root-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-ssh-bin-'));
  fs.writeFileSync(path.join(bin, 'sudo'), FAKE_SUDO, { mode: 0o755 });
  const abs = (p) => path.join(root, ...String(p).split('/').filter(Boolean));
  return {
    kind: 'local',
    root,
    exec(command, env) {
      return spawn(shell, ['-c', command], {
        cwd: root,
        env: { ...process.env, ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
        windowsHide: true,
      });
    },
    async readFile(p) { return fs.readFileSync(abs(p)); },
    async writeFile(p, data, mode) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), data, { mode }); try { fs.chmodSync(abs(p), mode); } catch { /* windows */ } },
    async stat(p) {
      const st = fs.statSync(abs(p));
      return { mode: st.mode, size: st.size, uid: 0, gid: 0, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000), dir: st.isDirectory() };
    },
    async mkdir(p) { fs.mkdirSync(abs(p), { recursive: true }); },
    async chmod(p, mode) { try { fs.chmodSync(abs(p), mode); } catch { /* windows */ } },
    async readdir(p) { return fs.readdirSync(abs(p)); },
    close() {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
      try { fs.rmSync(bin, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/** Docker available and an image present locally (never pulls). */
export function dockerImageAvailable(image) {
  const r = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 20_000 });
  return r.status === 0;
}

export function dockerBackend(image = 'alpine:3.22') {
  if (!dockerImageAvailable(image)) return null;
  const name = `aico-ops-test-${crypto.randomBytes(4).toString('hex')}`;
  const run = spawnSync('docker', ['run', '-d', '--rm', '--network', 'none', '--name', name, image, 'sleep', '3600'], { encoding: 'utf8', timeout: 60_000 });
  if (run.status !== 0) return null;
  const dx = (args, input) => {
    const r = spawnSync('docker', ['exec', '-i', name, ...args], { input, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    return r;
  };
  dx(['sh', '-c', 'cat > /usr/local/bin/sudo && chmod 755 /usr/local/bin/sudo'], FAKE_SUDO);
  const sh = (script, ...args) => dx(['sh', '-c', script, '_', ...args]);
  return {
    kind: 'docker',
    container: name,
    exec(command, env) {
      const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      return spawn('docker', ['exec', '-i', ...envArgs, name, 'sh', '-c', command], { windowsHide: true });
    },
    async readFile(p) {
      const r = sh('cat -- "$1"', p);
      if (r.status !== 0) throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
      return r.stdout;
    },
    async writeFile(p, data, mode) {
      const r = dx(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1" && chmod "$2" "$1"', '_', p, mode.toString(8)], data);
      if (r.status !== 0) throw new Error(String(r.stderr));
    },
    async stat(p) {
      const r = sh('stat -c "%f %s %u %g %X %Y %F" -- "$1"', p);
      if (r.status !== 0) throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
      const [modeHex, size, uid, gid, atime, mtime, ...type] = String(r.stdout).trim().split(' ');
      return { mode: parseInt(modeHex, 16), size: Number(size), uid: Number(uid), gid: Number(gid), atime: Number(atime), mtime: Number(mtime), dir: type.join(' ') === 'directory' };
    },
    async mkdir(p) { sh('mkdir -p -- "$1"', p); },
    async chmod(p, mode) { sh('chmod "$2" -- "$1"', p, mode.toString(8)); },
    async readdir(p) {
      const r = sh('ls -A -- "$1"', p);
      return String(r.stdout).split('\n').filter(Boolean);
    },
    close() { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 60_000 }); },
  };
}

// ── the server ───────────────────────────────────────────────────────

/**
 * Start a server. `users`: { name: { password?, publicKey? (OpenSSH line) } }.
 * Returns { port, hostKey (public line), fingerprint, execs, authAttempts, env, close() }.
 * `env` is mutable: the next exec sees its current values (NOPASSWD, FAKE_SUDO_SHA256).
 */
export async function startSshServer({ backend, users, hostKey, port = 0 }) {
  // ssh2 cannot always parse the ed25519 key it generates (seen on Node 22 under Linux: parseKey returns an
  // Error), so fall back to ECDSA rather than crash the suite.
  let keys = hostKey ?? utils.generateKeyPairSync('ed25519');
  let parsedHost = utils.parseKey(keys.public);
  if (!hostKey && (parsedHost instanceof Error || typeof parsedHost?.getPublicSSH !== 'function')) {
    keys = utils.generateKeyPairSync('ecdsa', { bits: 256 });
    parsedHost = utils.parseKey(keys.public);
  }
  const hostBlob = parsedHost.getPublicSSH();
  const state = {
    execs: [],
    authAttempts: [],
    env: { FAKE_SUDO_SHA256: '', NOPASSWD: '' },
    sockets: new Set(),
  };
  const allowed = Object.fromEntries(Object.entries(users).map(([u, v]) => [u, {
    ...v, parsedKey: v.publicKey ? utils.parseKey(v.publicKey) : undefined,
  }]));

  const server = new Server({ hostKeys: [keys.private] }, (client) => {
    state.sockets.add(client);
    client.on('close', () => state.sockets.delete(client));
    client.on('authentication', (ctx) => {
      state.authAttempts.push({ user: ctx.username, method: ctx.method });
      const u = allowed[ctx.username];
      if (u && ctx.method === 'password' && typeof u.password === 'string'
        && crypto.timingSafeEqual(Buffer.from(sha256(ctx.password)), Buffer.from(sha256(u.password)))) return ctx.accept();
      if (u && ctx.method === 'publickey' && u.parsedKey
        && ctx.key.algo === u.parsedKey.type && Buffer.compare(ctx.key.data, u.parsedKey.getPublicSSH()) === 0) {
        if (!ctx.signature) return ctx.accept();
        if (u.parsedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
      }
      return ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('exec', (accept, _reject, info) => {
          state.execs.push(info.command);
          const stream = accept();
          const child = backend.exec(info.command, { ...state.env });
          stream.pipe(child.stdin);
          child.stdin.on('error', () => {});
          child.stdout.on('data', d => stream.write(d));
          child.stderr.on('data', d => stream.stderr.write(d));
          let exited = false;
          child.on('close', (code) => {
            exited = true;
            try { stream.exit(code ?? 1); stream.end(); } catch { /* client gone */ }
          });
          child.on('error', (err) => { try { stream.stderr.write(String(err)); stream.exit(127); stream.end(); } catch { /* gone */ } });
          stream.on('close', () => { if (!exited) try { child.kill(); } catch { /* gone */ } });
        });
        session.on('signal', (accept) => { accept?.(); });
        session.on('sftp', (accept) => serveSftp(accept(), backend));
      });
      client.on('tcpip', (accept, reject, info) => {
        const sock = net.connect(info.destPort, info.destIP);
        sock.on('error', () => { try { reject(); } catch { /* already accepted */ } });
        sock.on('connect', () => {
          const stream = accept();
          stream.pipe(sock).pipe(stream);
          stream.on('error', () => sock.destroy());
        });
      });
    });
    client.on('error', () => { /* a client hanging up mid-handshake is normal (host key probes) */ });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  return {
    port: actualPort,
    hostPublic: keys.public,
    hostKeys: keys,
    fingerprint: `SHA256:${crypto.createHash('sha256').update(hostBlob).digest('base64').replace(/=+$/, '')}`,
    execs: state.execs,
    authAttempts: state.authAttempts,
    env: state.env,
    close: () => new Promise((resolve) => {
      for (const c of state.sockets) { try { c.end(); } catch { /* gone */ } }
      server.close(() => resolve());
    }),
  };
}

// ── SFTP, over the backend ───────────────────────────────────────────

function serveSftp(sftp, backend) {
  const handles = new Map();
  let next = 1;
  const newHandle = (value) => {
    const id = Buffer.alloc(4);
    id.writeUInt32BE(next++);
    handles.set(id.toString('hex'), value);
    return id;
  };
  const get = (h) => handles.get(Buffer.from(h).toString('hex'));
  const attrsOf = (st) => ({ mode: st.mode, size: st.size, uid: st.uid, gid: st.gid, atime: st.atime, mtime: st.mtime });
  const fail = (reqid, err) => sftp.status(reqid, err?.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);

  sftp.on('OPEN', async (reqid, filename, flags, attrs) => {
    const mode = utils.sftp.flagsToString(flags) ?? 'r';
    try {
      if (/[wa+]/.test(mode)) {
        sftp.handle(reqid, newHandle({ kind: 'write', path: filename, chunks: [], size: 0, mode: attrs?.mode ?? 0o644 }));
      } else {
        const data = await backend.readFile(filename);
        sftp.handle(reqid, newHandle({ kind: 'read', path: filename, data }));
      }
    } catch (err) { fail(reqid, err); }
  });
  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const h = get(handle);
    if (!h || h.kind !== 'write') return sftp.status(reqid, STATUS_CODE.FAILURE);
    h.chunks.push({ offset, data: Buffer.from(data) });
    h.size = Math.max(h.size, offset + data.length);
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on('READ', (reqid, handle, offset, length) => {
    const h = get(handle);
    if (!h || h.kind !== 'read') return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (offset >= h.data.length) return sftp.status(reqid, STATUS_CODE.EOF);
    sftp.data(reqid, h.data.subarray(offset, Math.min(h.data.length, offset + length)));
  });
  sftp.on('FSTAT', (reqid, handle) => {
    const h = get(handle);
    if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
    const size = h.kind === 'read' ? h.data.length : h.size;
    sftp.attrs(reqid, { mode: 0o100644, size, uid: 0, gid: 0, atime: 0, mtime: 0 });
  });
  sftp.on('FSETSTAT', (reqid, handle, attrs) => {
    const h = get(handle);
    if (h && h.kind === 'write' && attrs?.mode !== undefined) h.mode = attrs.mode;
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on('CLOSE', async (reqid, handle) => {
    const h = get(handle);
    handles.delete(Buffer.from(handle).toString('hex'));
    if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
    try {
      if (h.kind === 'write') {
        const buf = Buffer.alloc(h.size);
        for (const c of h.chunks) c.data.copy(buf, c.offset);
        await backend.writeFile(h.path, buf, h.mode & 0o7777);
      }
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) { fail(reqid, err); }
  });
  const statHandler = async (reqid, p) => {
    try { sftp.attrs(reqid, attrsOf(await backend.stat(p))); } catch (err) { fail(reqid, err); }
  };
  sftp.on('STAT', statHandler);
  sftp.on('LSTAT', statHandler);
  sftp.on('SETSTAT', async (reqid, p, attrs) => {
    try { if (attrs?.mode !== undefined) await backend.chmod(p, attrs.mode & 0o7777); sftp.status(reqid, STATUS_CODE.OK); } catch (err) { fail(reqid, err); }
  });
  sftp.on('MKDIR', async (reqid, p) => {
    try { await backend.mkdir(p); sftp.status(reqid, STATUS_CODE.OK); } catch (err) { fail(reqid, err); }
  });
  sftp.on('REALPATH', (reqid, p) => sftp.name(reqid, [{ filename: p, longname: p, attrs: {} }]));
  sftp.on('OPENDIR', async (reqid, p) => {
    try {
      const names = await backend.readdir(p);
      sftp.handle(reqid, newHandle({ kind: 'dir', path: p, names, sent: false }));
    } catch (err) { fail(reqid, err); }
  });
  sftp.on('READDIR', async (reqid, handle) => {
    const h = get(handle);
    if (!h || h.kind !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (h.sent) return sftp.status(reqid, STATUS_CODE.EOF);
    h.sent = true;
    const list = [];
    for (const n of h.names) {
      try {
        const st = await backend.stat(`${h.path.replace(/\/$/, '')}/${n}`);
        const typeBits = st.dir ? 0o040000 : 0o100000;
        list.push({ filename: n, longname: n, attrs: { ...attrsOf(st), mode: (st.mode & 0o7777) | typeBits } });
      } catch { /* vanished */ }
    }
    if (!list.length) return sftp.status(reqid, STATUS_CODE.EOF);
    sftp.name(reqid, list);
  });
}
