#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Search Orchestrator
 *
 * Runs all configured search queries across OpenAlex, Semantic Scholar,
 * Europe PMC, CORE, and Dimensions. Deduplicates results and merges
 * into data/publications.json.
 *
 * Usage: node src/search.js
 *
 * Environment variables:
 *   S2_API_KEY         — Semantic Scholar API key
 *   CORE_API_KEY       — CORE API key (https://core.ac.uk/apikeys/register)
 *   DIMENSIONS_API_KEY — Dimensions API key (https://app.dimensions.ai/)
 */

const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const { queryLabel } = require('./utils');
const { searchOpenAlex } = require('./sources/openalex');
const { searchSemanticScholar } = require('./sources/semantic_scholar');
const { searchEuropePMC } = require('./sources/europepmc');
const { searchCORE } = require('./sources/core');
const { searchDimensions } = require('./sources/dimensions');
const { deduplicateItems, mergeIntoExisting } = require('./dedup');

const DATA_FILE = path.join(__dirname, '..', 'data', 'publications.json');

async function run() {
  console.log('AuScope DOI Tracker — Search');
  console.log('============================');
  console.log('Queries: ' + config.search_queries.length);
  console.log('Primary: "' + config.search_queries[0] + '" (' + config.primary_max_pages + ' pages + Semantic Scholar)');
  console.log('Secondary: ' + (config.search_queries.length - 1) + ' terms (' + config.secondary_max_pages + ' pages each)\n');

  const s2ApiKey = process.env[config.s2_api_key_env] || '';
  const coreApiKey = process.env.CORE_API_KEY || '';
  const dimApiKey = process.env.DIMENSIONS_API_KEY || '';

  const sources = ['OpenAlex', 'Europe PMC'];
  if (s2ApiKey) sources.push('Semantic Scholar');
  if (coreApiKey) sources.push('CORE');
  if (dimApiKey) sources.push('Dimensions');
  console.log('Sources: ' + sources.join(', '));
  if (!s2ApiKey) console.warn('  (no S2_API_KEY — Semantic Scholar disabled)');
  if (!coreApiKey) console.warn('  (no CORE_API_KEY — CORE disabled)');
  if (!dimApiKey) console.warn('  (no DIMENSIONS_API_KEY — Dimensions disabled)');
  console.log('');

  const allItems = [];
  let totalRaw = 0;

  for (let qi = 0; qi < config.search_queries.length; qi++) {
    const query = config.search_queries[qi];
    const label = queryLabel(query);
    const isPrimary = qi === 0;

    process.stdout.write('[' + (qi + 1) + '/' + config.search_queries.length + '] "' + label + '" ... ');

    let queryCount = 0;

    // OpenAlex
    try {
      const maxPages = isPrimary ? config.primary_max_pages : config.secondary_max_pages;
      const oaItems = await searchOpenAlex(query, { email: config.email, maxPages });
      oaItems.forEach(item => { item.searchTerms = [label]; });
      allItems.push(...oaItems);
      queryCount += oaItems.length;
    } catch (err) {
      process.stdout.write('OA err ');
      console.error('  OpenAlex error: ' + err.message);
    }

    // Semantic Scholar — primary only
    if (isPrimary) {
      try {
        const s2Items = await searchSemanticScholar(query, { apiKey: s2ApiKey, maxResults: 500 });
        s2Items.forEach(item => { item.searchTerms = [label]; });
        allItems.push(...s2Items);
        queryCount += s2Items.length;
      } catch (err) {
        process.stdout.write('S2 err ');
        console.error('  Semantic Scholar error: ' + err.message);
      }
    }

    // Europe PMC
    try {
      const maxResults = isPrimary ? config.MAX_RESULTS_EUROPEPMC || 500 : config.secondary_max_pages * 100;
      const pmcItems = await searchEuropePMC(query, { maxResults });
      pmcItems.forEach(item => { item.searchTerms = [label]; });
      allItems.push(...pmcItems);
      queryCount += pmcItems.length;
    } catch (err) {
      process.stdout.write('PMC err ');
      console.error('  Europe PMC error: ' + err.message);
    }

    // CORE — primary only (covers theses, OA grey literature)
    if (isPrimary && coreApiKey) {
      try {
        const coreItems = await searchCORE(query, { apiKey: coreApiKey, maxResults: 200 });
        coreItems.forEach(item => { item.searchTerms = [label]; });
        allItems.push(...coreItems);
        queryCount += coreItems.length;
      } catch (err) {
        process.stdout.write('CORE err ');
        console.error('  CORE error: ' + err.message);
      }
    }

    // Dimensions — primary only (journals, conferences, grants)
    if (isPrimary && dimApiKey) {
      try {
        const dimItems = await searchDimensions(query, { apiKey: dimApiKey, maxResults: 200 });
        dimItems.forEach(item => { item.searchTerms = [label]; });
        allItems.push(...dimItems);
        queryCount += dimItems.length;
      } catch (err) {
        process.stdout.write('DIM err ');
        console.error('  Dimensions error: ' + err.message);
      }
    }

    totalRaw += queryCount;
    console.log(queryCount + ' results');
  }

  console.log('\nRaw results: ' + totalRaw);

  // Filter by min_year
  const minYear = config.min_year || 0;
  let filtered = allItems;
  if (minYear) {
    filtered = allItems.filter(item => !item.year || item.year >= minYear);
    const removed = allItems.length - filtered.length;
    if (removed > 0) console.log('Filtered out: ' + removed + ' results before ' + minYear);
  }

  // Deduplicate
  const deduped = deduplicateItems(filtered);
  console.log('After dedup: ' + deduped.length + ' unique DOIs');

  // Load existing data and merge
  let pubData = { metadata: { type: 'publications', last_updated: null, total_count: 0 }, records: [] };
  if (fs.existsSync(DATA_FILE)) {
    pubData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }

  const { records, added, updated } = mergeIntoExisting(pubData.records, deduped);

  pubData.records = records;
  pubData.metadata.last_updated = new Date().toISOString();
  pubData.metadata.total_count = records.length;

  fs.writeFileSync(DATA_FILE, JSON.stringify(pubData, null, 2));

  console.log('\nNew DOIs added: ' + added);
  console.log('Existing updated: ' + updated);
  console.log('Total in database: ' + records.length);
  console.log('\nSaved to ' + DATA_FILE);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
