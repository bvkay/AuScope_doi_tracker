#!/usr/bin/env node
/**
 * AuScope DOI Tracker: Search Orchestrator
 *
 * Runs the configured search queries across OpenAlex, Semantic Scholar,
 * Europe PMC, CORE and Dimensions, deduplicates the results and merges
 * them into data/publications.json.
 *
 * Two modes:
 *   node src/search.js            every unit of work in one go (manual use)
 *   node src/search.js --batch    a few units of the current weekly cycle,
 *                                 resumable; what the hourly workflow runs
 *
 * The work is cut into units: one OpenAlex filter and five-year window of
 * the primary term, one secondary term, or the non-OpenAlex sources of the
 * primary term. Progress is kept in data/search-state.json per ISO week.
 * OpenAlex bills keyless requests against a daily budget shared by every
 * client on the runner's IP address, so a batch does a handful of units,
 * commits what it found and stops the moment that budget is gone; the next
 * hour's batch carries on. No API key is used, by decision (13 Nov 2026).
 *
 * Options: --units N (default 4, or SEARCH_UNITS); SEARCH_BUDGET_MS caps a
 * batch's wall clock (default 15 minutes, checked between units).
 *
 * Environment variables:
 *   S2_API_KEY         Semantic Scholar API key
 *   CORE_API_KEY       CORE API key (https://core.ac.uk/apikeys/register)
 *   DIMENSIONS_API_KEY Dimensions API key (https://app.dimensions.ai/)
 */

const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const { queryLabel } = require('./utils');
const { searchOpenAlex, searchOpenAlexUnit, yearWindows } = require('./sources/openalex');
const { searchSemanticScholar } = require('./sources/semantic_scholar');
const { searchEuropePMC, searchEuropePMCAck } = require('./sources/europepmc');
const { searchCORE } = require('./sources/core');
const { searchDimensions } = require('./sources/dimensions');
const { deduplicateItems, mergeIntoExisting } = require('./dedup');

const DATA_FILE = path.join(__dirname, '..', 'data', 'publications.json');
const STATE_FILE = path.join(__dirname, '..', 'data', 'search-state.json');
const DEFAULT_UNITS = 4;
const MAX_ATTEMPTS = 6;             // per unit per cycle; then it waits for next week
const DEFAULT_BUDGET_MS = 15 * 60 * 1000;
const FILTERS = ['fulltext.search', 'default.search'];

function apiKeys() {
  return {
    s2: process.env[config.s2_api_key_env] || '',
    core: process.env.CORE_API_KEY || '',
    dim: process.env.DIMENSIONS_API_KEY || ''
  };
}

function banner(keys, units) {
  console.log('AuScope DOI Tracker: Search');
  console.log('===========================');
  console.log('Queries: ' + config.search_queries.length + ' in ' + units.length + ' units');
  console.log('Primary: "' + queryLabel(config.search_queries[0]) + '" ('
    + (config.primary_max_pages || 20) * 25 + ' results per filter and five-year window)');
  console.log('Secondary: ' + (config.search_queries.length - 1) + ' terms ('
    + (config.secondary_max_pages || 2) * 25 + ' results per filter)');
  const sources = ['OpenAlex', 'Europe PMC', 'Semantic Scholar'];
  if (keys.core) sources.push('CORE');
  if (keys.dim) sources.push('Dimensions');
  console.log('Sources: ' + sources.join(', '));
  if (!keys.s2) console.warn('  (no S2_API_KEY: Semantic Scholar runs unauthenticated, slowly)');
  if (!keys.core) console.warn('  (no CORE_API_KEY: CORE disabled)');
  if (!keys.dim) console.warn('  (no DIMENSIONS_API_KEY: Dimensions disabled)');
  console.log('');
}

// ── Units of work ──
// Ordered so the heaviest OpenAlex work (the primary term) goes first in a
// cycle, while the shared budget is most likely to be fresh.
function buildUnits() {
  const units = [];
  const primary = config.search_queries[0];
  const label = queryLabel(primary);
  const primaryMax = (config.primary_max_pages || 20) * 25;
  for (const window of yearWindows(config.min_year || 1997)) {
    for (const filterType of FILTERS) {
      units.push({
        id: 'oa:' + label + ':' + filterType + ':' + window.start,
        kind: 'oa', query: primary, label, filterType, window, maxResults: primaryMax
      });
    }
  }
  units.push({ id: 'others:' + label, kind: 'others', query: primary, label });
  const secondaryMax = (config.secondary_max_pages || 2) * 25;
  const secondaryPmc = (config.secondary_max_pages || 2) * 100;
  for (let qi = 1; qi < config.search_queries.length; qi++) {
    const query = config.search_queries[qi];
    const l = queryLabel(query);
    units.push({ id: 'term:' + l, kind: 'term', query, label: l, maxResults: secondaryMax, pmcMax: secondaryPmc });
  }
  return units;
}

