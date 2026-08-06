#!/usr/bin/env node
/**
 * AuScope NVCL Pillar — Live Harvester (merged-v1 methodology)
 *
 * Queries every NVCL node's PUBLIC services directly:
 *   1. WFS GetFeature gsmlp:BoreholeView (CQL nvclCollection='true', paged)
 *      -> registered borehole list per node (id, name, lat/lng, length)
 *   2. NVCLDataServices getDatasetCollection.html per borehole
 *      -> datasets with TSG metadata (instrument, dates) + DepthRange
 *
 * Counting rules (see src/nvcl/METHODOLOGY.md — the citable document):
 *   - The atom is the per-DATASET scan interval (depth_start, depth_end).
 *   - unique_scanned_km  = union of each borehole's intervals (overlaps merged)
 *   - total_scan_km      = plain sum of interval lengths (rescans count)
 *   - A dataset with a missing/invalid interval contributes ZERO metres and
 *     increments interval_unrecorded. Borehole length is NEVER substituted.
 *   - Garbage clamp: an interval longer than 1.5x the drilled borehole length
 *     (when known) is discarded as metadata garbage and counted.
 *
 * Outputs (only when the run is healthy — see health guard below):
 *   data/nvcl-stats.json      canonical snapshot (consumed by src/stats.js)
 *   docs/nvcl-data.json       page feed for docs/nvcl.html (stats + dot map)
 *   data/nvcl-history.jsonl   one appended line per run (trend record)
 *
 * Health guard: outputs are written only if >= 5 nodes are reachable AND
 * total boreholes-with-data >= 80% of the previous snapshot's count.
 * Otherwise the run exits 1 loudly and touches nothing — a half-blind
 * harvest must never replace a good national snapshot.
 *
 * Env:
 *   NVCL_ONLY=TAS,CSIRO   harvest only these nodes (testing)
 *   NVCL_OUT_DIR=/tmp/x   redirect all three outputs (testing)
 *   NVCL_FORCE=1          bypass the health guard (testing / rebaseline only)
 *
 * Usage: node src/nvcl/harvest.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const DOCS_DIR = path.join(ROOT, 'docs');
const CONFIG = readJson(path.join(ROOT, 'config.json'), {});

const OUT_DIR = process.env.NVCL_OUT_DIR || null;   // redirects writes only
const FORCE = process.env.NVCL_FORCE === '1';
const ONLY = (process.env.NVCL_ONLY || '').split(',')
  .map(function(s) { return s.trim().toUpperCase(); }).filter(Boolean);

const USER_AGENT = 'AuScope-doi-tracker NVCL harvester'
  + (CONFIG.email ? ' (mailto:' + CONFIG.email + ')' : '');

const WFS_TIMEOUT_MS = 60000;      // NT fallback pages carry 10k features
const DS_TIMEOUT_MS = 15000;
const RETRIES = 2;
const RETRY_DELAY_MS = 3000;
const CONCURRENCY = 8;             // dataset fetches in flight per node
const WFS_PAGE = 1000;
const FALLBACK_PAGE = 10000;       // unfiltered paging (NT: CQL disabled)
const CLAMP_FACTOR = 1.5;          // interval vs borehole length garbage clamp
const MIN_NODES_UP = 5;            // health guard
const MIN_PREV_FRACTION = 0.8;     // health guard

// The 8 public NVCL nodes. cqlBroken: GeoServer ignores CQL on nvclCollection
// (returns 0 rows) so we page ALL boreholes and filter locally. wfsOnly: VIC
// has no HyLogger node and no NVCLDataServices (confirmed 404) — its WFS is
// still queried so the registered-borehole count stays honest.
const NODES = [
  { code: 'CSIRO', name: 'CSIRO',              wfs: 'https://nvclwebservices.csiro.au/geoserver/ows',       nvcl: 'https://nvclwebservices.csiro.au/NVCLDataServices' },
  { code: 'NSW',   name: 'New South Wales',    wfs: 'https://gs.geoscience.nsw.gov.au/geoserver/ows',       nvcl: 'https://nvcl.geoscience.nsw.gov.au/NVCLDataServices' },
  { code: 'NT',    name: 'Northern Territory', wfs: 'https://geology.data.nt.gov.au/geoserver/ows',         nvcl: 'https://geology.data.nt.gov.au/NVCLDataServices', cqlBroken: true },
  { code: 'QLD',   name: 'Queensland',         wfs: 'https://geology.information.qld.gov.au/geoserver/ows', nvcl: 'https://geology.information.qld.gov.au/NVCLDataServices' },
  { code: 'SA',    name: 'South Australia',    wfs: 'https://sarigdata.pir.sa.gov.au/geoserver/ows',        nvcl: 'https://sarigdata.pir.sa.gov.au/nvcl/NVCLDataServices' },
  { code: 'TAS',   name: 'Tasmania',           wfs: 'https://www.mrt.tas.gov.au/web-services/ows',          nvcl: 'https://www.mrt.tas.gov.au/NVCLDataServices' },
  { code: 'VIC',   name: 'Victoria',           wfs: 'https://geology.data.vic.gov.au/nvcl/ows',             nvcl: 'https://geology.data.vic.gov.au/NVCLDataServices', wfsOnly: true,
    note: 'No HyLogger node. Boreholes flagged here may have been scanned at another node.' },
  { code: 'WA',    name: 'Western Australia',  wfs: 'https://geossdi.dmp.wa.gov.au/services/ows',           nvcl: 'https://geossdi.dmp.wa.gov.au/NVCLDataServices' },
];

// ── Main ──────────────────────────────────────────────────────────

async function run() {
  const asOf = new Date().toISOString().substring(0, 10);
  console.log('NVCL Harvest (merged-v1) — ' + asOf);
  console.log('=================================\n');
  if (ONLY.length) console.log('Node filter: ' + ONLY.join(', ') + ' (NVCL_ONLY)');
  if (OUT_DIR) console.log('Output redirect: ' + OUT_DIR + ' (NVCL_OUT_DIR)');
  if (FORCE) console.log('WARNING: health guard bypassed (NVCL_FORCE=1)');

  const t0 = Date.now();
  const nodes = ONLY.length
    ? NODES.filter(function(n) { return ONLY.indexOf(n.code) !== -1; })
    : NODES;
  if (!nodes.length) throw new Error('NVCL_ONLY matched no nodes');

  // Harvest nodes sequentially (politeness); boreholes within a node
  // are fetched with CONCURRENCY workers.
  const results = [];
  for (let i = 0; i < nodes.length; i++) {
    results.push(await harvestNode(nodes[i]));
  }

  const snapshot = aggregate(results, asOf);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log('\nHarvest finished in ' + elapsed + 's');
  printSummary(snapshot);

  // ── Health guard ──
  // Compare against the CANONICAL previous snapshot (data/nvcl-stats.json),
  // not the redirect target — the guard exists to protect the national file.
  const prev = readJson(path.join(DATA_DIR, 'nvcl-stats.json'), null);
  const prevCount = prev && prev.summary ? prev.summary.total_boreholes_with_data : null;
  const nodesUp = results.filter(function(r) { return r.wfsOk; }).length;
  const bhCount = snapshot.summary.total_boreholes_with_data;
  const guardErrors = [];
  if (nodesUp < MIN_NODES_UP) {
    guardErrors.push('only ' + nodesUp + ' of ' + NODES.length + ' nodes reachable (need >= ' + MIN_NODES_UP + ')');
  }
  if (prevCount && bhCount < prevCount * MIN_PREV_FRACTION) {
    guardErrors.push('boreholes with data ' + bhCount + ' < 80% of previous snapshot (' + prevCount + ')');
  }
  if (guardErrors.length && !FORCE) {
    console.error('\nHEALTH GUARD FAILED — refusing to write outputs:');
    guardErrors.forEach(function(e) { console.error('  - ' + e); });
    console.error('The previous snapshot stays in place. Re-run when nodes recover,');
    console.error('or set NVCL_FORCE=1 to rebaseline deliberately.');
    process.exit(1);
  }
  if (guardErrors.length && FORCE) {
    console.warn('\nHealth guard WOULD have failed (bypassed by NVCL_FORCE=1):');
    guardErrors.forEach(function(e) { console.warn('  - ' + e); });
  }

  // ── Write outputs ──
  const dataOut = OUT_DIR || DATA_DIR;
  const docsOut = OUT_DIR || DOCS_DIR;
  if (OUT_DIR) fs.mkdirSync(OUT_DIR, { recursive: true });

  const statsPath = path.join(dataOut, 'nvcl-stats.json');
  fs.writeFileSync(statsPath, JSON.stringify(snapshot, null, 1));
  console.log('\nWrote ' + statsPath);

  const feed = Object.assign({}, snapshot, {
    boreholeStates: NODES.map(function(n) { return n.code; }),
    boreholes: buildDotArray(results),
  });
  const feedPath = path.join(docsOut, 'nvcl-data.json');
  fs.writeFileSync(feedPath, JSON.stringify(feed));
  console.log('Wrote ' + feedPath + ' (' + feed.boreholes.length + ' map dots)');

  const histLine = JSON.stringify({
    date: asOf,
    boreholes: bhCount,
    datasets: snapshot.summary.total_datasets,
    unique_km: snapshot.summary.unique_scanned_km,
    total_scan_km: snapshot.summary.total_scan_km,
    unrecorded: snapshot.summary.interval_unrecorded_datasets,
    nodes_up: nodesUp,
  });
  const histPath = path.join(dataOut, 'nvcl-history.jsonl');
  fs.appendFileSync(histPath, histLine + '\n');
  console.log('Appended ' + histPath);
}

// ── Per-node harvest ──────────────────────────────────────────────

async function harvestNode(node) {
  console.log('\n[' + node.code + '] ' + node.name);
  const result = {
    node: node, wfsOk: false, dsOk: false,
    boreholes: [],            // { id, name, lat, lng, lengthM, datasets: [] }
    wfsCount: 0,
    fetchFailures: 0,         // borehole dataset fetches that hard-failed
  };

  // 1. WFS borehole list
  try {
    result.boreholes = node.cqlBroken
      ? await fetchWfsUnfiltered(node)
      : await fetchWfsFiltered(node);
    result.wfsOk = true;
    result.wfsCount = result.boreholes.length;
    console.log('  WFS: ' + result.wfsCount + ' NVCL boreholes registered');
  } catch (e) {
    console.warn('  WFS UNREACHABLE: ' + e.message);
    return result;            // status 'unreachable'; never kills the run
  }

  if (node.wfsOnly) {
    console.log('  Skipping dataset harvest (' + (node.note || 'WFS-only node') + ')');
    result.dsOk = true;       // node answered everything it has
    return result;
  }

  // 2. Dataset collections, CONCURRENCY at a time
  let done = 0, withData = 0;
  const queue = result.boreholes.slice();
  async function worker() {
    for (;;) {
      const bh = queue.shift();
      if (!bh) return;
      try {
        bh.datasets = await fetchDatasets(node, bh.id);
        if (bh.datasets.length) withData++;
      } catch (e) {
        bh.datasets = [];
        bh.fetchFailed = true;
        result.fetchFailures++;
      }
      done++;
      if (done % 200 === 0) console.log('  ' + done + '/' + result.boreholes.length + ' boreholes queried...');
    }
  }
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  // A node whose dataset service rejected every single query is down even
  // though its WFS answered — count it as reached (WFS worked) but flag it.
  result.dsOk = result.fetchFailures < result.boreholes.length || result.boreholes.length === 0;
  console.log('  Datasets: ' + withData + '/' + result.boreholes.length + ' boreholes have data'
    + (result.fetchFailures ? ' (' + result.fetchFailures + ' fetch failures)' : ''));
  if (!result.dsOk) console.warn('  DATASET SERVICE UNREACHABLE (all ' + result.fetchFailures + ' queries failed)');
  return result;
}

// Standard path: WFS 2.0.0 GET, JSON output, server-side CQL filter, paged.
async function fetchWfsFiltered(node) {
  const out = new Map();
  let startIndex = 0;
  for (;;) {
    const url = node.wfs + '?service=WFS&version=2.0.0&request=GetFeature'
      + '&typeName=gsmlp:BoreholeView&outputFormat=application/json'
      + '&count=' + WFS_PAGE + '&startIndex=' + startIndex
      + '&CQL_FILTER=' + encodeURIComponent("nvclCollection='true'");
    const text = await fetchText(url, WFS_TIMEOUT_MS);
    let features;
    try {
      features = (JSON.parse(text).features) || [];
    } catch (e) {
      // Server ignored outputFormat and sent GML — parse the XML instead.
      features = parseWfsXml(text);
    }
    features.forEach(function(f) { addFeature(out, f); });
    if (features.length < WFS_PAGE) break;
    startIndex += features.length;
  }
  return Array.from(out.values());
}

// Fallback path (NT): CQL on nvclCollection silently matches nothing, so
// page through ALL boreholes (WFS 1.0.0 POST, the nvcl_kit approach) and
// filter locally on the nvclCollection property.
async function fetchWfsUnfiltered(node) {
  const out = new Map();
  let startIndex = 0;
  for (;;) {
    const body = 'service=WFS&version=1.0.0&request=GetFeature'
      + '&typeName=gsmlp:BoreholeView&outputFormat=json'
      + '&maxFeatures=' + FALLBACK_PAGE + '&startIndex=' + startIndex;
    const text = await fetchText(node.wfs, WFS_TIMEOUT_MS, {
      method: 'POST', body: body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const features = (JSON.parse(text).features) || [];
    features.forEach(function(f) {
      const p = f.properties || {};
      if (String(p.nvclCollection) !== 'true') return;
      addFeature(out, f);
    });
    if (features.length < FALLBACK_PAGE) break;
    startIndex += features.length;
    console.log('  paged ' + startIndex + ' features, ' + out.size + ' NVCL so far...');
  }
  return Array.from(out.values());
}

function addFeature(map, f) {
  const p = f.properties || {};
  const identifier = p.identifier || '';
  const id = identifier ? identifier.replace(/\/+$/, '').split('/').pop() : '';
  if (!id) return;
  const coords = (f.geometry && f.geometry.coordinates) || [];
  const lng = num(coords[0]), lat = num(coords[1]);
  if (lat === null || lng === null || (lat === 0 && lng === 0)) return;
  map.set(id, {
    id: id,
    name: p.name || id,
    lat: lat, lng: lng,
    lengthM: num(p.boreholeLength_m),
    custodian: p.boreholeMaterialCustodian || '',
    datasets: [],
  });
}

// Minimal GML fallback for servers that ignore outputFormat=application/json.
// Enough structure to keep a node alive, not a general GML parser.
function parseWfsXml(text) {
  const features = [];
  const blocks = text.match(/<gsmlp:BoreholeView[\s\S]*?<\/gsmlp:BoreholeView>/g) || [];
  blocks.forEach(function(b) {
    if (!/<gsmlp:nvclCollection>\s*true\s*</.test(b)) return;
    const pos = tag(b, 'gml:pos').split(/\s+/).map(Number);
    // GML 3.2 EPSG:4326 axis order is lat lng; swap if it looks reversed.
    let lat = pos[0], lng = pos[1];
    if (lat > 90 || lat < -90) { lat = pos[1]; lng = pos[0]; }
    features.push({
      properties: {
        identifier: tag(b, 'gsmlp:identifier'),
        name: tag(b, 'gsmlp:name'),
        boreholeLength_m: tag(b, 'gsmlp:boreholeLength_m') || null,
        boreholeMaterialCustodian: tag(b, 'gsmlp:boreholeMaterialCustodian'),
        nvclCollection: 'true',
      },
      geometry: { coordinates: [lng, lat] },
    });
  });
  return features;
}

// ── Dataset collection parsing ────────────────────────────────────

async function fetchDatasets(node, boreholeId) {
  const url = node.nvcl + '/getDatasetCollection.html?holeidentifier='
    + encodeURIComponent(boreholeId);
  const xml = await fetchText(url, DS_TIMEOUT_MS);
  const datasets = [];
  const blocks = xml.match(/<Dataset>[\s\S]*?<\/Dataset>/g) || [];
  blocks.forEach(function(b) {
    const desc = unescapeXml(tag(b, 'description'));
    const range = b.match(/<DepthRange>[\s\S]*?<\/DepthRange>/);
    const ds = {
      id: tag(b, 'DatasetID'),
      name: tag(b, 'DatasetName'),
      created: dateOnly(tag(b, 'createdDate')),
      instrument: canonicalInstrument(tag(desc, 'InstrumentName')),
      scanDate: dateOnly(tag(desc, 'ScanDate')) || null,
      depthStart: range ? num(tag(range[0], 'start')) : null,
      depthEnd: range ? num(tag(range[0], 'end')) : null,
      // TIR marker: a tirq spectrum element, or 'TIR' in any log name —
      // the same detection rule the retired deep pipeline used.
      tir: /<tirq>/.test(b) || /<logName>[^<]*tir/i.test(b),
    };
    // Effective date: TSG ScanDate when recorded, else system createdDate.
    ds.date = ds.scanDate || ds.created || null;
    datasets.push(ds);
  });
  return datasets;
}

// Canonicalise messy TSG instrument names: trim, collapse whitespace, and
// normalise HyLogger/HyChips version-unit forms ('Hylogger3-2', 'HyLogger 3.2'
// -> 'HyLogger 3-2'). Anything blank or NA-ish lands in the Unknown bucket.
function canonicalInstrument(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!s || /^(na|unknown|na or unknown|none)$/i.test(s)) return 'Unknown';
  const m = s.match(/^(hylogger|hychips)s?\s*(\d+)\s*[-. ]?\s*(\d+)?$/i);
  if (m) {
    const kind = m[1].toLowerCase() === 'hychips' ? 'HyChips' : 'HyLogger';
    return kind + ' ' + m[2] + (m[3] ? '-' + m[3] : '');
  }
  return s;
}

// ── Metrics (the merged methodology) ──────────────────────────────

// Per-borehole scan metrics from its datasets' depth intervals.
//   valid interval: start & end present, end > start, and (end-start) within
//   CLAMP_FACTOR x drilled length when the drilled length is known.
//   uniqueM: union of valid intervals.  totalM: plain sum (rescans count).
//   unrecorded: datasets contributing zero because their interval is
//   missing or invalid — NEVER substituted with borehole length.
function boreholeMetrics(bh) {
  const intervals = [];
  let unrecorded = 0, clamped = 0;
  bh.datasets.forEach(function(ds) {
    if (ds.depthStart === null || ds.depthEnd === null || ds.depthEnd <= ds.depthStart) {
      unrecorded++;
      return;
    }
    const len = ds.depthEnd - ds.depthStart;
    if (bh.lengthM && bh.lengthM > 0 && len > bh.lengthM * CLAMP_FACTOR) {
      clamped++;
      unrecorded++;           // clamped intervals are a subtype of unrecorded
      return;
    }
    intervals.push([ds.depthStart, ds.depthEnd]);
  });

  let totalM = 0;
  intervals.forEach(function(iv) { totalM += iv[1] - iv[0]; });

  // Union: sort by start, merge overlapping/adjacent, sum survivor lengths.
  intervals.sort(function(a, b) { return a[0] - b[0]; });
  let uniqueM = 0, curStart = null, curEnd = null;
  intervals.forEach(function(iv) {
    if (curStart === null) { curStart = iv[0]; curEnd = iv[1]; return; }
    if (iv[0] <= curEnd) { if (iv[1] > curEnd) curEnd = iv[1]; return; }
    uniqueM += curEnd - curStart;
    curStart = iv[0]; curEnd = iv[1];
  });
  if (curStart !== null) uniqueM += curEnd - curStart;

  // Estimation tier (disclosed, never blended into measured figures):
  // when a borehole has datasets but NO valid intervals at all — i.e. its
  // node publishes none — estimate its scanned length as the drilled hole
  // length, ONCE per borehole (never per dataset; rescans must not inflate
  // an estimate). Reported separately as estimated_km.
  let estimatedM = 0;
  if (intervals.length === 0 && unrecorded > 0 && bh.lengthM && bh.lengthM > 0) {
    estimatedM = bh.lengthM;
  }

  return {
    uniqueM: uniqueM, totalM: totalM, estimatedM: estimatedM,
    unrecorded: unrecorded, clamped: clamped,
    intervalDatasets: intervals.length,
  };
}

// ── Aggregation ───────────────────────────────────────────────────

function aggregate(results, asOf) {
  const today = new Date(asOf + 'T00:00:00Z');
  const cutoff12mo = new Date(today.getTime() - 365 * 86400000).toISOString().substring(0, 10);

  const states = [];
  const instruments = {};   // canonical -> { datasets, boreholes:Set, m, first, last, states:Set }
  let sumDatasets = 0, sumBoreholesWithData = 0, sumUniqueM = 0, sumTotalM = 0;
  let sumUnrecorded = 0, sumClamped = 0, sumDrilledM = 0, sumWithInstrument = 0, sumTir = 0;
  let sumEstimatedM = 0, sumEstimatedBh = 0;
  let earliest = null, latest = null;
  let rescanBoreholes = 0, maxScans = 0;
  const participating = [], nonParticipating = [];
  let nonPartBoreholes = 0;

  results.forEach(function(r) {
    const node = r.node;
    if (!r.wfsOk) {
      states.push({
        state: node.code, status: 'unreachable',
        wfs_registered_boreholes: null, total_datasets: 0,
        total_boreholes_with_data: 0, total_km_scanned: 0,
        unique_scanned_km: 0, total_scan_km: 0, interval_unrecorded: 0,
        latest_dataset_date: null, days_since_latest: null,
        datasets_last_12mo: 0, km_scanned_last_12mo: 0,
        note: 'Node did not answer during this harvest. Figures from this node are absent, not zero.',
      });
      return;
    }

    let stDatasets = 0, stWithData = 0, stUniqueM = 0, stTotalM = 0;
    let stEstimatedM = 0, stEstimatedBh = 0;
    let stUnrecorded = 0, stClamped = 0, stLatest = null;
    let st12moDatasets = 0, st12moM = 0;

    r.boreholes.forEach(function(bh) {
      if (!bh.datasets.length) return;
      stWithData++;
      stDatasets += bh.datasets.length;
      if (bh.lengthM && bh.lengthM > 0) sumDrilledM += bh.lengthM;

      const m = boreholeMetrics(bh);
      bh.metrics = m;
      stUniqueM += m.uniqueM;
      stTotalM += m.totalM;
      if (m.estimatedM > 0) { stEstimatedM += m.estimatedM; stEstimatedBh++; }
      stUnrecorded += m.unrecorded;
      stClamped += m.clamped;
      if (m.intervalDatasets > 1) rescanBoreholes++;
      if (m.intervalDatasets > maxScans) maxScans = m.intervalDatasets;

      bh.datasets.forEach(function(ds) {
        if (ds.instrument !== 'Unknown') sumWithInstrument++;
        if (ds.tir) sumTir++;
        if (ds.date) {
          if (!earliest || ds.date < earliest) earliest = ds.date;
          if (!latest || ds.date > latest) latest = ds.date;
          if (!stLatest || ds.date > stLatest) stLatest = ds.date;
          if (ds.date >= cutoff12mo) {
            st12moDatasets++;
            if (ds.depthStart !== null && ds.depthEnd !== null && ds.depthEnd > ds.depthStart) {
              st12moM += ds.depthEnd - ds.depthStart;
            }
          }
        }
        // Instrument roll-up (valid interval lengths only — zero substitution)
        const inst = instruments[ds.instrument] || (instruments[ds.instrument] = {
          datasets: 0, boreholes: new Set(), m: 0, first: null, last: null, states: new Set(),
        });
        inst.datasets++;
        inst.boreholes.add(node.code + '/' + bh.id);
        if (ds.depthStart !== null && ds.depthEnd !== null && ds.depthEnd > ds.depthStart
          && !(bh.lengthM && bh.lengthM > 0 && (ds.depthEnd - ds.depthStart) > bh.lengthM * CLAMP_FACTOR)) {
          inst.m += ds.depthEnd - ds.depthStart;
        }
        if (ds.date) {
          if (!inst.first || ds.date < inst.first) inst.first = ds.date;
          if (!inst.last || ds.date > inst.last) inst.last = ds.date;
        }
        inst.states.add(node.code);
      });
    });

    sumDatasets += stDatasets;
    sumBoreholesWithData += stWithData;
    sumUniqueM += stUniqueM;
    sumTotalM += stTotalM;
    sumEstimatedM += stEstimatedM;
    sumEstimatedBh += stEstimatedBh;
    sumUnrecorded += stUnrecorded;
    sumClamped += stClamped;

    const isParticipating = stDatasets > 0;
    if (isParticipating) participating.push(node.code);
    else { nonParticipating.push(node.code); nonPartBoreholes += r.wfsCount; }

    const entry = {
      state: node.code,
      status: isParticipating ? 'participating' : 'non_participating',
      wfs_registered_boreholes: r.wfsCount,
      total_datasets: stDatasets,
      total_boreholes_with_data: stWithData,
      total_km_scanned: km(stUniqueM),          // page-compat alias of unique
      unique_scanned_km: km(stUniqueM),
      total_scan_km: km(stTotalM),
      estimated_km: km(stEstimatedM),
      estimated_boreholes: stEstimatedBh,
      interval_unrecorded: stUnrecorded,
      interval_clamped: stClamped,
      latest_dataset_date: stLatest,
      days_since_latest: stLatest ? Math.max(0, Math.round((today - new Date(stLatest + 'T00:00:00Z')) / 86400000)) : null,
      datasets_last_12mo: st12moDatasets,
      km_scanned_last_12mo: km(st12moM),
    };
    if (node.note && !isParticipating) entry.note = node.note;
    if (r.fetchFailures) entry.dataset_fetch_failures = r.fetchFailures;
    states.push(entry);
  });

  // Instrument table, largest first (Unknown bucket kept — it is honest).
  const instrumentList = Object.keys(instruments).map(function(name) {
    const i = instruments[name];
    const years = (i.first && i.last)
      ? Math.round((new Date(i.last) - new Date(i.first)) / 86400000 / 365.25 * 100) / 100
      : 0;
    return {
      instrument_canonical: name,
      datasets: i.datasets,
      boreholes: i.boreholes.size,
      km_scanned: km(i.m),
      first_use: i.first,
      last_use: i.last,
      states_used: Array.from(i.states).sort(),
      service_years: years,
      km_per_year: years > 0 ? Math.round(km(i.m) / years * 100) / 100 : null,
    };
  }).sort(function(a, b) { return b.km_scanned - a.km_scanned; });

  const endpoints = {};
  NODES.forEach(function(n) {
    endpoints[n.code] = {
      name: n.name,
      wfs: n.wfs,
      nvcl: n.nvcl,
      hits_url: n.wfs + '?service=WFS&version=2.0.0&request=GetFeature'
        + '&typeName=gsmlp:BoreholeView&resultType=hits'
        + '&CQL_FILTER=nvclCollection=%27true%27',
    };
  });

  return {
    as_of: asOf,
    method: 'merged-v1',
    source: 'src/nvcl/harvest.js — live harvest of all public NVCL node services (see src/nvcl/METHODOLOGY.md)',
    summary: {
      total_datasets: sumDatasets,
      total_boreholes_with_data: sumBoreholesWithData,
      // total_scanned_km is kept as an ALIAS of unique_scanned_km so the
      // existing page keeps working; unique_scanned_km is the real name.
      total_scanned_km: km(sumUniqueM),
      total_scanned_km_note: 'alias of unique_scanned_km (union of per-dataset scan intervals per borehole)',
      unique_scanned_km: km(sumUniqueM),
      total_scan_km: km(sumTotalM),
      // Estimation tier — DISCLOSED, never blended: boreholes whose node
      // publishes no intervals at all, estimated once each at drilled length.
      estimated_km: km(sumEstimatedM),
      estimated_boreholes: sumEstimatedBh,
      combined_estimate_km: km(sumUniqueM + sumEstimatedM),
      interval_unrecorded_datasets: sumUnrecorded,
      interval_clamped_datasets: sumClamped,
      total_borehole_drilled_km: km(sumDrilledM),
      datasets_with_instrument_data: sumWithInstrument,
      participating_nodes: participating.sort(),
      participating_node_count: participating.length,
      non_participating_jurisdictions: nonParticipating.sort(),
      non_participating_borehole_count: nonPartBoreholes,
      date_range: { earliest_scan: earliest, latest_scan: latest },
      rescan_stats: {
        boreholes_with_multiple_scans: rescanBoreholes,
        max_scans_one_borehole: maxScans,
      },
      tir_stats: {
        tir_datasets: sumTir,
        tir_pct_of_total: sumDatasets ? Math.round(sumTir / sumDatasets * 1000) / 10 : null,
      },
    },
    states: states.sort(function(a, b) { return a.state < b.state ? -1 : 1; }),
    instruments: instrumentList,
    endpoints: endpoints,
  };
}

// Compact dot array for the page map: [lat, lng, stateIdx, 'YYYY-MM', depth_m].
// One dot per borehole WITH data; depth is the union (unique) metres.
function buildDotArray(results) {
  const order = NODES.map(function(n) { return n.code; });
  const dots = [];
  results.forEach(function(r) {
    const idx = order.indexOf(r.node.code);
    r.boreholes.forEach(function(bh) {
      if (!bh.datasets.length) return;
      let month = '';
      bh.datasets.forEach(function(ds) {
        if (ds.date && (!month || ds.date.substring(0, 7) < month)) month = ds.date.substring(0, 7);
      });
      const uniqueM = bh.metrics ? bh.metrics.uniqueM : 0;
      dots.push([
        Math.round(bh.lat * 1000) / 1000,
        Math.round(bh.lng * 1000) / 1000,
        idx,
        month,
        Math.round(uniqueM * 10) / 10,
      ]);
    });
  });
  return dots;
}

function printSummary(s) {
  const sm = s.summary;
  console.log('\n=== NATIONAL SUMMARY (' + s.as_of + ') ===');
  console.log('Boreholes with data:  ' + sm.total_boreholes_with_data);
  console.log('Datasets:             ' + sm.total_datasets);
  console.log('Unique scanned:       ' + sm.unique_scanned_km + ' km (union of intervals)');
  console.log('Estimated (no API):   ' + sm.estimated_km + ' km across ' + sm.estimated_boreholes + ' boreholes (drilled-length estimate, disclosed)');
  console.log('Combined estimate:    ' + sm.combined_estimate_km + ' km (measured + estimated)');
  console.log('Total scan work:      ' + sm.total_scan_km + ' km (rescans counted)');
  console.log('Interval unrecorded:  ' + sm.interval_unrecorded_datasets
    + ' datasets (' + sm.interval_clamped_datasets + ' clamped as garbage)');
  console.log('Drilled length:       ' + sm.total_borehole_drilled_km + ' km');
  console.log('Rescanned boreholes:  ' + sm.rescan_stats.boreholes_with_multiple_scans
    + ' (max ' + sm.rescan_stats.max_scans_one_borehole + ' scans)');
  s.states.forEach(function(st) {
    console.log('  ' + st.state + ': ' + st.total_boreholes_with_data + ' bh, '
      + st.total_datasets + ' ds, ' + st.unique_scanned_km + ' km unique / '
      + st.total_scan_km + ' km total, ' + st.interval_unrecorded + ' unrecorded ['
      + st.status + ']');
  });
}

// ── Plumbing ──────────────────────────────────────────────────────

async function fetchText(url, timeoutMs, opts) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);
    const controller = new AbortController();
    const timer = setTimeout(function() { controller.abort(); }, timeoutMs);
    try {
      const init = Object.assign({ headers: {} }, opts || {});
      init.headers = Object.assign({ 'User-Agent': USER_AGENT }, init.headers);
      init.signal = controller.signal;
      const resp = await fetch(url, init);
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new Error('HTTP ' + resp.status);
        continue;                              // polite retry
      }
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.text();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error('timeout after ' + timeoutMs + 'ms') : e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('fetch failed');
}

function tag(xml, name) {
  const m = String(xml).match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>'));
  return m ? m[1].trim() : '';
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function dateOnly(s) {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function km(metres) {
  return Math.round(metres / 1000 * 100) / 100;
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { /* fall through */ }
  return fallback;
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

run().catch(function(err) {
  console.error('Harvest failed: ' + err.message);
  process.exit(1);
});
