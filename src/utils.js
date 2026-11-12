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

// Hosts whose daily budget is spent for this process. OpenAlex answers a
// keyless client that is over budget with 429 "Insufficient budget" and a
// two-minute Retry-After that never helps: the budget is shared by every
// client on the runner's IP address and resets at midnight UTC. Sleeping on
// it cost the weekly pipeline its whole 90 minutes on every run from 16 Sep
// to 11 Nov 2026. One such reply marks the host out for the rest of the run;
// later calls fail at once and callers can read err.budgetExhausted.
const hostBudgetOut = {};
// A Retry-After longer than this is a budget wall, not a burst: wait no longer.
const RETRY_AFTER_CAP_MS = 30000;

function budgetError(host, url, body) {
  const err = new Error('HTTP 429 from ' + url.split('?')[0] + ': daily budget exhausted'
    + (body ? ' (' + body.slice(0, 120) + ')' : ''));
  err.budgetExhausted = true;
  err.host = host;
  return err;
}

function isBudgetOut(host) {
  return !!hostBudgetOut[host];
}

/**
 * Fetch JSON from a URL with retries and rate-limit handling.
 * Honors Retry-After on 429/5xx (capped), backs off exponentially with
 * jitter, fails fast once a host is in a sustained 429 storm, and stops
 * at once when a host reports its daily budget exhausted.
 * @param {string} url
 * @param {object} opts - { headers, retries, retryDelay }
 * @returns {Promise<object>}
 */
async function fetchJSON(url, opts = {}) {
  const host = url.split('/')[2] || '';
  if (hostBudgetOut[host]) throw budgetError(host, url, '');
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
    let body = '';
    try { body = (await resp.text()).replace(/\s+/g, ' ').slice(0, 200); } catch (_) {}

    if (resp.status === 429 && /insufficient budget/i.test(body)) {
      hostBudgetOut[host] = true;
      console.warn(host + ': daily budget exhausted, no further requests this run');
      throw budgetError(host, url, body);
    }

    if (throttled && attempt < retries) {
      // Retry-After (seconds) wins when the server sends one, capped;
      // otherwise exponential backoff with jitter: 2s, 4s, 8s, 16s, 32s (+0-1s).
      const retryAfter = parseInt(resp.headers.get('retry-after'), 10);
      const wait = retryAfter > 0
        ? Math.min(retryAfter * 1000, RETRY_AFTER_CAP_MS)
        : Math.min(baseDelay * Math.pow(2, attempt), 90000) + Math.floor(Math.random() * 1000);
      console.warn('HTTP ' + resp.status + ' from ' + url.split('?')[0]
        + ': retry ' + (attempt + 1) + ' in ' + Math.round(wait / 1000) + 's');
      await sleep(wait);
      continue;
    }

    lastError = new Error('HTTP ' + resp.status + ' from ' + url.split('?')[0]
      + (body ? ': ' + body : ''));
    break;
  }

  if (throttled) {
    hostFailures[host] = (hostFailures[host] || 0) + 1;
    if (hostFailures[host] === STORM_THRESHOLD) {
      console.warn(host + ': ' + STORM_THRESHOLD
        + ' consecutive rate-limited requests, failing fast for the rest of this run');
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

/**
 * Component deposits — individually-DOI'd figures, tables and data
 * supplements of a paper (figshare/Zenodo/GSA mint these) — are not
 * publications. Recognised by their canonical title prefixes; the parent
 * paper is tracked in its own right.
 * @param {string} title
 * @returns {boolean}
 */
function isComponentTitle(title) {
  return /^(figure|fig\.|table|appendix|video|movie|supplemental material|supplementary (information|material|materials|data|figure|table)|data s\d)\b/i
    .test((title || '').trim());
}

module.exports = { fetchJSON, isBudgetOut, sleep, stripHtml, normaliseDoi, queryLabel, isComponentTitle };
