#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Project Mapping ingest
 *
 * Pulls the shared "Project Mapping" Google Sheet (the editing surface —
 * labels preserved exactly as supplied) and versions it in the repo:
 *
 *   data/project-mapping.json          — canonical snapshot
 *   docs/project-mapping.json          — same-origin feed for the pages
 *   data/project-mapping-history.jsonl — one line per CHANGE (not per run):
 *                                        appended only when the mapping
 *                                        differs from the previous snapshot,
 *                                        so the history reads as an edit log
 *                                        of the taxonomy, not a heartbeat.
 *
 * The sheet maps AuScope project IDs to the Downward-Looking Telescope
 * lenses ("DLT Lens"), programs, funding/public names, host, leader and
 * NCRIS status. The DOI-level join is deliberately coarse for now: each
 * dataset PLATFORM is attributed to one project id (platform_projects
 * below) — the granularity the sheet supports today. Refining to per-DOI
 * attribution (e.g. DataCite fundingReferences award numbers) replaces
 * that table, not the pages.
 *
 * Degrades to a no-op when the sheet is unreachable: the committed
 * snapshot stays in place (absent is not zero).
 *
 * Usage: node src/update-project-mapping.js
 */

const fs = require('fs');
const path = require('path');

const SHEET_ID = '1lbOrD2jD83U670cs0WJNkTk3gQDc0AR6CKBufYIyvqU';
const SHEET_NAME = 'Project Mapping';
const CSV_URL = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID
  + '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(SHEET_NAME);

const STORE_FILE = path.join(__dirname, '..', 'data', 'project-mapping.json');
const FEED_FILE = path.join(__dirname, '..', 'docs', 'project-mapping.json');
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'project-mapping-history.jsonl');

// Which project id a dataset platform's DOIs are attributed to. Kept here —
// declared config, not page-buried constants — so the registry, the lens
// bands and anything else all read one answer.
const PLATFORM_PROJECTS = {
  'EarthBank': '0',          // the sheet's id is 0.00000; normId collapses it to '0'
  'AusPass': '3.31',
  'NCI:MT': '3.33',
  'NCI:DAS': '3.31',
  'NVCL': '3.41',
};

// Minimal RFC-4180 CSV parser — quotes, embedded commas, embedded newlines.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// "2.50000" -> "2.5" — the sheet exports numeric ids with trailing zeros.
function normId(v) {
  const s = String(v || '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return s;
  return String(parseFloat(s));
}

async function run() {
  console.log('AuScope Project Mapping ingest');
  console.log('==============================\n');

  let csv;
  try {
    const res = await fetch(CSV_URL, { headers: { 'User-Agent': 'AuScope-DOI-Tracker' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    csv = await res.text();
    if (!/lens/i.test(csv.slice(0, 400))) throw new Error('response is not the mapping sheet');
  } catch (err) {
    console.warn('Sheet unreachable (' + err.message + ') — keeping the committed snapshot.');
    process.exit(0);
  }

  const rows = parseCsv(csv);
  const header = rows.shift().map(h => h.trim());
  // Two columns are both headed "ID" — position disambiguates: the first is
  // the project id, the sixth the secondary id. Everything else is by name,
  // so a reordered sheet fails loudly rather than mis-mapping.
  const col = name => header.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const iLens = col('DLT Lens'), iProgram = col('Program'),
    iFunding = col('Project Funding Name'), iPublic = col('Project Public Name'),
    iType = col('Type'), iHost = col('Host'), iLeader = col('Leader'), iNcris = col('NCRIS');
  if (iLens < 0 || iProgram < 0) throw new Error('sheet header changed: ' + header.join(' | '));

  const mappings = rows.map(r => ({
    projectId: normId(r[0]),
    lens: (r[iLens] || '').trim(),
    program: (r[iProgram] || '').trim(),
    fundingName: (r[iFunding] || '').trim(),
    project: (r[iPublic] || '').trim(),
    secondaryId: normId(r[5]),
    type: (r[iType] || '').trim(),
    host: (r[iHost] || '').trim(),
    leader: (r[iLeader] || '').trim(),
    ncris: (r[iNcris] || '').trim(),
  })).filter(m => m.projectId || m.lens || m.program);

  // Keyed lookup: first row wins per id (the sheet occasionally repeats one).
  const projects = {};
  for (const m of mappings) {
    if (m.projectId && !projects[m.projectId]) projects[m.projectId] = m;
  }

  const lenses = [...new Set(mappings.map(m => m.lens).filter(Boolean))];
  const programs = [...new Set(mappings.map(m => m.program).filter(Boolean))];

  const snapshot = {
    metadata: {
      source: 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit',
      sheet: SHEET_NAME,
      fetched: new Date().toISOString(),
      note: 'Labels preserved exactly as supplied by the shared Project Mapping sheet.',
      rows: mappings.length,
      lenses: lenses,
      programs: programs,
    },
    platform_projects: PLATFORM_PROJECTS,
    projects: projects,
    mappings: mappings,
  };

  // ── Change-gated history ──
  // Content hash over everything except the fetch timestamp: a weekly run
  // that finds the sheet unchanged appends nothing, so the jsonl is a real
  // edit log — each line is a taxonomy the site actually displayed.
  const contentKey = JSON.stringify({ p: PLATFORM_PROJECTS, m: mappings });
  let prevKey = null;
  if (fs.existsSync(STORE_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      prevKey = JSON.stringify({ p: prev.platform_projects, m: prev.mappings });
    } catch (e) { /* fresh */ }
  }
  const changed = contentKey !== prevKey;

  fs.writeFileSync(STORE_FILE, JSON.stringify(snapshot, null, 2));
  fs.writeFileSync(FEED_FILE, JSON.stringify(snapshot));
  console.log('Mapping: ' + mappings.length + ' rows, '
    + lenses.length + ' lenses, ' + programs.length + ' programs, '
    + Object.keys(projects).length + ' distinct project ids.');

  if (changed) {
    fs.appendFileSync(HISTORY_FILE, JSON.stringify({
      date: new Date().toISOString().slice(0, 10),
      rows: mappings.length,
      lenses: lenses,
      programs: programs,
      platform_projects: PLATFORM_PROJECTS,
      mappings: mappings,
    }) + '\n');
    console.log('History: mapping changed — snapshot appended to '
      + path.basename(HISTORY_FILE));
  } else {
    console.log('History: unchanged since last ingest, nothing appended.');
  }
}

run().catch(err => { console.error('Fatal: ' + err.message); process.exit(1); });