function tag(items, label) {
  items.forEach(item => { item.searchTerms = [label]; });
  return items;
}

// Runs one unit. Throws when OpenAlex failed, so the unit is retried in a
// later batch (and the batch stops when the failure is a spent budget);
// the other sources are best effort and log their own failures.
async function runUnit(unit, keys) {
  const items = [];
  const email = config.email;
  const q = unit.query;
  const label = unit.label;

  if (unit.kind === 'oa') {
    const got = await searchOpenAlexUnit(q, {
      filterType: unit.filterType, window: unit.window, maxResults: unit.maxResults, email
    });
    return tag(got, label);
  }

  if (unit.kind === 'term') {
    items.push(...tag(await searchOpenAlex(q, { email, maxResults: unit.maxResults }), label));
    try {
      items.push(...tag(await searchEuropePMC(q, { maxResults: unit.pmcMax }), label));
    } catch (err) {
      console.error('  Europe PMC error: ' + err.message);
    }
    return items;
  }

  // 'others': every non-OpenAlex source for the primary term. The
  // acknowledgement search catches papers that thank AuScope without
  // naming it in the abstract.
  try {
    items.push(...tag(await searchSemanticScholar(q, { apiKey: keys.s2, maxResults: 500 }), label));
  } catch (err) {
    console.error('  Semantic Scholar error: ' + err.message);
  }
  try {
    items.push(...tag(await searchEuropePMC(q, { maxResults: config.MAX_RESULTS_EUROPEPMC || 500 }), label));
  } catch (err) {
    console.error('  Europe PMC error: ' + err.message);
  }
  try {
    items.push(...tag(await searchEuropePMCAck(q, { maxResults: 500 }), label));
  } catch (err) {
    console.error('  Europe PMC ACK error: ' + err.message);
  }
  if (keys.core) {
    try {
      items.push(...tag(await searchCORE(q, { apiKey: keys.core, maxResults: 200 }), label));
    } catch (err) {
      console.error('  CORE error: ' + err.message);
    }
  }
  if (keys.dim) {
    try {
      items.push(...tag(await searchDimensions(q, { apiKey: keys.dim, maxResults: 200 }), label));
    } catch (err) {
      console.error('  Dimensions error: ' + err.message);
    }
  }
  return items;
}

// ── Filter, dedup and merge into the store ──
function mergeItems(allItems) {
  const minYear = config.min_year || 0;
  let filtered = allItems;
  if (minYear) {
    filtered = allItems.filter(item => !item.year || item.year >= minYear);
    const removed = allItems.length - filtered.length;
    if (removed > 0) console.log('Filtered out: ' + removed + ' results before ' + minYear);
  }

  // Exclude AuScope-ecosystem dataset/instrument DOI prefixes. OpenAlex
  // indexes DataCite records as works, so the instrument registry, EarthBank,
  // NCI and FDSN records match keyword searches; they belong to the
  // datasets/instruments pillars, never the publications corpus.
  const excludedPrefixes = config.excluded_doi_prefixes || [];
  if (excludedPrefixes.length) {
    const before = filtered.length;
    filtered = filtered.filter(item => {
      const doi = (item.doi || '').toLowerCase();
      return !excludedPrefixes.some(p => doi.indexOf(p.toLowerCase() + '/') === 0);
    });
    const removedPrefix = before - filtered.length;
    if (removedPrefix > 0) console.log('Filtered out: ' + removedPrefix + ' infrastructure DOIs (excluded prefixes)');
  }

  const deduped = deduplicateItems(filtered);
  console.log('After dedup: ' + deduped.length + ' unique DOIs');

  let pubData = { metadata: { type: 'publications', last_updated: null, total_count: 0 }, records: [] };
  if (fs.existsSync(DATA_FILE)) {
    pubData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  const { records, added, updated } = mergeIntoExisting(pubData.records, deduped);
  pubData.records = records;
  pubData.metadata.last_updated = new Date().toISOString();
  pubData.metadata.total_count = records.length;
  fs.writeFileSync(DATA_FILE, JSON.stringify(pubData, null, 2));

  console.log('New DOIs added: ' + added);
  console.log('Existing updated: ' + updated);
  console.log('Total in database: ' + records.length);
  console.log('Saved to ' + DATA_FILE);
  return { added, updated, total: records.length };
}

// ── Mode 1: everything in one go ──
async function runAll() {
  const keys = apiKeys();
  const units = buildUnits();
  banner(keys, units);
  const allItems = [];
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    process.stdout.write('[' + (i + 1) + '/' + units.length + '] ' + unit.id + ' ... ');
    try {
      const items = await runUnit(unit, keys);
      allItems.push(...items);
      console.log(items.length + ' results');
    } catch (err) {
      console.log('failed');
      console.error('  ' + err.message);
      if (err.budgetExhausted) {
        console.error('OpenAlex budget exhausted; stopping the search here');
        break;
      }
    }
  }
  console.log('\nRaw results: ' + allItems.length);
  mergeItems(allItems);
}

