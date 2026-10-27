import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { createApp } from './app.ts';
import { readConfig } from './config.ts';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const records = [
  { id: 'cat', source: { description: 'cat dancing', tags: ['Cat', 'a"b\\c'], rating: 'PG-13', mood_emoji: '😄', custom: 'preserved' } },
  { _id: 'fallback', _source: { original_description: 'fallback', tags: ['cat-person'], rating: 'g' } },
  { id: 'rating', source: { rating: 'X' } },
  { id: 'compound', source: { tags: ['Adult-Content'] } },
  { id: 'removed', source: { description: 'CONTENT HAS BEEN REMOVED' } },
  { id: 'negative', source: { tags: ['DOG'], rating: 'g' } },
];

async function fixture(nsfw = false) {
  let calls = 0;
  let mode = 'normal';
  let aborted = 0;
  let release: (() => void) | undefined;
  const events = new EventEmitter();
  const upstream = createServer(async (req, res) => {
    calls++;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/db/v1/tables/honey%2Fcomb/query');
    assert.equal(req.headers.authorization, 'ApiKey sentinel');
    assert.equal(req.headers.cookie, undefined);
    let text = ''; for await (const chunk of req) text += chunk;
    const query = JSON.parse(text);
    if (mode === 'hold' || mode === 'delay') {
      const gate = Promise.withResolvers<void>();
      release = gate.resolve;
      res.on('close', () => {
        if (!res.writableEnded) { aborted++; events.emit('aborted'); }
        gate.resolve();
      });
      events.emit('held');
      // Real HTTP integration deliberately exercises the production 10-second
      // platform deadline; the upstream remains held until cancellation.
      await gate.promise;
    }
    if (res.destroyed) return;
    if (mode === 'error') { res.writeHead(500); res.end('secret raw upstream'); return; }
    if (mode === 'redirect') { res.writeHead(302, { Location: '/credential-leak' }); res.end(); return; }
    if (mode === 'malformed') { res.end('{'); return; }
    if (mode === 'schema') { res.end('{}'); return; }
    if (mode === 'oversize') { res.end('x'.repeat(4 * 1024 * 1024 + 1)); return; }
    if (mode === 'query-error') { res.end(JSON.stringify({ responses: [{ error: 'secret raw upstream' }] })); return; }
    if (mode === 'stale') {
      assert(query.offset <= 2000);
      res.end(JSON.stringify({ responses: [{ hits: { hits: query.offset ? [] : records, total: 10000 } }] }));
      return;
    }
    let hits = records;
    if (query.full_text_search?.field === '_id') hits = records.filter(h => ('id' in h ? h.id : h._id) === query.full_text_search.term);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ responses: [{ hits: { hits, total: hits.length } }] }));
  });
  const base = await listen(upstream);
  const app = createApp(readConfig({ ANTFLY_URL: `${base}/db/v1/`, ANTFLY_TABLE: 'honey/comb', ANTFLY_AUTHORIZATION: 'ApiKey sentinel', MAX_CONCURRENT_QUERIES: '1', NSFW: nsfw ? '1' : '' }));
  const url = await listen(app);
  async function post(route: string, value: unknown, extra: Record<string, string> = {}) {
    return fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'untrusted', Authorization: 'Bearer caller', ...extra }, body: JSON.stringify(value) });
  }
  return { url, post, events, calls: () => calls, aborted: () => aborted, mode(value: string) { mode = value; }, release() { release?.(); },
    async close() {
      const closed = [once(app, 'close'), once(upstream, 'close')];
      app.closeAllConnections(); upstream.closeAllConnections(); app.close(); upstream.close();
      await Promise.all(closed);
    } };
}

test('random browse recovers from a stale empty page within its bounded sample window', async (t) => {
  t.mock.method(Math, 'random', () => 0.99);
  const f = await fixture();
  try {
    f.mode('stale');
    await f.post('/api/random', {});
    const result = await (await f.post('/api/random', {})).json();
    assert.deepEqual(result.results.map((g: { id: string }) => g.id).sort(), ['cat', 'fallback', 'negative']);
    assert.equal(f.calls(), 3);
  } finally { await f.close(); }
});

test('publication policy, exact structured filters, metadata and ID lookup', async () => {
  const f = await fixture();
  try {
    for (const route of ['/api/search', '/api/random']) {
      const res = await f.post(route, route.endsWith('search') ? { query: 'cat' } : {});
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data.results.map((g: { id: string }) => g.id).sort(), ['cat', 'fallback', 'negative']);
      assert.equal(data.total, 6);
    }
    const filtered = await (await f.post('/api/search', { query: '"dancing" loose tag:cat rating:PG-13 -tag:dog' })).json();
    assert.deepEqual(filtered.results.map((g: { id: string }) => g.id), ['cat']);
    assert.equal(filtered.results[0].custom, 'preserved');
    const negative = await (await f.post('/api/search', { query: '-tag:dog' })).json();
    assert.deepEqual(negative.results.map((g: { id: string }) => g.id), ['cat', 'fallback']);
    const literal = await (await f.post('/api/search', { query: 'tag:"a\\"b\\\\c"' })).json();
    assert.deepEqual(literal.results.map((g: { id: string }) => g.id), ['cat']);
    for (const id of ['rating', 'compound', 'removed', 'missing']) assert.equal((await fetch(`${f.url}/api/gifs/${id}`)).status, 404);
    const fallback = await (await fetch(`${f.url}/api/gifs/fallback`)).json();
    assert.equal(fallback.description, 'fallback');
  } finally { await f.close(); }
  const adult = await fixture(true);
  try {
    const data = await (await adult.post('/api/random', {})).json();
    assert.deepEqual(data.results.map((g: { id: string }) => g.id).sort(), ['cat', 'compound', 'fallback', 'negative', 'rating']);
    assert.equal((await fetch(`${adult.url}/api/gifs/removed`)).status, 404);
    assert.equal((await fetch(`${adult.url}/api/gifs/rating`)).status, 200);
  } finally { await adult.close(); }
});

