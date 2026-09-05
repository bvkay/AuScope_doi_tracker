#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Seismic instrument register ingest
 *
 * Turns the ported AusPASS StationXML pipeline's output into the page feed
 * for docs/seismic-instruments.html:
 *   data/seismic/PIDINST_candidates_final.json  (src/seismic/build_candidates.py)
 *   data/seismic/deployments.jsonl              (src/seismic/parse.py)
 *     -> docs/seismic-instruments.json
 *
 * SCOPE: confirmed attribution tiers only (ANU-built, AuScope, ANSIR-loan).
 * probable-ANSIR and unattributed are counted in metadata for disclosure but
 * never in the headline — attribution is per instrument, never per network
 * (WA Array hosts 542 units, 28 of them AuScope; see src/seismic/METHODOLOGY.md).
 *
 * No PIDInst DOIs exist for these units yet, so identity is (role, model,
 * serial) and every unit carries `doi: null` — the slot lights up when the
 * records are minted.
 *
 * Usage: node src/seismic-inventory.js
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data', 'seismic');
const CAND = path.join(DATA, 'PIDINST_candidates_final.json');
const DEPS = path.join(DATA, 'unit_deployments.json');
const NETS = path.join(DATA, 'networks_digest.json');
const OUT = path.join(__dirname, '..', 'docs', 'seismic-instruments.json');

const CONFIRMED = /^confirmed/;
const DAY = 86400000;

// StationXML carries scheduled future end dates; usage to date must not count
// days that have not happened yet.
const TODAY = new Date().toISOString().slice(0, 10);

// countries arrive as a mix of names and ISO codes on the same corpus
const COUNTRY = { AU: 'Australia', AUS: 'Australia', NZ: 'New Zealand', ID: 'Indonesia' };
const country = c => COUNTRY[String(c || '').trim().toUpperCase()] || c;

function epochDays(start, end) {
  if (!start) return null;
  const a = Date.parse(start);
  const b = Date.parse((end && end < TODAY ? end : TODAY) + '');
  if (isNaN(a) || isNaN(b) || b < a) return null;
  return Math.round((b - a) / DAY);
}

