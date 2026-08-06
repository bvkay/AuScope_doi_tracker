#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Review Queue Decisions
 *
 * Consumes data/review-decisions.json (pushed from the Google Sheet's
 * "Review queue" tab): human accept/reject verdicts on candidate-strong
 * works that verified.js found but never auto-added.
 *
 *   accept -> appended to publications.json (evidence: candidate,
 *             provenance 'Manual review'), full metadata taken from
 *             publications-verified.json
 *   reject -> recorded in data/review-rejects.json so the work never
 *             reappears in the review queue
 *
 * Decisions file is cleared after processing (same pattern as pending.json).
 * Runs in CI before verified.js/evidence.js.
 * Usage: node src/process-review-decisions.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DECISIONS_FILE = path.join(DATA_DIR, 'review-decisions.json');
const REJECTS_FILE = path.join(DATA_DIR, 'review-rejects.json');
const PUB_FILE = path.join(DATA_DIR, 'publications.json');

function normDoi(s) {
  if (!s) return '';
  return String(s).trim().replace(/^https?:\/\/(www\.)?(dx\.)?doi\.org\//i, '').toLowerCase();
}
function readJson(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  return fallback;
}

function run() {
  console.log('Review Queue Decisions');
  console.log('======================\n');

  const decisions = (readJson(DECISIONS_FILE, {}).records) || [];
  if (!decisions.length) { console.log('No decisions pending.'); return; }

  const pubData = readJson(PUB_FILE, null);
  if (!pubData) { console.error('No publications.json'); process.exit(1); }

  const verifiedRecs = (readJson(path.join(DATA_DIR, 'publications-verified.json'), {}).records) || [];
  const byDoi = {};
  verifiedRecs.forEach(function(r) { byDoi[normDoi(r.doi)] = r; });

  const inCorpus = {};
  pubData.records.forEach(function(p) {
    inCorpus[normDoi(p.doi)] = true;
    (p.relatedDois || []).forEach(function(d) { inCorpus[normDoi(d)] = true; });
  });

  const rejects = readJson(REJECTS_FILE, { records: [] });
  const rejectSet = {};
  rejects.records.forEach(function(r) { rejectSet[normDoi(r.doi)] = true; });

  const today = new Date().toISOString().substring(0, 10);
  let accepted = 0, rejected = 0, skipped = 0;

  decisions.forEach(function(d) {
    const k = normDoi(d.doi);
    const verdict = String(d.decision || '').toLowerCase();
    if (!k || (verdict !== 'accept' && verdict !== 'reject')) { skipped++; return; }

    if (verdict === 'reject') {
      if (!rejectSet[k]) {
        rejects.records.push({ doi: k, decidedBy: d.decidedBy || 'sheet', date: today, note: d.note || '' });
        rejectSet[k] = true;
        rejected++;
      }
      return;
    }

    // accept
    if (inCorpus[k]) { skipped++; return; }
    const src = byDoi[k];
    if (!src) {
      console.warn('  accept for unknown DOI (not in verified output): ' + k + ' — skipped');
      skipped++;
      return;
    }
    const rec = Object.assign({}, src);
    delete rec.attribution; delete rec.authorIds; delete rec.authorOrcids; delete rec.rors;
    rec.dateAdded = today;
    rec.searchTerms = ['Manual review'];
    rec.evidence = 'candidate';
    rec.evidenceDetail = 'accepted from review queue' + (d.decidedBy ? ' by ' + d.decidedBy : '');
    pubData.records.push(rec);
    inCorpus[k] = true;
    accepted++;
  });

  fs.writeFileSync(PUB_FILE, JSON.stringify(pubData, null, 2));
  fs.writeFileSync(REJECTS_FILE, JSON.stringify(rejects, null, 2));
  fs.writeFileSync(DECISIONS_FILE, JSON.stringify({ processed: new Date().toISOString(), records: [] }, null, 2));

  console.log('Accepted: ' + accepted + ' | Rejected: ' + rejected + ' | Skipped: ' + skipped);
  console.log('Rejects on file: ' + rejects.records.length);
}

run();
