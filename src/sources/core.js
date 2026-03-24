const { fetchJSON, sleep, stripHtml } = require('../utils');

/**
 * Search CORE for open access works matching a query.
 * Covers theses, reports, conference papers, and OA articles
 * that other sources may miss.
 *
 * Requires a free API key: https://core.ac.uk/apikeys/register
 *
 * @param {string} query
 * @param {object} opts - { apiKey, maxResults }
 * @returns {Promise<Array>}
 */
async function searchCORE(query, opts = {}) {
  const apiKey = opts.apiKey || '';
  if (!apiKey) return [];

  const maxResults = opts.maxResults || 200;
  const limit = 100;
  const items = [];

  for (let offset = 0; offset < maxResults; offset += limit) {
    const url = 'https://api.core.ac.uk/v3/search/works'
      + '?q=' + encodeURIComponent(query)
      + '&limit=' + limit
      + '&offset=' + offset;

    let data;
    try {
      data = await fetchJSON(url, {
        headers: { 'Authorization': 'Bearer ' + apiKey },
        retries: 2,
        retryDelay: 2000
      });
    } catch (err) {
      console.warn('CORE error at offset ' + offset + ': ' + err.message);
      break;
    }

    const results = data.results || [];
    if (results.length === 0) break;

    for (const r of results) {
      // CORE returns DOIs in various formats
      let doi = '';
      if (r.doi) {
        doi = r.doi.replace(/^https?:\/\/doi\.org\//i, '');
      }
      if (!doi) continue;

      const authors = (r.authors || []).map(a => {
        if (typeof a === 'string') return a;
        return a.name || '';
      }).filter(Boolean);

      let year = null;
      if (r.yearPublished) {
        year = parseInt(r.yearPublished);
      } else if (r.publishedDate) {
        year = parseInt(r.publishedDate.substring(0, 4));
      }

      items.push({
        doi,
        title: stripHtml(r.title || '') || 'Untitled',
        authors: authors.join('; '),
        journal: r.journals && r.journals[0] ? r.journals[0].title || '' : '',
        publisher: r.publisher || '',
        year: year && !isNaN(year) ? year : null,
        cited: r.citationCount || 0,
        type: r.documentType || '',
        isOA: 'Yes',  // CORE only indexes OA content
        subject: (r.subjects || []).slice(0, 3).join('; '),
        sources: ['CORE']
      });
    }

    if (results.length < limit) break;
    await sleep(500);  // Free tier: ~10 req/s
  }

  return items;
}

module.exports = { searchCORE };
