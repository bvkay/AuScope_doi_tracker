#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Keyword-in-context verifier
 *
 * A keyword-tier record says "an AuScope-related term matched this paper"
 * without saying WHERE. The false-positive classes all hide in that
 * blindness: a term only in the reference list (a citation TO AuScope
 * work, not use OF it), an author-name collision, a literature table.
 * This pass fetches structured open-access full text where it exists
 * (Europe PMC JATS XML — <ack>, <body>, <ref-list> are explicit markup)
 * and records, per matched term, occurrence counts per section plus a
 * quotable snippet (first ack occurrence, else body, else references).
 *
 * Record-level flags (aggregates ACROSS terms — per-term detail lives in
 * `terms`, so a mixed record is judged by its strongest term):
 *   referenceOnly  every found term sits only in the bibliography
 *   ackMention     some term appears in acknowledgments/funding
 *   notFound       no term appears in the text we could read
 *
 * Nothing is auto-removed or auto-upgraded: output feeds human review,
 * every flag traces to a section, snippet and PMCID.
 *
 * State (data/keyword-context.json) merges across runs: 'checked'
 * entries are final (never overwritten by a later failure); 'no-oa-text'
 * is retried after RETRY_DAYS (papers enter PMC late); 'error' entries
 * retry up to 3 times. VERIFY_MAX (default 300) caps a run so the
 * backlog drains over successive weekly runs. Progress is flushed every
 * 25 records — a crash keeps what was done.
 *
 * Usage: node src/verify-keywords.js [--sample=N] [--recheck]
 */

const fs = require('fs');
const path = require('path');
const { fetchJSON, sleep, normaliseDoi } = require('./utils');

const ROOT = path.join(__dirname, '..');
const PUB_FILE = path.join(ROOT, 'data', 'publications.json');
const OUT_FILE = path.join(ROOT, 'data', 'keyword-context.json');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const MANUAL = ['Manual entry', 'Manual submission'];
const PACE_MS = 350;
const RETRY_DAYS = 60;
const MAX_ATTEMPTS = 3;
const envMax = parseInt(process.env.VERIFY_MAX, 10);
const MAX = Number.isFinite(envMax) && envMax >= 0 ? envMax : 300;
const argv = process.argv.slice(2);
const SAMPLE = parseInt((argv.find(a => a.startsWith('--sample=')) || '').split('=')[1] || '0', 10);
const RECHECK = argv.includes('--recheck');

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

// Stored searchTerms were quote-stripped at write time (queryLabel), so
// map each label back to its config query to recover phrase boundaries;
// labels that drifted out of config fall back to word-AND matching.
const LABEL_TO_QUERY = {};
(CONFIG.search_queries || []).forEach(q => {
  LABEL_TO_QUERY[q.replace(/"/g, '').replace(/\s+/g, ' ').trim()] = q;
});

// ─── Text handling ──────────────────────────────────────────────────────────

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[‐‑−]/g, '-');   // unicode hyphens → ASCII
}

