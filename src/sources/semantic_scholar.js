const { fetchJSON, sleep, stripHtml } = require('../utils');

/**
 * Search Semantic Scholar for papers matching a query.
 * Uses API key if provided (1 req/sec guaranteed), otherwise anonymous pool.
 * @param {string} query
 * @param {object} opts - { apiKey, maxResults }
 * @returns {Promise<Array>}
 */
async function searchSemanticScholar(query, opts = {}) {
  const apiKey = opts.apiKey || '';
  const maxResults = opts.maxResults || 500;
  const limit = 100;
  const items = [];
  const headers = apiKey ? { 'x-api-key': apiKey } : {};

  for (let offset = 0; offset < maxResults; offset += limit) {
    if (offset > 0) await sleep(apiKey ? 1000 : 3000);

    const url = 'https://api.semanticscholar.org/graph/v1/paper/search'
      + '?query=' + encodeURIComponent(query)
      + '&offset=' + offset
      + '&limit=' + limit
      + '&fields=title,authors,year,citationCount,externalIds,journal,openAccessPdf,publicationTypes,s2FieldsOfStudy';

    let data;
    try {
      data = await fetchJSON(url, { headers, retries: apiKey ? 3 : 2, retryDelay: 5000 });
    } catch {
      break;
    }

    if (!data || !data.data || data.data.length === 0) break;

    for (const p of data.data) {
      const doi = p.externalIds ? (p.externalIds.DOI || '') : '';
      if (!doi) continue;

      const authors = (p.authors || []).map(a => a.name);
      const types = (p.publicationTypes || []).join(', ')
        .replace(/([A-Z])/g, ' $1').trim().toLowerCase();

      // Deduplicate subject categories
      const seen = {};
      const subjects = (p.s2FieldsOfStudy || [])
        .map(f => f.category)
        .filter(s => { if (!s || seen[s]) return false; seen[s] = true; return true; });

      items.push({
        doi,
        title: stripHtml(p.title || '') || 'Untitled',
        authors: authors.join('; '),
        journal: p.journal ? (p.journal.name || '') : '',
        publisher: '',
        year: p.year || null,
        cited: p.citationCount || 0,
        type: types || '',
        isOA: (p.openAccessPdf && p.openAccessPdf.url) ? 'Yes' : 'No',
        subject: subjects.slice(0, 3).join('; '),
        sources: ['Semantic Scholar']
      });
    }

    if (data.data.length < limit) break;
  }

  return items;
}

module.exports = { searchSemanticScholar };
