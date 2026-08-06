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
    citations: pubs.reduce(function(sum, p) { return sum + (parseInt(p.cited) || 0); }, 0),
    verified: pubs.filter(function(p) { return p.evidence === 'verified'; }).length,
    candidate: pubs.filter(function(p) { return p.evidence === 'candidate'; }).length
  };
  console.log('Publications: ' + pillars.publications.total + ' (' + pillars.publications.citations + ' citations)');

  // ── Datasets + samples (local, from dataset-inventory.js) ──
  // EarthBank PhysicalObject records are physical samples/specimens — they
  // get their own pillar rather than inflating the dataset count.
  const dsData = readJson(path.join(DATA_DIR, 'datasets.json'), { records: [] });
  const datasets = dsData.records || [];
  const byPlatform = {};
  let samples = 0;
  datasets.forEach(function(d) {
    if (d.platform === 'EarthBank' && d.type === 'PhysicalObject') { samples++; return; }
    const key = d.platform || 'Other';
    byPlatform[key] = (byPlatform[key] || 0) + 1;
  });
  const dsTotal = datasets.length - samples;
  pillars.datasets = { total: dsTotal, byPlatform: byPlatform };

  // ── Samples (EarthBank, live) ──
  // Two facets: PhysicalObject records are per-sample DOIs; Dataset records
  // additionally DECLARE their sample and data-point counts in sizes[]
  // ("1883 Samples", "194 Geochem data points"). The declared sum is the
  // scientifically meaningful headline; the DOI count is a facet of it,
  // never added together (they describe overlapping samples).
  try {
    const ebRecords = await fetchAllDois('hypc.gxglvy');
    let declaredSamples = 0, dataPoints = 0;
    ebRecords.forEach(function(r) {
      const a = r.attributes || {};
      if ((a.types || {}).resourceTypeGeneral !== 'Dataset') return;
      (a.sizes || []).forEach(function(s) {
        const m = String(s).trim().match(/^([\d,]+)\s+(.*)$/);
        if (!m) return;
        const n = parseInt(m[1].replace(/,/g, '')) || 0;
        if (/^samples?$/i.test(m[2])) declaredSamples += n;
        else if (/data points?$/i.test(m[2])) dataPoints += n;
      });
    });
    pillars.samples = {
      declared: declaredSamples,
      sampleDois: samples,
      dataPoints: dataPoints,
      source: 'EarthBank DataCite records'
    };
    console.log('Samples: ' + declaredSamples + ' declared across datasets ('
      + samples + ' with their own DOIs, ' + dataPoints + ' analytical data points)');
  } catch (e) {
    console.warn('EarthBank sample scan failed: ' + e.message);
    pillars.samples = { declared: null, sampleDois: samples, dataPoints: null, source: 'EarthBank DataCite records' };
  }
  console.log('Datasets: ' + dsTotal + ' across ' + Object.keys(byPlatform).length + ' platforms');

  // ── Seismic stations (AusPass FDSN, live) ──
  try {
    const resp = await fetch('https://auspass.edu.au/fdsnws/station/1/query?level=network&format=text');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const lines = (await resp.text()).trim().split('\n');
    let stations = 0;
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split('|');
      if (parts.length >= 5) stations += parseInt(parts[4]) || 0;
    }
    pillars.stations = { total: stations, source: 'AusPass FDSN station service' };
    console.log('Stations: ' + stations);
  } catch (e) {
    console.warn('AusPass station fetch failed: ' + e.message);
    pillars.stations = null;
  }

  // ── Instruments + surveys (DataCite, live) ──
  try {
    const records = await fetchAllDois('auscope.repo3');
    let units = 0, surveys = 0;
    const collectsSet = {}, papersSet = {};
    const modelByDoi = {};
    const deployments = {};  // model -> total survey memberships
    const surveyRecs = [];
    records.forEach(function(r) {
      const a = r.attributes || {};
      if (isSurvey(a)) {
        surveys++;
        surveyRecs.push(a);
        (a.relatedIdentifiers || []).forEach(function(rel) {
          const t = normDoi(rel.relatedIdentifier);
          if (!t) return;
          if (rel.relationType === 'Collects') collectsSet[t] = true;
          if (rel.relationType === 'IsDescribedBy') papersSet[t] = true;
        });
      } else {
        units++;
        modelByDoi[normDoi(a.doi)] = unitModel(a);
      }
    });
    // Most-deployed models: each HasPart edge is one unit deployed in one survey.
    surveyRecs.forEach(function(a) {
      (a.relatedIdentifiers || []).forEach(function(rel) {
        if (rel.relationType !== 'HasPart') return;
        const model = modelByDoi[normDoi(rel.relatedIdentifier)];
        if (model) deployments[model] = (deployments[model] || 0) + 1;
      });
    });
    const topModels = Object.keys(deployments).map(function(m) {
      return { model: m, deployments: deployments[m] };
    }).sort(function(x, y) { return y.deployments - x.deployments; }).slice(0, 8);
    pillars.instruments = {
      units: units,
      surveys: surveys,
      linkedDatasets: Object.keys(collectsSet).length,
      linkedPapers: Object.keys(papersSet).length,
      topModels: topModels
    };
    console.log('Instruments: ' + units + ' units, ' + surveys + ' surveys ('
      + pillars.instruments.linkedDatasets + ' linked datasets, '
      + pillars.instruments.linkedPapers + ' linked papers)');
    console.log('Top models: ' + topModels.map(function(t) { return t.model + ' x' + t.deployments; }).join(', '));
  } catch (e) {
    console.warn('Instrument registry fetch failed: ' + e.message);
    pillars.instruments = null;
  }

  // ── NVCL infrastructure (committed snapshot from the NVCL pipeline) ──
  // Service metrics come from data/nvcl-stats.json, distilled from the
  // heavy NVCL harvest pipeline. as_of travels with the numbers — the date
  // is the honesty mechanism until a light harvester automates refresh.
  const nvcl = readJson(path.join(DATA_DIR, 'nvcl-stats.json'), null);
  if (nvcl && nvcl.summary) {
    pillars.nvcl = {
      asOf: nvcl.as_of,
      boreholes: nvcl.summary.total_boreholes_with_data,
      // measured = intervals the nodes publish; combined adds the disclosed
      // estimation tier for nodes that publish none (WA, NT).
      scannedKm: nvcl.summary.total_scanned_km,
      combinedKm: nvcl.summary.combined_estimate_km || nvcl.summary.total_scanned_km,
      estimatedKm: nvcl.summary.estimated_km || 0,
      datasets: nvcl.summary.total_datasets,
      nodes: nvcl.summary.participating_node_count
    };
    console.log('NVCL: ' + pillars.nvcl.boreholes + ' boreholes, '
      + pillars.nvcl.scannedKm + ' km scanned (as of ' + nvcl.as_of + ')');
  } else {
    pillars.nvcl = null;
  }

  // ── AuSIS (Australian Seismometers in Schools, live) ──
  // Reads the committed data products of AuScope/AuScope_Outreach (Ben's
  // production outreach platform: daily station backup, hourly streaming
  // probe) — fresher than anything we could harvest ourselves.
  try {
    const base = 'https://auscope.github.io/AuScope_Outreach/data/';
    const stResp = await fetch(base + 'ausis_stations.geojson');
    if (!stResp.ok) throw new Error('stations HTTP ' + stResp.status);
    const feats = ((await stResp.json()).features) || [];
    const active = feats.filter(function(f) {
      const p = f.properties || {};
      return !(p.endDate || p.end_date || p.endTime);
    }).length;
    let streaming = null;
    try {
      // Shape: { checked, stations: { CODE: { streaming: bool, checkedAt } } }
      const ss = await (await fetch(base + 'ausis_status.json')).json();
      let vals = ss.stations || ss;
      if (!Array.isArray(vals)) vals = Object.values(vals || {});
      if (vals.length) {
        streaming = vals.filter(function(s) {
          return s && (s.streaming === true || s.status === 'up' || s.ok === true);
        }).length;
      }
    } catch (e) { /* streaming count optional */ }
    pillars.ausis = {
      stations: feats.length,
      active: active,
      streaming: streaming,
      networkDoi: '10.7914/SN/S1',
      since: 2011
    };
    console.log('AuSIS: ' + feats.length + ' school stations (' + active + ' active'
      + (streaming !== null ? ', ' + streaming + ' streaming' : '') + ')');
  } catch (e) {
    console.warn('AuSIS fetch failed: ' + e.message);
    pillars.ausis = null;
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
    verified: pillars.publications.verified,
    citations: pillars.publications.citations,
    datasets: pillars.datasets.total,
    samplesDeclared: pillars.samples ? pillars.samples.declared : null,
    stations: pillars.stations ? pillars.stations.total : null,
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

// Model name from a unit's 'Model:' TechnicalInfo entry, falling back to
// known model tokens in the title (24 PR6-24 loggers carry no Model entry).
const MODEL_TOKENS = ['LEMI-120', 'LEMI-423', 'LEMI-424', 'PR6-24', 'MTC-150', 'MTU-5C'];
function unitModel(attrs) {
  const descs = attrs.descriptions || [];
  for (let i = 0; i < descs.length; i++) {
    if ((descs[i].descriptionType || '') !== 'TechnicalInfo') continue;
    const t = descs[i].description || '';
    if (t.toLowerCase().indexOf('model:') === 0) {
      const name = t.substring(6).replace(/\((?:URL|URI):.*$/i, '').trim();
      if (name) return name;
    }
  }
  const title = ((attrs.titles || [])[0] || {}).title || '';
  for (let j = 0; j < MODEL_TOKENS.length; j++) {
    if (title.indexOf(MODEL_TOKENS[j]) !== -1) return MODEL_TOKENS[j];
  }
  return 'Other';
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
