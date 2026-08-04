#!/usr/bin/env node
/**
 * AuScope DOI Tracker — ORCID Watchlist Harvester
 *
 * Mines ORCIDs from authors of papers already in publications-verified.json
 * and publications-review.json. Ranks by frequency, looks up names and
 * institutions via OpenAlex, and outputs a candidate list to graze.
 *
 * The output is a CANDIDATE list, not an auto-add list. Read the CSV,
 * pick the ORCIDs that are clearly AuScope-relevant (researchers at partner
 * institutions, with multiple papers in the verified set), and add them
 * to data/verified-config.json. Then rerun verified.js to expand coverage.
 *
 * Usage:
 *   node src/harvest-orcids.js               # default: ≥3 papers, top 50 lookups
 *   node src/harvest-orcids.js --min=2       # lower frequency threshold
 *   node src/harvest-orcids.js --top=100     # look up more candidates
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE   = path.join(__dirname, '..', 'data', 'verified-config.json');
const VERIFIED_FILE = path.join(__dirname, '..', 'data', 'publications-verified.json');
const REVIEW_FILE   = path.join(__dirname, '..', 'data', 'publications-review.json');
const OUTPUT_FILE   = path.join(__dirname, '..', 'data', 'orcid-candidates.json');
const CSV_FILE      = path.join(__dirname, '..', 'data', 'orcid-candidates.csv');

const argv = process.argv.slice(2);
function arg(name, def) {
  const m = argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=')[1] : def;
}

const MIN_PAPERS = parseInt(arg('min', '3'), 10);
const TOP_N      = parseInt(arg('top', '50'), 10);

function csvEscape(s) {
  s = s == null ? '' : String(s);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function lookupAuthor(orcid, email) {
  const url = `https://api.openalex.org/authors/orcid:${encodeURIComponent(orcid)}`
    + `?select=display_name,last_known_institutions,works_count,cited_by_count`
    + (email ? `&mailto=${encodeURIComponent(email)}` : '');
  try {
    const resp = await fetch(url);
    if (resp.status === 404) return null;
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    const data = await resp.json();
    const inst = (data.last_known_institutions || [])[0] || {};
    return {
      name: data.display_name || '',
      institution: inst.display_name || '',
      country: inst.country_code || '',
      worksCount: data.works_count || 0,
      citedBy: data.cited_by_count || 0
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function run() {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const existing = new Set((config.researcher_orcids || []).map(o => o.toLowerCase()));
  const partnerSet = new Set((config.partner_rors || []).map(r => r.toLowerCase()));

  // ─── Mine ORCIDs from verified + review records ───
  const orcidStats = {};
  const sources = [
    { file: VERIFIED_FILE },
    { file: REVIEW_FILE }
  ];

  for (const src of sources) {
    if (!fs.existsSync(src.file)) continue;
    const data = JSON.parse(fs.readFileSync(src.file, 'utf8'));
    for (const rec of (data.records || [])) {
      const tier = rec.attribution || 'unknown';
      // Track which AuScope-partner RORs THIS record co-affiliates with — used to
      // up-weight ORCIDs that consistently appear at AuScope partners.
      const recPartners = (rec.rors || []).filter(r => partnerSet.has(r.toLowerCase()));

      for (const o of (rec.authorOrcids || [])) {
        const orcid = o.toLowerCase();
        if (!orcidStats[orcid]) {
          orcidStats[orcid] = {
            count: 0,
            tiers: {},
            partnerHits: 0,
            samplePapers: []
          };
        }
        const s = orcidStats[orcid];
        s.count++;
        s.tiers[tier] = (s.tiers[tier] || 0) + 1;
        if (recPartners.length > 0) s.partnerHits++;
        if (s.samplePapers.length < 3) {
          s.samplePapers.push({
            doi: rec.doi,
            year: rec.year,
            title: (rec.title || '').slice(0, 100)
          });
        }
      }
    }
  }

  // ─── Filter & rank ───
  const candidates = Object.entries(orcidStats)
    .filter(([orcid]) => !existing.has(orcid))
    .filter(([_, s]) => s.count >= MIN_PAPERS)
    .map(([orcid, s]) => ({ orcid, ...s }))
    // Score: papers + 2× partner-co-affiliations (rewards AuScope-context co-authorship)
    .sort((a, b) => (b.count + 2 * b.partnerHits) - (a.count + 2 * a.partnerHits));

  console.log(`Mined ${Object.keys(orcidStats).length} unique ORCIDs from verified+review records`);
  console.log(`Already in watchlist: ${[...existing].filter(o => orcidStats[o]).length}`);
  console.log(`New candidates (≥${MIN_PAPERS} papers): ${candidates.length}\n`);

  const topN = candidates.slice(0, TOP_N);
  if (topN.length === 0) {
    console.log('No new candidates above threshold. Try --min=2 to lower the bar.');
    return;
  }

  console.log(`Looking up names from OpenAlex for top ${topN.length} ...\n`);
  for (let i = 0; i < topN.length; i++) {
    const c = topN[i];
    process.stdout.write(`  [${(i + 1).toString().padStart(3)}/${topN.length}] ${c.orcid} ... `);
    const meta = await lookupAuthor(c.orcid, config.email);
    if (meta && !meta.error) {
      Object.assign(c, meta);
      console.log(`${meta.name || '(no name)'}${meta.institution ? ' — ' + meta.institution : ''}`);
    } else {
      c.name = ''; c.institution = ''; c.country = '';
      c.worksCount = 0; c.citedBy = 0;
      console.log(meta && meta.error ? `lookup error: ${meta.error}` : 'no record');
    }
    await new Promise(r => setTimeout(r, 150));
  }

  // ─── Write JSON ───
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    metadata: {
      generated: new Date().toISOString(),
      total_candidates: candidates.length,
      looked_up: topN.length,
      min_papers_threshold: MIN_PAPERS,
      partner_corroboration_weight: 2
    },
    candidates: topN
  }, null, 2));

  // ─── Write CSV (the useful artefact for human review) ───
  const lines = ['orcid,name,institution,country,papers_in_set,partner_co_affiliations,verified,strong,review,total_openalex_works,sample_title,sample_year'];
  for (const c of topN) {
    const t = c.tiers || {};
    const sample = c.samplePapers[0] || {};
    lines.push([
      c.orcid,
      csvEscape(c.name),
      csvEscape(c.institution),
      c.country,
      c.count,
      c.partnerHits,
      t['verified'] || 0,
      t['candidate-strong'] || 0,
      t['candidate-review'] || 0,
      c.worksCount,
      csvEscape(sample.title || ''),
      sample.year || ''
    ].join(','));
  }
  fs.writeFileSync(CSV_FILE, lines.join('\n'));

  console.log('\n─── Top 20 candidates by score (papers + 2× partner co-affiliations) ───\n');
  console.log('  ' + 'count'.padStart(5)
    + ' ' + 'partner'.padStart(7)
    + '  ' + 'orcid'.padEnd(20)
    + '  ' + 'name'.padEnd(30)
    + '  institution');
  for (const c of topN.slice(0, 20)) {
    console.log('  '
      + String(c.count).padStart(5)
      + ' ' + String(c.partnerHits).padStart(7)
      + '  ' + c.orcid.padEnd(20)
      + '  ' + (c.name || '?').padEnd(30).slice(0, 30)
      + '  ' + (c.institution || '?'));
  }

  console.log(`\nFull list: ${OUTPUT_FILE}`);
  console.log(`Spreadsheet-friendly: ${CSV_FILE}`);
  console.log(`\nNext step: open the CSV, pick the ORCIDs that are clearly AuScope-relevant,\n` +
              `add them to the "researcher_orcids" array in verified-config.json,\n` +
              `then rerun: node src/verified.js && node src/compare.js --csv`);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});