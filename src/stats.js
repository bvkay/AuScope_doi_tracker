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
const { normaliseDoi } = require('./utils');

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
  // NCI records carry a subset tag (MT | DAS) so each data type gets its own
  // dashboard widget; the subset key is 'NCI MT' / 'NCI DAS'.
  const subsetKey = function(d) {
    if (d.platform === 'NCI' && d.subset) return 'NCI ' + d.subset;
    return d.platform || 'Other';
  };
  const byPlatform = {};
  let samples = 0;
  datasets.forEach(function(d) {
    if (d.platform === 'EarthBank' && d.type === 'PhysicalObject') { samples++; return; }
    const key = subsetKey(d);
    byPlatform[key] = (byPlatform[key] || 0) + 1;
  });
  const dsTotal = datasets.length - samples;

  // Per-subset F-UJI averages, joined by DOI from data/fair-scores.json
  // (written by fair-assess.js; absent file degrades to no averages).
  const fairStore = readJson(path.join(DATA_DIR, 'fair-scores.json'), { scores: {} });
  const fairAvg = {};
  if (fairStore.scores && Object.keys(fairStore.scores).length) {
    const sums = {};
    datasets.forEach(function(d) {
      if (!d.doi || (d.platform === 'EarthBank' && d.type === 'PhysicalObject')) return;
      const entry = fairStore.scores[normaliseDoi(d.doi)];
      if (!entry || entry.score == null) return;
      const key = subsetKey(d);
      sums[key] = sums[key] || { n: 0, sum: 0 };
      sums[key].n++; sums[key].sum += entry.score;
    });
    Object.keys(sums).forEach(function(k) {
      fairAvg[k] = Math.round(sums[k].sum / sums[k].n);
    });
  }
  pillars.datasets = {
    total: dsTotal, byPlatform: byPlatform, fairAvg: fairAvg,
    fairMeta: fairStore.metadata
      ? { metric_version: fairStore.metadata.metric_version, last_updated: fairStore.metadata.last_updated }
      : null
  };

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

  // ── GNSS (AuScope-funded CORS stations, live from GA) ──
  // GA's CORS metadata API is the operator's registry; the AUSCOPE network
  // tenancy (ID 101) marks the stations AuScope built or funded. Falls back
  // to the weekly snapshot committed by bvkay/AuScope_Outreach — the same
  // source gnss.html uses, so page and card can never disagree on provenance.
  try {
    let sites = [];
    try {
      let page = 0;
      for (;;) {
        const r = await fetch('https://metadata.gnss.ga.gov.au/api/corsSites?size=200&page=' + page);
        if (!r.ok) throw new Error('GA API HTTP ' + r.status);
        const batch = (((await r.json())._embedded) || {}).corsSites || [];
        if (!batch.length) break;
        sites = sites.concat(batch);
        if (++page > 30) break;
      }
      sites = sites.filter(function(x) {
        return (x.networkTenancies || []).some(function(t) { return t.corsNetworkId === 101; });
      });
      if (!sites.length) throw new Error('AUSCOPE tenancy empty');
      sites = sites.map(function(x) { return { installed: x.dateInstalled || '' }; });
    } catch (liveErr) {
      const gj = await (await fetch('https://raw.githubusercontent.com/bvkay/AuScope_Outreach/main/data/gnss_auscope.geojson')).json();
      sites = (gj.features || []).map(function(f) {
        return { installed: (f.properties || {}).dateInstalled || '' };
      });
      console.log('GNSS: GA API failed (' + liveErr.message + '), using weekly snapshot');
    }
    const years = sites.map(function(x) { return String(x.installed).slice(0, 4); })
      .filter(Boolean).sort();
    pillars.gnss = {
      stations: sites.length,
      since: years.length ? Number(years[0]) : null,
      latest: years.length ? Number(years[years.length - 1]) : null,
      network: 'AUSCOPE tenancy (ID 101) in GA CORS',
      source: 'GA CORS metadata API',
    };
    console.log('GNSS: ' + sites.length + ' AuScope-funded CORS stations'
      + (years.length ? ' (built ' + years[0] + '-' + years[years.length - 1] + ')' : ''));
  } catch (e) {
    console.log('GNSS: unavailable (' + e.message + ')');
    pillars.gnss = null;
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

  // ── AusMT (Australia's MT data portal, live) ──
  // Reads the portal's own machine surfaces (static files, CC0 catalogue):
  // build_provenance.json carries the corpus counts, collections.json the
  // AusLAMP programme rollup. Operated by Ben — same trust tier as AuSIS.
  try {
    const base = 'https://ausmt.auscope.org.au/data/';
    const prov = await (await fetch(base + 'build_provenance.json')).json();
    if (!prov || !prov.n_surveys) throw new Error('no counts in build_provenance');
    let auslamp = null;
    try {
      const coll = await (await fetch(base + 'collections.json')).json();
      if (coll && coll.auslamp) {
        auslamp = { surveys: coll.auslamp.n_surveys, stations: coll.auslamp.n_stations };
      }
    } catch (e) { /* AusLAMP rollup optional */ }
    pillars.ausmt = {
      surveys: prov.n_surveys,
      stations: prov.n_stations,
      auslamp: auslamp,
      generated: (prov.generated || '').substring(0, 10)
    };
    // Run-level deployment register (committed snapshot from ausmt-inventory.js —
    // the SOLE source for MT instrument deployments; the instrument registry's
    // survey records are deliberately not used for this). Scope: AuScope-funded
    // instruments only (fundingReferences filter via the registry fetch above),
    // falling back to unfiltered totals if the registry fetch failed.
    const runs = readJson(path.join(DATA_DIR, 'ausmt-runs.json'), null);
    if (runs && runs.metadata) {
      const m = runs.metadata;
      const scoped = m.scope_tagged && m.auscope_instruments != null;
      pillars.ausmt.instrumentsDeployed = scoped ? m.auscope_instruments : m.instruments;
      pillars.ausmt.occupations = scoped ? m.auscope_occupations : m.occupations;
      pillars.ausmt.recordingDays = scoped ? m.auscope_recording_days : m.recording_days;
      pillars.ausmt.surveysPopulated = m.surveys_populated;
      pillars.ausmt.scopeFiltered = !!scoped;
      pillars.ausmt.runsFetched = (m.fetched || '').substring(0, 10);
    }
    console.log('AusMT: ' + pillars.ausmt.surveys + ' surveys, '
      + pillars.ausmt.stations + ' stations'
      + (auslamp ? ' (AusLAMP ' + auslamp.surveys + '/' + auslamp.stations + ')' : '')
      + (pillars.ausmt.instrumentsDeployed != null
        ? ' · runs: ' + pillars.ausmt.instrumentsDeployed + ' instruments'
          + (pillars.ausmt.scopeFiltered ? ' (AuScope-funded)' : ' (unfiltered)')
          + ', ' + pillars.ausmt.recordingDays + ' recording-days ('
          + pillars.ausmt.surveysPopulated + '/' + pillars.ausmt.surveys + ' surveys populated)'
        : ''));
  } catch (e) {
    console.warn('AusMT fetch failed: ' + e.message);
    pillars.ausmt = null;
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
      ? pillars.instruments.linkedDatasets + pillars.instruments.linkedPapers : null,
    ausmtSurveys: pillars.ausmt ? pillars.ausmt.surveys : null,
    ausmtStations: pillars.ausmt ? pillars.ausmt.stations : null,
    ausmtInstrumentsDeployed: pillars.ausmt && pillars.ausmt.instrumentsDeployed != null
      ? pillars.ausmt.instrumentsDeployed : null,
    ausmtRecordingDays: pillars.ausmt && pillars.ausmt.recordingDays != null
      ? pillars.ausmt.recordingDays : null
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
