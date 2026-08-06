#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Same-Work Consolidation
 *
 * DOI-level dedup can't catch the same WORK registered under several DOIs:
 *   - Zenodo concept vs version DOIs (consecutive numbers)
 *   - preprint vs published article (EarthArXiv/EGUsphere/arXiv/... vs journal)
 *   - the same item re-minted by a second publisher (e.g. ASEG abstracts)
 *   - repository version suffixes (10.x/12345 vs 10.x/12345.v1)
 *
 * Groups records by normalised title + first author family name + year and
 * keeps ONE canonical record per group (published > non-versioned > concept
 * > most cited), folding the other DOIs into relatedDois so nothing is lost.
 * Citations become the group maximum (never summed — citer sets overlap).
 *
 * Run after maintain.js, before verified.js/evidence.js.
 * Usage: node src/consolidate.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const PUB_FILE = path.join(__dirname, '..', 'data', 'publications.json');
const DRY = process.argv.includes('--dry-run');

// Preprint servers (by prefix or DOI substring)
const PREPRINT_PREFIXES = ['10.31223', '10.21203', '10.22541', '10.20944',
  '10.31219', '10.31234', '10.32942', '10.48550', '10.31222'];
const PREPRINT_SUBSTRINGS = ['/essoar', 'egusphere'];

const EVIDENCE_RANK = { verified: 0, candidate: 1, 'text-attributed': 2,
  'text-infrastructure': 3, 'text-software': 4, keyword: 5 };

function normDoi(s) {
  if (!s) return '';
  return String(s).trim().replace(/^https?:\/\/(www\.)?(dx\.)?doi\.org\//i, '').toLowerCase();
}
function normTitle(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function firstFamily(a) {
  const first = String(a || '').split(';')[0].trim();
  return first ? first.split(' ').pop().toLowerCase() : '';
}
function isPreprint(doi) {
  return PREPRINT_PREFIXES.some(p => doi.indexOf(p + '/') === 0)
    || PREPRINT_SUBSTRINGS.some(s => doi.indexOf(s) !== -1);
}
function zenodoNum(doi) {
  const m = doi.match(/^10\.5281\/zenodo\.(\d+)$/);
  return m ? parseInt(m[1]) : null;
}

// Higher score = better canonical.
function score(r) {
  const doi = normDoi(r.doi);
  let s = 0;
  if (!isPreprint(doi)) s += 8;
  if (r.journal && !/^zenodo/i.test(r.journal)) s += 4;
  if (!/\.v\d+$/.test(doi)) s += 2;
  return s;
}

function pickCanonical(group) {
  return group.slice().sort(function(a, b) {
    const sa = score(a), sb = score(b);
    if (sa !== sb) return sb - sa;
    const ca = parseInt(a.cited) || 0, cb = parseInt(b.cited) || 0;
    if (ca !== cb) return cb - ca;
    // Zenodo pairs: the lower number is the version-independent concept DOI
    const za = zenodoNum(normDoi(a.doi)), zb = zenodoNum(normDoi(b.doi));
    if (za !== null && zb !== null && za !== zb) return za - zb;
    if ((a.dateAdded || '') !== (b.dateAdded || '')) return (a.dateAdded || '') < (b.dateAdded || '') ? -1 : 1;
    return normDoi(a.doi) < normDoi(b.doi) ? -1 : 1;
  })[0];
}

function run() {
  console.log('Same-Work Consolidation' + (DRY ? ' (dry run)' : ''));
  console.log('=======================\n');

  const pubData = JSON.parse(fs.readFileSync(PUB_FILE, 'utf8'));
  let records = pubData.records || [];

  // Peer-review artifacts are not publications: Copernicus journals mint
  // DOIs for referee/author comments (-rc1/-ac2/...), and they match our
  // text scans because they quote the paper under review.
  const isReviewArtifact = function(r) {
    const t = String(r.type || '').toLowerCase();
    if (t === 'peer review' || t === 'peer-review') return true;
    return /^10\.5194\/.*-(rc|ac|ec|cc)\d+$/.test(normDoi(r.doi));
  };
  const artifacts = records.filter(isReviewArtifact);
  if (artifacts.length) {
    console.log('Removed ' + artifacts.length + ' peer-review artifacts:');
    artifacts.forEach(function(r) { console.log('    ' + r.doi + '  ' + String(r.title).substring(0, 50)); });
    records = records.filter(function(r) { return !isReviewArtifact(r); });
  }

  // Repair DOI fields stored as full URLs first — they may then collide.
  let urlFixed = 0;
  const byDoi = {};
  records.forEach(function(r) {
    const fixed = normDoi(r.doi);
    if (fixed !== (r.doi || '').toLowerCase()) urlFixed++;
    r.doi = fixed;
  });
  if (urlFixed) console.log('Normalised ' + urlFixed + ' URL-form DOI fields.');

  const groups = {};
  records.forEach(function(r) {
    const t = normTitle(r.title);
    if (!t) return;
    const k = t + '|' + firstFamily(r.authors) + '|' + (r.year || '');
    (groups[k] = groups[k] || []).push(r);
  });

  const remove = {};
  let groupCount = 0;
  Object.keys(groups).forEach(function(k) {
    const g = groups[k];
    if (g.length < 2) return;
    groupCount++;
    const keep = pickCanonical(g);
    const related = [];
    const termSet = {}, sourceSet = {};
    (keep.searchTerms || []).forEach(function(t) { termSet[t] = true; });
    (keep.sources || []).forEach(function(s) { sourceSet[s] = true; });
    let best = keep.evidence || 'keyword';
    let cited = parseInt(keep.cited) || 0;
    g.forEach(function(r) {
      if (r === keep) return;
      remove[r.doi] = true;
      related.push(r.doi);
      (r.searchTerms || []).forEach(function(t) { termSet[t] = true; });
      (r.sources || []).forEach(function(s) { sourceSet[s] = true; });
      if (EVIDENCE_RANK[r.evidence] < EVIDENCE_RANK[best]) best = r.evidence;
      cited = Math.max(cited, parseInt(r.cited) || 0);
      if (!keep.journal && r.journal) keep.journal = r.journal;
      if (!keep.subject && r.subject) keep.subject = r.subject;
    });
    keep.relatedDois = (keep.relatedDois || []).concat(related);
    keep.searchTerms = Object.keys(termSet);
    keep.sources = Object.keys(sourceSet);
    keep.evidence = best;
    keep.cited = cited;
    console.log('  [' + g.length + '→1] ' + String(keep.title).substring(0, 60));
    console.log('        kept ' + keep.doi + '  (folded: ' + related.join(', ') + ')');
  });

  const finalRecords = records.filter(function(r) { return !remove[r.doi]; });

  console.log('\nGroups consolidated: ' + groupCount
    + ' | records removed: ' + (records.length - finalRecords.length)
    + ' | corpus: ' + records.length + ' → ' + finalRecords.length);

  if (DRY) { console.log('\nDry run — nothing written.'); return; }
  pubData.records = finalRecords;
  pubData.metadata = pubData.metadata || {};
  pubData.metadata.total_count = finalRecords.length;
  pubData.metadata.consolidated = new Date().toISOString();
  fs.writeFileSync(PUB_FILE, JSON.stringify(pubData, null, 2));
  console.log('Wrote ' + PUB_FILE);
}

run();