// ── Mode 2: a batch of the current weekly cycle ──
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return null; }
}

function githubOutput(pairs) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.keys(pairs).map(k => k + '=' + pairs[k]).join('\n') + '\n';
  fs.appendFileSync(process.env.GITHUB_OUTPUT, lines);
}

async function runBatch(maxUnits) {
  const keys = apiKeys();
  const units = buildUnits();
  const byId = {};
  units.forEach(u => { byId[u.id] = u; });

  const cycle = isoWeek(new Date());
  let state = loadState();
  let changed = false;
  if (!state || state.cycle !== cycle || !Array.isArray(state.units)) {
    state = { cycle, started: new Date().toISOString(), units: [] };
    changed = true;
  }
  // Reconcile with the configured units, since terms can change mid-cycle.
  const rows = {};
  state.units.forEach(r => { rows[r.id] = r; });
  state.units = units.map(u => rows[u.id] || { id: u.id, status: 'pending', attempts: 0 });

  const isOpen = r => r.status !== 'done' && r.attempts < MAX_ATTEMPTS;
  const pending = state.units.filter(isOpen);
  const todo = pending.slice(0, maxUnits);
  banner(keys, units);
  console.log('Cycle ' + cycle + ': ' + (units.length - pending.length) + ' of ' + units.length
    + ' units closed, ' + todo.length + ' this batch\n');

  const budgetMs = parseInt(process.env.SEARCH_BUDGET_MS, 10) || DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const allItems = [];
  let done = 0;
  let stopped = '';
  for (const row of todo) {
    if (Date.now() > deadline) { stopped = 'wall clock budget spent'; break; }
    const unit = byId[row.id];
    row.attempts++;
    changed = true;
    process.stdout.write(unit.id + ' ... ');
    try {
      const items = await runUnit(unit, keys);
      allItems.push(...items);
      row.status = 'done';
      row.done_at = new Date().toISOString();
      row.results = items.length;
      delete row.error;
      done++;
      console.log(items.length + ' results');
    } catch (err) {
      row.status = 'failed';
      row.error = String(err.message || err).slice(0, 160);
      console.log('failed');
      console.error('  ' + row.error);
      if (err.budgetExhausted) { stopped = 'OpenAlex daily budget exhausted on this runner'; break; }
    }
  }
  if (stopped) console.log('\nStopped: ' + stopped + '; the rest waits for the next batch');

  if (allItems.length) {
    console.log('\nRaw results: ' + allItems.length);
    mergeItems(allItems);
  }

  const remaining = state.units.filter(isOpen).length;
  const givenUp = state.units.filter(r => r.status !== 'done' && r.attempts >= MAX_ATTEMPTS).length;
  const complete = remaining === 0;
  const completedNow = complete && done > 0 && !state.completed;
  if (complete && !state.completed) { state.completed = new Date().toISOString(); changed = true; }
  if (changed) {
    state.updated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
  console.log('\nCycle ' + cycle + ': ' + (units.length - remaining - givenUp) + ' done, '
    + remaining + ' remaining' + (givenUp ? ', ' + givenUp + ' given up this cycle' : '')
    + (complete ? ' (complete)' : ''));
  githubOutput({
    did_work: done > 0 || allItems.length > 0,
    cycle_complete: complete,
    completed_now: completedNow,
    units_remaining: remaining
  });
}

const args = process.argv.slice(2);
const ui = args.indexOf('--units');
const unitsPerBatch = ui !== -1
  ? parseInt(args[ui + 1], 10)
  : (parseInt(process.env.SEARCH_UNITS, 10) || DEFAULT_UNITS);
(args.includes('--batch') ? runBatch(unitsPerBatch || DEFAULT_UNITS) : runAll()).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
