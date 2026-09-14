/**
 * Searcher recall check against the reference publications list.
 *
 * Question it answers: which reference-list papers (data/reference-dois.txt)
 * could the keyword searcher EVER find on its own — and via which query?
 * Targets are the reference DOIs whose tracker record carries no organic
 * search term (manual entries) or is absent entirely. For each configured
 * query × 40-DOI batch it asks OpenAlex one combined question:
 * default.search (title+abstract+fulltext) restricted to those DOIs.
 *
 * Built for OpenAlex's velocity limits, which penalise burst clients for
 * hours (learned the hard way, 14 Sep 2026):
 *   - one request every RECALL_PACE_MS ms (default 5000)
 *   - at most RECALL_MAX_REQUESTS per run (default 150) — the full grid
 *     completes over several runs
 *   - resumable: data/recall-check.json records every completed grid cell
 *     and all matches; re-running continues where it stopped
 *   - two consecutive failed batches = a rate-limit storm: save and stop
 *
 * Run locally (npm run recall-check) or via the manual recall-check
 * GitHub workflow, which raises the per-run cap and commits the state.
 */

const fs = require('fs');
const path = require('path');
const { fetchJSON, sleep, normaliseDoi } = require('./utils');

const ROOT = path.join(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const REF_FILE = path.join(ROOT, 'data', 'reference-dois.txt');
const PUB_FILE = path.join(ROOT, 'data', 'publications.json');
const STATE_FILE = path.join(ROOT, 'data', 'recall-check.json');

const PACE_MS = Number.isFinite(parseInt(process.env.RECALL_PACE_MS, 10))
  ? parseInt(process.env.RECALL_PACE_MS, 10) : 5000;
const MAX_REQUESTS = Number.isFinite(parseInt(process.env.RECALL_MAX_REQUESTS, 10))
  ? parseInt(process.env.RECALL_MAX_REQUESTS, 10) : 150;
const BATCH = 40;
const MANUAL = ['Manual entry', 'Manual submission'];

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return null; }
}

function saveState(state) {
  state.updated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}

function summarise(state) {
  const cellsTotal = CONFIG.search_queries.length * Math.ceil(state.targets.length / BATCH);
  const cellsDone = Object.keys(state.done).length;
  const matched = Object.keys(state.matches).length;
  console.log('\nGrid: ' + cellsDone + '/' + cellsTotal + ' cells checked ('
    + Math.round(cellsDone / cellsTotal * 100) + '%), requests so far: ' + state.requestsTotal);
  console.log('Targets matched by at least one query: ' + matched + ' of ' + state.targets.length);
  const perQuery = {};
  Object.values(state.matches).forEach(qs => qs.forEach(q => { perQuery[q] = (perQuery[q] || 0) + 1; }));
  Object.entries(perQuery).sort((a, b) => b[1] - a[1])
    .forEach(([q, n]) => console.log('  ' + String(n).padStart(3) + '  ' + q));
  if (cellsDone === cellsTotal) {
    console.log('\nGRID COMPLETE. The ' + (state.targets.length - matched)
      + ' unmatched targets contain no configured search term in any text'
      + ' OpenAlex indexes — the searcher can never find them by keyword.');
  } else {
    console.log('\nRun again to continue (state in data/recall-check.json).');
  }
}

async function main() {
  const refDois = [...new Set(fs.readFileSync(REF_FILE, 'utf8')
    .split('\n').map(s => s.trim()).filter(s => s && s[0] !== '#').map(normaliseDoi))];

  let state = loadState();
  if (!state || process.env.RECALL_RESET === '1') {
    // Freeze the target list on first run so grid cells stay stable across
    // resumed runs even as the tracker's records evolve.
    const db = JSON.parse(fs.readFileSync(PUB_FILE, 'utf8'));
    const byDoi = {};
    (db.records || []).forEach(r => { byDoi[normaliseDoi(r.doi)] = r; });
    const targets = refDois.filter(d => {
      const r = byDoi[d];
      if (!r) return true;
      return !(r.searchTerms || []).some(t => MANUAL.indexOf(t) === -1);
    }).sort();
    state = {
      started: new Date().toISOString(),
      targets: targets,
      done: {},
      matches: {},
      requestsTotal: 0
    };
    console.log('New recall check: ' + targets.length + ' targets ('
      + refDois.length + ' reference DOIs, organically-found ones excluded)');
  } else {
    console.log('Resuming recall check started ' + state.started
      + ' (' + Object.keys(state.done).length + ' cells already checked)');
  }

  let requests = 0;
  let consecutiveFailures = 0;

  outer:
  for (const q of CONFIG.search_queries) {
    for (let i = 0; i < state.targets.length; i += BATCH) {
      const cell = q + '‖' + i;
      if (state.done[cell]) continue;
      if (requests >= MAX_REQUESTS) {
        console.log('\nPer-run request cap reached (' + MAX_REQUESTS + ').');
        break outer;
      }
      const batch = state.targets.slice(i, i + BATCH);
      const url = 'https://api.openalex.org/works?per_page=' + BATCH
        + '&filter=default.search:' + encodeURIComponent(q)
        + ',doi:' + batch.map(encodeURIComponent).join('|')
        + '&select=doi&mailto=' + encodeURIComponent(CONFIG.email);
      requests++;
      state.requestsTotal++;
      try {
        const data = await fetchJSON(url, { retries: 2 });
        for (const w of (data.results || [])) {
          const d = normaliseDoi(w.doi || '');
          if (state.targets.indexOf(d) === -1) continue;
          state.matches[d] = state.matches[d] || [];
          if (state.matches[d].indexOf(q) === -1) state.matches[d].push(q);
        }
        state.done[cell] = 1;
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures++;
        console.warn('cell failed [' + q + ' @' + i + ']: ' + err.message);
        if (consecutiveFailures >= 2) {
          console.warn('\nTwo consecutive failures — rate-limit storm; saving and stopping.');
          break outer;
        }
      }
      saveState(state);
      await sleep(PACE_MS);
    }
  }

  saveState(state);
  summarise(state);
}

main().catch(err => {
  console.error('recall-check failed: ' + err.message);
  process.exit(1);
});
