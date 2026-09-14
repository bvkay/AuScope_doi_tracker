/**
 * Shared utilities for the AuScope DOI Tracker.
 */

// Per-host circuit breaker: when every recent request to a host has ended in
// exhausted-429, the host is refusing this client for now (OpenAlex throttles
// shared CI runner IPs for whole runs) and long backoffs only stretch the job
// by hours. After STORM_THRESHOLD consecutive exhausted failures, requests to
// that host get a single attempt with no backoff. Any success resets it.
const STORM_THRESHOLD = 8;
const hostFailures = {};

/**
 * Fetch JSON from a URL with retries and rate-limit handling.
 * Honors Retry-After on 429/5xx, backs off exponentially with jitter,
 * and fails fast once a host is in a sustained 429 storm.
 * @param {string} url
 * @param {object} opts - { headers, retries, retryDelay }
 * @returns {Promise<object>}
 */
async function fetchJSON(url, opts = {}) {
  const host = url.split('/')[2] || '';
  const storming = (hostFailures[host] || 0) >= STORM_THRESHOLD;
  const retries = storming ? 0 : (opts.retries !== undefined ? opts.retries : 5);
  const baseDelay = opts.retryDelay || 2000;
  const headers = opts.headers || {};

  let lastError;
  let throttled = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url, { headers });

    if (resp.status === 404) { hostFailures[host] = 0; return {}; }
    if (resp.ok) { hostFailures[host] = 0; return resp.json(); }

    throttled = resp.status === 429 || resp.status >= 500;
    if (throttled && attempt < retries) {
      // Retry-After (seconds) wins when the server sends one; otherwise
      // exponential backoff with jitter: 2s, 4s, 8s, 16s, 32s (+0-1s).
      const retryAfter = parseInt(resp.headers.get('retry-after'), 10);
      const wait = retryAfter > 0
        ? Math.min(retryAfter * 1000, 120000)
        : Math.min(baseDelay * Math.pow(2, attempt), 90000) + Math.floor(Math.random() * 1000);
      console.warn('HTTP ' + resp.status + ' from ' + url.split('?')[0]
        + ' — retry ' + (attempt + 1) + ' in ' + Math.round(wait / 1000) + 's');
      await sleep(wait);
      continue;
    }

    let body = '';
    try { body = (await resp.text()).replace(/\s+/g, ' ').slice(0, 200); } catch (_) {}
    lastError = new Error('HTTP ' + resp.status + ' from ' + url.split('?')[0]
      + (body ? ' — ' + body : ''));
    break;
  }

  if (throttled) {
    hostFailures[host] = (hostFailures[host] || 0) + 1;
    if (hostFailures[host] === STORM_THRESHOLD) {
      console.warn(host + ': ' + STORM_THRESHOLD
        + ' consecutive rate-limited requests — failing fast for the rest of this run');
    }
  }
  throw lastError || new Error('retries exhausted for ' + url.split('?')[0]);
}

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Strip HTML/XML tags from a string.
 * @param {string} str
 * @returns {string}
 */
function stripHtml(str) {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Normalise a DOI string for deduplication.
 * Strips https://doi.org/ prefix, doi: prefix, lowercases, trims.
 * @param {string} doi
 * @returns {string}
 */
function normaliseDoi(doi) {
  if (!doi) return '';
  return doi.toString().toLowerCase()
    .replace(/^https?:\/\/doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .trim();
}

/**
 * Clean a search query into a readable label.
 * Strips double-quotes and collapses whitespace.
 * @param {string} query
 * @returns {string}
 */
function queryLabel(query) {
  return query.replace(/"/g, '').replace(/\s+/g, ' ').trim();
}

module.exports = { fetchJSON, sleep, stripHtml, normaliseDoi, queryLabel };
