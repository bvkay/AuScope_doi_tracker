#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Evidence Ladder
 *
 * Merges the two attribution systems into one `evidence` field on every
 * publications.json record, best evidence wins:
 *
 *   verified          identifier evidence: AuScope ROR/funder ID
 *                     (publications-verified.json, attribution=verified)
 *   candidate         watchlist ORCID + partner-institution co-affiliation
 *                     (publications-verified.json, attribution=candidate-strong)
 *   text-attributed   AuScope acknowledged in text (scan-tiers tier1)
 *   text-infrastructure  infrastructure-enabled wording (tier2)
 *   text-software     AuScope software used (tier3)
 *   keyword           found by keyword search only — no confirmed signal
 *
 * ROR-verified works missing from the corpus are appended (they are
 * definitionally AuScope publications); candidate-strong misses are listed
 * in data/evidence-candidates.json for human review, never auto-added.
 *
 * Run AFTER verified.js and (when refreshed) scan-tiers.js, BEFORE stats.js.
 * Usage: node src/evidence.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PUB_FILE = path.join(DATA_DIR, 'publications.json');

function normDoi(s) {
  if (!s) return '';
  return String(s).trim().replace(/^https?:\/\/(www\.)?(dx\.)?doi\.org\//i, '').toLowerCase();
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { /* fall through */ }
  return fallback;
}

function run() {
  console.log('AuScope Evidence Ladder');
  console.log('=======================\n');

  const pubData = readJson(PUB_FILE, null);
  if (!pubData || !pubData.records) {
    console.error('No publications.json — nothing to tag.');
    process.exit(1);
  }

  const verified = (readJson(path.join(DATA_DIR, 'publications-verified.json'), {}).records) || [];
  const tagged = (readJson(path.join(DATA_DIR, 'publications-tagged.json'), {}).records) || [];

  const idMap = {};   // doi -> { attribution, verifiedBy }
  verified.forEach(function(r) {
    const k = normDoi(r.doi);
    if (k) idMap[k] = { attribution: r.attribution, verifiedBy: r.verifiedBy };
  });
  const tierMap = {}; // doi -> tier1/tier2/tier3/dropped/unmatched
  tagged.forEach(function(r) {
    const k = normDoi(r.doi);
    if (k && r.tier) tierMap[k] = r.tier;
  });

  const TIER_EVIDENCE = {
    tier1: 'text-attributed',
    tier2: 'text-infrastructure',
    tier3: 'text-software'
  };

  // Self-healing: records that entered the corpus ONLY as ROR-verified
  // auto-appends are removed again if the current verified run no longer
  // confirms them (e.g. after tightening the mis-affiliation guard).
  const beforeHeal = pubData.records.length;
  pubData.records = pubData.records.filter(function(p) {
    const terms = p.searchTerms || [];
    if (!(terms.length === 1 && terms[0] === 'ROR-verified')) return true;
    const id = idMap[normDoi(p.doi)];
    return !!(id && id.attribution === 'verified');
  });
  const healed = beforeHeal - pubData.records.length;
  if (healed) console.log('Self-heal: removed ' + healed + ' auto-appended records no longer identifier-confirmed.');

  const counts = {};
  const inCorpus = {};
  pubData.records.forEach(function(p) {
    const k = normDoi(p.doi);
    inCorpus[k] = true;
    const id = idMap[k];
    let evidence, detail;
    if (id && id.attribution === 'verified') {
      evidence = 'verified';
      detail = (id.verifiedBy || []).join
        ? (id.verifiedBy || []).join('; ')
        : String(id.verifiedBy || 'AuScope ROR/funder match');
    } else if (id && id.attribution === 'candidate-strong') {
      evidence = 'candidate';
      detail = 'watchlist ORCID + partner co-affiliation';
    } else if (TIER_EVIDENCE[tierMap[k]]) {
      evidence = TIER_EVIDENCE[tierMap[k]];
      detail = 'text scan (' + tierMap[k] + ')';
    } else {
      evidence = 'keyword';
      detail = '';
    }
    p.evidence = evidence;
    if (detail) p.evidenceDetail = detail; else delete p.evidenceDetail;
    counts[evidence] = (counts[evidence] || 0) + 1;
  });

  // ── Append ROR-verified works missing from the corpus ──
  const today = new Date().toISOString().substring(0, 10);
  let added = 0;
  const candidateMisses = [];
  const excludedPrefixes = (readJson(path.join(__dirname, '..', 'config.json'), {}).excluded_doi_prefixes) || [];
  // DOIs folded into another record by consolidate.js must never be
  // re-appended as "missing" — they are the same work under another DOI.
  const foldedSet = {};
  pubData.records.forEach(function(p) {
    (p.relatedDois || []).forEach(function(d) { foldedSet[normDoi(d)] = true; });
  });
  verified.forEach(function(r) {
    const k = normDoi(r.doi);
    if (!k || inCorpus[k] || foldedSet[k]) return;
    // Infrastructure DOIs (datasets/instruments) never join the corpus.
    if (excludedPrefixes.some(function(p) { return k.indexOf(p.toLowerCase() + '/') === 0; })) return;
    if (r.attribution === 'verified') {
      const rec = Object.assign({}, r);
      delete rec.attribution;
      delete rec.authorIds;
      delete rec.authorOrcids;
      delete rec.rors;
      rec.dateAdded = today;
      rec.searchTerms = ['ROR-verified'];
      rec.evidence = 'verified';
      rec.evidenceDetail = String(r.verifiedBy || 'AuScope ROR match');
      pubData.records.push(rec);
      inCorpus[k] = true;
      counts.verified = (counts.verified || 0) + 1;
      added++;
    } else {
      candidateMisses.push({ doi: r.doi, title: r.title, year: r.year, journal: r.journal });
    }
  });

  // ── Human curation overrides (data/evidence-overrides.json) ──
  // Machine evidence is only as good as OpenAlex's affiliation matching;
  // this is the documented valve for correcting it. Each entry:
  //   { doi, action: 'remove' | 'grade', evidence?, reason }
  const overrides = readJson(path.join(DATA_DIR, 'evidence-overrides.json'), { records: [] }).records || [];
  if (overrides.length) {
    const removeSet = {}, gradeMap = {};
    overrides.forEach(function(o) {
      const k = normDoi(o.doi);
      if (!k) return;
      if (o.action === 'remove') removeSet[k] = o.reason || '';
      else if (o.action === 'grade' && o.evidence) gradeMap[k] = o;
    });
    const before = pubData.records.length;
    pubData.records = pubData.records.filter(function(p) {
      const k = normDoi(p.doi);
      if (removeSet[k] !== undefined) {
        counts[p.evidence] = (counts[p.evidence] || 1) - 1;
        return false;
      }
      return true;
    });
    pubData.records.forEach(function(p) {
      const o = gradeMap[normDoi(p.doi)];
      if (o && p.evidence !== o.evidence) {
        counts[p.evidence] = (counts[p.evidence] || 1) - 1;
        counts[o.evidence] = (counts[o.evidence] || 0) + 1;
        p.evidence = o.evidence;
        p.evidenceDetail = 'manual override: ' + (o.reason || 'curator decision');
      }
    });
    const removedN = before - pubData.records.length;
    if (removedN || Object.keys(gradeMap).length) {
      console.log('Overrides applied: ' + removedN + ' removed, ' + Object.keys(gradeMap).length + ' regraded.');
    }
  }

  pubData.metadata = pubData.metadata || {};
  pubData.metadata.evidence_updated = new Date().toISOString();
  fs.writeFileSync(PUB_FILE, JSON.stringify(pubData, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'evidence-candidates.json'),
    JSON.stringify({ generated: new Date().toISOString(), note: 'candidate-strong works not in the corpus — human review before adding', records: candidateMisses }, null, 2));

  console.log('Evidence distribution across ' + pubData.records.length + ' records:');
  ['verified', 'candidate', 'text-attributed', 'text-infrastructure', 'text-software', 'keyword'].forEach(function(e) {
    console.log('  ' + e + ': ' + (counts[e] || 0));
  });
  console.log('\nAppended ' + added + ' ROR-verified works new to the corpus.');
  console.log(candidateMisses.length + ' candidate-strong works held for review (data/evidence-candidates.json).');
}

run();
