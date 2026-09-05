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
// The first author's FAMILY name, however the source wrote it. Taking the
// last whitespace token (the old rule) returns the given name whenever the
// source writes "Family, Given" — so "Alfonso, Christopher P." keyed as "p."
// while "Christopher Alfonso" keyed as "alfonso", and the same work sat in
// two groups. Comma form wins if present; particles (van, de, del...) are
// dropped so "van Hinsbergen, Douwe" and "D. J. van Hinsbergen" agree.
const NAME_PARTICLES = new Set(['van', 'von', 'de', 'del', 'della', 'der', 'den',
  'di', 'da', 'dos', 'du', 'la', 'le', 'los', 'mac', 'mc', 'st', 'ter', 'ten']);
function firstFamily(a) {
  let first = String(a || '').split(';')[0].trim();
  if (!first) return '';
  if (first.indexOf(',') !== -1) first = first.split(',')[0];      // "Family, Given"
  const parts = first.toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  while (parts.length > 1 && NAME_PARTICLES.has(parts[0])) parts.shift();
  return parts.length ? parts[parts.length - 1] : '';
}
function isPreprint(doi) {
  // Copernicus discussion papers carry the submission year in the DOI
  // (10.5194/essd-2020-336) and are superseded by the accepted article
  // (10.5194/essd-13-1371-2021) — a different year, hence the year-free pass.
  if (/^10\.5194\/[a-z]+-\d{4}-\d+$/.test(doi)) return true;
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

  // ── Not research outputs ────────────────────────────────────────────────
  // Two kinds of record reach the corpus through DOI searches but are not
  // publications, and both were inflating headline tiers:
  //   1. Data deposits and supplementary material (Zenodo/Figshare datasets,
  //      "Supplementary Information to ...", front/back matter). AuScope's
  //      datasets are counted in the datasets pillar; counting a data deposit
  //      here too would double-count the same output under two headings.
  //   2. Member-magazine front matter and standing columns. ASEG's Preview
  //      types these as "article", so the type field cannot see them — the
  //      title pattern can ("Editor's Desk", "ASEG Branch news", "Issue 207").
  //      Substantive Preview articles are deliberately KEPT; only the
  //      recurring non-article furniture is dropped.
  const EXCLUDED_TYPES = ['dataset', 'supplementary materials', 'paratext'];
  const MAGAZINE_COLUMN = /^(editor.?s desk|executive brief|welcome to new members|preview number|issue \d+|.*branch news|.*: news$|data trends|president.?s (piece|report)|new members|obituar|from the president|letters? to the editor|conference calendar|calendar|advertisers? index|table of contents|front matter|back matter|masthead)/i;
  const nonOutput = function(r) {
    if (EXCLUDED_TYPES.indexOf(String(r.type || '').toLowerCase()) !== -1) return 'type:' + r.type;
    if (MAGAZINE_COLUMN.test(String(r.title || '').trim())) return 'magazine column';
    return null;
  };
  const dropped = records.filter(function(r) { return nonOutput(r); });
  if (dropped.length) {
    const byReason = {};
    dropped.forEach(function(r) {
      const k = nonOutput(r).indexOf('type:') === 0 ? nonOutput(r) : 'magazine column';
      byReason[k] = (byReason[k] || 0) + 1;
    });
    console.log('Removed ' + dropped.length + ' records that are not research outputs:');
    Object.keys(byReason).sort().forEach(function(k) {
      console.log('    ' + String(byReason[k]).padStart(3) + '  ' + k);
    });
    records = records.filter(function(r) { return !nonOutput(r); });
  }

  // Withdrawn and retracted papers are not research outputs and must not sit
  // inside an impact count. Publishers signal this in the title ("WITHDRAWN:",
  // "RETRACTED ARTICLE:"), which is the only marker present in this corpus.
  const isWithdrawn = function(r) {
    return /^\s*(withdrawn|retracted)\b/i.test(String(r.title || ''));
  };
  const withdrawn = records.filter(isWithdrawn);
  if (withdrawn.length) {
    console.log('Removed ' + withdrawn.length + ' withdrawn/retracted papers:');
    withdrawn.forEach(function(r) {
      console.log('    ' + r.doi + '  [' + (r.evidence || '?') + ']  ' + String(r.title).substring(0, 60));
    });
    records = records.filter(function(r) { return !isWithdrawn(r); });
  }
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

  // Two independent same-work signals, merged with a union-find so either one
  // is enough: (a) normalised title + first author's family name + year, and
  // (b) a shared versioned-DOI base — 10.6084/m9.figshare.32101921.v1 and
  // ...32101921 are one Figshare item even though the later version retitled
  // itself "... Final", which defeats title matching on its own.
  const parent = {};
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  records.forEach(function(r) { parent[r.doi] = r.doi; });

  const byKey = {};
  records.forEach(function(r) {
    const t = normTitle(r.title);
    if (t) {
      const k = 't|' + t + '|' + firstFamily(r.authors) + '|' + (r.year || '');
      if (byKey[k]) union(r.doi, byKey[k]); else byKey[k] = r.doi;
    }
    const base = normDoi(r.doi).replace(/\.v\d+$/, '');
    if (base) {
      const k2 = 'd|' + base;
      if (byKey[k2]) union(r.doi, byKey[k2]); else byKey[k2] = r.doi;
    }
  });

  // Preprint -> published pairs almost never share a year, so the year in the
  // key above blocks exactly the case this script exists to catch. Repeat the
  // match without the year, but ONLY where a preprint is involved and the
  // years are close. Without that guard this would merge recurring magazine
  // columns that legitimately share a title across issues ("Editor's Desk",
  // "ASEG Branch news", "Geoscience Australia: News").
  const noYear = {};
  records.forEach(function(r) {
    const t = normTitle(r.title);
    if (!t) return;
    const k = t + '|' + firstFamily(r.authors);
    (noYear[k] = noYear[k] || []).push(r);
  });
  Object.keys(noYear).forEach(function(k) {
    const bucket = noYear[k];
    if (bucket.length < 2) return;
    const pres = bucket.filter(function(r) { return isPreprint(normDoi(r.doi)); });
    if (!pres.length) return;                       // no preprint: leave alone
    const others = bucket.filter(function(r) { return pres.indexOf(r) === -1; });
    pres.forEach(function(pre) {
      const py = parseInt(pre.year) || 0;
      const near = (others.length ? others : pres.filter(function(x) { return x !== pre; }))
        .filter(function(o) { const oy = parseInt(o.year) || 0; return !py || !oy || Math.abs(oy - py) <= 3; });
      if (near.length) union(pre.doi, near[0].doi);
    });
  });

  const groups = {};
  records.forEach(function(r) {
    const root = find(r.doi);
    (groups[root] = groups[root] || []).push(r);
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
