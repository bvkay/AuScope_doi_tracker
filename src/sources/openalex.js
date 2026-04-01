const { fetchJSON, sleep, stripHtml } = require('../utils');

/**
 * Search OpenAlex for works matching a query.
 * Runs two passes: fulltext.search (deep, covers full paper text) and
 * default.search (broader, catches papers not fulltext-indexed).
 * Results are combined and deduped by DOI.
 * @param {string} query - Search query (supports quoted phrases)
 * @param {object} opts - { email, maxPages }
 * @returns {Promise<Array>} Normalised citation records
 */
async function searchOpenAlex(query, opts = {}) {
  const email = opts.email || '';
  const maxPages = opts.maxPages || 2;
  const yearWindows = opts.yearWindows || false;

  let fulltextItems, defaultItems;

  if (yearWindows) {
    // Split by year windows to bypass per-query pagination caps.
    // Each window gets full pagination independently.
    const currentYear = new Date().getFullYear();
    const minYear = opts.minYear || 1997;
    const windowSize = 5;
    fulltextItems = [];
    defaultItems = [];

    for (let startYear = minYear; startYear <= currentYear; startYear += windowSize) {
      const endYear = Math.min(startYear + windowSize - 1, currentYear);
      const yearFilter = ',publication_year:' + startYear + '-' + endYear;
      const windowFt = await searchOpenAlexFilter_(query, 'fulltext.search', email, maxPages, yearFilter);
      const windowDf = await searchOpenAlexFilter_(query, 'default.search', email, maxPages, yearFilter);
      fulltextItems.push(...windowFt);
      defaultItems.push(...windowDf);
    }
  } else {
    fulltextItems = await searchOpenAlexFilter_(query, 'fulltext.search', email, maxPages);
    defaultItems = await searchOpenAlexFilter_(query, 'default.search', email, maxPages);
  }

  // Dedup by DOI (fulltext results take priority)
  const seen = {};
  const items = [];
  for (const item of fulltextItems) {
    seen[item.doi.toLowerCase()] = true;
    items.push(item);
  }
  for (const item of defaultItems) {
    if (!seen[item.doi.toLowerCase()]) {
      seen[item.doi.toLowerCase()] = true;
      items.push(item);
    }
  }

  return items;
}

async function searchOpenAlexFilter_(query, filterType, email, maxPages, extraFilter) {
  const items = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = 'https://api.openalex.org/works?per_page=25&page=' + page
      + '&filter=' + filterType + ':' + encodeURIComponent(query) + (extraFilter || '')
      + '&select=id,doi,title,publication_year,authorships,primary_location,cited_by_count,type,open_access,topics'
      + '&sort=publication_year:desc'
      + '&mailto=' + encodeURIComponent(email);

    const data = await fetchJSON(url);
    if (!data.results || data.results.length === 0) break;

    for (const w of data.results) {
      const doi = w.doi ? w.doi.replace('https://doi.org/', '') : '';
      if (!doi) continue;

      const authorships = w.authorships || [];
      const authors = authorships.map(a => a.author.display_name);
      const loc = w.primary_location || {};
      const src = loc.source || {};

      // Extract unique institutions and countries from all authorships
      const instSet = {};
      const countrySet = {};
      for (const a of authorships) {
        for (const inst of (a.institutions || [])) {
          if (inst.display_name) instSet[inst.display_name] = true;
          if (inst.country_code) countrySet[inst.country_code] = true;
        }
      }

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
        sources: ['OpenAlex'],
        authorCount: authors.length,
        institutions: Object.keys(instSet),
        countries: Object.keys(countrySet)
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
