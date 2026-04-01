const { fetchJSON, sleep, stripHtml } = require('../utils');

/**
 * Search Europe PMC for publications matching a query.
 * @param {string} query
 * @param {object} opts - { maxResults }
 * @returns {Promise<Array>}
 */
async function searchEuropePMC(query, opts = {}) {
  const maxResults = opts.maxResults || 500;
  const pageSize = 100;
  const maxPages = Math.ceil(maxResults / pageSize);
  const items = [];
  let cursorMark = '*';

  for (let page = 0; page < maxPages; page++) {
    const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'
      + '?query=' + encodeURIComponent(query)
      + '&resultType=core'
      + '&pageSize=' + pageSize
      + '&cursorMark=' + encodeURIComponent(cursorMark)
      + '&format=json'
      + '&sort=P_PDATE_D+desc';

    const data = await fetchJSON(url);
    const results = data.resultList ? data.resultList.result : [];
    if (results.length === 0) break;

    for (const r of results) {
      const doi = r.doi || '';
      if (!doi) continue;

      let authors = [];
      if (r.authorList && r.authorList.author) {
        authors = r.authorList.author.map(a =>
          ((a.firstName || '') + ' ' + (a.lastName || '')).trim()
        );
      } else if (r.authorString) {
        authors = [r.authorString];
      }

      let subjects = [];
      if (r.meshHeadingList && r.meshHeadingList.meshHeading) {
        subjects = r.meshHeadingList.meshHeading.map(m => m.descriptorName);
      } else if (r.keywordList && r.keywordList.keyword) {
        subjects = r.keywordList.keyword;
      }

      items.push({
        doi,
        title: stripHtml(r.title || '') || 'Untitled',
        authors: authors.join('; '),
        journal: r.journalTitle || '',
        publisher: '',
        year: r.pubYear ? parseInt(r.pubYear, 10) : null,
        cited: r.citedByCount || 0,
        type: r.pubType || '',
        isOA: r.isOpenAccess === 'Y' ? 'Yes' : 'No',
        subject: subjects.slice(0, 3).join('; '),
        sources: ['Europe PMC']
      });
    }

    cursorMark = data.nextCursorMark || '';
    if (!cursorMark || results.length < pageSize) break;
    await sleep(200);
  }

  return items;
}

/**
 * Search Europe PMC specifically in acknowledgement and funding sections.
 * Many papers mention infrastructure like AuScope only in acknowledgements,
 * not in the abstract — this catches those.
 * @param {string} query
 * @param {object} opts - { maxResults }
 * @returns {Promise<Array>}
 */
async function searchEuropePMCAck(query, opts = {}) {
  // ACK_FUND searches acknowledgements + funding sections specifically
  const ackQuery = 'ACK_FUND:"' + query.replace(/"/g, '') + '"';
  return searchEuropePMC(ackQuery, opts);
}

module.exports = { searchEuropePMC, searchEuropePMCAck };