// Space-replacing on purpose (prevents word fusing across tags), unlike
// utils.stripHtml. Comments/CDATA go first — they may contain '>'.
function xmlToText(s) {
  return decodeEntities(
    (s || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
      .replace(/<[^>]*>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/** JATS XML → { ack, body, refs } as plain text. Namespace-tolerant. */
function splitSections(xml) {
  const grab = (src, tag, greedy) => {
    const re = new RegExp('<(?:[\\w-]+:)?' + tag + '\\b[^>]*>([\\s\\S]*' + (greedy ? '' : '?')
      + ')</(?:[\\w-]+:)?' + tag + '>', 'g');
    const parts = [];
    let m;
    while ((m = re.exec(src)) !== null) parts.push(m[1]);
    return parts.join(' ');
  };
  const ackXml = grab(xml, 'ack') + ' ' + grab(xml, 'funding-group');
  // remove ack/funding spans before extracting body so a nested <ack>
  // is not double-counted
  const bodySrc = xml
    .replace(/<(?:[\w-]+:)?ack\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?ack>/g, ' ')
    .replace(/<(?:[\w-]+:)?funding-group\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?funding-group>/g, ' ');
  return {
    ack: xmlToText(ackXml),
    body: xmlToText(grab(bodySrc, 'body') + ' ' + grab(bodySrc, 'abstract')),
    // greedy: grouped reference lists nest <ref-list> inside <ref-list>
    refs: xmlToText(grab(xml, 'ref-list', true))
  };
}

// ─── Term matching ──────────────────────────────────────────────────────────

/** Query → parts: quoted phrases whole, bare words individually (AND). */
function termParts(label) {
  const query = LABEL_TO_QUERY[label] || label;
  const parts = [];
  const rest = query.replace(/"([^"]+)"/g, (_, phrase) => { parts.push(phrase.trim()); return ' '; });
  rest.split(/\s+/).forEach(w => { if (w) parts.push(w); });
  return parts.filter(Boolean);
}

function findPart(text, part) {
  const hay = text.toLowerCase();
  const needle = part.toLowerCase();
  const hits = [];
  let i = hay.indexOf(needle);
  while (i !== -1 && hits.length < 50) {
    hits.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return hits;
}

/**
 * A section matches when EVERY part occurs in it (mirrors the search
 * APIs' AND semantics). Positions returned are of the longest (most
 * distinctive) part, so counts and snippets anchor on the real signal.
 */
function findTerm(text, label) {
  const parts = termParts(label);
  if (parts.length === 0) return { hits: [], anchorLen: 0 };
  const perPart = parts.map(p => findPart(text, p));
  if (perPart.some(h => h.length === 0)) return { hits: [], anchorLen: 0 };
  let li = 0;
  parts.forEach((p, i) => { if (p.length > parts[li].length) li = i; });
  return { hits: perPart[li], anchorLen: parts[li].length };
}

function snippetAt(text, pos, len) {
  const start = Math.max(0, pos - 120);
  const end = Math.min(text.length, pos + len + 160);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

// ─── Europe PMC ─────────────────────────────────────────────────────────────

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Returns { xml, pmcid } for the OA full text, or null when none exists. */
async function fullTextFor(doi) {
  const q = await fetchJSON(EPMC + '/search?query=DOI:%22' + encodeURIComponent(doi)
    + '%22&format=json&pageSize=3', { retries: 2 });
  const hits = ((q.resultList && q.resultList.result) || [])
    .filter(h => normaliseDoi(h.doi || '') === doi);      // never read another paper's text
  const hit = hits.find(h => h.pmcid && h.isOpenAccess === 'Y');
  if (!hit) return null;
  const xml = await fetchText(EPMC + '/' + hit.pmcid + '/fullTextXML');
  // an HTML error page also contains <body>; require a JATS article root
  if (!xml || !/<(?:[\w-]+:)?article\b/.test(xml)) return null;
  return { xml, pmcid: hit.pmcid };
}

// ─── Main ───────────────────────────────────────────────────────────────────

function organicTerms(rec) {
  return (rec.searchTerms || []).filter(t => MANUAL.indexOf(t) === -1
    && !/data citation$/.test(t) && t !== 'ROR-verified');
}

function daysSince(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? (Date.now() - t) / 86400000 : Infinity;
}

async function run() {
  console.log('Keyword-in-context verifier');
  console.log('===========================\n');

  const db = JSON.parse(fs.readFileSync(PUB_FILE, 'utf8'));
  let prev = { results: {} };
  try { prev = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch (e) { /* first run */ }
  const results = prev.results || {};

  const flush = () => fs.writeFileSync(OUT_FILE, JSON.stringify({
    updated: new Date().toISOString(),
    results
  }, null, 1));

  let targets = db.records.filter(r => r.evidence === 'keyword' && organicTerms(r).length > 0);
  if (!RECHECK) {
    targets = targets.filter(r => {
      const prevR = results[normaliseDoi(r.doi)];
      if (!prevR) return true;
      if (prevR.status === 'checked') return false;
      if (prevR.status === 'no-oa-text') return daysSince(prevR.checkedAt) > RETRY_DAYS;
      if (prevR.status === 'error') return (prevR.attempts || 0) < MAX_ATTEMPTS;
      return true;
    });
  }
  if (SAMPLE > 0) targets = targets.slice(0, SAMPLE);
  console.log('Keyword-tier records to check: ' + targets.length
    + (RECHECK ? ' (recheck)' : '') + ', cap ' + MAX + ' this run\n');

  let checked = 0;
  try {
    for (const rec of targets) {
      if (checked >= MAX) { console.log('Per-run cap reached.'); break; }
      const doi = normaliseDoi(rec.doi);
      const prevR = results[doi];
      checked++;

      let got = null, failed = false;
      try { got = await fullTextFor(doi); } catch (e) { failed = true; }
      if (failed) {
        // transient failure: never overwrite a good answer, count attempts
        if (!prevR || prevR.status !== 'checked') {
          results[doi] = { status: 'error', attempts: ((prevR && prevR.attempts) || 0) + 1 };
        }
      } else if (!got) {
        if (!prevR || prevR.status !== 'checked') {
          // real negative — EPMC has no OA text (yet); recheck after RETRY_DAYS
          results[doi] = { status: 'no-oa-text', checkedAt: new Date().toISOString().slice(0, 10) };
        }
      } else {
        const sec = splitSections(got.xml);
        const terms = {};
        const flags = [];
        let anyBodyOrAck = false, anyRefs = false, anyAck = false, anyFound = false;
        for (const term of organicTerms(rec)) {
          const inAck = findTerm(sec.ack, term);
          const inBody = findTerm(sec.body, term);
          const inRefs = findTerm(sec.refs, term);
          anyFound = anyFound || (inAck.hits.length + inBody.hits.length + inRefs.hits.length) > 0;
          anyBodyOrAck = anyBodyOrAck || (inAck.hits.length + inBody.hits.length) > 0;
          anyRefs = anyRefs || inRefs.hits.length > 0;
          anyAck = anyAck || inAck.hits.length > 0;
          const pick = inAck.hits.length ? [sec.ack, inAck] : (inBody.hits.length ? [sec.body, inBody]
            : (inRefs.hits.length ? [sec.refs, inRefs] : null));
          terms[term] = {
            ack: inAck.hits.length, body: inBody.hits.length, refs: inRefs.hits.length,
            snippet: pick ? snippetAt(pick[0], pick[1].hits[0], pick[1].anchorLen) : ''
          };
        }
        if (anyFound && !anyBodyOrAck && anyRefs) flags.push('referenceOnly');
        if (anyAck) flags.push('ackMention');
        if (!anyFound) flags.push('notFound');
        results[doi] = { status: 'checked', pmcid: got.pmcid, flags, terms };
      }
      if (checked % 25 === 0) flush();
      await sleep(PACE_MS);
    }
  } finally {
    flush();
  }

  const all = Object.values(results);
  const has = s => all.filter(r => r.status === s).length;
  const flag = f => all.filter(r => (r.flags || []).includes(f)).length;
  console.log('\nThis run: ' + checked + ' records');
  console.log('All-time: ' + all.length + ' attempted — ' + has('checked') + ' with OA text, '
    + has('no-oa-text') + ' without, ' + has('error') + ' errored');
  console.log('  referenceOnly (cite-only suspects): ' + flag('referenceOnly'));
  console.log('  ackMention (upgrade candidates):    ' + flag('ackMention'));
  console.log('  term not in available text:         ' + flag('notFound'));
}

run().catch(err => {
  // Best-effort stage: report and succeed so the pipeline continues
  console.error('verify-keywords failed: ' + err.message);
});
