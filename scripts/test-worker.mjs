// Tests for the suggestion handler (worker/). Runs in plain Node, no Cloudflare needed.
// Run: node scripts/test-worker.mjs
import assert from 'node:assert/strict';
import { handleSuggest } from '../worker/index.js';
import { parseSuggestion, buildEmail } from '../worker/suggest.js';
import countries from '../worker/countries.json' with { type: 'json' };

const NOW = Date.UTC(2026, 9, 3, 12);
const OPENED = String(NOW - 60e3);
const fd = obj => { const f = new FormData(); for (const [k, v] of Object.entries(obj)) f.set(k, v); return f; };
const good = { type: 'rule', country: 'poland', details: 'Minimum wage for 2027 is missing.', source: 'https://www.gov.pl/', email: 'a@b.co', t: OPENED, website: '' };

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await test('accepts a valid suggestion', () => {
  const r = parseSuggestion(fd(good), countries, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.data.country, 'Poland');
});
await test('honeypot is treated as spam', () => assert.equal(parseSuggestion(fd({ ...good, website: 'x' }), countries, NOW).spam, true));
await test('too-fast submit is spam', () => assert.equal(parseSuggestion(fd({ ...good, t: String(NOW - 500) }), countries, NOW).spam, true));
await test('stale form is rejected, not spam', () => {
  const r = parseSuggestion(fd({ ...good, t: String(NOW - 2 * 86400e3) }), countries, NOW);
  assert.equal(r.ok, false); assert.ok(!r.spam);
});
await test('missing t (no JavaScript) still accepted', () => assert.equal(parseSuggestion(fd({ ...good, t: '' }), countries, NOW).ok, true));
await test('rejects unknown type, unknown country, empty details', () => {
  const r = parseSuggestion(fd({ ...good, type: 'hack', country: 'zz', details: '  ' }), countries, NOW);
  assert.equal(r.errors.length, 3);
});
await test('rejects over-long details', () => assert.equal(parseSuggestion(fd({ ...good, details: 'x'.repeat(2001) }), countries, NOW).ok, false));
await test('rejects javascript: and non-URL sources', () => {
  for (const source of ['javascript:alert(1)', 'not a url', 'ftp://x.y/']) assert.equal(parseSuggestion(fd({ ...good, source }), countries, NOW).ok, false, source);
});
await test('rejects bad email', () => {
  for (const email of ['nope', 'a@b', 'a b@c.de', 'x@y.z\r\nBcc: v@w.xy']) assert.equal(parseSuggestion(fd({ ...good, email }), countries, NOW).ok, false, email);
});
await test('"not listed" country uses the free-text name', () => {
  const r = parseSuggestion(fd({ ...good, country: 'other', otherCountry: 'Vietnam\r\nX' }), countries, NOW);
  assert.equal(r.data.country, 'Not listed: Vietnam X');
});
await test('email subject has no line breaks; replyTo only when given', () => {
  const r = parseSuggestion(fd({ ...good, country: 'other', otherCountry: 'A\nBcc: evil@x.com', email: '' }), countries, NOW);
  const m = buildEmail(r.data, { from: 'f@x.eu', to: 't@x.eu', receivedAt: 'now' });
  assert.ok(!/[\r\n]/.test(m.subject)); assert.equal(m.replyTo, undefined);
  assert.equal(buildEmail(parseSuggestion(fd(good), countries, NOW).data, { from: 'f', to: 't', receivedAt: 'n' }).replyTo, 'a@b.co');
});

// ---- handler, with fake Cloudflare bindings ----
const req = (body, headers = {}) => new Request('https://www.intelligentpayroll.eu/api/suggest', { method: 'POST', body: fd(body), headers: { Origin: 'https://www.intelligentpayroll.eu', 'CF-Connecting-IP': '1.2.3.4', ...headers } });
const env = (over = {}) => {
  const sent = [];
  return { sent, SUGGEST_TO: 'owner@example.com', EMAIL: { send: async m => { sent.push(m); return { messageId: '1' }; } }, SUGGEST_LIMIT: { limit: async () => ({ success: true }) }, ...over };
};

await test('handler sends one email and thanks the visitor', async () => {
  const e = env(); const r = await handleSuggest(req(good), e, NOW);
  assert.equal(r.status, 200); assert.equal(e.sent.length, 1);
  assert.equal(e.sent[0].to, 'owner@example.com'); assert.equal(e.sent[0].from, 'suggestions@intelligentpayroll.eu');
  assert.match(r.headers.get('Content-Security-Policy'), /default-src 'none'/);
});
await test('handler: spam gets a thank-you but no email', async () => {
  const e = env(); const r = await handleSuggest(req({ ...good, website: 'spam' }), e, NOW);
  assert.equal(r.status, 200); assert.equal(e.sent.length, 0);
});
await test('handler: validation errors are 400 and escaped', async () => {
  const e = env(); const r = await handleSuggest(req({ ...good, details: '' }), e, NOW);
  assert.equal(r.status, 400); assert.equal(e.sent.length, 0);
});
await test('handler: rate limit gives 429', async () => {
  const e = env({ SUGGEST_LIMIT: { limit: async () => ({ success: false }) } });
  assert.equal((await handleSuggest(req(good), e, NOW)).status, 429); assert.equal(e.sent.length, 0);
});
await test('handler: other sites cannot post', async () => {
  const e = env(); assert.equal((await handleSuggest(req(good, { Origin: 'https://evil.example' }), e, NOW)).status, 403);
});
await test('handler: GET is refused', async () => {
  assert.equal((await handleSuggest(new Request('https://www.intelligentpayroll.eu/api/suggest'), env(), NOW)).status, 405);
});
await test('handler: missing secret gives 503, send failure gives 502', async () => {
  assert.equal((await handleSuggest(req(good), env({ SUGGEST_TO: '' }), NOW)).status, 503);
  const e = env({ EMAIL: { send: async () => { throw Object.assign(new Error('x'), { code: 'E_RATE_LIMIT_EXCEEDED' }); } } });
  const orig = console.error; console.error = () => {};
  try { assert.equal((await handleSuggest(req(good), e, NOW)).status, 502); } finally { console.error = orig; }
});

console.log(`\n${n} worker tests passed.`);
