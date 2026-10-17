/* global process */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = process.env.STATIC_ROOT || '/dist';
const port = Number(process.env.PORT || 8080);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.xcf': 'application/octet-stream',
};

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return '/';
  }
}

function resolveRequestPath(url) {
  const pathname = safeDecode((url || '/').split('?')[0].split('#')[0]) || '/';
  const normalized = path.posix.normalize(pathname);
  const relative = normalized === '/' ? 'index.html' : normalized.replace(/^\/+/, '');
  const file = path.join(root, relative);

  if (!file.startsWith(root + path.sep) && file !== root) {
    return null;
  }

  return file;
}

function pickFile(url) {
  let file = resolveRequestPath(url);
  if (file === null) return null;

  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, 'index.html');
  }

  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    return file;
  }

  return path.join(root, 'index.html');
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'method not allowed\n', {
      allow: 'GET, HEAD',
      'content-type': 'text/plain; charset=utf-8',
    });
    return;
  }

  try {
    const file = pickFile(req.url);
    if (file === null) {
      send(res, 403, 'forbidden\n', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }

    const body = fs.readFileSync(file);
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': mimeTypes[ext] || 'application/octet-stream',
      'cache-control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    console.error('standalone-entry failed:', err && (err.stack || err));
    send(res, 500, 'internal server error\n', {
      'content-type': 'text/plain; charset=utf-8',
    });
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`vite app served by EdgeJS QuickJS on 0.0.0.0:${port}`);
});
