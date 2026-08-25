#!/usr/bin/env node
/**
 * AuScope DOI Tracker — AusMT run-level deployment harvest
 *
 * The MT deployment register's SOLE source of truth is AusMT's per-station
 * runs metadata (https://ausmt.auscope.org.au/data/products/<survey>/<station>/station.json):
 * second-precision acquisition windows naming each recorder and magnetic
 * coil by DOI and serial. The instrument registry's field-survey records
 * are deliberately NOT used for deployment accounting.
 *
 * Writes data/ausmt-runs.json:
 *   metadata  — build_id sentinel, counts, per-survey runs status
 *   occupations — one row per instrument × station occupation
 *
 * Gated on the portal's build.json build_id: when the portal has not
 * rebuilt since the last harvest, this is a single 300-byte request.
 * Fail-soft: portal unreachable → keep the existing file, exit 0.
 *
 * Usage: node src/ausmt-inventory.js [--force]
 */

const fs = require('fs');
const path = require('path');
const { sleep } = require('./utils');

const BASE = 'https://ausmt.auscope.org.au/data/';
const OUT_FILE = path.join(__dirname, '..', 'data', 'ausmt-runs.json');
const FEED_FILE = path.join(__dirname, '..', 'docs', 'ausmt-data.json');
const FORCE = process.argv.includes('--force');

// AuScope-funded scope filter: which registry units carry AuScope in
// fundingReferences. Two DataCite pages; degrades to null (no filter tags).
async function fetchAuScopeFunded() {
  const funded = {};
  try {
    for (let page = 1; page <= 5; page++) {
      const j = await getJson('https://api.datacite.org/dois?client-id=auscope.repo3&page[size]=100&page[number]=' + page);
      const rows = j.data || [];
      rows.forEach(function (d) {
        const a = d.attributes || {};
        if ((a.fundingReferences || []).some(function (f) { return /auscope/i.test(f.funderName || ''); })) {
          funded[String(a.doi || '').toLowerCase()] = true;
        }
      });
      if (rows.length < 100) break;
      await sleep(300);
    }
    return funded;
  } catch (e) {
    console.warn('Registry funding fetch failed (' + e.message + ') — occupations will carry no scope tags.');
    return null;
  }
}

async function getJson(url) {
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + url);
  return resp.json();
}

// A survey counts as run-populated when its runs carry instrument
// identifiers — the scaffolded AusLAMP surveys have runs blocks with
// placeholder times and no identifiers.
function runInstruments(run) {
  const found = [];
  const dl = run.data_logger || {};
  if ((dl.identifiers || []).length) {
    found.push({ role: 'recorder', component: null, model: dl.model || null,
      serial: dl.serial_number || null, doi: dl.identifiers[0].identifier });
  }
  (run.channels || []).forEach(function (ch) {
    const s = ch.sensor || {};
    if ((s.identifiers || []).length) {
      found.push({ role: 'sensor', component: ch.component || null, model: s.model || null,
        serial: s.serial_number || null, doi: s.identifiers[0].identifier });
    }
  });
  return found;
}

