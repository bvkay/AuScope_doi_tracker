#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Data-citation harvest
 *
 * Papers that USE AuScope data usually cite the dataset's DOI rather than
 * writing "AuScope" anywhere a keyword search can see. For every DOI in
 * data/datasets.json (EarthBank, AusPass FDSN networks, NCI collections,
 * NVCL), this asks DataCite which works cite it, then:
 *
 *   - records the links in data/data-citations.json — machine evidence
 *     the evidence ladder reads (citing papers grade text-infrastructure)
 *   - merges citing papers into publications.json, tagged
 *     '<Platform> data citation' (EarthBank / AusPass / NCI / NVCL)
 *
 * Best-effort, repo convention: a failed DataCite lookup keeps that
 * dataset's previous citation list; the run never shrinks knowledge and
 * exits 0 so the pipeline continues.
 *
 * Run AFTER dataset-inventory.js and BEFORE evidence.js.
 * Usage: node src/data-citations.js
 */

const fs = require('fs');
const path = require('path');
const { sleep, normaliseDoi } = require('./utils');
const { lookupMetadata } = require('./sources/openalex');
const { lookupCrossref } = require('./sources/crossref');

const ROOT = path.join(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const DS_FILE = path.join(ROOT, 'data', 'datasets.json');
const PUB_FILE = path.join(ROOT, 'data', 'publications.json');
const OUT_FILE = path.join(ROOT, 'data', 'data-citations.json');
const OVERRIDES_FILE = path.join(ROOT, 'data', 'evidence-overrides.json');

const PACE_MS = 400;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

async function citationsOf(doi) {
  const resp = await fetch('https://api.datacite.org/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'query($id: ID!){ work(id:$id){ citationCount citations(first:100){ nodes { id } } } }',
      variables: { id: doi }
    })
  });
  if (!resp.ok) throw new Error('DataCite HTTP ' + resp.status);
  const result = await resp.json();
  if (result.errors) {
    // "Record not found" = DOI not in DataCite (some NCI/NVCL DOIs) — a
    // real empty answer, not a failure
    if (/not found/i.test(result.errors[0].message || '')) return [];
    throw new Error(result.errors[0].message);
  }
  const work = result.data && result.data.work;
  if (!work) return [];
  return (work.citations && work.citations.nodes || [])
    .map(n => normaliseDoi(n.id || ''))
    .filter(d => /^10\./.test(d));
}

async function run() {
  console.log('AuScope Data-citation Harvest');
  console.log('=============================\n');

  const datasets = (readJson(DS_FILE, { records: [] }).records || [])
    .filter(r => r.doi && /^10\./.test(normaliseDoi(r.doi)));
  const prev = readJson(OUT_FILE, { sources: {} });
  const sources = {};
  let failed = 0, withCitations = 0;

  for (const ds of datasets) {
    const key = normaliseDoi(ds.doi);
    try {
      const citing = await citationsOf(key);
      sources[key] = { platform: ds.platform || '', name: (ds.name || '').slice(0, 80), citing };
      if (citing.length) withCitations++;
    } catch (err) {
      failed++;
      // keep last known answer for this dataset
      if (prev.sources && prev.sources[key]) sources[key] = prev.sources[key];
      console.warn('  lookup failed for ' + key + ': ' + err.message);
    }
    await sleep(PACE_MS);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    harvested: new Date().toISOString(),
    sources
  }, null, 1));
  console.log('Checked ' + datasets.length + ' dataset DOIs ('
    + withCitations + ' with citations, ' + failed + ' lookups failed — previous values kept)');

  // ── Merge citing papers into the publications corpus ──
  const pubData = readJson(PUB_FILE, null);
  if (!pubData || !pubData.records) { console.error('No publications.json'); return; }
  const byDoi = {};
  pubData.records.forEach(r => { byDoi[normaliseDoi(r.doi)] = r; });

  const datasetDois = new Set(Object.keys(sources));
  const excluded = (CONFIG.excluded_doi_prefixes || []).map(p => p.toLowerCase());
  const removed = new Set((readJson(OVERRIDES_FILE, { records: [] }).records || [])
    .filter(o => o.action === 'remove').map(o => normaliseDoi(o.doi)));

  // citing doi -> [platform tags]
  const citers = {};
  for (const [dsDoi, entry] of Object.entries(sources)) {
    for (const c of (entry.citing || [])) {
      if (datasetDois.has(c)) continue;                       // dataset citing dataset
      if (excluded.some(p => c.indexOf(p + '/') === 0)) continue;
      if (removed.has(c)) continue;                           // curator said no
      citers[c] = citers[c] || new Set();
      citers[c].add((entry.platform || 'AuScope') + ' data citation');
    }
  }

  let added = 0, tagged = 0, skippedOld = 0, noMeta = 0;
  for (const [doi, tagSet] of Object.entries(citers)) {
    const tags = [...tagSet];
    const existing = byDoi[doi];
    if (existing) {
      existing.searchTerms = existing.searchTerms || [];
      let changed = false;
      tags.forEach(t => {
        if (existing.searchTerms.indexOf(t) === -1) { existing.searchTerms.push(t); changed = true; }
      });
      if (changed) tagged++;
      continue;
    }
    // New paper: fetch metadata (Crossref first, OpenAlex for gaps)
    let cr = null, oa = null;
    try { cr = await lookupCrossref(doi, CONFIG.email); } catch (e) { /* gap */ }
    await sleep(150);
    try { oa = await lookupMetadata(doi, CONFIG.email); } catch (e) { /* gap */ }
    await sleep(150);
    const base = cr || {}, o = oa || {};
    if (!base.title && !o.title) { noMeta++; continue; }
    const year = base.year || o.year || null;
    if (year && year < (CONFIG.min_year || 0)) { skippedOld++; continue; }
    pubData.records.push({
      doi: doi,
      title: base.title || o.title || '',
      authors: base.authors || o.authors || '',
      journal: base.journal || o.journal || '',
      publisher: base.publisher || o.publisher || '',
      year: year,
      cited: Math.max(base.cited || 0, o.cited || 0),
      type: base.type || o.type || '',
      isOA: (o.isOA && o.isOA !== 'Unknown') ? o.isOA : (base.isOA || 'Unknown'),
      subject: o.subject || base.subject || '',
      publicationDate: o.publicationDate || undefined,
      sources: [cr ? 'Crossref' : null, oa ? 'OpenAlex' : null].filter(Boolean),
      searchTerms: tags,
      dateAdded: new Date().toISOString().slice(0, 10)
    });
    byDoi[doi] = pubData.records[pubData.records.length - 1];
    added++;
  }

  if (added || tagged) {
    pubData.metadata.last_updated = new Date().toISOString();
    pubData.metadata.total_count = pubData.records.length;
    fs.writeFileSync(PUB_FILE, JSON.stringify(pubData, null, 2));
  }
  console.log('Citing papers: ' + Object.keys(citers).length + ' distinct — '
    + added + ' added, ' + tagged + ' existing records tagged, '
    + noMeta + ' without metadata, ' + skippedOld + ' pre-' + CONFIG.min_year);
}

run().catch(err => {
  // Best-effort stage: report and succeed so the pipeline continues
  console.error('data-citations failed: ' + err.message);
});
