#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Dataset Inventory
 *
 * Fetches all AuScope dataset DOIs from:
 *   1. EarthBank (DataCite API)
 *   2. AusPass (FDSN station + networks API)
 *   3. NCI GeoNetwork (MT + DAS collections)
 *
 * Stores in data/datasets.json. Run as part of the weekly GitHub Action.
 *
 * Usage: node src/dataset-inventory.js
 */

const fs = require('fs');
const path = require('path');
const { fetchJSON, sleep, normaliseDoi } = require('./utils');

const DATA_FILE = path.join(__dirname, '..', 'data', 'datasets.json');

async function run() {
  console.log('AuScope Dataset Inventory');
  console.log('========================\n');

  const allDatasets = [];

  // ── EarthBank (DataCite) ──
  try {
    const earthbank = await fetchEarthBank();
    allDatasets.push(...earthbank);
    console.log('EarthBank: ' + earthbank.length + ' datasets');
  } catch (err) {
    console.error('EarthBank error: ' + err.message);
  }

  // ── AusPass (FDSN) ──
  try {
    const auspass = await fetchAusPass();
    allDatasets.push(...auspass);
    console.log('AusPass: ' + auspass.length + ' networks');
  } catch (err) {
    console.error('AusPass error: ' + err.message);
  }

  // ── NCI Magnetotellurics ──
  try {
    const nciMT = await fetchNCICollection('f0824_6578_7486_1991', 'NCI MT');
    allDatasets.push(...nciMT);
    console.log('NCI MT: ' + nciMT.length + ' datasets');
  } catch (err) {
    console.error('NCI MT error: ' + err.message);
  }

  // ── NCI DAS ──
  try {
    const nciDAS = await fetchNCICollection('f7227_9397_9402_8183', 'NCI DAS');
    allDatasets.push(...nciDAS);
    console.log('NCI DAS: ' + nciDAS.length + ' datasets');
  } catch (err) {
    console.error('NCI DAS error: ' + err.message);
  }

  // Dedup by DOI (some datasets may appear in multiple sources)
  const deduped = dedup(allDatasets);

  // Save
  const output = {
    metadata: {
      type: 'datasets',
      last_updated: new Date().toISOString(),
      total_count: deduped.length
    },
    records: deduped
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));

  const withDoi = deduped.filter(d => d.doi).length;
  console.log('\nTotal: ' + deduped.length + ' datasets (' + withDoi + ' with DOI)');
  console.log('Saved to ' + DATA_FILE);
}

// ─── EarthBank (DataCite API) ───────────────────────────────────────────────

async function fetchEarthBank() {
  const datasets = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const url = 'https://api.datacite.org/dois?client-id=hypc.gxglvy&page[size]=' + pageSize
      + '&page[number]=' + page + '&sort=-created';
    const data = await fetchJSON(url);
    const items = data.data || [];
    if (items.length === 0) break;

    for (const item of items) {
      const attrs = item.attributes || {};
      const title = attrs.titles && attrs.titles[0] ? attrs.titles[0].title : 'Untitled';
      const authors = (attrs.creators || []).map(c => {
        if (c.familyName && c.givenName) return c.familyName + ', ' + c.givenName.charAt(0) + '.';
        return c.name || 'Unknown';
      }).join(', ');

      datasets.push({
        doi: attrs.doi || item.id,
        name: title,
        authors,
        year: attrs.publicationYear || null,
        platform: 'EarthBank',
        type: attrs.types ? (attrs.types.resourceTypeGeneral || 'Dataset') : 'Dataset'
      });
    }

    if (items.length < pageSize) break;
    page++;
    await sleep(200);
  }

  return datasets;
}

// ─── AusPass (FDSN Station + Networks API) ──────────────────────────────────

