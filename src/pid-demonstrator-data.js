#!/usr/bin/env node
/**
 * AuScope DOI Tracker — PID demonstrator feed
 *
 * Joins four sources into one feed for the "Instrument PIDs in practice"
 * page: follow one instrument DOI to the surveys it recorded, the dataset
 * DOIs those surveys published, and the papers that describe them.
 *
 *   data/ausmt-runs.json   occupations, station coordinates, survey status
 *                          (written by src/ausmt-inventory.js — NOT re-run here)
 *   AusMT mtcat.json       survey titles + survey-level related_identifiers
 *   AusMT station.json     ONE per populated survey: resources[] dataset DOIs
 *   DataCite auscope.repo3 the instrument registry (units + survey records)
 *   data/publications.json paper metadata for the registry's IsDescribedBy
 *
 * Cost: build.json + mtcat.json + one station.json per populated survey
 * (27 today) + 2 DataCite pages — about 31 requests, under three minutes.
 *
 * Writes docs/pid-demonstrator-data.json (page feed) and
 * data/pid-demonstrator-data.json (identical copy). Any fetch failure or
 * malformed response → log, keep the previous files, exit 0. A partial feed
 * is never written; both files are written via temp file + rename.
 *
 * Usage: node src/pid-demonstrator-data.js
 */

const fs = require('fs');
const path = require('path');
const { fetchJSON, sleep, normaliseDoi } = require('./utils');

const AUSMT = 'https://ausmt.auscope.org.au/data/';
const DATACITE_CLIENT = 'auscope.repo3';
const DATACITE_FIRST = 'https://api.datacite.org/dois?client-id=' + DATACITE_CLIENT + '&page[size]=100';
const ROOT = path.join(__dirname, '..');
const RUNS_FILE = path.join(ROOT, 'data', 'ausmt-runs.json');
const PUBS_FILE = path.join(ROOT, 'data', 'publications.json');
const OUT_FILES = [
  path.join(ROOT, 'docs', 'pid-demonstrator-data.json'),
  path.join(ROOT, 'data', 'pid-demonstrator-data.json'),
];

// Dataset-DOI classification rule (from inspecting station.json and mtcat.json):
// every related_collection_identifiers entry in a station.json resource — and
// every mtcat survey related_identifiers entry — carries an explicit
// `identifies` field naming what the DOI points at. Observed values:
// 'collection' (the NCI survey collection), 'raw_packed' (packed raw time
// series archive), 'level2' (processed level-2 product), 'level3', 'entire'.
//   identifies === 'collection'      → 'collection'
//   identifies starts with 'raw'     → 'raw'
//   identifies === 'level2'          → 'level2'
//   anything else ('entire', 'level3', …) → 'other'
// When `identifies` is absent the owning resource decides: a resource whose
// id names raw data ('ts-raw_packed') or whose processing_level is 'raw'
// → 'raw'; otherwise 'other'. No DOI is ever guessed into 'collection'.
function classify(identifies, resource) {
  const v = String(identifies || '').toLowerCase();
  if (v === 'collection') return 'collection';
  if (/^raw/.test(v)) return 'raw';
  if (v === 'level2') return 'level2';
  if (v) return 'other';
  if (resource && (/raw/i.test(String(resource.id || '')) || resource.processing_level === 'raw')) return 'raw';
  return 'other';
}
const IDENTIFIES_ORDER = { collection: 0, raw: 1, level2: 2, other: 3 };

