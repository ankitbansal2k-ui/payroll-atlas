// Validates a visitor suggestion and builds the notification email.
// Pure functions with no Cloudflare APIs, so scripts/test-worker.mjs can run them in Node.

export const TYPES = { country: 'Add a country', rule: 'Missing or wrong rule', feature: 'Feature idea', other: 'Something else' };
export const LIMITS = { details: 2000, url: 500, email: 254, name: 100 };
export const MIN_FILL_MS = 3000;          // faster than this is almost certainly a bot
export const MAX_FILL_MS = 24 * 3600e3;   // a form older than a day is stale

const oneLine = s => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim();

// form: a FormData (or anything with get()). countries: { code: name }. now: ms timestamp.
// Returns { ok: true, data } | { ok: false, errors: [message], spam?: true }.
export function parseSuggestion(form, countries, now) {
  const get = k => (form.get(k) ?? '').toString();

  // Honeypot: a field hidden from people. Anything in it means a bot. Report success to it quietly.
  if (get('website').trim()) return { ok: false, spam: true, errors: [] };
  const started = Number(get('t'));
  if (Number.isFinite(started) && started > 0) {
    const age = now - started;
    if (age < MIN_FILL_MS || age > MAX_FILL_MS) return { ok: false, spam: age < MIN_FILL_MS, errors: age < MIN_FILL_MS ? [] : ['This form has expired. Reload the page and try again.'] };
  }

  const errors = [];
  const type = get('type');
  if (!Object.prototype.hasOwnProperty.call(TYPES, type)) errors.push('Choose what your suggestion is about.');

  const country = get('country');
  let countryLabel = '';
  if (country && country !== 'other') {
    if (!Object.prototype.hasOwnProperty.call(countries, country)) errors.push('Choose a country from the list.');
    else countryLabel = countries[country];
  }
  const otherCountry = oneLine(get('otherCountry')).slice(0, LIMITS.name);
  if (country === 'other') countryLabel = otherCountry ? `Not listed: ${otherCountry}` : 'Not listed';

  const details = get('details').replace(/\r\n/g, '\n').trim();
  if (!details) errors.push('Tell us your suggestion.');
  else if (details.length > LIMITS.details) errors.push(`Keep your suggestion under ${LIMITS.details} characters.`);

  const source = oneLine(get('source'));
  if (source) {
    let ok = false;
    try { const u = new URL(source); ok = (u.protocol === 'https:' || u.protocol === 'http:') && source.length <= LIMITS.url; } catch {}
    if (!ok) errors.push('The source link must be a full web address starting with https://.');
  }

  const email = oneLine(get('email'));
  if (email && (email.length > LIMITS.email || !/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(email))) errors.push('Check your email address, or leave it empty.');

  if (errors.length) return { ok: false, errors };
  return { ok: true, data: { type, country: countryLabel, details, source, email } };
}

export function buildEmail(data, { from, to, receivedAt }) {
  const subject = oneLine(`Suggestion: ${TYPES[data.type]}${data.country ? ` - ${data.country}` : ''}`).slice(0, 150);
  const text = [
    `Type: ${TYPES[data.type]}`,
    `Country: ${data.country || '-'}`,
    `Source: ${data.source || '-'}`,
    `Reply to: ${data.email || '(none given)'}`,
    `Received: ${receivedAt}`,
    '',
    data.details,
    '',
    '--',
    'Sent from the suggestion form on intelligentpayroll.eu. Nothing is published automatically.',
    'Delete this email within 12 months (see privacy.html).',
  ].join('\n');
  const msg = { to, from, subject, text };
  if (data.email) msg.replyTo = data.email;
  return msg;
}
