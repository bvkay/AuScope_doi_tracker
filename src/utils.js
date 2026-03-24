/**
 * Shared utilities for the AuScope DOI Tracker.
 */

/**
 * Fetch JSON from a URL with retries and rate-limit handling.
 * @param {string} url
 * @param {object} opts - { headers, retries, retryDelay }
 * @returns {Promise<object>}
 */
async function fetchJSON(url, opts = {}) {
  const retries = opts.retries !== undefined ? opts.retries : 3;
  const retryDelay = opts.retryDelay || 3000;
  const headers = opts.headers || {};

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelay * attempt);

    const resp = await fetch(url, { headers });

    if (resp.status === 404) return {};
    if (resp.ok) return resp.json();

    if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
      console.warn('HTTP ' + resp.status + ' from ' + url.split('?')[0] + ' — retry ' + (attempt + 1));
      continue;
    }

    throw new Error('HTTP ' + resp.status + ' from ' + url.split('?')[0]);
  }
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
