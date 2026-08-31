#!/usr/bin/env node
/**
 * AuScope DOI Tracker — registry licence + creator enrichment
 *
 * Fetches DataCite licence strings and ORCID-resolved creators for every
 * dataset DOI on the roster, for the Dataset Registry's Licence and
 * Creators columns:
 *
 *   docs/registry-licenses.json — { records: {doi: licence}, creators: {doi: [..]} }
 *
 * Adapted from Rebecca Farrington's fork (28 Aug 2026) with two changes:
 * a failed DOI keeps its PREVIOUS values rather than blanking them (absent
 * is not zero — same rule as everywhere else in this repo), and the run
 * reports how many lookups failed instead of dying on the first.
 *
 * Usage: node src/update-registry-licenses.js
 */

const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, '..', 'data', 'datasets.json');
const OUTPUT = path.join(__dirname, '..', 'docs', 'registry-licenses.json');
const CONCURRENCY = 6;

function label(items) {
  return (items || [])
    .map(r => r.rightsIdentifier || r.rights || r.rightsUri || r.rightsURI || '')
    .filter(Boolean).join('; ');
}

function creatorsOf(items) {
  return (items || []).map(function(c) {
    const id = (c.nameIdentifiers || []).find(function(x) {
      return String(x.nameIdentifierScheme || '').toUpperCase() === 'ORCID'
        || /orcid\.org/i.test(x.nameIdentifier || '');
    });
    return {
      name: c.name || [c.givenName, c.familyName].filter(Boolean).join(' '),
      given: c.givenName || '', family: c.familyName || '',
      orcid: id ? String(id.nameIdentifier || '').replace(/^https?:\/\/orcid\.org\//i, '') : '',
    };
  }).filter(function(c) { return c.name; });
}

async function fetchOne(doi) {
  const res = await fetch('https://api.datacite.org/dois/' + encodeURIComponent(doi), {
    headers: { Accept: 'application/vnd.api+json', 'User-Agent': 'AuScope-DOI-Tracker' },
  });
  if (res.status === 404) return { license: '', creators: [] };
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const attrs = ((await res.json()).data || {}).attributes || {};
  return { license: label(attrs.rightsList), creators: creatorsOf(attrs.creators) };
}

async function run() {
  console.log('AuScope registry licence enrichment');
  console.log('===================================\n');

  const rows = JSON.parse(fs.readFileSync(INPUT, 'utf8')).records || [];
  const dois = Array.from(new Set(rows.map(r => r.doi).filter(Boolean)));

  // Previous values survive a failed lookup.
  let prev = { records: {}, creators: {} };
  if (fs.existsSync(OUTPUT)) {
    try { prev = JSON.parse(fs.readFileSync(OUTPUT, 'utf8')); } catch (e) { /* fresh */ }
  }
  const records = Object.assign({}, prev.records || {});
  const creators = Object.assign({}, prev.creators || {});

  let cursor = 0, ok = 0, failed = 0;
  async function worker() {
    for (;;) {
      const doi = dois[cursor++];
      if (!doi) return;
      const key = doi.toLowerCase();
      try {
        const r = await fetchOne(doi);
        records[key] = r.license;
        creators[key] = r.creators;
        ok++;
      } catch (err) {
        failed++;
        console.warn('  ' + doi + ' — FAILED (' + err.message + ')'
          + (key in (prev.records || {}) ? ', kept previous' : ''));
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  fs.writeFileSync(OUTPUT, JSON.stringify({
    generated: new Date().toISOString(),
    source: 'DataCite REST API',
    records: records,
    creators: creators,
  }, null, 2) + '\n');

  const withLicence = Object.values(records).filter(Boolean).length;
  const withOrcid = Object.values(creators)
    .filter(list => (list || []).some(c => c.orcid)).length;
  console.log('\nDone: ' + ok + ' fetched, ' + failed + ' failed of ' + dois.length + ' DOIs.');
  console.log('Licences present: ' + withLicence + ' · DOIs with >=1 ORCID creator: ' + withOrcid);
}

run().catch(err => { console.error('Fatal: ' + err.message); process.exit(1); });
