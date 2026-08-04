#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Identifier-based Verified Discovery
 *
 * Queries OpenAlex by:
 *   1. AuScope ROR ID(s) → tier "verified"
 *   2. AuScope/NCRIS funder ID(s) → tier "verified"
 *   3. Watchlist ORCIDs → tier depends on corroboration:
 *        - already verified by ROR/funder → just adds ORCID as supporting signal
 *        - co-affiliated with an AuScope partner ROR → "candidate-strong"
 *        - no other signal → "candidate-review" (NOT counted in headline)
 *
 * Outputs:
 *   data/publications-verified.json  — verified + candidate-strong
 *   data/publications-review.json    — candidate-review (human gate)
 *
 * Usage: node src/verified.js
 */

const fs = require('fs');
const path = require('path');

let utils;
try {
  utils = require('./utils');
} catch (e) {
  utils = {
    fetchJSON: async (url, opts = {}) => {
      const headers = opts.headers || {};
      for (let attempt = 0; attempt <= 3; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 3000 * attempt));
        const resp = await fetch(url, { headers });
        if (resp.status === 404) return {};
        if (resp.ok) return resp.json();
        if (resp.status === 429 || resp.status >= 500) continue;
        let body = '';
        try { body = (await resp.text()).slice(0, 200); } catch (_) {}
        throw new Error('HTTP ' + resp.status + ' ' + url.split('?')[0] + (body ? ' — ' + body : ''));
      }
      throw new Error('retries exhausted: ' + url.split('?')[0]);
    },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    normaliseDoi: d => (d || '').toString().toLowerCase()
      .replace(/^https?:\/\/doi\.org\//i, '').replace(/^doi:/i, '').trim(),
    stripHtml: s => (s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  };
}
const { fetchJSON, sleep, normaliseDoi, stripHtml } = utils;

const CONFIG_FILE   = path.join(__dirname, '..', 'data', 'verified-config.json');
const VERIFIED_FILE = path.join(__dirname, '..', 'data', 'publications-verified.json');
const REVIEW_FILE   = path.join(__dirname, '..', 'data', 'publications-review.json');

// ─── OpenAlex pagination helper ─────────────────────────────────────────────

/**
 * Fetch all OpenAlex works matching `field:value`. The filter operator (colon
 * and comma) MUST stay literal in the URL — only the value is URL-encoded.
 * Year range is appended literally.
 */
async function fetchAllWorks(field, value, opts) {
  const { email, perPage = 200, maxPages = 50, minYear = 0 } = opts;
  const currentYear = new Date().getFullYear();
  const yearRange = minYear ? `,publication_year:${minYear}-${currentYear}` : '';
  const filterExpr = `${field}:${encodeURIComponent(value)}${yearRange}`;

  const works = [];
  let cursor = '*';
  let page = 0;
  let firstUrl = null;

  while (cursor && page < maxPages) {
    const url = 'https://api.openalex.org/works'
      + '?filter=' + filterExpr
      + '&per_page=' + perPage
      + '&cursor=' + encodeURIComponent(cursor)
      + '&select=id,doi,title,publication_year,authorships,primary_location,cited_by_count,type,open_access,topics'
      + '&mailto=' + encodeURIComponent(email);

    if (page === 0) firstUrl = url;

    let data;
    try {
      data = await fetchJSON(url);
    } catch (err) {
      console.error('  fetch error: ' + err.message);
      if (page === 0) console.error('  url was: ' + firstUrl);
      break;
    }

    const results = data.results || [];
    if (results.length === 0) break;
    works.push(...results);

    cursor = data.meta && data.meta.next_cursor ? data.meta.next_cursor : null;
    page++;
    await sleep(120);
  }

  return works;
}

// ─── Work → record normalisation ────────────────────────────────────────────

