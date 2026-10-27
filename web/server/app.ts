import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { open, stat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';
import { createAntfly } from './antfly.ts';
import type { Config } from './config.ts';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
function json(res: ServerResponse, status: number, value: unknown, head = false) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(head ? undefined : JSON.stringify(value));
}
async function body(req: IncomingMessage, search: boolean) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Content-Type must be application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16 * 1024) { req.resume(); throw new HttpError(413, 'Request body exceeds 16 KiB'); }
    chunks.push(chunk);
  }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new HttpError(400, 'Expected JSON object');
  const values = data as Record<string, unknown>;
  const allowed = search ? ['query', 'limit', 'mood'] : ['limit', 'mood'];
  if (Object.keys(values).some(k => !allowed.includes(k))) throw new HttpError(400, 'Unknown request field');
  if (search && (typeof values.query !== 'string' || values.query.length > 2048)) throw new HttpError(400, 'query must be a string of at most 2048 code units');
  const limit = values.limit === undefined ? (search ? 50 : 30) : values.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, 'limit must be an integer in 1..50');
  const mood = values.mood;
  if (mood !== undefined && (typeof mood !== 'string' || !mood.trim() || mood.length > 64)) throw new HttpError(400, 'mood must be nonempty and at most 64 code units');
  return { query: values.query as string, limit, mood: mood as string | undefined };
}

export function createApp(config: Config) {
  const service = createAntfly(config);
  let active = 0;
  return createServer(async (req, res) => {
    const head = req.method === 'HEAD';
    try {
      const rawPath = (req.url ?? '/').split('?')[0];
      let path: string;
      try { path = decodeURIComponent(rawPath); }
      catch { throw new HttpError(400, 'Invalid path encoding'); }
      if (path.includes('\0') || path.includes('\\') || path.split('/').includes('..')) throw new HttpError(400, 'Invalid path');
      if (path === '/healthz') {
        if (req.method !== 'GET' && !head) { res.setHeader('Allow', 'GET, HEAD'); throw new HttpError(405, 'Method not allowed'); }
        json(res, 200, { ok: true }, head); return;
      }
      const search = path === '/api/search';
      const random = path === '/api/random';
      const detail = /^\/api\/gifs\/[^/]+$/.test(rawPath);
      if (search || random || detail) {
        const method = detail ? 'GET' : 'POST';
        if (req.method !== method) { res.setHeader('Allow', method); throw new HttpError(405, 'Method not allowed'); }
        const id = detail ? path.slice('/api/gifs/'.length) : '';
        if (detail && (!id || id.length > 512)) throw new HttpError(400, 'id must be nonempty and at most 512 code units');
        const input = detail ? undefined : await body(req, search);
        if (active >= config.maxConcurrentQueries) {
          res.setHeader('Retry-After', '1'); throw new HttpError(429, 'Too many concurrent queries');
        }
        active++;
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
        const disconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', disconnect);
        if (res.destroyed) controller.abort();
        try {
          const result = detail ? await service.getGifById(id, controller.signal)
            : search ? await service.searchGifs(input!.query, input!.limit, input!.mood, controller.signal)
            : await service.getRandomGifs(input!.limit, input!.mood, controller.signal);
          if (controller.signal.aborted) throw controller.signal.reason;
          json(res, result === null ? 404 : 200, result ?? { error: 'GIF not found' });
        } catch {
          if (!res.destroyed) json(res, timedOut ? 504 : 502, { error: timedOut ? 'Antfly request timed out' : 'Antfly request failed' });
        } finally { clearTimeout(timer); res.off('close', disconnect); active--; }
        return;
      }
      if (path === '/api' || path.startsWith('/api/') || path === '/termite' || path.startsWith('/termite/')) throw new HttpError(404, 'Not found');
      if (req.method !== 'GET' && !head) throw new HttpError(404, 'Not found');
      try { if (!(await stat(dist)).isDirectory()) throw new Error(); }
      catch { throw new HttpError(503, 'Frontend unavailable; build web/dist first'); }
      let target = resolve(dist, `.${path}`);
      if (target !== resolve(dist) && !target.startsWith(resolve(dist) + sep)) throw new HttpError(400, 'Invalid path');
      let file;
      try { file = await open(target); if (!(await file.stat()).isFile()) { await file.close(); file = undefined; } }
      catch { /* extensionless routes may use the SPA entry point */ }
      if (!file && !extname(path)) {
        target = resolve(dist, 'index.html');
        try { file = await open(target); } catch { throw new HttpError(503, 'Frontend unavailable; build web/dist first'); }
      }
      if (!file) throw new HttpError(404, 'Not found');
      const actual = await realpath(target);
      const root = await realpath(dist);
      if (!actual.startsWith(root + sep)) { await file.close(); throw new HttpError(404, 'Not found'); }
      const info = await file.stat();
      res.writeHead(200, { 'Content-Type': mime[extname(target)] ?? 'application/octet-stream', 'Content-Length': info.size, 'X-Content-Type-Options': 'nosniff' });
      if (head) { await file.close(); res.end(); }
      else {
        const stream = file.createReadStream();
        res.on('close', () => stream.destroy());
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      }
    } catch (error) {
      const known = error instanceof HttpError;
      json(res, known ? error.status : 500, { error: known ? error.message : 'Internal server error' }, head);
    }
  });
}
