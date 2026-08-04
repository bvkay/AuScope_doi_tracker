#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Compare Current vs Verified
 *
 * Reads:
 *   data/publications.json           (current keyword-based corpus)
 *   data/publications-verified.json  (output of verified.js)
 *
 * Prints a comparison report:
 *   - Overlap (good — keyword search caught a verified paper)
 *   - In current only (potential false positives or unverified-but-real)
 *   - In verified only (papers your keyword search missed — false negatives)
 *
 * Optionally writes a CSV of the keyword-only set so you can scan it.
 *
 * Usage: node src/compare.js [--csv]
 */

const fs = require('fs');
const path = require('path');

const CURRENT_FILE  = path.join(__dirname, '..', 'data', 'publications.json');
const VERIFIED_FILE = path.join(__dirname, '..', 'data', 'publications-verified.json');
const CSV_FILE      = path.join(__dirname, '..', 'data', 'keyword-only.csv');

function normaliseDoi(d) {
  return (d || '').toString().toLowerCase()
    .replace(/^https?:\/\/doi\.org\//i, '').replace(/^doi:/i, '').trim();
}

function loadRecords(file) {
  if (!fs.existsSync(file)) {
    console.error(`Missing file: ${file}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return data.records || data;
}

function indexByDoi(records) {
  const map = {};
  for (const r of records) {
    const k = normaliseDoi(r.doi);
    if (k) map[k] = r;
  }
  return map;
}

function csvEscape(s) {
  s = (s == null ? '' : String(s));
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function run() {
  const writeCsv = process.argv.includes('--csv');
  const current  = loadRecords(CURRENT_FILE);
  const verified = loadRecords(VERIFIED_FILE);

  const curMap = indexByDoi(current);
  const verMap = indexByDoi(verified);

  const inBoth        = [];
  const onlyInCurrent = [];
  const onlyInVerified= [];

  for (const doi of Object.keys(curMap)) {
    if (verMap[doi]) inBoth.push(curMap[doi]);
    else onlyInCurrent.push(curMap[doi]);
  }
  for (const doi of Object.keys(verMap)) {
    if (!curMap[doi]) onlyInVerified.push(verMap[doi]);
  }

  // Bucket the keyword-only set by which search term found them
  const byTerm = {};
  for (const r of onlyInCurrent) {
    for (const t of (r.searchTerms || ['(no term)'])) {
      byTerm[t] = (byTerm[t] || 0) + 1;
    }
  }
  const termsSorted = Object.entries(byTerm).sort((a, b) => b[1] - a[1]);

  // ─── Report ───
  console.log('AuScope: Current vs Verified Comparison');
  console.log('=======================================\n');
  console.log(`Current corpus       : ${current.length}`);
  console.log(`Verified corpus      : ${verified.length}`);
  console.log(`Overlap (good)       : ${inBoth.length}`);
  console.log(`Current only        ↘: ${onlyInCurrent.length}  (keyword found, ID-attribution did not)`);
  console.log(`Verified only       ↗: ${onlyInVerified.length}  (ID-attribution found, keyword search missed)`);
  console.log('');

  console.log('Top search terms in keyword-only set:');
  for (const [term, n] of termsSorted.slice(0, 20)) {
    console.log(`  ${n.toString().padStart(5)}  ${term}`);
  }
  console.log('');

  if (onlyInVerified.length > 0) {
    console.log('Sample of papers verified.js found that keyword search missed:');
    for (const r of onlyInVerified.slice(0, 10)) {
      console.log(`  ${r.year || '????'}  ${(r.title || '').substring(0, 90)}`);
      console.log(`         ${r.doi}  via ${(r.verifiedBy || []).join(', ')}`);
    }
    console.log('');
  }

  // Write CSV of keyword-only set if requested
  if (writeCsv) {
    const lines = ['doi,year,title,searchTerms,authors,journal'];
    for (const r of onlyInCurrent) {
      lines.push([
        csvEscape(r.doi),
        csvEscape(r.year),
        csvEscape(r.title),
        csvEscape((r.searchTerms || []).join(' | ')),
        csvEscape(r.authors),
        csvEscape(r.journal)
      ].join(','));
    }
    fs.writeFileSync(CSV_FILE, lines.join('\n'));
    console.log(`Wrote ${CSV_FILE} for manual review.`);
  } else {
    console.log('Tip: rerun with --csv to dump the keyword-only set for review.');
  }
}

run();