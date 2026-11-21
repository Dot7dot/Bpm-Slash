// Zero-dependency static file server for BPM Slash.
// Usage: npm start  (PORT env var overrides the default 5173)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startServer({ port = 5173, root } = {}) {
  const rootDir = path.resolve(root || defaultRoot);

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.normalize(path.join(rootDir, rel));
      if (file !== rootDir && !file.startsWith(rootDir + path.sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
          return;
        }
        const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (range && (range[1] || range[2])) {
          let start = range[1] ? parseInt(range[1], 10) : Math.max(0, st.size - parseInt(range[2], 10));
          let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
          end = Math.min(end, st.size - 1);
          if (start > end || start >= st.size) {
            res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
            return;
          }
          res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
          if (req.method === 'HEAD') return res.end();
          fs.createReadStream(file, { start, end }).pipe(res);
          return;
        }
        res.writeHead(200, { ...headers, 'Content-Length': st.size });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).pipe(res);
      });
    } catch (e) {
      res.writeHead(400).end('Bad request');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  const actual = server.address().port;
  return {
    url: `http://localhost:${actual}`,
    port: actual,
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  const port = Number(process.env.PORT) || 5173;
  const s = await startServer({ port });
  console.log(`BPM Slash 已啟動：${s.url}`);
}