function isoDay(ts) {
  const t = Date.parse(ts);
  return isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function mostCommon(values) {
  const n = {};
  let best = null;
  values.forEach(function (v) {
    if (v == null || v === '') return;
    n[v] = (n[v] || 0) + 1;
    if (best === null || n[v] > n[best]) best = v;
  });
  return best;
}

function relatedDois(attrs, relation) {
  return (attrs.relatedIdentifiers || [])
    .filter(function (r) { return r.relationType === relation; })
    .map(function (r) { return normaliseDoi(r.relatedIdentifier); })
    .filter(function (d) { return /^10\./.test(d); });
}

// "YYYY-MM-DD/YYYY-MM-DD" (or a single date) → [start, end] day strings.
function coverage(attrs) {
  const c = (attrs.dates || []).find(function (d) { return d.dateType === 'Coverage'; });
  if (!c || !c.date) return null;
  const parts = String(c.date).split('/');
  const a = isoDay(parts[0]);
  const b = isoDay(parts[1] || parts[0]);
  return a && b ? [a, b] : null;
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

async function fetchRequired(url, what, check) {
  const j = await fetchJSON(url, { headers: { Accept: 'application/json' }, retries: 3 });
  // fetchJSON resolves a 404 to {} — a missing source is a failure here.
  if (!j || !Object.keys(j).length || (check && !check(j))) {
    throw new Error(what + ' missing or malformed (' + url.split('?')[0] + ')');
  }
  return j;
}

async function fetchAll(populated, firstStation) {
  const build = await fetchRequired(AUSMT + 'build.json', 'AusMT build.json',
    function (j) { return !!j.build_id; });
  await sleep(150);
  const mtcat = await fetchRequired(AUSMT + 'mtcat.json', 'AusMT mtcat.json',
    function (j) { return Array.isArray(j.surveys); });

  const stationJson = {};
  for (const sv of populated) {
    await sleep(150);
    const stn = firstStation[sv];
    stationJson[sv] = await fetchRequired(
      AUSMT + 'products/' + sv + '/' + encodeURIComponent(stn) + '/station.json',
      'station.json ' + sv + '/' + stn);
  }

  const registry = [];
  let url = DATACITE_FIRST, total = null;
  for (let page = 0; url && page < 10; page++) {
    if (page) await sleep(300);
    const j = await fetchRequired(url, 'DataCite page ' + (page + 1),
      function (x) { return Array.isArray(x.data); });
    if (total === null) total = j.meta && j.meta.total;
    j.data.forEach(function (d) { registry.push(d.attributes || {}); });
    url = (j.links && j.links.next) || null;
  }
  if (url || (total != null && registry.length !== total)) {
    throw new Error('DataCite listing incomplete: got ' + registry.length + ' of ' + total);
  }
  return { build: build, mtcat: mtcat, stationJson: stationJson, registry: registry,
    registryFetched: new Date().toISOString() };
}

async function run() {
  console.log('PID Demonstrator Feed');
  console.log('=====================\n');

  const runs = JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8'));
  const occupations = runs.occupations || [];
  const status = (runs.metadata && runs.metadata.survey_status) || {};
  const populated = Object.keys(status).filter(function (k) { return status[k] === 'populated'; });
  if (!occupations.length || !populated.length) {
    console.warn('data/ausmt-runs.json has no populated occupations — keeping previous feed.');
    process.exit(0);
  }

  // First station with an occupation, per survey (harvest order = mtcat order).
  const firstStation = {};
  occupations.forEach(function (o) {
    if (!firstStation[o.survey]) firstStation[o.survey] = o.station;
  });

  let live;
  try {
    live = await fetchAll(populated, firstStation);
  } catch (err) {
    console.warn('Fetch failed (' + err.message + ') — keeping previous feed, nothing written.');
    process.exit(0);
  }
  if (live.build.build_id !== (runs.metadata && runs.metadata.build_id)) {
    console.warn('Note: live AusMT build ' + live.build.build_id + ' differs from the runs harvest build '
      + (runs.metadata && runs.metadata.build_id) + ' — occupations are from the older harvest.');
  }

  // ── Registry: units and survey records ────────────────────────────────
  // Every auscope.repo3 record is resourceTypeGeneral 'Instrument'. Survey
  // (deployment) records are the ones that list their member units with
  // HasPart; instrument units point upward with IsPartOf.
  const unitByDoi = {};
  const surveyRecords = {};
  live.registry.forEach(function (a) {
    const doi = normaliseDoi(a.doi);
    const hasPart = (a.relatedIdentifiers || []).some(function (r) { return r.relationType === 'HasPart'; });
    const title = ((a.titles || [])[0] || {}).title || null;
    if (hasPart) {
      surveyRecords[doi] = {
        title: title,
        collects: relatedDois(a, 'Collects'),
        described_by: relatedDois(a, 'IsDescribedBy'),
        coverage: coverage(a),
        members: {},
      };
    } else {
      const host = (a.contributors || []).find(function (c) { return c.contributorType === 'HostingInstitution'; });
      const publisher = typeof a.publisher === 'object' && a.publisher ? a.publisher.name : a.publisher;
      unitByDoi[doi] = {
        is_part_of: relatedDois(a, 'IsPartOf'),
        registry_title: title,
        owner: (host && host.name) || publisher || null,
      };
    }
  });
  Object.keys(unitByDoi).forEach(function (u) {
    unitByDoi[u].is_part_of.forEach(function (sr) {
      if (surveyRecords[sr]) surveyRecords[sr].members[u] = true;
    });
  });

  // ── Instruments ───────────────────────────────────────────────────────
  const byInst = {};
  occupations.forEach(function (o) {
    const k = normaliseDoi(o.doi);
    if (!k) return;
    const r = byInst[k] = byInst[k] || { occ: [], stations: {}, svFirst: {}, hours: 0, undated: 0 };
    r.occ.push(o);
    // Station and survey counts come from the same DATED set, so the tiles,
    // the stop list and the map agree. cariewerloo-2012 publishes 37 runs
    // with no time period; they are counted separately as n_undated so the
    // page can say so rather than silently dropping them.
    if (!o.start) { r.undated++; return; }
    r.stations[o.survey + '/' + o.station] = true;
    r.hours += o.hours || 0;
    if (!r.svFirst[o.survey] || o.start < r.svFirst[o.survey]) r.svFirst[o.survey] = o.start;
  });
  let unregistered = 0;
  const instruments = Object.keys(byInst).map(function (doi) {
    const r = byInst[doi];
    const starts = r.occ.map(function (o) { return o.start; }).filter(Boolean).sort();
    const ends = r.occ.map(function (o) { return o.end; }).filter(Boolean).sort();
    const afVals = r.occ.map(function (o) { return o.af; });
    const reg = unitByDoi[doi];
    if (!reg) unregistered++;
    return {
      doi: doi,
      model: mostCommon(r.occ.map(function (o) { return o.model; })),
      serial: mostCommon(r.occ.map(function (o) { return o.serial; })),
      role: mostCommon(r.occ.map(function (o) { return o.role; })),
      af: afVals.some(function (v) { return v === true; }) ? true
        : afVals.every(function (v) { return v === null || v === undefined; }) ? null : false,
      first: starts.length ? isoDay(starts[0]) : null,
      last: ends.length ? isoDay(ends[ends.length - 1]) : null,
      hours: Math.round(r.hours * 100) / 100,
      n_undated: r.undated,
      n_stations: Object.keys(r.stations).length,
      surveys: Object.keys(r.svFirst).sort(function (a, b) {
        return r.svFirst[a] < r.svFirst[b] ? -1 : r.svFirst[a] > r.svFirst[b] ? 1 : 0;
      }),
      is_part_of: reg ? reg.is_part_of : [],
      registry_title: reg ? reg.registry_title : null,
      owner: reg ? reg.owner : null,
    };
  }).sort(function (a, b) { return b.hours - a.hours || (a.doi < b.doi ? -1 : 1); });

  // ── Survey → registry survey record ───────────────────────────────────
  // Majority vote over the IsPartOf of the units that occupied the survey,
  // with two guards, because a raw "most votes" count is wrong where the
  // same fleet moved between overlapping campaigns (all 38 Burra units are
  // also IsPartOf the Tumby Bay record, which then out-polls Burra's own):
  //   1. Coverage guard — a candidate record whose DataCite Coverage window
  //      does not overlap the survey's occupation window (first start →
  //      last end) is discarded. This is what stops pre-registry surveys
  //      (Capricorn 2010, Tasmania 2016) being claimed by later records.
  //   2. Fit — each surviving candidate scores votes / |survey units ∪
  //      record members| (Jaccard over unit DOIs). The best score wins only
  //      if its votes are a strict majority of the survey's units, its
  //      Jaccard is ≥ 0.5 and it is the unique best; otherwise null.
  // Cross-check: when both the record's Collects and the survey's AusMT
  // dataset DOIs exist they must intersect, else the match is dropped (null).
  const svUnits = {}, svWindow = {};
  occupations.forEach(function (o) {
    const u = normaliseDoi(o.doi);
    (svUnits[o.survey] = svUnits[o.survey] || {})[u] = true;
    const w = svWindow[o.survey] = svWindow[o.survey] || [null, null];
    const s = isoDay(o.start), e = isoDay(o.end);
    if (s && (!w[0] || s < w[0])) w[0] = s;
    if (e && (!w[1] || e > w[1])) w[1] = e;
  });

  function matchRegistry(sv, datasetDois) {
    const units = Object.keys(svUnits[sv] || {});
    const w = svWindow[sv];
    const votes = {};
    units.forEach(function (u) {
      ((unitByDoi[u] || {}).is_part_of || []).forEach(function (sr) {
        votes[sr] = (votes[sr] || 0) + 1;
      });
    });
    const scored = Object.keys(votes).filter(function (sr) {
      const rec = surveyRecords[sr];
      if (!rec) return false;
      if (rec.coverage && w[0] && w[1] && (rec.coverage[0] > w[1] || rec.coverage[1] < w[0])) return false;
      return true;
    }).map(function (sr) {
      const members = Object.keys(surveyRecords[sr].members);
      const union = {};
      units.forEach(function (u) { union[u] = true; });
      members.forEach(function (u) { union[u] = true; });
      return { sr: sr, votes: votes[sr], fit: votes[sr] / Object.keys(union).length };
    }).sort(function (a, b) { return b.fit - a.fit || b.votes - a.votes; });
    const best = scored[0];
    let pick = null, why;
    if (!best) why = 'no registry record overlaps ' + (w[0] || '?') + '..' + (w[1] || '?');
    else if (scored[1] && scored[1].fit === best.fit) why = 'tie ' + best.sr + '/' + scored[1].sr;
    else if (best.votes * 2 <= units.length) why = best.sr + ' votes ' + best.votes + '/' + units.length + ' not a majority';
    else if (best.fit < 0.5) why = best.sr + ' fit ' + best.fit.toFixed(2) + ' < 0.5';
    else {
      const collects = surveyRecords[best.sr].collects;
      if (collects.length && datasetDois.length
          && !collects.some(function (d) { return datasetDois.indexOf(d) !== -1; })) {
        why = best.sr + ' Collects ' + collects.join(',') + ' disjoint from AusMT dataset DOIs';
      } else {
        pick = best.sr;
        why = best.votes + '/' + units.length + ' units, fit ' + best.fit.toFixed(2)
          + (collects.length && datasetDois.length ? ', Collects agrees' : ', no Collects cross-check');
      }
    }
    console.log('  ' + sv + ' → ' + (pick || 'null') + '  (' + why + ')');
    return pick;
  }

  // ── Papers lookup ─────────────────────────────────────────────────────
  const pubsRaw = JSON.parse(fs.readFileSync(PUBS_FILE, 'utf8'));
  const pubs = {};
  (Array.isArray(pubsRaw) ? pubsRaw : (pubsRaw.records || [])).forEach(function (p) {
    const d = normaliseDoi(p.doi);
    if (d) pubs[d] = p;
  });

  // ── Surveys ───────────────────────────────────────────────────────────
  const mtcatSurvey = {};
  live.mtcat.surveys.forEach(function (s) { mtcatSurvey[s.survey_id] = s; });
  const runsSurvey = {};
  (runs.surveys || []).forEach(function (s) { runsSurvey[s.id] = s; });

  console.log('Survey → registry record:');
  const surveys = {};
  populated.forEach(function (sv) {
    const m = mtcatSurvey[sv] || {};
    const rs = runsSurvey[sv] || {};
    const mtcatRel = {};
    (m.related_identifiers || []).forEach(function (r) {
      if (r.identifier_type === 'DOI') mtcatRel[normaliseDoi(r.identifier)] = r;
    });

    // Dataset DOIs: the station.json resources first (in resource order),
    // then any survey-level mtcat DOI the sampled station did not carry.
    const seen = {};
    const datasets = [];
    function add(doi, identifies, resource) {
      const d = normaliseDoi(doi);
      if (!/^10\./.test(d) || seen[d]) return;
      seen[d] = true;
      const fromCat = mtcatRel[d];
      datasets.push({
        doi: d,
        identifies: classify(identifies || (fromCat && fromCat.identifies), resource),
        custodian: (fromCat && fromCat.custodian) || (resource && resource.repository) || null,
      });
    }
    (live.stationJson[sv].resources || []).forEach(function (res) {
      (res.related_collection_identifiers || []).forEach(function (rc) {
        if (String(rc.scheme || 'DOI').toUpperCase() === 'DOI') add(rc.identifier, rc.identifies, res);
      });
    });
    // A survey-level related identifier is a DATASET only when its relation
    // says so. mtcat also lists the literature about a survey (IsDocumentedBy
    // journal articles, ASEG abstracts); those were landing in dataset_dois as
    // "other" and the page then showed a 1970s paper as a data product.
    // Literature goes to the papers list instead (when the tracker knows it).
    const DATASET_RELATIONS = { IsPartOf: 1, IsDerivedFrom: 1, IsVariantFormOf: 1, HasPart: 1, IsSourceOf: 1, IsSupplementTo: 1 };
    const LITERATURE_RELATIONS = { IsDocumentedBy: 1, IsDescribedBy: 1, IsCitedBy: 1, IsReferencedBy: 1, References: 1, Cites: 1 };
    const literature = [];
    Object.keys(mtcatRel).forEach(function (d) {
      const rel = mtcatRel[d].relation || null;
      if (rel && LITERATURE_RELATIONS[rel]) { literature.push(d); return; }
      if (rel && !DATASET_RELATIONS[rel]) return;                 // unknown relation: not a dataset claim
      if (!rel && !/^10\.(25914|4225|26186)\//.test(d)) return;  // relation-less: only the known data repositories
      add(d, mtcatRel[d].identifies, null);
    });
    datasets.sort(function (a, b) { return IDENTIFIES_ORDER[a.identifies] - IDENTIFIES_ORDER[b.identifies]; });

    const registryDoi = matchRegistry(sv, datasets.map(function (x) { return x.doi; }));
    // Papers come from the registry survey record's IsDescribedBy, taken as
    // listed — with one documented exception. The Vulcan 2022 record also
    // lists an ambient-noise seismic tomography paper (the campaign co-located
    // seismic nodes with the MT array); it describes the seismic deployment,
    // not these MT instruments, and the demonstrator carries no seismic
    // content by decision. Dropped here and logged, so the feed never shows a
    // seismic paper under a magnetometer. Anything else the registry lists
    // is kept verbatim.
    const EXCLUDED_PAPERS = {
      '10.1080/08123985.2024.2371001': 'ambient-noise seismic tomography (Vulcan co-located nodes), not MT evidence',
    };
    const described = registryDoi ? surveyRecords[registryDoi].described_by.filter(function (d) {
      const why = EXCLUDED_PAPERS[normaliseDoi(d)];
      if (why) console.log('  ' + sv + ': dropped described-by ' + d + ' — ' + why);
      return !why;
    }) : [];
    // Literature mtcat lists for the survey joins the registry's list when the
    // tracker holds the record (title/year/cited); unknown DOIs are not
    // shown as bare strings.
    literature.forEach(function (d) {
      if (described.indexOf(d) === -1 && pubs[d] && !EXCLUDED_PAPERS[d]) described.push(d);
    });
    const papers = described.map(function (d) {
      const p = pubs[d];
      return {
        doi: d,
        title: p ? p.title || null : null,
        year: p ? p.year || null : null,
        cited: p && p.cited != null ? p.cited : null,
        journal: p ? p.journal || null : null,
      };
    });

    surveys[sv] = {
      title: m.title || rs.title || sv,
      organisation: m.organisation || rs.organisation || null,
      year_start: m.year_start || rs.year_start || null,
      year_end: m.year_end || rs.year_end || null,
      n_stations: m.n_stations || rs.n_stations || null,
      runs: status[sv],
      registry_doi: registryDoi,
      dataset_dois: datasets,
      papers: papers,
    };
  });

  const out = {
    metadata: {
      type: 'pid-demonstrator',
      // build_id / generated are the portal build the OCCUPATIONS came from —
      // the last ausmt-inventory.js harvest — because that is what the page
      // attributes ("Deployments from AusMT release …"). Stamping the live
      // build here made a 13 Sep harvest claim a 28 Sep release and silenced
      // the page's "a newer release is not yet indexed" line.
      build_id: runs.metadata.build_id || null,
      generated: runs.metadata.generated || null,
      fetched: new Date().toISOString(),
      surveys_total: runs.metadata.surveys_total,
      surveys_populated: runs.metadata.surveys_populated,
      registry_fetched: live.registryFetched,
      runs_fetched: runs.metadata.fetched || null,
      // The portal build seen at feed time. When it is newer than build_id
      // the harvest is trailing it and the page says so.
      live_build_id: live.build.build_id,
      live_generated: live.build.generated || null,
      sources: {
        mtcat: AUSMT + 'mtcat.json',
        station_json: AUSMT + 'products/<survey>/<station>/station.json',
        datacite_client: DATACITE_CLIENT,
      },
    },
    instruments: instruments,
    surveys: surveys,
    stations: runs.stations || {},
    occupations: occupations.map(function (o) {
      return { survey: o.survey, station: o.station, run: o.run, start: o.start, end: o.end,
        hours: o.hours, role: o.role, component: o.component, model: o.model,
        serial: o.serial, doi: normaliseDoi(o.doi), af: o.af };
    }),
  };

  const text = JSON.stringify(out, null, 1);
  // Two timestamps change on every run even when nothing else did; writing
  // them would commit ~1.6 MB of identical feed to git history every week.
  // Compare with those two keys blanked and skip the write when nothing
  // substantive moved.
  function stable(obj) {
    const m = Object.assign({}, obj.metadata, { fetched: null, registry_fetched: null });
    return JSON.stringify(Object.assign({}, obj, { metadata: m }));
  }
  let unchanged = false;
  try {
    const prev = JSON.parse(fs.readFileSync(OUT_FILES[0], 'utf8'));
    unchanged = stable(prev) === stable(out);
  } catch (e) { /* no previous feed, or unreadable: write */ }
  if (unchanged) {
    console.log('\nFeed unchanged apart from timestamps — not rewritten.');
  } else {
    OUT_FILES.forEach(function (f) { writeAtomic(f, text); });
    console.log('\nSaved ' + OUT_FILES.join(' + ') + ' (' + Math.round(text.length / 1024) + ' KB)');
  }
  console.log(instruments.length + ' instruments (' + unregistered + ' not in the registry), '
    + populated.length + ' surveys, ' + live.registry.length + ' registry records ('
    + Object.keys(surveyRecords).length + ' survey records), ' + occupations.length + ' occupations.');
}

run().catch(function (err) {
  // Anything unexpected after the fetches: nothing has been written yet
  // unless the final writes themselves failed. Exit 0 so CI keeps going.
  console.error('PID demonstrator feed failed: ' + err.message + ' — previous feed kept.');
  process.exit(0);
});
