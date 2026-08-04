#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Partner ROR Diagnostic
 *
 * Audits which partner RORs in verified-config.json actually matched papers,
 * and looks up the canonical institution name. Uses OpenAlex's institutions
 * endpoint for the lookup (same source as the rest of the pipeline) — this
 * is more reliable than calling ROR.org directly.
 *
 * Usage: node src/check-partners.js
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE   = path.join(__dirname, '..', 'data', 'verified-config.json');
const VERIFIED_FILE = path.join(__dirname, '..', 'data', 'publications-verified.json');
const REVIEW_FILE   = path.join(__dirname, '..', 'data', 'publications-review.json');

let configEmail = '';

async function lookupInstitution(rorId) {
  // OpenAlex accepts /institutions/ror:<id> as a lookup path
  const url = `https://api.openalex.org/institutions/ror:${encodeURIComponent(rorId)}`
    + `?select=display_name,country_code,type,works_count`
    + (configEmail ? `&mailto=${encodeURIComponent(configEmail)}` : '');

  try {
    const resp = await fetch(url);
    if (resp.status === 404) return { name: null, country: null, works: 0, type: '' };
    if (!resp.ok) return { name: null, country: null, works: 0, type: '', error: `HTTP ${resp.status}` };
    const data = await resp.json();
    return {
      name: data.display_name || null,
      country: data.country_code || null,
      type: data.type || '',
      works: data.works_count || 0
    };
  } catch (e) {
    return { name: null, country: null, works: 0, type: '', error: e.message };
  }
}

function countSignals(records) {
  const partnerCounts = {};
  const auscopeRorCounts = {};
  for (const r of records) {
    for (const sig of (r.verifiedBy || [])) {
      if (sig.startsWith('partner-ror:')) {
        const ror = sig.slice('partner-ror:'.length);
        partnerCounts[ror] = (partnerCounts[ror] || 0) + 1;
      } else if (sig.startsWith('ror:')) {
        const ror = sig.slice('ror:'.length);
        auscopeRorCounts[ror] = (auscopeRorCounts[ror] || 0) + 1;
      }
    }
  }
  return { partnerCounts, auscopeRorCounts };
}

async function run() {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  configEmail = config.email || '';

  let allRecords = [];
  if (fs.existsSync(VERIFIED_FILE)) {
    allRecords = allRecords.concat(JSON.parse(fs.readFileSync(VERIFIED_FILE, 'utf8')).records || []);
  }
  if (fs.existsSync(REVIEW_FILE)) {
    allRecords = allRecords.concat(JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf8')).records || []);
  }
  if (allRecords.length === 0) {
    console.error('No records found. Run `node src/verified.js` first.');
    process.exit(1);
  }

  const { partnerCounts, auscopeRorCounts } = countSignals(allRecords);

  console.log('Partner ROR Diagnostic');
  console.log('======================\n');
  console.log(`Read ${allRecords.length} records (verified + review).`);
  console.log(`Looking up institution names via OpenAlex ...\n`);

  // ─── AuScope RORs ───
  console.log('AuScope RORs (configured):');
  console.log(`  ${'ROR'.padEnd(14)} ${'Matches'.padStart(7)}   Institution`);
  for (const ror of (config.auscope_rors || [])) {
    const meta = await lookupInstitution(ror);
    const n = auscopeRorCounts[ror] || 0;
    const tag = meta.name
      ? `${meta.name}${meta.country ? ` (${meta.country})` : ''}${meta.type ? ` [${meta.type}]` : ''}`
      : `*** NOT FOUND IN OPENALEX *** ${meta.error ? '(' + meta.error + ')' : ''}`;
    console.log(`  ${ror.padEnd(14)} ${String(n).padStart(7)}   ${tag}`);
    await new Promise(r => setTimeout(r, 150));
  }
  console.log('');

  // ─── Partner RORs ───
  console.log('Partner RORs (configured):');
  console.log(`  ${'ROR'.padEnd(14)} ${'Matches'.padStart(7)}   Institution\n`);

  const configured = (config.partner_rors || []).map(r => r.toLowerCase());
  const rows = [];
  for (const ror of configured) {
    const meta = await lookupInstitution(ror);
    rows.push({
      ror,
      matches: partnerCounts[ror] || 0,
      name: meta.name || null,
      country: meta.country || '',
      type: meta.type || '',
      error: meta.error || null
    });
    await new Promise(r => setTimeout(r, 150));
  }
  rows.sort((a, b) => b.matches - a.matches);

  for (const r of rows) {
    let label;
    if (r.name) {
      label = `${r.name}${r.country ? ` (${r.country})` : ''}${r.type ? ` [${r.type}]` : ''}`;
    } else {
      label = `*** NOT FOUND IN OPENALEX *** ${r.error ? '(' + r.error + ')' : ''}`;
    }
    console.log(`  ${r.ror.padEnd(14)} ${String(r.matches).padStart(7)}   ${label}`);
  }
  console.log('');

  // ─── Stray partner-RORs in data not in config ───
  const stray = Object.keys(partnerCounts).filter(r => !configured.includes(r));
  if (stray.length > 0) {
    console.log('Partner RORs in data but NOT in config (unexpected):');
    for (const ror of stray) {
      console.log(`  ${ror} — ${partnerCounts[ror]} matches`);
    }
    console.log('');
  }

  // ─── Summary ───
  const matched   = rows.filter(r => r.matches > 0).length;
  const notFound  = rows.filter(r => !r.name).length;
  const totalSig  = rows.reduce((s, r) => s + r.matches, 0);

  console.log('─── Summary ───');
  console.log(`Configured partner RORs              : ${rows.length}`);
  console.log(`...with at least one matched paper   : ${matched}`);
  console.log(`...with zero matches                 : ${rows.length - matched}`);
  console.log(`...not resolvable in OpenAlex        : ${notFound}`);
  console.log(`Total partner-ror corroborations     : ${totalSig}`);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});