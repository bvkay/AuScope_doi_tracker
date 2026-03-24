#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Maintenance
 *
 * Runs two passes on data/publications.json:
 *   1. Dedup — removes duplicate DOIs, merging metadata from duplicates
 *   2. Fill — fetches missing metadata for records with gaps
 *
 * Usage: node src/maintain.js
 */

const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const { normaliseDoi, sleep } = require('./utils');
const { lookupCrossref } = require('./sources/crossref');
const { lookupMetadata: lookupOpenAlex } = require('./sources/openalex');

const PUB_FILE = path.join(__dirname, '..', 'data', 'publications.json');

async function run() {
  if (!fs.existsSync(PUB_FILE)) {
    console.log('No publications.json found.');
    return;
  }

  const pubData = JSON.parse(fs.readFileSync(PUB_FILE, 'utf8'));
  const records = pubData.records || [];
  console.log('Maintenance — ' + records.length + ' records\n');

  // ── Pass 1: Dedup ──
  const dedupResult = dedup(records);
  console.log('Dedup: removed ' + dedupResult.removed + ' duplicate(s)\n');

  // ── Pass 2: Fill missing metadata ──
  const fillResult = await fillMissing(dedupResult.records);
  console.log('\nMetadata fill: updated ' + fillResult.filled + ' record(s)\n');

  // Save
  pubData.records = fillResult.records;
  pubData.metadata.last_updated = new Date().toISOString();
  pubData.metadata.total_count = pubData.records.length;
  fs.writeFileSync(PUB_FILE, JSON.stringify(pubData, null, 2));

  console.log('Total records: ' + pubData.records.length);
  console.log('Saved to ' + PUB_FILE);
}

/**
 * Remove duplicate DOIs. Keeps the record with the most filled fields,
 * merges sources/searchTerms/citations from duplicates.
 */
function dedup(records) {
  const doiMap = {};
  let removed = 0;

  for (const rec of records) {
    const key = normaliseDoi(rec.doi);
    if (!key) continue;

    if (doiMap[key]) {
      mergeRecord(doiMap[key], rec);
      removed++;
    } else {
      doiMap[key] = rec;
    }
  }

  return { records: Object.values(doiMap), removed };
}

function mergeRecord(target, source) {
  // Merge array fields
  (source.sources || []).forEach(function(s) {
    if ((target.sources || []).indexOf(s) < 0) target.sources.push(s);
  });
  (source.searchTerms || []).forEach(function(t) {
    if ((target.searchTerms || []).indexOf(t) < 0) target.searchTerms.push(t);
  });
  // Keep highest citation count
  if ((source.cited || 0) > (target.cited || 0)) target.cited = source.cited;
  // Prefer longer strings (more complete)
  if (source.title && source.title.length > (target.title || '').length) target.title = source.title;
  if (source.authors && source.authors.length > (target.authors || '').length) target.authors = source.authors;
  if (source.journal && source.journal.length > (target.journal || '').length) target.journal = source.journal;
  if (source.publisher && source.publisher.length > (target.publisher || '').length) target.publisher = source.publisher;
  if (!target.year && source.year) target.year = source.year;
  if (source.type && source.type.length > (target.type || '').length) target.type = source.type;
  if (source.subject && source.subject.length > (target.subject || '').length) target.subject = source.subject;
  if ((!target.isOA || target.isOA === 'Unknown') && source.isOA && source.isOA !== 'Unknown') target.isOA = source.isOA;
  if (!target.dateAdded && source.dateAdded) target.dateAdded = source.dateAdded;
}

/**
 * Fill missing metadata for records with gaps.
 * Only makes API calls for records missing title, authors, journal, or subject.
 */
async function fillMissing(records) {
  let filled = 0;
  let checked = 0;

  for (const rec of records) {
    const doi = normaliseDoi(rec.doi);
    if (!doi) continue;

    const needsTitle = !rec.title;
    const needsAuthors = !rec.authors;
    const needsJournal = !rec.journal;
    const needsSubject = !rec.subject;
    const needsOA = !rec.isOA || rec.isOA === 'Unknown';

    if (!needsTitle && !needsAuthors && !needsJournal && !needsSubject && !needsOA) continue;

    checked++;
    if (checked % 50 === 0) {
      process.stdout.write('  Checked ' + checked + ' records...\r');
    }

    // Crossref for core metadata
    let crMeta = null;
    if (needsTitle || needsAuthors || needsJournal) {
      try {
        crMeta = await lookupCrossref(doi, config.email);
      } catch (e) { /* skip */ }
      await sleep(100);
    }

    // OpenAlex for subject, OA, and anything Crossref missed
    let oaMeta = null;
    if (needsSubject || needsOA || (needsTitle && !crMeta) || (needsAuthors && !crMeta)) {
      try {
        oaMeta = await lookupOpenAlex(doi, config.email);
      } catch (e) { /* skip */ }
      await sleep(100);
    }

    if (!crMeta && !oaMeta) continue;

    let changed = false;
    const cr = crMeta || {};
    const oa = oaMeta || {};

    if (needsTitle && (cr.title || oa.title)) { rec.title = cr.title || oa.title; changed = true; }
    if (needsAuthors && (cr.authors || oa.authors)) { rec.authors = cr.authors || oa.authors; changed = true; }
    if (needsJournal && (cr.journal || oa.journal)) { rec.journal = cr.journal || oa.journal; changed = true; }
    if (!rec.publisher && (cr.publisher || oa.publisher)) { rec.publisher = cr.publisher || oa.publisher; changed = true; }
    if (!rec.year && (cr.year || oa.year)) { rec.year = cr.year || oa.year; changed = true; }
    if (needsSubject && (oa.subject || cr.subject)) { rec.subject = oa.subject || cr.subject; changed = true; }
    if (needsOA && oa.isOA && oa.isOA !== 'Unknown') { rec.isOA = oa.isOA; changed = true; }
    if (!rec.type && (cr.type || oa.type)) { rec.type = cr.type || oa.type; changed = true; }

    // Update citation count if higher
    const newCited = Math.max(cr.cited || 0, oa.cited || 0);
    if (newCited > (rec.cited || 0)) { rec.cited = newCited; changed = true; }

    if (changed) filled++;
  }

  return { records, filled };
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