async function fetchAusPass() {
  // Step 1: Fetch network list from AusPass FDSN station service
  const stationResp = await fetch('https://auspass.edu.au/fdsnws/station/1/query?level=network&format=text');
  if (!stationResp.ok) throw new Error('AusPass station service HTTP ' + stationResp.status);
  const stationText = await stationResp.text();

  const lines = stationText.trim().split('\n');
  const networks = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('|');
    if (parts.length < 5) continue;
    const code = parts[0].trim();
    const desc = parts[1].trim();
    const startTime = parts[2].trim();
    const startYear = startTime ? startTime.substring(0, 4) : '';

    networks.push({
      code,
      name: desc,
      year: startYear ? parseInt(startYear) : null,
      doi: '',
      platform: 'AusPass',
      type: 'Seismic Network'
    });
  }

  // Step 2: Fetch DOIs from FDSN Networks API
  const doiMapExact = {};
  const doiMapCode = {};
  try {
    const fdsnResp = await fetch('https://www.fdsn.org/ws/networks/1/query?format=json');
    if (fdsnResp.ok) {
      const fdsnData = await fdsnResp.json();
      const fdsnNetworks = fdsnData.networks || fdsnData;
      if (Array.isArray(fdsnNetworks)) {
        for (const net of fdsnNetworks) {
          if (net.doi && net.fdsn_code) {
            doiMapCode[net.fdsn_code] = net.doi;
            if (net.start_date) {
              const sy = net.start_date.substring(0, 4);
              doiMapExact[net.fdsn_code + '_' + sy] = net.doi;
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn('  FDSN networks API failed: ' + e.message);
  }

  // Step 3: Match DOIs to networks
  for (const nw of networks) {
    const startYr = nw.year ? String(nw.year) : '';
    nw.doi = doiMapExact[nw.code + '_' + startYr] || doiMapCode[nw.code] || '';
  }

  return networks;
}

// ─── NCI GeoNetwork Collections ─────────────────────────────────────────────

async function fetchNCICollection(rootUuid, label) {
  const children = await fetchNCIChildren(rootUuid);
  // Recursively fetch one level deep
  const datasets = [];
  for (const child of children) {
    datasets.push(child);
    if (child.nciUuid) {
      try {
        const grandchildren = await fetchNCIChildren(child.nciUuid);
        datasets.push(...grandchildren);
      } catch (e) {
        // Some nodes are leaves
      }
      await sleep(200);
    }
  }
  return datasets;
}

async function fetchNCIChildren(parentUuid) {
  const url = 'https://geonetwork.nci.org.au/geonetwork/srv/api/records/' + parentUuid + '/related?type=children';
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) return [];
  const data = await resp.json();
  const children = data.children || [];

  const kids = [];
  for (const child of children) {
    const title = extractTitle(child);
    const uuid = child.id || child['@id'] || '';

    kids.push({
      doi: '',
      name: title,
      authors: '',
      year: null,
      platform: 'NCI',
      type: 'Dataset',
      nciUuid: uuid
    });
  }

  // Resolve DOIs and metadata for each child
  for (const kid of kids) {
    if (!kid.nciUuid) continue;
    try {
      const meta = await fetchNCIRecordMeta(kid.nciUuid);
      kid.doi = meta.doi;
      kid.authors = meta.authors;
      kid.year = meta.year ? parseInt(meta.year) : null;
    } catch (e) {
      // Skip metadata failures
    }
    await sleep(100);
  }

  return kids;
}

function extractTitle(child) {
  let title = child.title;
  if (title && typeof title === 'object') {
    title = title.eng || title.en || Object.values(title)[0] || 'Untitled';
  }
  return title || child.defaultTitle || 'Untitled';
}

async function fetchNCIRecordMeta(uuid) {
  const resp = await fetch('https://geonetwork.nci.org.au/geonetwork/srv/api/records/' + uuid, {
    headers: { 'Accept': 'application/json' }
  });
  if (!resp.ok) return { doi: '', authors: '', year: '' };
  const data = await resp.json();

  // Extract DOI
  let doi = '';
  try {
    const dsUri = data['gmd:dataSetURI'];
    if (dsUri) {
      const uriText = typeof dsUri['gco:CharacterString'] === 'object'
        ? dsUri['gco:CharacterString']['#text']
        : dsUri['gco:CharacterString'];
      if (uriText && uriText.indexOf('10.') === 0) doi = uriText;
      if (!doi) {
        const doiMatch = (uriText || '').match(/(?:doi\.org\/)?(10\.\d{4,}\/[^\s"'<,]+)/);
        if (doiMatch) doi = doiMatch[1];
      }
    }
  } catch (e) {}
  if (!doi) {
    const fullText = JSON.stringify(data);
    const nciDoi = fullText.match(/10\.25914\/[a-z0-9]+-[a-z0-9]+/);
    if (nciDoi) doi = nciDoi[0];
  }

  // Extract authors
  let authors = '';
  try {
    const ident = data['gmd:identificationInfo'] || {};
    const di = ident['gmd:MD_DataIdentification'] || {};
    const cit = di['gmd:citation'] || {};
    const ciCit = cit['gmd:CI_Citation'] || {};
    let parties = ciCit['gmd:citedResponsibleParty'];
    if (parties && !Array.isArray(parties)) parties = [parties];
    if (parties) {
      const names = [];
      for (const p of parties) {
        const rp = p['gmd:CI_ResponsibleParty'] || {};
        let role = '';
        try { role = rp['gmd:role']['gmd:CI_RoleCode']['@codeListValue']; } catch (e) {}
        if (role === 'author' || role === 'creator' || role === 'originator') {
          let name = '';
          try {
            name = rp['gmd:individualName']['gco:CharacterString'];
            if (typeof name === 'object') name = name['#text'] || '';
          } catch (e) {}
          if (!name) {
            try {
              name = rp['gmd:organisationName']['gco:CharacterString'];
              if (typeof name === 'object') name = name['#text'] || '';
            } catch (e) {}
          }
          if (name) names.push(name);
        }
      }
      if (names.length > 0) authors = names.join(', ');
    }
  } catch (e) {}

  // Extract year
  let year = '';
  try {
    const ident = data['gmd:identificationInfo'] || {};
    const di = ident['gmd:MD_DataIdentification'] || {};
    const cit = di['gmd:citation'] || {};
    const ciCit = cit['gmd:CI_Citation'] || {};
    let dates = ciCit['gmd:date'];
    if (dates && !Array.isArray(dates)) dates = [dates];
    if (dates) {
      for (const d of dates) {
        const ciDate = d['gmd:CI_Date'] || {};
        const dateStr = ciDate['gmd:date'] || {};
        let dt = dateStr['gco:DateTime'] || dateStr['gco:Date'];
        if (dt && typeof dt === 'object') dt = dt['#text'];
        if (dt) { year = String(dt).substring(0, 4); break; }
      }
    }
  } catch (e) {}

  return { doi, authors, year };
}

// ─── Dedup ──────────────────────────────────────────────────────────────────

function dedup(datasets) {
  const seen = {};
  const result = [];

  for (const ds of datasets) {
    // Dedup by DOI if available, otherwise by platform+name
    const key = ds.doi
      ? normaliseDoi(ds.doi)
      : (ds.platform + ':' + (ds.name || '').toLowerCase().substring(0, 50));

    if (!seen[key]) {
      seen[key] = true;
      result.push(ds);
    }
  }

  return result;
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
