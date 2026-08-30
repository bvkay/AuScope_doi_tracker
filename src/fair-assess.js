#!/usr/bin/env node
/**
 * AuScope DOI Tracker — F-UJI FAIR assessment
 *
 * Assesses dataset DOIs against a locally running F-UJI server
 * (https://github.com/pangaea-data-publisher/fuji) and stores the scores:
 *   data/fair-scores.json  — canonical store, keyed by normalised DOI
 *   docs/fair-scores.json  — slim same-origin feed for the platform pages
 *
 * Roster: data/datasets.json records with a DOI, excluding PhysicalObject
 * (sample records — F-UJI's metrics target data resources).
 *
 * Degrades to a no-op when the server is unreachable, so the step chain
 * never breaks (same philosophy as stats.js).
 *
 * Server: FUJI_SERVER env (default http://localhost:1071), HTTP Basic auth
 * FUJI_USER/FUJI_PASS (defaults are F-UJI's own documented dev credentials).
 * Pin FUJI_VERSION to the deployed release — the API self-reports 0.0.0
 * when pip-installed from a git tag.
 *
 * Usage: node src/fair-assess.js
 */

const fs = require('fs');
const path = require('path');
const { normaliseDoi, sleep } = require('./utils');

const DS_FILE = path.join(__dirname, '..', 'data', 'datasets.json');
const STORE_FILE = path.join(__dirname, '..', 'data', 'fair-scores.json');
const FEED_FILE = path.join(__dirname, '..', 'docs', 'fair-scores.json');
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'fair-history.jsonl');
const HISTORY_FEED = path.join(__dirname, '..', 'docs', 'fair-history.json');

const SERVER = process.env.FUJI_SERVER || 'http://localhost:1071';
const AUTH = 'Basic ' + Buffer.from(
  (process.env.FUJI_USER || 'marvel') + ':' + (process.env.FUJI_PASS || 'wonderwoman')
).toString('base64');
const FUJI_VERSION = process.env.FUJI_VERSION || '3.5.1';
const METRIC_VERSION = 'metrics_v0.8';
const SKIP_TYPES = ['PhysicalObject'];
const TIMEOUT_MS = 300000;
const MAX_ATTEMPTS = 3;

