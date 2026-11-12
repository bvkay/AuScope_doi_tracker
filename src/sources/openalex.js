const { fetchJSON, sleep, stripHtml } = require('../utils');

// The largest page OpenAlex serves. A list request costs the same budget
// credit whatever its size, so 100 a page costs a quarter of 25 a page.
const PER_PAGE = 100;

/**
 * Five-year windows from minYear to the current year. The primary term
 * has more results than one query can page through, so each window is
 * paged on its own.
 */
function yearWindows(minYear) {
  const currentYear = new Date().getFullYear();
  const out = [];
  for (let start = minYear || 1997; start <= currentYear; start += 5) {
    out.push({ start: start, end: Math.min(start + 4, currentYear) });
  }
  return out;
}

/**
 * One unit of OpenAlex work: a term, one filter type, optionally one year
 * window, capped at maxResults. The batched search schedules these,
 * because a unit costs at most ceil(maxResults / 100) requests and can be
 * retried on its own when the shared keyless budget runs out mid-run.
 * @param {string} query
 * @param {object} opts - { filterType, window, maxResults, email }
 * @returns {Promise<Array>} Normalised citation records
 */
async function searchOpenAlexUnit(query, opts = {}) {
  const yearFilter = opts.window
    ? ',publication_year:' + opts.window.start + '-' + opts.window.end : '';
  return searchOpenAlexFilter_(query, opts.filterType || 'default.search',
    opts.email || '', opts.maxResults || 500, yearFilter);
}

/**
 * Search OpenAlex for works matching a query.
 * Runs two passes: fulltext.search (deep, covers full paper text) and
 * default.search (broader, catches papers not fulltext-indexed).
 * Results are combined and deduped by DOI.
 * @param {string} query - Search query (supports quoted phrases)
 * @param {object} opts - { email, maxResults, maxPages (pages of 25, the
 *   older unit of account), yearWindows, minYear }
 * @returns {Promise<Array>} Normalised citation records
 */
async function searchOpenAlex(query, opts = {}) {
  const email = opts.email || '';
  const maxResults = opts.maxResults || ((opts.maxPages || 2) * 25);
  const windows = opts.yearWindows ? yearWindows(opts.minYear) : [null];

  const fulltextItems = [];
  const defaultItems = [];
  for (const window of windows) {
    fulltextItems.push(...await searchOpenAlexUnit(query,
      { filterType: 'fulltext.search', window, maxResults, email }));
    defaultItems.push(...await searchOpenAlexUnit(query,
      { filterType: 'default.search', window, maxResults, email }));
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

async function searchOpenAlexFilter_(query, filterType, email, maxResults, extraFilter) {
  const items = [];
  const pages = Math.max(1, Math.ceil(maxResults / PER_PAGE));

  for (let page = 1; page <= pages; page++) {
    const url = 'https://api.openalex.org/works?per_page=' + PER_PAGE + '&page=' + page
      + '&filter=' + filterType + ':' + encodeURIComponent(query) + (extraFilter || '')
      + '&select=id,doi,title,publication_year,publication_date,authorships,primary_location,cited_by_count,type,open_access,topics'
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
        publicationDate: /^\d{4}-\d{2}/.test(w.publication_date || '') ? w.publication_date : undefined,
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

    if (data.results.length < PER_PAGE) break;
    await sleep(100);   // keyless limit is 10 requests a second
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
      publicationDate: /^\d{4}-\d{2}/.test(data.publication_date || '') ? data.publication_date : undefined,
      cited: data.cited_by_count || 0,
      type: (data.type || '').replace(/-/g, ' '),
      isOA: data.open_access ? (data.open_access.is_oa ? 'Yes' : 'No') : 'Unknown',
      subject: (data.topics || []).slice(0, 3).map(t => t.display_name).join('; ')
    };
  } catch {
    return null;
  }
}

module.exports = { searchOpenAlex, searchOpenAlexUnit, yearWindows, getCitationCount, lookupMetadata };
