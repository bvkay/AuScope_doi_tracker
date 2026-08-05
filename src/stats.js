#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Cross-Pillar Stats Aggregator
 *
 * Gathers headline numbers across every impact pillar:
 *   - Publications + citations   (data/publications.json)
 *   - Datasets by platform       (data/datasets.json)
 *   - Instruments + field surveys (DataCite, client auscope.repo3, live)
 *   - Data repository records    (DataCite, client auscope.repo1, live)
 *
 * Writes docs/stats-data.json (consumed by the dashboard build) and appends
 * a dated snapshot to data/stats-history.json — one entry per day, so board
 * numbers are reproducible from git history.
 *
 * Every figure is derived, never hand-entered. DataCite failures degrade to
 * null rather than breaking the build (the dashboard skips null pillars).
 *
 * Usage: node src/stats.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DOCS_DIR = path.join(__dirname, '..', 'docs');
const HISTORY_FILE = path.join(DATA_DIR, 'stats-history.json');

async function run() {
  console.log('AuScope Cross-Pillar Stats');
  console.log('==========================\n');

  const pillars = {};

  // ── Publications (local) ──
  const pubData = readJson(path.join(DATA_DIR, 'publications.json'), { records: [] });
  const pubs = pubData.records || [];
  pillars.publications = {
    total: pubs.length,
    citations: pubs.reduce(function(sum, p) { return sum + (parseInt(p.cited) || 0); }, 0)
  };
  console.log('Publications: ' + pillars.publications.total + ' (' + pillars.publications.citations + ' citations)');

  // ── Datasets (local, from dataset-inventory.js) ──
  const dsData = readJson(path.join(DATA_DIR, 'datasets.json'), { records: [] });
  const datasets = dsData.records || [];
  const byPlatform = {};
  datasets.forEach(function(d) {
    const key = d.platform || 'Other';
    byPlatform[key] = (byPlatform[key] || 0) + 1;
  });
  pillars.datasets = { total: datasets.length, byPlatform: byPlatform };
  console.log('Datasets: ' + datasets.length + ' across ' + Object.keys(byPlatform).length + ' platforms');

  // ── Instruments + surveys (DataCite, live) ──
  try {
    const records = await fetchAllDois('auscope.repo3');
    let units = 0, surveys = 0;
    const collectsSet = {}, papersSet = {};
    records.forEach(function(r) {
      const a = r.attributes || {};
      if (isSurvey(a)) {
        surveys++;
        (a.relatedIdentifiers || []).forEach(function(rel) {
          const t = normDoi(rel.relatedIdentifier);
          if (!t) return;
          if (rel.relationType === 'Collects') collectsSet[t] = true;
          if (rel.relationType === 'IsDescribedBy') papersSet[t] = true;
        });
      } else {
        units++;
      }
    });
    pillars.instruments = {
      units: units,
      surveys: surveys,
      linkedDatasets: Object.keys(collectsSet).length,
      linkedPapers: Object.keys(papersSet).length
    };
    console.log('Instruments: ' + units + ' units, ' + surveys + ' surveys ('
      + pillars.instruments.linkedDatasets + ' linked datasets, '
      + pillars.instruments.linkedPapers + ' linked papers)');
  } catch (e) {
    console.warn('Instrument registry fetch failed: ' + e.message);
    pillars.instruments = null;
  }

  // ── Data repository (DataCite, count only) ──
  try {
    const resp = await fetch('https://api.datacite.org/dois?client-id=auscope.repo1&page[size]=0');
    const j = await resp.json();
    pillars.dataRepository = { total: (j.meta && j.meta.total) || 0 };
    console.log('Data repository: ' + pillars.dataRepository.total + ' records');
  } catch (e) {
    console.warn('Data repository fetch failed: ' + e.message);
    pillars.dataRepository = null;
  }

  // ── Write stats-data.json ──
  const out = { generated: new Date().toISOString(), pillars: pillars };
  fs.writeFileSync(path.join(DOCS_DIR, 'stats-data.json'), JSON.stringify(out, null, 2));
  console.log('\nWrote docs/stats-data.json');

  // ── Append daily snapshot to history (one entry per date, latest wins) ──
  const history = readJson(HISTORY_FILE, []);
  const today = out.generated.substring(0, 10);
  const snapshot = {
    date: today,
    publications: pillars.publications.total,
    citations: pillars.publications.citations,
    datasets: pillars.datasets.total,
    instrumentUnits: pillars.instruments ? pillars.instruments.units : null,
    surveys: pillars.instruments ? pillars.instruments.surveys : null,
    impactLinks: pillars.instruments
      ? pillars.instruments.linkedDatasets + pillars.instruments.linkedPapers : null
  };
  const filtered = history.filter(function(h) { return h.date !== today; });
  filtered.push(snapshot);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(filtered, null, 2));
  console.log('Appended snapshot for ' + today + ' (' + filtered.length + ' total in history)');
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { /* fall through */ }
  return fallback;
}

function normDoi(s) {
  if (!s) return '';
  return String(s).trim().replace(/^https?:\/\/(www\.)?(dx\.)?doi\.org\//i, '').toLowerCase();
}

// Same survey heuristic as docs/instruments.html: FIELD SURVEYS marker
// (case-insensitive) or HasPart relations.
function isSurvey(attrs) {
  const descs = attrs.descriptions || [];
  for (let i = 0; i < descs.length; i++) {
    if ((descs[i].descriptionType || '') === 'TechnicalInfo'
      && (descs[i].description || '').toLowerCase().indexOf('instrument type: field surveys') === 0) return true;
  }
  return (attrs.relatedIdentifiers || []).some(function(r) { return r.relationType === 'HasPart'; });
}

async function fetchAllDois(clientId) {
  const all = [];
  let page = 1;
  for (;;) {
    const url = 'https://api.datacite.org/dois?client-id=' + clientId
      + '&page[size]=100&page[number]=' + page;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('DataCite HTTP ' + resp.status);
    const j = await resp.json();
    all.push.apply(all, j.data || []);
    if (!j.data || j.data.length < 100) break;
    page++;
  }
  return all;
}

run().catch(function(err) {
  console.error('Failed: ' + err.message);
  process.exit(1);
});
