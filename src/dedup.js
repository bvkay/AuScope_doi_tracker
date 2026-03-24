const { normaliseDoi } = require('./utils');

/**
 * Deduplicate an array of citation items by DOI.
 * Merges source tags, search terms, keeps highest citation count,
 * and prefers the longest (most complete) string for metadata fields.
 *
 * @param {Array} items - Raw items from all sources
 * @returns {Array} Deduplicated items
 */
function deduplicateItems(items) {
  const doiMap = {};

  for (const item of items) {
    const key = normaliseDoi(item.doi);
    if (!key) continue;

    if (doiMap[key]) {
      mergeInto(doiMap[key], item);
    } else {
      doiMap[key] = copyItem(item);
    }
  }

  return Object.values(doiMap);
}

function mergeInto(target, source) {
  // Merge source tags
  for (const s of (source.sources || [])) {
    if (target.sources.indexOf(s) < 0) target.sources.push(s);
  }
  // Merge search terms
  for (const t of (source.searchTerms || [])) {
    if (target.searchTerms.indexOf(t) < 0) target.searchTerms.push(t);
  }
  // Keep highest citation count
  if ((source.cited || 0) > (target.cited || 0)) target.cited = source.cited;
  // Prefer longer (more complete) strings
  if (source.title && source.title.length > (target.title || '').length) target.title = source.title;
  if (source.authors && source.authors.length > (target.authors || '').length) target.authors = source.authors;
  if (source.journal && source.journal.length > (target.journal || '').length) target.journal = source.journal;
  if (source.publisher && source.publisher.length > (target.publisher || '').length) target.publisher = source.publisher;
  if (!target.year && source.year) target.year = source.year;
  if (source.type && source.type.length > (target.type || '').length) target.type = source.type;
  if (source.subject && source.subject.length > (target.subject || '').length) target.subject = source.subject;
  if (target.isOA === 'Unknown' && source.isOA !== 'Unknown') target.isOA = source.isOA;
  // Merge institutions and countries (take the larger set)
  if ((source.institutions || []).length > (target.institutions || []).length) target.institutions = source.institutions;
  if ((source.countries || []).length > (target.countries || []).length) target.countries = source.countries;
  // Keep highest author count
  if ((source.authorCount || 0) > (target.authorCount || 0)) target.authorCount = source.authorCount;
}

function copyItem(item) {
  return {
    doi: item.doi,
    title: item.title || '',
    authors: item.authors || '',
    journal: item.journal || '',
    publisher: item.publisher || '',
    year: item.year || null,
    cited: item.cited || 0,
    type: item.type || '',
    isOA: item.isOA || 'Unknown',
    subject: item.subject || '',
    sources: (item.sources || []).slice(),
    searchTerms: (item.searchTerms || []).slice(),
    authorCount: item.authorCount || 0,
    institutions: (item.institutions || []).slice(),
    countries: (item.countries || []).slice()
  };
}

/**
 * Merge new items into an existing records array (from JSON file).
 * Returns { records, added, updated } with the merged array and counts.
 *
 * @param {Array} existing - Current records from publications.json
 * @param {Array} newItems - Freshly searched/deduped items
 * @returns {object}
 */
function mergeIntoExisting(existing, newItems) {
  // Build lookup of existing DOIs
  const doiIndex = {};
  for (let i = 0; i < existing.length; i++) {
    const key = normaliseDoi(existing[i].doi);
    if (key) doiIndex[key] = i;
  }

  let added = 0;
  let updated = 0;

  for (const item of newItems) {
    const key = normaliseDoi(item.doi);
    if (!key) continue;

    if (doiIndex[key] !== undefined) {
      const idx = doiIndex[key];
      const rec = existing[idx];
      const oldSources = rec.sources ? rec.sources.join(',') : '';

      mergeInto(rec, item);

      // Count as updated if anything changed
      const newSources = rec.sources ? rec.sources.join(',') : '';
      if (newSources !== oldSources || item.cited > (rec.cited || 0)) {
        updated++;
      }
    } else {
      const newRec = copyItem(item);
      newRec.dateAdded = new Date().toISOString().slice(0, 10);
      existing.push(newRec);
      doiIndex[key] = existing.length - 1;
      added++;
    }
  }

  return { records: existing, added, updated };
}

module.exports = { deduplicateItems, mergeIntoExisting };
