/**
 * Publication-date enrichment for financial-year reporting.
 *
 * Records carry an integer `year` only, which cannot place a publication
 * in an Australian financial year (Jul 1 – Jun 30). This pass fills a
 * `publicationDate` field (YYYY-MM-DD, or YYYY-MM when the day is
 * unknown) on every record that lacks one:
 *
 *   1. OpenAlex, batched — filter=doi:a|b|... 40 DOIs per request.
 *   2. Crossref, per-DOI — only for the residue OpenAlex missed, capped
 *      per run so a large residue drains over successive weekly runs.
 *
 * Existing publicationDate values are never overwritten. Best-effort:
 * fetch failures leave records undated and the script still exits 0.
 *
 * Wall-clock budget: ENRICH_BUDGET_MS (default 10 minutes). Every request
 * races the deadline, so a single throttled call cannot overrun it — on a
 * CI 429 storm fetchJSON honours Retry-After (5 x 120 s), which is how one
 * OpenAlex batch burned 10 minutes on 30 Sep 2026 before Crossref dated all
 * 17 DOIs in 3 s. OpenAlex may therefore spend at most HALF the budget; the
 * rest is kept for the Crossref fallback. On exhaustion each pass stops,
 * keeps what it filled, the file is written and the script exits 0.
 */

const fs = require('fs');
const path = require('path');
const { fetchJSON, sleep, normaliseDoi } = require('./utils');

const ROOT = path.join(__dirname, '..');
const PUB_FILE = path.join(ROOT, 'data', 'publications.json');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const OPENALEX_BATCH = 40;      // 50 is the API cap on piped filter values
const CROSSREF_CAP = 300;       // per-run ceiling on per-DOI fallback calls

const DEFAULT_BUDGET_MS = 10 * 60 * 1000;
const BUDGET_MS = (() => {
  const raw = process.env.ENRICH_BUDGET_MS;
  if (raw === undefined || raw === '') return DEFAULT_BUDGET_MS;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  console.warn('Ignoring invalid ENRICH_BUDGET_MS=' + JSON.stringify(raw)
    + '; using ' + DEFAULT_BUDGET_MS + ' ms');
  return DEFAULT_BUDGET_MS;
})();
const STARTED = Date.now();
const DEADLINE = STARTED + BUDGET_MS;
const OPENALEX_DEADLINE = STARTED + Math.floor(BUDGET_MS / 2);
let budgetExhausted = false;
const OA_NOTE = 'its half of the budget; the rest is kept for Crossref';
const secs = ms => (ms / 1000).toFixed(ms < 10000 ? 3 : 0) + ' s';

class BudgetExhausted extends Error {
  constructor() { super('wall-clock budget exhausted'); }
}

/**
 * fetchJSON raced against a deadline. Past the deadline the call is
 * abandoned rather than awaited — its retry loop may still be sleeping on a
 * Retry-After, which is why the script exits explicitly once the budget has
 * run out instead of waiting for the event loop to drain.
 */
function fetchWithin(deadline, url, opts) {
  const left = deadline - Date.now();
  if (left <= 0) return Promise.reject(new BudgetExhausted());
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BudgetExhausted()), left);
  });
  return Promise.race([fetchJSON(url, opts), expiry]).finally(() => clearTimeout(timer));
}

/** Crossref "batches" are single-DOI requests, so N and M match there. */
function logExhausted(source, batches, dois, note) {
  budgetExhausted = true;
  console.log('  ' + source + ': budget exhausted after ' + batches + ' batches / ' + dois + ' DOIs'
    + (note ? ' (' + note + ')' : ''));
}

/** Format Crossref/OpenAlex date parts, keeping only what is known. */
function formatDateParts(parts) {
  if (!Array.isArray(parts) || !parts[0]) return '';
  const y = String(parts[0]);
  if (!parts[1]) return '';                    // year-only adds nothing over `year`
  const m = String(parts[1]).padStart(2, '0');
  if (!parts[2]) return y + '-' + m;
  return y + '-' + m + '-' + String(parts[2]).padStart(2, '0');
}

/**
 * The most SPECIFIC usable date in a Crossref message — not the first field
 * that happens to be present (published-print is often year-only while
 * published-online carries the full date). Day-level beats month-level;
 * at equal specificity, print > issued > published > online.
 */
function bestCrossrefDate(msg) {
  const candidates = ['published-print', 'issued', 'published', 'published-online']
    .map(k => formatDateParts(msg[k] && msg[k]['date-parts'] && msg[k]['date-parts'][0]))
    .filter(Boolean);
  const dayLevel = candidates.find(d => d.length === 10);
  return dayLevel || candidates[0] || '';
}

async function openAlexPass(records) {
  let filled = 0, failedBatches = 0, batches = 0, dois = 0;
  for (let i = 0; i < records.length; i += OPENALEX_BATCH) {
    if (Date.now() >= OPENALEX_DEADLINE) { logExhausted('OpenAlex', batches, dois, OA_NOTE); break; }
    const batch = records.slice(i, i + OPENALEX_BATCH);
    const byDoi = {};
    batch.forEach(r => { byDoi[normaliseDoi(r.doi)] = r; });
    const url = 'https://api.openalex.org/works?per_page=' + OPENALEX_BATCH
      + '&filter=doi:' + batch.map(r => encodeURIComponent(normaliseDoi(r.doi))).join('|')
      + '&select=doi,publication_date'
      + '&mailto=' + encodeURIComponent(CONFIG.email);
    try {
      const data = await fetchWithin(OPENALEX_DEADLINE, url);
      for (const w of (data.results || [])) {
        const doi = normaliseDoi(w.doi || '');
        const rec = byDoi[doi];
        if (rec && !rec.publicationDate && /^\d{4}-\d{2}/.test(w.publication_date || '')) {
          rec.publicationDate = w.publication_date;
          filled++;
        }
      }
    } catch (err) {
      if (err instanceof BudgetExhausted) { logExhausted('OpenAlex', batches, dois, OA_NOTE); break; }
      failedBatches++;
      console.warn('  OpenAlex batch failed (' + batch.length + ' DOIs): ' + err.message);
    }
    batches++;
    dois += batch.length;
    await sleep(250);
  }
  return { filled, failedBatches };
}