async function evaluate(doi) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(SERVER + '/fuji/api/v1/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: AUTH },
      body: JSON.stringify({
        object_identifier: 'https://doi.org/' + doi,
        test_debug: false,
        use_datacite: true,
        metric_version: METRIC_VERSION,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function extract(doi, platform, body) {
  const s = body.summary || {};
  const pct = s.score_percent || {};
  const round1 = v => (typeof v === 'number' ? Math.round(v * 10) / 10 : null);
  return {
    doi,
    platform,
    assessed: new Date().toISOString().slice(0, 10),
    score: round1(pct.FAIR),
    f: round1(pct.F), a: round1(pct.A), i: round1(pct.I), r: round1(pct.R),
    maturity: (s.maturity || {}).FAIR != null ? s.maturity.FAIR : null,
    passed: (s.status_passed || {}).FAIR != null ? s.status_passed.FAIR : null,
    total: (s.status_total || {}).FAIR != null ? s.status_total.FAIR : null,
    fuji_version: FUJI_VERSION,
    metric_version: String(body.metric_version || ''),
    // [metric id, earned, total, status, maturity] per metric
    checks: (body.results || []).map(r => [
      r.metric_identifier,
      (r.score || {}).earned != null ? r.score.earned : null,
      (r.score || {}).total != null ? r.score.total : null,
      r.test_status || null,
      r.maturity != null ? r.maturity : null,
    ]),
    attempts: 1,
    last_error: null,
  };
}

function metricNames(body) {
  const names = {};
  for (const r of body.results || []) names[r.metric_identifier] = r.metric_name || '';
  return names;
}

async function run() {
  console.log('AuScope FAIR Assessment (F-UJI)');
  console.log('===============================\n');

  // Health check — absent server degrades to a no-op.
  try {
    const res = await fetch(SERVER + '/fuji/api/v1/ui/', { headers: { Authorization: AUTH } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (err) {
    console.warn('F-UJI server unreachable at ' + SERVER + ' (' + err.message + ') — skipping FAIR assessment.');
    process.exit(0);
  }

  const dsData = JSON.parse(fs.readFileSync(DS_FILE, 'utf8'));
  const roster = (dsData.records || []).filter(r => r.doi && !SKIP_TYPES.includes(r.type));
  console.log('Roster: ' + roster.length + ' DOIs (of ' + (dsData.records || []).length + ' records)\n');

  let store = { metadata: {}, scores: {} };
  if (fs.existsSync(STORE_FILE)) {
    try { store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch (e) { /* fresh */ }
  }
  store.scores = store.scores || {};

  let names = store.metadata && store.metadata.metric_names ? store.metadata.metric_names : {};
  let ok = 0, failed = 0;

  for (let idx = 0; idx < roster.length; idx++) {
    const rec = roster[idx];
    const key = normaliseDoi(rec.doi);
    const prev = store.scores[key];
    const tag = '[' + (idx + 1) + '/' + roster.length + '] ' + key;
    if (prev && prev.last_error && (prev.attempts || 0) >= MAX_ATTEMPTS) {
      console.log(tag + ' — skipped (failed ' + prev.attempts + 'x)');
      continue;
    }
    try {
      const t0 = Date.now();
      const body = await evaluate(key);
      const entry = extract(key, rec.platform, body);
      if (entry.score == null) throw new Error('no score in response');
      if (prev) entry.attempts = 1; // fresh success resets the counter
      store.scores[key] = entry;
      if (!Object.keys(names).length) names = metricNames(body);
      ok++;
      console.log(tag + ' — ' + entry.score + '% (F ' + entry.f + ' / A ' + entry.a + ' / I ' + entry.i + ' / R ' + entry.r + ') in ' + Math.round((Date.now() - t0) / 1000) + 's');
    } catch (err) {
      failed++;
      if (prev && prev.score != null) {
        prev.last_error = err.message;
        prev.attempts = (prev.attempts || 1) + 1;
        console.warn(tag + ' — FAILED (' + err.message + '), kept previous score ' + prev.score + '%');
      } else {
        store.scores[key] = {
          doi: key, platform: rec.platform, score: null,
          attempts: ((prev || {}).attempts || 0) + 1, last_error: err.message,
        };
        console.warn(tag + ' — FAILED (' + err.message + ')');
      }
    }
    await sleep(1000); // politeness toward the hosts F-UJI crawls on our behalf
  }

  const now = new Date().toISOString();
  store.metadata = {
    type: 'fair-scores',
    last_updated: now,
    fuji_version: FUJI_VERSION,
    metric_version: METRIC_VERSION.replace('metrics_v', ''),
    metric_names: names,
    assessed: Object.values(store.scores).filter(e => e.score != null).length,
    errors: Object.values(store.scores).filter(e => e.score == null).length,
  };
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));

  // Slim page feed: drop bookkeeping fields, keep the breakdown.
  const feedScores = {};
  for (const [key, e] of Object.entries(store.scores)) {
    if (e.score == null) continue;
    feedScores[key] = {
      s: e.score, f: e.f, a: e.a, i: e.i, r: e.r,
      m: e.maturity, p: e.passed, t: e.total, d: e.assessed,
      checks: e.checks,
    };
  }
  fs.writeFileSync(FEED_FILE, JSON.stringify({
    generated: now,
    fuji_version: FUJI_VERSION,
    metric_version: store.metadata.metric_version,
    metric_names: names,
    scores: feedScores,
  }));

  // ── History: one line per run, full granularity ──
  // fair-scores.json is a REPLACE store: each run overwrites last month's
  // per-metric detail, so score trajectories were unrecoverable (the fork's
  // fair-trends page has to say so out loud). Every run now appends a dated
  // measurement record carrying, per DOI assessed THIS run, the total, the
  // F/A/I/R split, maturity and the per-metric earned score AND verdict.
  // Verdicts are stored separately from scores because F-UJI awards partial
  // credit on failed metrics (earned 0.5, status fail) — one is not
  // derivable from the other. The more granularity these snapshots hold,
  // the more comparisons they can answer later; at ~25 KB per monthly line
  // the cost is irrelevant.
  if (ok > 0) {
    const today = new Date().toISOString().slice(0, 10);
    appendHistory(store, today, ok, null);
    writeHistoryFeed();
  } else {
    console.log('History: nothing assessed this run, no snapshot appended.');
  }

  console.log('\nDone: ' + ok + ' assessed, ' + failed + ' failed this run; ' + store.metadata.assessed + ' scores in store.');

  const byPlatform = {};
  for (const e of Object.values(store.scores)) {
    if (e.score == null) continue;
    const p = e.platform || '?';
    byPlatform[p] = byPlatform[p] || { n: 0, sum: 0 };
    byPlatform[p].n++; byPlatform[p].sum += e.score;
  }
  for (const [p, v] of Object.entries(byPlatform)) {
    console.log('  ' + p + ': avg ' + Math.round(v.sum / v.n) + '% over ' + v.n);
  }
}

// Append one measurement line for the entries assessed on `date`.
// `note` marks non-routine lines (the backfilled baseline).
function appendHistory(store, date, expected, note) {
  const entries = Object.values(store.scores)
    .filter(e => e.score != null && e.assessed === date);
  if (!entries.length) { console.log('History: no entries dated ' + date); return; }

  // One shared metric-id order per line keeps the per-DOI rows to two
  // parallel arrays instead of 17 repeated identifiers each.
  const metricIds = (entries.find(e => (e.checks || []).length) || {}).checks
    ? entries.find(e => (e.checks || []).length).checks.map(c => c[0]) : [];

  const records = {};
  for (const e of entries) {
    const byId = {};
    for (const c of (e.checks || [])) byId[c[0]] = c;
    records[e.doi] = {
      p: e.platform || '',
      s: e.score, f: e.f, a: e.a, i: e.i, r: e.r,
      m: e.maturity, pd: e.passed,
      e: metricIds.map(id => (byId[id] ? byId[id][1] : null)),
      v: metricIds.map(id => (byId[id] ? (byId[id][3] === 'pass' ? 'p' : 'f') : 'x')).join(''),
    };
  }
  const line = {
    date: date,
    fuji_version: FUJI_VERSION,
    metric_version: METRIC_VERSION.replace('metrics_v', ''),
    assessed: entries.length,
    metrics: metricIds,
  };
  if (note) line.note = note;
  line.records = records;
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(line) + '\n');
  console.log('History: appended ' + entries.length + ' scores for ' + date
    + ' -> ' + path.basename(HISTORY_FILE));
}

// Slim same-origin aggregate feed for the future FAIR-trends page: per run,
// the overall and per-platform averages plus each metric's pass rate. The
// per-DOI detail stays in the jsonl; a page charting national trends never
// needs to download it.
function writeHistoryFeed() {
  if (!fs.existsSync(HISTORY_FILE)) return;
  const runs = [];
  for (const raw of fs.readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    let l; try { l = JSON.parse(raw); } catch (e) { continue; }
    const recs = Object.values(l.records || {});
    if (!recs.length) continue;
    const platforms = {};
    let sum = 0;
    const passCounts = l.metrics.map(() => 0);
    const rateable = l.metrics.map(() => 0);
    for (const r of recs) {
      sum += r.s;
      const p = r.p || '?';
      platforms[p] = platforms[p] || { n: 0, sum: 0 };
      platforms[p].n++; platforms[p].sum += r.s;
      (r.v || '').split('').forEach((ch, i) => {
        if (ch === 'x') return;
        rateable[i]++;
        if (ch === 'p') passCounts[i]++;
      });
    }
    const metricPass = {};
    l.metrics.forEach((id, i) => {
      if (rateable[i]) metricPass[id] = Math.round(passCounts[i] / rateable[i] * 1000) / 10;
    });
    for (const p of Object.keys(platforms)) {
      platforms[p] = { n: platforms[p].n, avg: Math.round(platforms[p].sum / platforms[p].n * 10) / 10 };
    }
    runs.push({
      date: l.date, assessed: recs.length,
      fuji_version: l.fuji_version, metric_version: l.metric_version,
      avg: Math.round(sum / recs.length * 10) / 10,
      platforms: platforms,
      metric_pass_pct: metricPass,
    });
  }
  fs.writeFileSync(HISTORY_FEED, JSON.stringify({
    generated: new Date().toISOString(),
    note: 'Per-run aggregates derived from data/fair-history.jsonl. Scores are '
      + 'comparable only within one metric_version.',
    runs: runs,
  }));
  console.log('History feed: ' + runs.length + ' run(s) -> ' + path.basename(HISTORY_FEED));
}

module.exports = { appendHistory, writeHistoryFeed };

if (require.main === module) {
  run().catch(err => { console.error('Fatal: ' + err.message); process.exit(1); });
}
