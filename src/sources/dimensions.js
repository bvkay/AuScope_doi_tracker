const { fetchJSON, sleep, stripHtml } = require('../utils');

/**
 * Search Dimensions for publications matching a query.
 * Covers journals, conference proceedings, grants, patents.
 *
 * Requires a free research API account: https://app.dimensions.ai/
 * Set DIMENSIONS_API_KEY env var, or pass credentials for token auth.
 *
 * Auth flow: POST to /api/auth with { key: apiKey } → get token → use in header.
 *
 * @param {string} query
 * @param {object} opts - { apiKey, maxResults }
 * @returns {Promise<Array>}
 */
async function searchDimensions(query, opts = {}) {
  const apiKey = opts.apiKey || '';
  if (!apiKey) return [];

  // Authenticate to get a JWT token
  let token;
  try {
    const authResp = await fetch('https://app.dimensions.ai/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKey })
    });
    if (!authResp.ok) {
      console.warn('Dimensions auth failed: HTTP ' + authResp.status);
      return [];
    }
    const authData = await authResp.json();
    token = authData.token;
    if (!token) {
      console.warn('Dimensions auth returned no token');
      return [];
    }
  } catch (err) {
    console.warn('Dimensions auth error: ' + err.message);
    return [];
  }

  const maxResults = opts.maxResults || 200;
  const limit = 100;
  const items = [];

  for (let skip = 0; skip < maxResults; skip += limit) {
    // Dimensions uses its own DSL query language
    const dsl = 'search publications for "' + query.replace(/"/g, '\\"') + '" '
      + 'return publications[doi+title+year+journal+authors+times_cited+type+open_access+category_for] '
      + 'limit ' + limit + ' skip ' + skip;

    let data;
    try {
      const resp = await fetch('https://app.dimensions.ai/api/dsl', {
        method: 'POST',
        headers: {
          'Authorization': 'JWT ' + token,
          'Content-Type': 'text/plain'
        },
        body: dsl
      });
      if (!resp.ok) {
        console.warn('Dimensions DSL query failed: HTTP ' + resp.status);
        break;
      }
      data = await resp.json();
    } catch (err) {
      console.warn('Dimensions query error: ' + err.message);
      break;
    }

    const pubs = data.publications || [];
    if (pubs.length === 0) break;

    for (const p of pubs) {
      const doi = p.doi || '';
      if (!doi) continue;

      // Authors in Dimensions are objects with first_name, last_name
      const authors = (p.authors || []).map(a => {
        if (a.first_name && a.last_name) return a.first_name + ' ' + a.last_name;
        if (a.full_name) return a.full_name;
        return '';
      }).filter(Boolean);

      // Journal title
      const journal = p.journal ? (p.journal.title || '') : '';

      // Subject categories (FOR codes)
      const subjects = (p.category_for || [])
        .slice(0, 3)
        .map(c => c.name || '')
        .filter(Boolean);

      // Open access
      const isOA = p.open_access && p.open_access.length > 0 ? 'Yes' : 'No';

      items.push({
        doi,
        title: stripHtml(p.title || '') || 'Untitled',
        authors: authors.join('; '),
        journal,
        publisher: '',
        year: p.year || null,
        cited: p.times_cited || 0,
        type: p.type || '',
        isOA,
        subject: subjects.join('; '),
        sources: ['Dimensions']
      });
    }

    if (pubs.length < limit) break;
    await sleep(1000);  // Dimensions rate limit: ~30 req/min
  }

  return items;
}

module.exports = { searchDimensions };
