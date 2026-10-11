// Moneta local server: serves the web app and the JSON API. Binds to localhost only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { handleApi } from './api.js';
import { HttpError } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 4747;
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = process.env.MONETA_DB || path.join(ROOT, 'data', 'moneta.db');
const MAX_BODY = 25 * 1024 * 1024;

const VENDOR = {
  '/vendor/chart.js': path.join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const db = openDb(DB_FILE);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request is too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let file = VENDOR[pathname];
  if (!file) {
    let rel;
    try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''); }
    catch { return send(res, 400, 'Bad request'); }
    file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (!path.extname(pathname)) return serveStatic(req, res, '/'); // SPA fallback
      return send(res, 404, 'Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url.pathname);
  }
  // Only accept API calls from this app's own origin, so other websites can't reach the local API.
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) {
    return send(res, 403, JSON.stringify({ error: 'Cross-origin request blocked' }), { 'Content-Type': 'application/json' });
  }
  try {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const query = Object.fromEntries(url.searchParams);
    const out = await handleApi(db, req.method, url.pathname, query, body);
    if (out && out.raw) return send(res, out.raw.status, out.raw.body, out.raw.headers);
    send(res, 200, JSON.stringify(out ?? null), { 'Content-Type': 'application/json; charset=utf-8' });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    send(res, status, JSON.stringify({ error: status === 500 ? `Something went wrong: ${err.message}` : err.message }), { 'Content-Type': 'application/json; charset=utf-8' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Moneta may already be running at http://localhost:${PORT}\n  (or start it on another port: PORT=4848 npm start)\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Moneta is running at http://localhost:${PORT}\n  Data file: ${DB_FILE}\n  Press Ctrl+C to stop.\n`);
});

const shutdown = () => { server.close(); try { db.close(); } catch { /* already closed */ } process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
