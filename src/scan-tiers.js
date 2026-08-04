#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Tier Classification Scanner
 *
 * Classifies every paper in publications.json into one of:
 *   - tier1     : AuScope-attributed (counts in NCRIS headline)
 *   - tier2     : AuScope-infrastructure-enabled (separate impact line)
 *   - tier3     : AuScope-software-used (separate impact line)
 *   - dropped   : matched a drop_entirely pattern with no other tier signal
 *   - unmatched : no signals — needs review (manual entries usually land here)
 *
 * Strategy
 * ────────
 * Phase A: bulk Europe PMC ACK_FUND searches (fast, full-text in ack/fund sections).
 *          One search per pattern returns ALL matching DOIs at once; we intersect
 *          with publications.json. This catches the bulk of tier 1 hits cleanly.
 * Phase B: for every paper, scan the local title + abstract text for all patterns.
 *          This catches:
 *            - papers Europe PMC hasn't indexed (preprints, EGU abstracts, theses)
 *            - patterns that aren't in Europe PMC ACK_FUND (e.g. tier 1 named
 *              infrastructure mentioned in introduction text rather than ack)
 * Phase C: assign each paper to the highest tier it matched. Apply drop logic.
 *
 * Output
 * ──────
 *   data/publications-tagged.json — same records as publications.json plus:
 *     tier:         tier1 | tier2 | tier3 | dropped | unmatched
 *     tierEvidence: [{ tier, pattern, section, source }]
 *
 * Usage
 * ─────
 *   node src/scan-tiers.js                   # full scan
 *   node src/scan-tiers.js --sample=50       # first 50 papers (for testing)
 *   node src/scan-tiers.js --skip-europepmc  # local abstracts only (faster, less recall)
 *   node src/scan-tiers.js --quiet           # less console output
 */

const fs = require('fs');
const path = require('path');

const FACILITY_FILE      = path.join(__dirname, '..', 'data', 'facility-names.json');
const PUBLICATIONS_FILE  = path.join(__dirname, '..', 'data', 'publications.json');
const VERIFIED_FILE      = path.join(__dirname, '..', 'data', 'publications-verified.json');
const OUTPUT_FILE        = path.join(__dirname, '..', 'data', 'publications-tagged.json');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const m = argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : (argv.includes(`--${n}`) ? true : d);
};
const SAMPLE        = parseInt(arg('sample', '0'), 10);
const SKIP_EUROPEPMC = !!arg('skip-europepmc', false);
const QUIET         = !!arg('quiet', false);
const log = (...a) => { if (!QUIET) console.log(...a); };

// ─── Helpers ────────────────────────────────────────────────────────────────

