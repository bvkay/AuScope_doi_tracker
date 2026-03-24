const { fetchJSON, sleep, stripHtml } = require('../utils');

/**
 * Search OpenAlex for works matching a query via full-text search.
 * @param {string} query - Search query (supports quoted phrases)
 * @param {object} opts - { email, maxPages }
 * @returns {Promise<Array>} Normalised citation records
 */
async function searchOpenAlex(query, opts = {}) {
  const email = opts.email || '';
  const maxPages = opts.maxPages || 2;
  const items = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = 'https://api.openalex.org/works?per_page=25&page=' + page
      + '&filter=fulltext.search:' + encodeURIComponent(query)
      + '&select=id,doi,title,publication_year,authorships,primary_location,cited_by_count,type,open_access,topics'
      + '&sort=publication_year:desc'
      + '&mailto=' + encodeURIComponent(email);

    const data = await fetchJSON(url);
    if (!data.results || data.results.length === 0) break;

    for (const w of data.results) {
      const doi = w.doi ? w.doi.replace('https://doi.org/', '') : '';
      if (!doi) continue;

      const authors = (w.authorships || []).map(a => a.author.display_name);
      const loc = w.primary_location || {};
      const src = loc.source || {};

      items.push({
        doi,
        title: stripHtml(w.title || '') || 'Untitled',
        authors: authors.join('; '),
        journal: src.display_name || '',
        publisher: src.host_organization_name || '',
        year: w.publication_year || null,
        cited: w.cited_by_count || 0,
        type: (w.type || '').replace(/-/g, ' '),
        isOA: w.open_access ? (w.open_access.is_oa ? 'Yes' : 'No') : 'No',
        subject: (w.topics || []).slice(0, 3).map(t => t.display_name).join('; '),
        sources: ['OpenAlex']
      });
    }

    if (data.results.length < 25) break;
    await sleep(100);
  }

  return items;
}

/**
 * Look up a single DOI in OpenAlex for citation count.
 * @param {string} doi
 * @param {string} email
 * @returns {Promise<number>}
 */
async function getCitationCount(doi, email) {
  const url = 'https://api.openalex.org/works/doi:' + encodeURIComponent(doi)
    + '?select=cited_by_count&mailto=' + encodeURIComponent(email);
  try {
    const data = await fetchJSON(url);
    return (data && data.cited_by_count) || 0;
  } catch {
    return 0;
  }
}

/**
 * Look up a single DOI for full metadata.
 * @param {string} doi
 * @param {string} email
 * @returns {Promise<object|null>}
 */
async function lookupMetadata(doi, email) {
  const url = 'https://api.openalex.org/works/doi:' + encodeURIComponent(doi)
    + '?mailto=' + encodeURIComponent(email);
  try {
    const data = await fetchJSON(url);
    if (!data || !data.title) return null;

    const authors = (data.authorships || []).map(a => a.author.display_name);
    const loc = data.primary_location || {};
    const src = loc.source || {};

    return {
      title: stripHtml(data.title || ''),
      authors: authors.join('; '),
      journal: src.display_name || '',
      publisher: src.host_organization_name || '',
      year: data.publication_year || null,
      cited: data.cited_by_count || 0,
      type: (data.type || '').replace(/-/g, ' '),
      isOA: data.open_access ? (data.open_access.is_oa ? 'Yes' : 'No') : 'Unknown',
      subject: (data.topics || []).slice(0, 3).map(t => t.display_name).join('; ')
    };
  } catch {
    return null;
  }
}

module.exports = { searchOpenAlex, getCitationCount, lookupMetadata };