async function run() {
  console.log('AusMT Run-Level Deployment Harvest');
  console.log('==================================\n');

  const existing = fs.existsSync(OUT_FILE)
    ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : null;

  let build;
  try {
    build = await getJson(BASE + 'build.json');
  } catch (err) {
    console.warn('AusMT unreachable (' + err.message + ') — keeping existing snapshot.');
    process.exit(0);
  }
  if (!FORCE && existing && existing.metadata && existing.metadata.build_id === build.build_id) {
    console.log('Portal build unchanged (' + build.build_id + ') — nothing to do.');
    process.exit(0);
  }

  const mtcat = await getJson(BASE + 'mtcat.json');
  const bySurvey = {};
  (mtcat.stations || []).forEach(function (st) {
    const stn = String(st.station_id || '').split('.').pop();
    (bySurvey[st.survey_id] = bySurvey[st.survey_id] || []).push(stn);
  });
  const surveyMeta = {};
  (mtcat.surveys || []).forEach(function (s) {
    surveyMeta[s.survey_id] = {
      title: s.title || s.survey_id,
      organisation: s.organisation || null,
      year_start: s.year_start || null,
      year_end: s.year_end || null,
      n_stations: s.n_stations || null,
    };
  });
  // Station coordinates ("<survey_id>/<station>" -> [lat, lon]) — feeds the
  // per-instrument mini maps on mt-deployments.html. Only stations that end
  // up in occupations are kept (filtered before writing).
  const stationCoords = {};
  (mtcat.stations || []).forEach(function (st) {
    const stn = String(st.station_id || '').split('.').pop();
    if (st.latitude != null && st.longitude != null) {
      stationCoords[st.survey_id + '/' + stn] =
        [Math.round(st.latitude * 1e5) / 1e5, Math.round(st.longitude * 1e5) / 1e5];
    }
  });
  const funded = await fetchAuScopeFunded();

  const occupations = [];
  const surveyStatus = {};
  const surveyIds = Object.keys(bySurvey);
  for (const survey of surveyIds) {
    const stations = bySurvey[survey];
    // Probe up to three spread stations (first, middle, last) to decide
    // whether this survey's runs are populated — a single-station probe
    // would misclassify a survey whose first station happens to lack runs
    // while the rest carry them.
    const probeIdx = stations.length >= 3
      ? [0, Math.floor(stations.length / 2), stations.length - 1]
      : stations.map(function (_, i) { return i; });
    let populated = false, sawRuns = false;
    for (const pi of probeIdx) {
      let probe = null;
      try {
        probe = await getJson(BASE + 'products/' + survey + '/' + encodeURIComponent(stations[pi]) + '/station.json');
      } catch (e) { /* treated as no runs at this station */ }
      await sleep(150);
      const probeRuns = (probe && probe.runs) || [];
      if (probeRuns.length) sawRuns = true;
      if (probeRuns.some(function (r) { return runInstruments(r).length > 0; })) {
        populated = true;
        break;
      }
    }
    if (!populated) {
      surveyStatus[survey] = sawRuns ? 'scaffolded' : 'none';
      continue;
    }
    console.log(survey + ': runs populated — harvesting ' + stations.length + ' stations');
    let ok = 0;
    for (const stn of stations) {
      try {
        const j = await getJson(BASE + 'products/' + survey + '/' + encodeURIComponent(stn) + '/station.json');
        (j.runs || []).forEach(function (r) {
          const tp = r.time_period || {};
          const hours = tp.start && tp.end
            ? Math.round((Date.parse(tp.end) - Date.parse(tp.start)) / 36000) / 100 : null;
          runInstruments(r).forEach(function (inst) {
            occupations.push({
              survey: survey, station: stn, run: r.id || null,
              start: tp.start || null, end: tp.end || null, hours: hours,
              role: inst.role, component: inst.component,
              model: inst.model, serial: inst.serial, doi: inst.doi,
              // AuScope-funded scope tag (null when registry fetch failed)
              af: funded ? !!funded[String(inst.doi || '').toLowerCase()] : null,
            });
          });
        });
        ok++;
      } catch (e) {
        console.warn('  ' + stn + ' failed: ' + e.message);
      }
      await sleep(150);
    }
    surveyStatus[survey] = 'populated';
    console.log('  ' + ok + '/' + stations.length + ' stations harvested');
  }

  const instruments = {};
  let totalHours = 0;
  occupations.forEach(function (o) {
    if (o.doi) instruments[o.doi.toLowerCase()] = true;
    totalHours += o.hours || 0;
  });
  const populatedCount = Object.values(surveyStatus).filter(function (s) { return s === 'populated'; }).length;

  // AuScope-funded rollup (the register's headline scope)
  const afInst = {};
  let afHours = 0, afOcc = 0;
  occupations.forEach(function (o) {
    if (o.af !== true) return;
    afInst[o.doi.toLowerCase()] = true;
    afHours += o.hours || 0;
    afOcc++;
  });

  const surveys = surveyIds.map(function (id) {
    const m = surveyMeta[id] || {};
    return {
      id: id, title: m.title || id, organisation: m.organisation,
      year_start: m.year_start, year_end: m.year_end, n_stations: m.n_stations,
      runs: surveyStatus[id],
    };
  });

  const out = {
    metadata: {
      type: 'ausmt-runs',
      source: 'ausmt.auscope.org.au per-station station.json runs',
      build_id: build.build_id,
      generated: build.generated || null,
      fetched: new Date().toISOString(),
      surveys_total: surveyIds.length,
      surveys_populated: populatedCount,
      survey_status: surveyStatus,
      instruments: Object.keys(instruments).length,
      occupations: occupations.length,
      recording_hours: Math.round(totalHours),
      recording_days: Math.round(totalHours / 24 * 10) / 10,
      scope_tagged: funded !== null,
      auscope_instruments: funded !== null ? Object.keys(afInst).length : null,
      auscope_occupations: funded !== null ? afOcc : null,
      auscope_recording_days: funded !== null ? Math.round(afHours / 24 * 10) / 10 : null,
    },
    surveys: surveys,
    stations: (function () {
      const used = {};
      occupations.forEach(function (o) {
        const key = o.survey + '/' + o.station;
        if (stationCoords[key]) used[key] = stationCoords[key];
      });
      return used;
    })(),
    occupations: occupations,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  // Same-origin page feed for docs/mt-deployments.html (identical payload,
  // compact serialisation).
  fs.writeFileSync(FEED_FILE, JSON.stringify(out));
  console.log('\nSaved ' + OUT_FILE + ' + ' + FEED_FILE);
  console.log(out.metadata.instruments + ' instruments (' +
    (out.metadata.auscope_instruments != null ? out.metadata.auscope_instruments + ' AuScope-funded' : 'untagged')
    + '), ' + out.metadata.occupations + ' occupations, ' + out.metadata.recording_days
    + ' recording-days across ' + populatedCount + '/' + surveyIds.length + ' surveys with populated runs.');
}

run().catch(function (err) { console.error('Fatal: ' + err.message); process.exit(1); });