test('public boundary rejects unrestricted database operations and invalid inputs without upstream calls', async () => {
  const f = await fixture();
  try {
    for (const [method, path] of [['POST', '/api/v1/tables/honeycomb/batch'], ['DELETE', '/api/v1/tables/honeycomb'], ['POST', '/api/v1/tables'], ['POST', '/api/v1/tables/honeycomb/query'], ['GET', '/api/unknown'], ['GET', '/termite'], ['POST', '/api'], ['GET', '/api/search']]) {
      const res = await fetch(f.url + path, { method });
      assert.equal(res.status, path === '/api/search' ? 405 : 404);
    }
    for (const payload of [{ query: 'x', table: 'other' }, { query: 'x', indexes: [] }, { query: 'x', offset: 1 }, { query: 'x', NSFW: 1 }, { query: 'x', limit: 0 }, { query: 'x', limit: 51 }, {}, { query: 'x'.repeat(2049) }, { query: 'x', mood: '' }]) assert.equal((await f.post('/api/search', payload)).status, 400);
    assert.equal((await f.post('/api/search', { query: 'x'.repeat(17_000) })).status, 413);
    const streamed = request(f.url + '/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const rejected = once(streamed, 'response');
    streamed.write('x'.repeat(17_000));
    const [response] = await rejected;
    assert.equal(response.statusCode, 413);
    response.resume();
    streamed.end();
    assert.equal((await f.post('/api/search', { query: 'x' }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await fetch(f.url + '/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await fetch(f.url + '/%2e%2e%2fpackage.json')).status, 400);
    assert.equal(f.calls(), 0);
    assert.deepEqual(await (await fetch(f.url + '/healthz')).json(), { ok: true });
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test('upstream failures are bounded, sanitized and never successful empty results', async () => {
  const f = await fixture();
  try {
    for (const mode of ['error', 'redirect', 'malformed', 'schema', 'oversize', 'query-error']) {
      f.mode(mode); const before = f.calls();
      for (const path of ['/api/search', '/api/gifs/cat']) {
        const res = path.endsWith('search') ? await f.post(path, { query: 'x' }) : await fetch(f.url + path);
        assert.equal(res.status, 502);
        assert.deepEqual(await res.json(), { error: 'Antfly request failed' });
      }
      assert.equal(f.calls(), before + 2);
    }
  } finally { await f.close(); }
});

test('concurrency, disconnect cancellation and deadline release slots', async () => {
  const f = await fixture();
  try {
    f.mode('hold');
    const held = once(f.events, 'held');
    const first = f.post('/api/search', { query: 'x' });
    await held;
    const excess = await f.post('/api/random', {});
    assert.equal(excess.status, 429); assert.equal(excess.headers.get('Retry-After'), '1');
    f.mode('normal'); f.release(); assert.equal((await first).status, 200);
    assert.equal((await f.post('/api/random', {})).status, 200);
    f.mode('hold');
    const heldAgain = once(f.events, 'held');
    const aborted = once(f.events, 'aborted');
    const client = request(f.url + '/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    client.on('error', () => {}); client.end('{"query":"x"}');
    await heldAgain;
    client.destroy();
    await aborted;
    f.mode('normal');
    assert.equal((await f.post('/api/random', {})).status, 200);
    f.mode('delay');
    assert.equal((await f.post('/api/search', { query: 'x' })).status, 504);
    f.mode('normal');
    assert.equal((await f.post('/api/random', {})).status, 200);
  } finally { await f.close(); }
});

test('configuration fails safely and preserves API base paths', () => {
  assert.equal(readConfig({ ANTFLY_URL: 'http://[::1]:8080/db/v1/' }).antflyUrl, 'http://[::1]:8080/db/v1');
  for (const env of [{ PORT: '0' }, { PORT: '65536' }, { MAX_CONCURRENT_QUERIES: '0' }, { ANTFLY_URL: 'http://example.com' }, { ANTFLY_URL: 'https://example.com' }, { ANTFLY_URL: 'https://name:secret@example.com' }, { ANTFLY_AUTHORIZATION: 'sentinel\nsecret' }, { ANTFLY_TABLE: '' }]) {
    assert.throws(() => readConfig(env), error => error instanceof Error && !error.message.includes('secret') && !error.message.includes('sentinel'));
  }
});