function normaliseDoi(d) {
  return (d || '').toString().toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '').trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchJSON(url, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1500 * i));
    let resp;
    try { resp = await fetch(url); }
    catch (e) { if (i === retries) throw e; continue; }
    if (resp.status === 404) return null;
    if (resp.ok) return resp.json();
    if (resp.status === 429 || resp.status >= 500) continue;
    let body = '';
    try { body = (await resp.text()).slice(0, 200); } catch (_) {}
    throw new Error(`HTTP ${resp.status} ${url.split('?')[0]} — ${body}`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Pattern compilation ────────────────────────────────────────────────────

/**
 * Flatten facility-names.json into a list of patterns with provenance.
 * Each entry: { tier, facility, pattern, regex }
 */
function compilePatterns(facCfg) {
  const out = [];

  for (const p of (facCfg.tier1_auscope_ack.patterns || [])) {
    out.push({ tier: 'tier1', facility: 'AuScope', pattern: p, regex: new RegExp(escapeRegex(p), 'i') });
  }
  for (const p of (facCfg.tier1_named_infrastructure.patterns || [])) {
    out.push({ tier: 'tier1', facility: 'Named infrastructure', pattern: p, regex: new RegExp(escapeRegex(p), 'i') });
  }

  for (const [fname, def] of Object.entries(facCfg.tier2_data_use.facilities || {})) {
    for (const p of (def.patterns || [])) {
      out.push({ tier: 'tier2', facility: fname, pattern: p, regex: new RegExp(escapeRegex(p), 'i') });
    }
  }

  for (const [fname, def] of Object.entries(facCfg.tier3_software_use.facilities || {})) {
    for (const p of (def.patterns || [])) {
      out.push({ tier: 'tier3', facility: fname, pattern: p, regex: new RegExp(escapeRegex(p), 'i') });
    }
  }

  for (const p of (facCfg.drop_entirely.patterns || [])) {
    out.push({ tier: 'drop', facility: 'Drop', pattern: p, regex: new RegExp(escapeRegex(p), 'i') });
  }

  return out;
}

function compileDropContextCues(facCfg) {
  return (facCfg.drop_facility_mentions.context_cues || []).map(c => ({
    cue: c, regex: new RegExp(escapeRegex(c), 'i')
  }));
}

// ─── Phase A: Europe PMC ACK_FUND bulk search ──────────────────────────────

/**
 * For each tier1 pattern, query Europe PMC for papers whose ack/funding text
 * contains it. Build a map: doi → [{ pattern, section: 'ack_fund' }]
 *
 * Europe PMC syntax: ACK_FUND:"AuScope" — query their REST API,
 * paginate via cursorMark, harvest all DOIs.
 */
async function europePmcAckFund(query) {
  const hits = [];
  let cursor = '*';
  let totalHits = 0;

  for (let page = 0; page < 50; page++) {
    const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'
      + `?query=${encodeURIComponent('ACK_FUND:"' + query + '"')}`
      + '&format=json'
      + '&pageSize=100'
      + `&cursorMark=${encodeURIComponent(cursor)}`;

    let data;
    try { data = await fetchJSON(url); }
    catch (e) {
      log(`    europePMC error: ${e.message}`);
      break;
    }
    if (!data || !data.resultList) break;

    if (page === 0) totalHits = data.hitCount || 0;

    for (const r of (data.resultList.result || [])) {
      const doi = normaliseDoi(r.doi);
      if (doi) hits.push(doi);
    }

    const next = data.nextCursorMark;
    if (!next || next === cursor) break;
    cursor = next;
    await sleep(200);
  }

  return { hits, totalHits };
}

async function buildEuropePmcMap(patterns) {
  // Only run for patterns that make sense as ACK_FUND queries (tier 1 mainly).
  // Tier 2/3 patterns work too — anyone whose acknowledgement section
  // mentions GPlates is a software user we'd want to count.
  const map = {};
  const queryablePatterns = patterns.filter(p => p.tier !== 'drop' && p.pattern.length >= 4);

  log(`\n[Phase A] Europe PMC ACK_FUND: querying ${queryablePatterns.length} patterns ...`);

  for (const p of queryablePatterns) {
    process.stdout.write(`  ${p.tier.padEnd(5)}  ${p.pattern.slice(0, 50).padEnd(50)} `);
    const { hits, totalHits } = await europePmcAckFund(p.pattern);
    if (!QUIET) console.log(`${hits.length}/${totalHits} DOIs`);
    for (const doi of hits) {
      if (!map[doi]) map[doi] = [];
      map[doi].push({ tier: p.tier, facility: p.facility, pattern: p.pattern, section: 'ack_fund' });
    }
    await sleep(150);
  }

  log(`  → ${Object.keys(map).length} unique DOIs from Europe PMC`);
  return map;
}

// ─── Phase B: local text scan ──────────────────────────────────────────────

/**
 * Scan the title + abstract of each publication for every pattern.
 * Returns an array of { pattern, facility, tier, section } per match.
 *
 * publications.json records may not have abstracts (older shapes don't).
 * We scan whatever text is available — title is always present.
 */
function scanLocal(rec, patterns) {
  const text = [
    rec.title || '',
    rec.abstract || '',
    rec.subject || '',
    (rec.searchTerms || []).join(' ')
  ].join(' \n ');

  const hits = [];
  for (const p of patterns) {
    if (p.regex.test(text)) {
      hits.push({
        tier: p.tier,
        facility: p.facility,
        pattern: p.pattern,
        section: 'local_text'
      });
    }
  }
  return hits;
}

// ─── Phase C: tier assignment ──────────────────────────────────────────────

const TIER_RANK = { tier1: 4, tier2: 3, tier3: 2, drop: 1 };

/**
 * Given all hits for a paper (Phase A + Phase B), pick the final tier.
 * Apply drop_facility_mentions context cues, and apply drop_entirely with
 * the rule: drop only takes effect if no tier1/tier2/tier3 also matched.
 */
function assignTier(hits, paper, dropCues) {
  if (hits.length === 0) return { tier: 'unmatched', evidence: [] };

  const realTiers = hits.filter(h => h.tier !== 'drop');
  const drops     = hits.filter(h => h.tier === 'drop');

  if (realTiers.length === 0 && drops.length > 0) {
    return { tier: 'dropped', evidence: drops };
  }

  // Highest tier wins (tier1 > tier2 > tier3)
  let best = realTiers[0];
  for (const h of realTiers) {
    if (TIER_RANK[h.tier] > TIER_RANK[best.tier]) best = h;
  }

  // If picked tier is tier2, check drop_facility_mentions context cues:
  // if the tier2 hit appears alongside one of the cues (mention-not-use),
  // demote the paper to unmatched.
  if (best.tier === 'tier2') {
    const text = [paper.title || '', paper.abstract || ''].join(' \n ');
    for (const c of dropCues) {
      if (c.regex.test(text)) {
        return {
          tier: 'unmatched',
          evidence: [{ ...best, demoted_by: c.cue }]
        };
      }
    }
  }

  return { tier: best.tier, evidence: realTiers };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function run() {
  const facCfg   = JSON.parse(fs.readFileSync(FACILITY_FILE, 'utf8'));
  const patterns = compilePatterns(facCfg);
  const dropCues = compileDropContextCues(facCfg);

  let pubs = JSON.parse(fs.readFileSync(PUBLICATIONS_FILE, 'utf8'));
  if (!Array.isArray(pubs)) pubs = pubs.records || [];
  if (SAMPLE > 0) pubs = pubs.slice(0, SAMPLE);

  log('AuScope Tier Classification Scanner');
  log('===================================');
  log(`Records to scan : ${pubs.length}`);
  log(`Patterns loaded : ${patterns.length} (${patterns.filter(p => p.tier === 'tier1').length} tier1, ${patterns.filter(p => p.tier === 'tier2').length} tier2, ${patterns.filter(p => p.tier === 'tier3').length} tier3, ${patterns.filter(p => p.tier === 'drop').length} drop)`);
  log(`Drop context cues: ${dropCues.length}`);

  // Phase A: Europe PMC bulk
  let europeMap = {};
  if (!SKIP_EUROPEPMC) {
    europeMap = await buildEuropePmcMap(patterns);
  } else {
    log('\n[Phase A] Skipped (--skip-europepmc)');
  }

  // Phase B: per-paper local scan + tier assignment
  log('\n[Phase B+C] Scanning local text and assigning tiers ...');
  const tagged = [];
  let count = { tier1: 0, tier2: 0, tier3: 0, dropped: 0, unmatched: 0 };

  for (let i = 0; i < pubs.length; i++) {
    const rec = pubs[i];
    const doi = normaliseDoi(rec.doi);

    const europeHits = (doi && europeMap[doi]) ? europeMap[doi] : [];
    const localHits  = scanLocal(rec, patterns);
    const allHits    = [...europeHits, ...localHits];
    // Dedupe: same (tier, pattern, section) only counts once
    const seen = new Set();
    const uniqHits = allHits.filter(h => {
      const k = `${h.tier}|${h.pattern}|${h.section}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const { tier, evidence } = assignTier(uniqHits, rec, dropCues);
    count[tier] = (count[tier] || 0) + 1;

    tagged.push({ ...rec, tier, tierEvidence: evidence });

    if (!QUIET && (i + 1) % 250 === 0) {
      log(`  ... scanned ${i + 1}/${pubs.length}`);
    }
  }

  // Phase D: write output
  const out = {
    metadata: {
      generated:    new Date().toISOString(),
      total:        tagged.length,
      counts:       count,
      patterns_used: patterns.length,
      europepmc_used: !SKIP_EUROPEPMC,
      facility_file: 'data/facility-names.json'
    },
    records: tagged
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));

  // ─── Summary ───
  log('\n─── Tier Distribution ───');
  log(`  tier1     (AuScope-attributed)      : ${count.tier1}`);
  log(`  tier2     (AuScope-enabled)         : ${count.tier2}`);
  log(`  tier3     (AuScope-software-used)   : ${count.tier3}`);
  log(`  dropped   (drop_entirely match)     : ${count.dropped}`);
  log(`  unmatched (no signal — needs review): ${count.unmatched}`);
  log(`\nWrote ${OUTPUT_FILE}`);

  // Show a few examples per tier
  if (!QUIET) {
    for (const t of ['tier1', 'tier2', 'tier3', 'dropped']) {
      const sample = tagged.filter(r => r.tier === t).slice(0, 3);
      if (sample.length === 0) continue;
      log(`\nSample ${t}:`);
      for (const r of sample) {
        const ev = r.tierEvidence[0] || {};
        log(`  ${r.year || '????'}  ${(r.title || '').slice(0, 80)}`);
        log(`         ${r.doi}  via ${ev.pattern} [${ev.section}]`);
      }
    }
  }
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});