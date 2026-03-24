const { fetchJSON, stripHtml } = require('../utils');

/**
 * Look up a single DOI in Crossref for metadata enrichment.
 * NOT used for discovery — only for filling missing fields on known DOIs.
 * @param {string} doi
 * @param {string} email
 * @returns {Promise<object|null>}
 */
async function lookupCrossref(doi, email) {
  try {
    const url = 'https://api.crossref.org/works/' + encodeURIComponent(doi)
      + '?mailto=' + encodeURIComponent(email);
    const data = await fetchJSON(url, {
      headers: { 'User-Agent': 'AuScopeCitations/1.0 (mailto:' + email + ')' }
    });
    const w = data.message;
    if (!w) return null;

    const authors = (w.author || []).map(a =>
      ((a.given || '') + ' ' + (a.family || '')).trim()
    );

    let year = null;
    const pp = w['published-print'];
    const po = w['published-online'];
    if (pp && pp['date-parts'] && pp['date-parts'][0]) {
      year = pp['date-parts'][0][0] || null;
    } else if (po && po['date-parts'] && po['date-parts'][0]) {
      year = po['date-parts'][0][0] || null;
    }

    const title = Array.isArray(w.title) ? (w.title[0] || '') : (w.title || '');
    const subject = (w.subject || []).slice(0, 3).join('; ');

    return {
      title: stripHtml(title),
      authors: authors.join('; '),
      journal: w['container-title'] ? (w['container-title'][0] || '') : '',
      publisher: w.publisher || '',
      year,
      cited: w['is-referenced-by-count'] || 0,
      type: (w.type || '').replace(/-/g, ' '),
      isOA: 'Unknown',
      subject
    };
  } catch {
    return null;
  }
}

module.exports = { lookupCrossref };
