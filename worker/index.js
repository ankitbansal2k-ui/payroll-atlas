// Cloudflare Worker: serves the static site from assets and handles POST /api/suggest.
// Only /api/* reaches this code (run_worker_first in wrangler.jsonc); everything else is served
// straight from the static assets with the headers in _headers.
// Secrets/vars (set in the Cloudflare dashboard, never in this repo): SUGGEST_TO = destination address.
import { parseSuggestion, buildEmail } from './suggest.js';
import countries from './countries.json' with { type: 'json' };

const FROM = 'suggestions@intelligentpayroll.eu';
const SITE_ORIGIN = 'https://www.intelligentpayroll.eu';
const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function page(status, title, paragraphs) {
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(title)} | Intelligent Payroll</title>
  <link rel="stylesheet" href="/legal.css">
</head>
<body>
  <header><a href="/">Intelligent Payroll</a></header>
  <main>
    <h1>${escapeHtml(title)}</h1>
${paragraphs.map(p => `    <p>${escapeHtml(p)}</p>`).join('\n')}
    <p><a href="/suggest.html">Back to the suggestion form</a> &middot; <a href="/">Home</a></p>
  </main>
</body>
</html>
`;
  return new Response(body, { status, headers: HEADERS });
}

const thanks = () => page(200, 'Thank you', ['Your suggestion has reached us. We read every one, but we cannot reply to them all.', 'If you gave an email address, we may contact you about this suggestion only.']);

export async function handleSuggest(request, env, now = Date.now()) {
  if (request.method !== 'POST') return page(405, 'Not allowed', ['Use the suggestion form to send a suggestion.']);
  const origin = request.headers.get('Origin');
  if (origin && origin !== SITE_ORIGIN && origin !== new URL(request.url).origin) return page(403, 'Not allowed', ['Suggestions can only be sent from this site.']);
  if (Number(request.headers.get('Content-Length') || 0) > 20000) return page(413, 'Too long', ['Your suggestion is too long. Shorten it and try again.']);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (env.SUGGEST_LIMIT) {
    const { success } = await env.SUGGEST_LIMIT.limit({ key: ip });
    if (!success) return page(429, 'Please wait', ['You have sent several suggestions in a short time. Try again in a minute.']);
  }

  let form;
  try { form = await request.formData(); } catch { return page(400, 'Something went wrong', ['We could not read the form. Go back and try again.']); }
  const result = parseSuggestion(form, countries, now);
  if (result.spam) return thanks();
  if (!result.ok) return page(400, 'Please check your suggestion', [...result.errors, 'Use your browser\'s back button: what you typed is still there.']);

  if (!env.SUGGEST_TO || !env.EMAIL) return page(503, 'Not available', ['Suggestions are not switched on yet. Please try again later.']);
  try {
    await env.EMAIL.send(buildEmail(result.data, { from: FROM, to: env.SUGGEST_TO, receivedAt: new Date(now).toISOString() }));
  } catch (e) {
    console.error('suggest send failed', e && (e.code || e.message));
    return page(502, 'Not sent', ['Your suggestion could not be sent just now. Please try again later.']);
  }
  return thanks();
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/suggest') return handleSuggest(request, env);
    if (pathname.startsWith('/api/')) return page(404, 'Not found', ['That address does not exist.']);
    return env.ASSETS.fetch(request);
  },
};
