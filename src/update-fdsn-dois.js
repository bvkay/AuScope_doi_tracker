#!/usr/bin/env node
/**
 * AuScope DOI Tracker — FDSN DOI Table Updater
 *
 * Regenerates docs/fdsn-doi-data.js, the shared [networkCode, startYear, doi]
 * lookup table embedded by auspass.html and datasets.html (fdsn.org sends no
 * CORS headers, so browsers cannot fetch it directly).
 *
 * Sources:
 *   1. AusPass FDSN station service — which networks we care about
 *   2. fdsn.org networks web service — authoritative DOI per code + start year
 *
 * Merge rules:
 *   - Existing rows are kept. Some are manually curated aliases (e.g. an
 *     AusPass start year that differs from the FDSN registry entry), so a
 *     conflicting registry DOI only WARNS unless --overwrite is passed.
 *   - New exact matches (code + start year) are added.
 *   - AusPass networks with no DOI match anywhere are listed for manual review.
 *
 * Usage: node src/update-fdsn-dois.js [--overwrite] [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const TABLE_FILE = path.join(__dirname, '..', 'docs', 'fdsn-doi-data.js');
const OVERWRITE = process.argv.includes('--overwrite');
const DRY_RUN = process.argv.includes('--dry-run');

// Non-AuScope networks mirrored by AusPass (IRIS/USGS global, test networks).
// Deliberately removed from the table in April 2026 - do not re-add.
const EXCLUDED_CODES = new Set(['IU', 'OA', 'XX']);

async function run() {
  console.log('FDSN DOI Table Updater');
  console.log('======================\n');

  // ── Existing curated table ──
  const existing = loadExistingTable();
  console.log('Existing table: ' + existing.length + ' rows');

  // ── AusPass networks ──
  const stationResp = await fetch('https://auspass.edu.au/fdsnws/station/1/query?level=network&format=text');
  if (!stationResp.ok) throw new Error('AusPass station service HTTP ' + stationResp.status);
  const stationText = await stationResp.text();
  const auspassNetworks = [];
  const lines = stationText.trim().split('\n');
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('|');
    if (parts.length < 5) continue;
    const code = parts[0].trim();
    const startYear = parts[2].trim().substring(0, 4);
    if (code && startYear) auspassNetworks.push({ code, startYear });
  }
  console.log('AusPass networks: ' + auspassNetworks.length);

  // ── FDSN registry DOIs ──
  const fdsnResp = await fetch('https://www.fdsn.org/ws/networks/1/query?format=json');
  if (!fdsnResp.ok) throw new Error('FDSN networks API HTTP ' + fdsnResp.status);
  const fdsnData = await fdsnResp.json();
  const fdsnNetworks = fdsnData.networks || fdsnData;
  const doiMapExact = {};
  for (const net of fdsnNetworks) {
    if (net.doi && net.fdsn_code && net.start_date) {
      doiMapExact[net.fdsn_code + '_' + net.start_date.substring(0, 4)] = net.doi;
    }
  }
  console.log('FDSN registry entries with DOIs: ' + Object.keys(doiMapExact).length + '\n');

  // ── Merge ──
  const table = new Map(existing.map(r => [r[0] + '_' + r[1], r[2]]));
  let added = 0, conflicts = 0, unmatched = [];

  for (const net of auspassNetworks) {
    if (EXCLUDED_CODES.has(net.code)) continue;
    const key = net.code + '_' + net.startYear;
    const registryDoi = doiMapExact[key];
    const existingDoi = table.get(key);

    if (existingDoi && registryDoi && normDoi(existingDoi) !== normDoi(registryDoi)) {
      conflicts++;
      if (OVERWRITE) {
        console.log('  OVERWRITE ' + key + ': ' + existingDoi + ' -> ' + registryDoi);
        table.set(key, registryDoi);
      } else {
        console.log('  CONFLICT  ' + key + ': table has ' + existingDoi + ', registry has ' + registryDoi + ' (kept table; use --overwrite to replace)');
      }
    } else if (!existingDoi && registryDoi) {
      console.log('  ADD       ' + key + ': ' + registryDoi);
      table.set(key, registryDoi);
      added++;
    } else if (!existingDoi && !registryDoi) {
      unmatched.push(key);
    }
  }

  console.log('\nAdded ' + added + ', conflicts ' + conflicts + ', total rows ' + table.size);
  if (unmatched.length) {
    console.log('AusPass networks with no DOI in table or registry (manual review):');
    console.log('  ' + unmatched.join(', '));
  }

  // ── Write ──
  const rows = [...table.entries()]
    .map(([key, doi]) => {
      const idx = key.lastIndexOf('_');
      return [key.substring(0, idx), key.substring(idx + 1), doi];
    })
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  const body = rows.map(r => '    ["' + r[0] + '","' + r[1] + '","' + r[2] + '"]').join(',\n');
  const out = `// ============================================================
// FDSN DOI LOOKUP TABLE  (shared by auspass.html and datasets.html)
// ============================================================
// Embedded copy of the FDSN registry's DOI mapping. fdsn.org doesn't send
// CORS headers, so pages can't fetch it in-browser.
// Format: [networkCode, startYear, doi].
// Some rows are manually curated aliases (e.g. a network whose AusPass start
// year differs from the FDSN registry entry) - do not blindly overwrite.
// Regenerate/refresh with: node src/update-fdsn-dois.js
var FDSN_DOI_DATA = [
${body}
];
`;

  if (DRY_RUN) {
    console.log('\n--dry-run: not writing ' + TABLE_FILE);
  } else {
    fs.writeFileSync(TABLE_FILE, out);
    console.log('\nWrote ' + TABLE_FILE);
  }
}

function loadExistingTable() {
  if (!fs.existsSync(TABLE_FILE)) return [];
  const src = fs.readFileSync(TABLE_FILE, 'utf8');
  const m = src.match(/var FDSN_DOI_DATA = \[([\s\S]*?)\];/);
  if (!m) return [];
  const rows = [];
  const re = /\["([^"]+)","([^"]+)","([^"]+)"\]/g;
  let r;
  while ((r = re.exec(m[1])) !== null) rows.push([r[1], r[2], r[3]]);
  return rows;
}

function normDoi(doi) {
  return (doi || '').toLowerCase().replace(/^https?:\/\/doi\.org\//, '').trim();
}

run().catch(err => {
  console.error('Failed: ' + err.message);
  process.exit(1);
});
