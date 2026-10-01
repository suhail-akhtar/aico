import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb } from './src/db.js';
import { sendJson, sendError, readJson, notFound } from './src/http.js';
import { listTickets, getTicket, createTicket, updateStatus } from './src/tickets.js';
import { listComments, addComment } from './src/comments.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serveStatic(req, res) {
  const rel = req.url === '/' ? 'index.html' : decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function ticketId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw notFound(`ticket ${raw} not found`);
  return id;
}

export function createServer({ dbPath = process.env.DB_PATH ?? 'data/helpdesk.db' } = {}) {
  const db = openDb(dbPath);
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x');
      if (!pathname.startsWith('/api/')) return serveStatic(req, res);

      let m;
      if (pathname === '/api/tickets' && req.method === 'GET') return sendJson(res, 200, listTickets(db));
      if (pathname === '/api/tickets' && req.method === 'POST') return sendJson(res, 201, createTicket(db, await readJson(req)));
      if ((m = pathname.match(/^\/api\/tickets\/([^/]+)$/))) {
        const id = ticketId(m[1]);
        if (req.method === 'GET') return sendJson(res, 200, getTicket(db, id));
        if (req.method === 'PATCH') return sendJson(res, 200, updateStatus(db, id, await readJson(req)));
      }
      if ((m = pathname.match(/^\/api\/tickets\/([^/]+)\/comments$/))) {
        const id = ticketId(m[1]);
        if (req.method === 'GET') return sendJson(res, 200, listComments(db, id));
        if (req.method === 'POST') return sendJson(res, 201, addComment(db, id, await readJson(req)));
      }
      throw notFound(`no route for ${req.method} ${pathname}`);
    } catch (err) {
      sendError(res, err);
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => console.log(`helpdesk listening on http://localhost:${port}`));
}