async function crossrefPass(records) {
  let filled = 0, attempted = 0;
  for (const rec of records) {
    if (attempted >= CROSSREF_CAP) break;
    if (Date.now() >= DEADLINE) { logExhausted('Crossref', attempted, attempted); break; }
    const url = 'https://api.crossref.org/works/' + encodeURIComponent(normaliseDoi(rec.doi))
      + '?mailto=' + encodeURIComponent(CONFIG.email);
    try {
      const data = await fetchWithin(DEADLINE, url, { retries: 1 });
      const date = bestCrossrefDate((data && data.message) || {});
      if (date && !rec.publicationDate) {
        rec.publicationDate = date;
        filled++;
      }
    } catch (err) {
      if (err instanceof BudgetExhausted) { logExhausted('Crossref', attempted, attempted); break; }
      // 404s already return {}; anything else is best-effort
    }
    attempted++;
    await sleep(150);
  }
  return { filled, attempted, remaining: records.length - attempted };
}

async function main() {
  const db = JSON.parse(fs.readFileSync(PUB_FILE, 'utf8'));
  const records = db.records || [];
  const missing = records.filter(r => !r.publicationDate && r.doi && /^10\./.test(normaliseDoi(r.doi)));

  console.log('Publication-date enrichment: ' + records.length + ' records, '
    + missing.length + ' missing a date (budget ' + secs(BUDGET_MS) + ')');
  if (missing.length === 0) return;

  const oa = await openAlexPass(missing);
  console.log('  OpenAlex filled ' + oa.filled
    + (oa.failedBatches ? ' (' + oa.failedBatches + ' batches failed)' : ''));

  const residue = missing.filter(r => !r.publicationDate);
  if (residue.length > 0) {
    const cr = await crossrefPass(residue);
    console.log('  Crossref filled ' + cr.filled + ' of ' + cr.attempted + ' attempted'
      + (cr.remaining > 0 ? ' (' + cr.remaining + ' left for future runs)' : ''));
  }

  // A YYYY-01-01 from OpenAlex is often a year-only placeholder. For dates
  // filled THIS run, ask Crossref for something more specific; keep Jan 1
  // only when Crossref agrees or offers nothing month-level.
  const jan1 = missing.filter(r => /^\d{4}-01-01$/.test(r.publicationDate || ''));
  if (jan1.length > 0) {
    let refined = 0, checked = 0;
    for (const rec of jan1) {
      if (Date.now() >= DEADLINE) break;
      const url = 'https://api.crossref.org/works/' + encodeURIComponent(normaliseDoi(rec.doi))
        + '?mailto=' + encodeURIComponent(CONFIG.email);
      try {
        const data = await fetchWithin(DEADLINE, url, { retries: 1 });
        const date = bestCrossrefDate((data && data.message) || {});
        if (date && date !== rec.publicationDate) {
          rec.publicationDate = date;
          refined++;
        }
      } catch (err) {
        if (err instanceof BudgetExhausted) break;
        /* keep the Jan-1 date */
      }
      checked++;
      await sleep(150);
    }
    if (checked < jan1.length) {
      // A record that keeps a date is never "missing" again, so an unchecked
      // Jan-1 placeholder kept now would never get this check. Withdraw it;
      // the next run re-fills and checks it.
      logExhausted('Jan-1 check', checked, checked);
      jan1.slice(checked).forEach(r => { delete r.publicationDate; });
      console.log('  ' + (jan1.length - checked) + ' unchecked Jan-1 date(s) withdrawn for the next run');
    }
    console.log('  Jan-1 placeholder check: refined ' + refined + ' of ' + checked + ' checked');
  }

  if (budgetExhausted) {
    console.log('Stopped on budget after ' + secs(Date.now() - STARTED) + ' of ' + secs(BUDGET_MS)
      + ' — keeping what was filled; the rest is left for the next run');
  }

  const totalFilled = missing.filter(r => r.publicationDate).length;
  if (totalFilled > 0) {
    db.metadata = db.metadata || {};
    db.metadata.dates_enriched = new Date().toISOString();
    fs.writeFileSync(PUB_FILE, JSON.stringify(db, null, 2));
    console.log('Wrote ' + PUB_FILE + ' — ' + records.filter(r => r.publicationDate).length
      + ' of ' + records.length + ' records now dated');
  } else {
    console.log('Nothing newly dated; file left untouched');
  }
}

// An abandoned request may still be sleeping on a Retry-After; once the
// budget is spent, flush the logs and exit 0 rather than wait for it.
function exitIfBudgetSpent() {
  if (!budgetExhausted) return;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(0)));
}

main().then(exitIfBudgetSpent, err => {
  // Best-effort stage: report and succeed so the pipeline continues
  console.error('enrich-dates failed: ' + err.message);
  exitIfBudgetSpent();
});
