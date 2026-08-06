#!/usr/bin/env node
/**
 * AuScope NVCL Pillar — THREDDS catalogue snapshot
 *
 * Records what the AuScope TSG mirror on NCI THREDDS actually holds, per
 * state, so the harvest can RECONCILE it against what each state's own
 * services surface.
 *
 * This matters because the two disagree. Measured 2026-08-06: the mirror
 * holds 407 archives more than the state nodes expose as boreholes-with-
 * data — WA +282, QLD +144, TAS +24 — and Victoria, whose node reports no
 * NVCL datasets at all, has 39 archives sitting on the mirror. Scanned
 * core that a state service does not advertise is still scanned core; the
 * page should say so rather than quietly inherit the node's blind spot.
 *
 * Writes data/nvcl/thredds-catalog.json:
 *   { fetched, states: { WA: { count, names: [...] }, ... } }
 *
 * Cheap (six catalogue XMLs, no archives touched). Run before harvest.js.
 *
 * Usage: node src/nvcl/thredds-catalog.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'nvcl', 'thredds-catalog.json');
const CONFIG = readJson(path.join(ROOT, 'config.json'), {});
const UA = 'AuScope-doi-tracker NVCL catalogue'
  + (CONFIG.email ? ' (mailto:' + CONFIG.email + ')' : '');

// THREDDS subpaths are case-sensitive and do NOT all match our node codes
// (Nsw/Wa/Nt all 404). Keys here are our node codes; values are the paths.
const SUBPATHS = { SA: 'SA', TAS: 'Tas', WA: 'WA', NT: 'NT', QLD: 'Qld', VIC: 'Vic' };
const BASE = 'https://thredds.nci.org.au/thredds/catalog/rs07/';

async function run() {
  console.log('THREDDS catalogue snapshot');
  console.log('==========================\n');
  const states = {};
  for (const code of Object.keys(SUBPATHS)) {
    const url = BASE + SUBPATHS[code] + '/catalog.xml';
    try {
      const xml = await fetchText(url);
      const names = [];
      const re = /<dataset[^>]*name="([^"]+\.zip)"/g;
      let m;
      while ((m = re.exec(xml)) !== null) names.push(m[1]);
      states[code] = { subpath: SUBPATHS[code], count: names.length, names: names.sort() };
      console.log('  ' + code + ': ' + names.length + ' archives');
    } catch (e) {
      console.warn('  ' + code + ': catalogue unreachable (' + e.message + ') — omitted, not zeroed');
      states[code] = { subpath: SUBPATHS[code], count: null, names: [], error: String(e.message) };
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    fetched: new Date().toISOString(),
    source: 'NCI THREDDS rs07 — AuScope NVCL TSG mirror (10.25914/bztg-rg43)',
    states: states,
  }, null, 1));
  console.log('\nWrote ' + OUT);
}

function fetchText(url) {
  const controller = new AbortController();
  const t = setTimeout(function () { controller.abort(); }, 60000);
  return fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .finally(function () { clearTimeout(t); });
}

function readJson(f, fallback) {
  try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
  return fallback;
}

run().catch(function (e) { console.error('Failed: ' + e.message); process.exit(1); });