function normaliseWork(w) {
  const doi = w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//i, '') : '';
  const authorships = w.authorships || [];
  const authors = authorships.map(a => a.author && a.author.display_name).filter(Boolean);
  const loc = w.primary_location || {};
  const src = loc.source || {};

  const instSet = {}, countrySet = {}, rorSet = {}, orcidSet = {}, authorIdSet = {};
  for (const a of authorships) {
    if (a.author) {
      if (a.author.id) authorIdSet[a.author.id] = a.author.display_name || '';
      if (a.author.orcid) orcidSet[a.author.orcid.replace(/^https?:\/\/orcid\.org\//i, '')] = true;
    }
    for (const inst of (a.institutions || [])) {
      if (inst.display_name) instSet[inst.display_name] = true;
      if (inst.country_code) countrySet[inst.country_code] = true;
      if (inst.ror) rorSet[inst.ror.replace(/^https?:\/\/ror\.org\//i, '')] = true;
    }
  }

  return {
    doi: doi.toLowerCase(),
    title: stripHtml(w.title || '') || 'Untitled',
    authors: authors.join('; '),
    journal: src.display_name || '',
    publisher: src.host_organization_name || '',
    year: w.publication_year || null,
    cited: w.cited_by_count || 0,
    type: (w.type || '').replace(/-/g, ' '),
    isOA: w.open_access ? (w.open_access.is_oa ? 'Yes' : 'No') : 'Unknown',
    subject: (w.topics || []).slice(0, 3).map(t => t.display_name).join('; '),
    sources: ['OpenAlex (verified)'],
    authorCount: authors.length,
    institutions: Object.keys(instSet),
    countries: Object.keys(countrySet),
    rors: Object.keys(rorSet),
    authorIds: Object.keys(authorIdSet),
    authorOrcids: Object.keys(orcidSet),
    attribution: 'unset',
    verifiedBy: []
  };
}

// ─── Tier merging logic ─────────────────────────────────────────────────────

const TIER_RANK = { 'candidate-review': 0, 'candidate-strong': 1, 'verified': 2 };

function promote(record, newTier, signal) {
  if (TIER_RANK[newTier] > TIER_RANK[record.attribution || 'candidate-review']) {
    record.attribution = newTier;
  }
  if (signal && !record.verifiedBy.includes(signal)) {
    record.verifiedBy.push(signal);
  }
}

function addOrUpdate(map, doi, work, tier, signal) {
  if (!doi) return;
  if (!map[doi]) {
    map[doi] = normaliseWork(work);
    map[doi].attribution = tier;
    map[doi].verifiedBy = [signal];
  } else {
    promote(map[doi], tier, signal);
  }
}

// ─── Main run ───────────────────────────────────────────────────────────────

async function run() {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const fetchOpts = {
    email: config.email,
    perPage: config.per_page || 200,
    maxPages: config.max_pages_per_query || 50,
    minYear: config.min_year || 0
  };

  const records = {};

  console.log('AuScope Verified Discovery');
  console.log('==========================\n');

  // 1. ROR queries
  for (const ror of (config.auscope_rors || [])) {
    process.stdout.write(`[ROR ${ror}] querying ... `);
    const works = await fetchAllWorks('authorships.institutions.ror', ror, fetchOpts);
    console.log(`${works.length} works`);
    for (const w of works) {
      const doi = normaliseDoi(w.doi);
      addOrUpdate(records, doi, w, 'verified', `ror:${ror}`);
    }
  }

  // 2. Funder ID queries
  for (const fid of (config.funder_ids || [])) {
    process.stdout.write(`[Funder ${fid}] querying ... `);
    const works = await fetchAllWorks('grants.funder', fid, fetchOpts);
    console.log(`${works.length} works`);
    for (const w of works) {
      const doi = normaliseDoi(w.doi);
      addOrUpdate(records, doi, w, 'verified', `funder:${fid}`);
    }
  }

  // 3. ORCID queries (discovery → corroboration check)
  const partnerSet = new Set((config.partner_rors || []).map(r => r.toLowerCase()));
  for (const orcid of (config.researcher_orcids || [])) {
    process.stdout.write(`[ORCID ${orcid}] querying ... `);
    const works = await fetchAllWorks(
      'authorships.author.orcid',
      `https://orcid.org/${orcid}`,
      fetchOpts
    );
    console.log(`${works.length} works`);

    for (const w of works) {
      const doi = normaliseDoi(w.doi);
      if (!doi) continue;

      if (records[doi] && records[doi].attribution === 'verified') {
        promote(records[doi], 'verified', `orcid:${orcid}`);
        continue;
      }

      const workRors = new Set();
      for (const a of (w.authorships || [])) {
        for (const inst of (a.institutions || [])) {
          if (inst.ror) {
            workRors.add(inst.ror.replace(/^https?:\/\/ror\.org\//i, '').toLowerCase());
          }
        }
      }
      const partnerHit = [...workRors].find(r => partnerSet.has(r));
      if (partnerHit) {
        addOrUpdate(records, doi, w, 'candidate-strong', `orcid:${orcid}`);
        promote(records[doi], 'candidate-strong', `partner-ror:${partnerHit}`);
      } else {
        addOrUpdate(records, doi, w, 'candidate-review', `orcid:${orcid}`);
      }
    }
  }

  // ─── Split & write ───
  const verified = [], review = [];
  for (const r of Object.values(records)) {
    if (r.attribution === 'verified' || r.attribution === 'candidate-strong') {
      verified.push(r);
    } else {
      review.push(r);
    }
  }

  verified.sort((a, b) => (b.year || 0) - (a.year || 0));
  review.sort((a, b) => (b.year || 0) - (a.year || 0));

  const meta = (recs, label) => ({
    type: label,
    last_updated: new Date().toISOString(),
    total_count: recs.length,
    by_tier: recs.reduce((acc, r) => {
      acc[r.attribution] = (acc[r.attribution] || 0) + 1;
      return acc;
    }, {})
  });

  fs.writeFileSync(VERIFIED_FILE, JSON.stringify({
    metadata: meta(verified, 'verified'),
    records: verified
  }, null, 2));

  fs.writeFileSync(REVIEW_FILE, JSON.stringify({
    metadata: meta(review, 'review'),
    records: review
  }, null, 2));

  console.log('\n─── Summary ───');
  console.log('Verified (ROR/funder)           : ' + verified.filter(r => r.attribution === 'verified').length);
  console.log('Candidate-strong (ORCID+partner): ' + verified.filter(r => r.attribution === 'candidate-strong').length);
  console.log('Candidate-review (ORCID only)   : ' + review.length);
  console.log('\nWrote ' + VERIFIED_FILE);
  console.log('Wrote ' + REVIEW_FILE);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});