function run() {
  console.log('AuScope Seismic Instrument Register');
  console.log('===================================\n');

  const cands = JSON.parse(fs.readFileSync(CAND, 'utf8'));
  const tiers = {};
  cands.forEach(c => { tiers[c.attribution] = (tiers[c.attribution] || 0) + 1; });
  const confirmed = cands.filter(c => CONFIRMED.test(c.attribution));

  // ── Deployments come from the sidecar written by build_candidates.py,
  //    keyed by the SAME normalised (manufacturer|model|serial) identity.
  //    Re-deriving the join here would mean reimplementing model
  //    canonicalisation and SmartSolo serial resolution in JS — the one
  //    place this pipeline must not have two sources of truth. ──
  const sidecar = JSON.parse(fs.readFileSync(DEPS, 'utf8'));
  const netUnits = {};   // network -> Set(unit key), for the mix table
  const netMeta = {};
  for (const [key, deps] of Object.entries(sidecar)) {
    for (const d of deps) {
      (netUnits[d.net] = netUnits[d.net] || new Set()).add(key);
      netMeta[d.net] = netMeta[d.net] || { code: d.net, name: '', doi: null };
    }
  }
  // network names/DOIs from the digest the parse step already produced
  try {
    const digest = JSON.parse(fs.readFileSync(NETS, 'utf8'));
    const list = Array.isArray(digest) ? digest : Object.values(digest);
    list.forEach(n => {
      const code = n.code || n.network;
      if (code && netMeta[code]) {
        netMeta[code].name = n.description || n.net_desc || n.name || netMeta[code].name;
        netMeta[code].doi = n.doi || n.net_doi || netMeta[code].doi;
      }
    });
  } catch (e) { console.warn('networks digest unavailable: ' + e.message); }

  // ── Units (confirmed only) ──
  const confirmedKeys = new Set();
  const units = confirmed.map(c => {
    const key = [c.manufacturer, c.model || '', String(c.serial)].join('|');
    confirmedKeys.add(key);
    const deps = (sidecar[key] || []).map(d => Object.assign({}, d, {
      country: country(d.country),
      days: epochDays(d.start, d.end),
    }));
    const days = deps.reduce((n, d) => n + (d.days || 0), 0);
    return {
      model: c.model, serial: String(c.serial), manufacturer: c.manufacturer || null,
      attribution: c.attribution, basis: c.basis || null,
      cls: c.instrument_class || 'unclassified',
      auscope_sites: c.auscope_sites || [],
      // funding of the EXPERIMENT — context, never attribution (METHODOLOGY.md)
      funding: c.network_funding || [],
      funding_auscope: !!c.funding_names_auscope,
      roles: String(c.roles || '').split('+').filter(Boolean).join(', '),
      integrated: !!c.integrated_node,
      still: !!c.still_deployed, reconstructed: !!c.serial_reconstructed,
      coverage: c.coverage_pidinst || null,
      networks: c.networks || [], networks_auscope: c.networks_auscope || [],
      networks_other: c.networks_other || [],
      countries: (c.countries || []).map(country).filter((v, i, a) => a.indexOf(v) === i),
      network_dois: c.network_dois || [],
      doi: null,          // PIDInst record not minted yet
      n_deployments: deps.length, days: days,
      deployments: deps,
    };
  });

  // ── Network mix table: how much of each network's kit is confirmed AuScope ──
  const networks = Object.keys(netUnits).map(code => {
    const all = netUnits[code];
    let conf = 0;
    all.forEach(k => { if (confirmedKeys.has(k)) conf++; });
    const m = netMeta[code] || {};
    return {
      code: code, name: m.name || '', doi: m.doi || null,
      units: all.size, confirmed: conf,
      pct: all.size ? Math.round(conf / all.size * 100) : 0,
    };
  }).sort((a, b) => b.confirmed - a.confirmed || b.units - a.units);

  const totalDays = units.reduce((n, u) => n + u.days, 0);
  const dates = units.flatMap(u => u.deployments.map(d => d.start)).filter(Boolean).sort();

  const out = {
    metadata: {
      type: 'seismic-instruments',
      source: 'AusPASS StationXML (channel level) x ANSIR project database x AuScope experiment roster',
      methodology: 'src/seismic/METHODOLOGY.md',
      generated: new Date().toISOString(),
      scope: 'confirmed attribution tiers only (ANU-built, AuScope, ANSIR-loan)',
      attribution_counts: tiers,
      class_counts: cands.reduce(function (a, c) {
        var k = c.instrument_class || 'unclassified'; a[k] = (a[k] || 0) + 1; return a;
      }, {}),
      funding_evidence: {
        units_funding_names_auscope: cands.filter(function (c) { return c.funding_names_auscope; }).length,
        of_those_unconfirmed: cands.filter(function (c) {
          return c.funding_names_auscope && String(c.attribution).indexOf('confirmed') !== 0;
        }).length,
        note: 'Funding of the experiment, not evidence of instrument ownership; captured, not promoted.'
      },
      class_counts_confirmed: confirmed.reduce(function (a, c) {
        var k = c.instrument_class || 'unclassified'; a[k] = (a[k] || 0) + 1; return a;
      }, {}),
      units: units.length,
      units_still_deployed: units.filter(u => u.still).length,
      networks_hosting: networks.filter(n => n.confirmed > 0).length,
      networks_total: networks.length,
      deployments: units.reduce((n, u) => n + u.n_deployments, 0),
      deployment_days: totalDays,
      deployment_years: Math.round(totalDays / 365.25),
      first_deployment: dates[0] || null,
      pidinst_minted: units.filter(u => u.doi).length,
    },
    networks: networks,
    units: units,
  };

  fs.writeFileSync(OUT, JSON.stringify(out));
  const m = out.metadata;
  console.log('Attribution: ' + JSON.stringify(tiers));
  console.log(m.units + ' confirmed units (' + m.units_still_deployed + ' still deployed), '
    + m.deployments + ' station-deployments, ' + m.deployment_days.toLocaleString()
    + ' deployment-days (' + m.deployment_years + ' unit-years)');
  console.log('Hosted across ' + m.networks_hosting + ' of ' + m.networks_total + ' networks; PIDInst minted: ' + m.pidinst_minted + '/' + m.units);
  console.log('\nWrote ' + OUT + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB)');
}

run();
