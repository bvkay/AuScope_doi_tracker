#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Process Pending DOIs
 *
 * Reads data/pending.json (DOIs submitted from the Google Sheet),
 * fetches metadata for each via Crossref + OpenAlex, deduplicates
 * against existing records, and merges into data/publications.json.
 * Clears pending.json when done.
 *
 * Usage: node src/process-pending.js
 */

const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const { normaliseDoi, sleep } = require('./utils');
const { lookupCrossref } = require('./sources/crossref');
const { lookupMetadata: lookupOpenAlex } = require('./sources/openalex');
const { mergeIntoExisting } = require('./dedup');

const PENDING_FILE = path.join(__dirname, '..', 'data', 'pending.json');
const PUB_FILE = path.join(__dirname, '..', 'data', 'publications.json');

async function run() {
  // Read pending DOIs
  if (!fs.existsSync(PENDING_FILE)) {
    console.log('No pending.json found — nothing to process.');
    return;
  }

  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  } catch (e) {
    console.log('Could not parse pending.json: ' + e.message);
    return;
  }

  if (!Array.isArray(pending) || pending.length === 0) {
    console.log('No pending DOIs to process.');
    return;
  }

  console.log('Processing ' + pending.length + ' pending DOI(s)...\n');

  // Load existing publications
  let pubData = { metadata: { type: 'publications', last_updated: null, total_count: 0 }, records: [] };
  if (fs.existsSync(PUB_FILE)) {
    pubData = JSON.parse(fs.readFileSync(PUB_FILE, 'utf8'));
  }

  // Build lookup of existing DOIs
  const existingDois = new Set();
  for (const rec of pubData.records) {
    existingDois.add(normaliseDoi(rec.doi));
  }

  // Process each pending DOI
  const newItems = [];
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < pending.length; i++) {
    const doi = normaliseDoi(pending[i].doi);
    if (!doi) continue;

    process.stdout.write('[' + (i + 1) + '/' + pending.length + '] ' + doi + ' ... ');

    // Skip if already in publications
    if (existingDois.has(doi)) {
      console.log('already exists, skipped');
      skipped++;
      continue;
    }

    // Fetch metadata: Crossref first, then OpenAlex for gaps
    let meta = null;
    let sources = [];

    try {
      meta = await lookupCrossref(doi, config.email);
      if (meta) sources.push('Crossref');
    } catch (e) {
      // Crossref failed, try OpenAlex
    }

    let oaMeta = null;
    try {
      oaMeta = await lookupOpenAlex(doi, config.email);
      if (oaMeta) sources.push('OpenAlex');
    } catch (e) {
      // OpenAlex also failed
    }

    if (!meta && !oaMeta) {
      console.log('no metadata found');
      errors++;
      await sleep(200);
      continue;
    }

    // Merge: start with Crossref, fill gaps from OpenAlex
    const base = meta || {};
    const oa = oaMeta || {};

    const record = {
      doi: doi,
      title: base.title || oa.title || '',
      authors: base.authors || oa.authors || '',
      journal: base.journal || oa.journal || '',
      publisher: base.publisher || oa.publisher || '',
      year: base.year || oa.year || null,
      cited: Math.max(base.cited || 0, oa.cited || 0),
      type: base.type || oa.type || '',
      isOA: (oa.isOA && oa.isOA !== 'Unknown') ? oa.isOA : (base.isOA || 'Unknown'),
      subject: oa.subject || base.subject || '',  // OpenAlex has better subjects
      sources: sources,
      searchTerms: ['Manual submission'],
      dateAdded: new Date().toISOString().slice(0, 10)
    };

    newItems.push(record);
    existingDois.add(doi);
    console.log('OK — ' + (record.title || 'Untitled').substring(0, 60));
    await sleep(200);
  }

  // Merge into publications
  if (newItems.length > 0) {
    const { records, added, updated } = mergeIntoExisting(pubData.records, newItems);
    pubData.records = records;
    pubData.metadata.last_updated = new Date().toISOString();
    pubData.metadata.total_count = records.length;
    fs.writeFileSync(PUB_FILE, JSON.stringify(pubData, null, 2));
    console.log('\nAdded: ' + added + ', Updated: ' + updated);
  }

  // Clear pending.json
  fs.writeFileSync(PENDING_FILE, '[]');

  console.log('\nSummary:');
  console.log('  Processed: ' + pending.length);
  console.log('  New records added: ' + newItems.length);
  console.log('  Already existed: ' + skipped);
  console.log('  No metadata found: ' + errors);
  console.log('  Total in database: ' + pubData.records.length);
  console.log('\nPending queue cleared.');
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
