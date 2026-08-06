#!/usr/bin/env node
/**
 * AuScope DOI Tracker — Dashboard Generator
 *
 * Reads data/publications.json (and data/datasets.json when ready)
 * and generates a static HTML dashboard at docs/index.html.
 * Designed to be served via GitHub Pages and embedded via iframe.
 *
 * Usage: node src/dashboard.js
 */

const fs = require('fs');
const path = require('path');

const DOCS_DIR = path.join(__dirname, '..', 'docs');
const PUB_FILE = path.join(__dirname, '..', 'data', 'publications.json');
const DS_FILE = path.join(__dirname, '..', 'data', 'datasets.json');
const PILLAR_FILE = path.join(DOCS_DIR, 'stats-data.json');

// Some source records store titles with HTML entities ("&amp;#8217;") or
// markup tags (<sup>40</sup>Ar). Decode + strip to plain text at export
// time; pages re-escape on render. Isotope superscripts degrade to the
// standard plain form (40Ar/39Ar).
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, function(m, n) { return String.fromCharCode(parseInt(n)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function(m, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/<\/?[a-zA-Z][^>]*>/g, '');
}

function run() {
  // Load data
  const pubData = fs.existsSync(PUB_FILE)
    ? JSON.parse(fs.readFileSync(PUB_FILE, 'utf8'))
    : { metadata: {}, records: [] };

  const dsData = fs.existsSync(DS_FILE)
    ? JSON.parse(fs.readFileSync(DS_FILE, 'utf8'))
    : { metadata: {}, records: [] };

  const pubs = pubData.records || [];
  const datasets = dsData.records || [];

  // ── Compute stats ──
  const stats = computeStats(pubs, datasets);

  // ── Write docs/data.json (for any external consumers) ──
  fs.writeFileSync(path.join(DOCS_DIR, 'data.json'), JSON.stringify({
    generated: new Date().toISOString(),
    stats: stats.summary,
    publicationsByYear: stats.byYear,
    topSubjects: stats.topSubjects,
    citationDistribution: stats.citationBuckets,
    evidenceBreakdown: stats.evidence
  }, null, 2));

  // ── Write docs/publications-data.json (slim feed for publications.html) ──
  const slim = pubs.map(function(p) {
    let authors = decodeEntities(String(p.authors || ''));
    if (authors.length > 260) authors = authors.substring(0, 257) + '…';
    return {
      doi: p.doi || '',
      title: decodeEntities(String(p.title || '')),
      authors: authors,
      year: p.year || '',
      journal: decodeEntities(String(p.journal || '')),
      cited: parseInt(p.cited) || 0,
      evidence: p.evidence || 'keyword',
      programs: recordPrograms(p),
      oa: /^yes$/i.test(String(p.isOA || ''))
    };
  });
  fs.writeFileSync(path.join(DOCS_DIR, 'publications-data.json'), JSON.stringify({
    generated: new Date().toISOString(),
    records: slim
  }));

  // ── Write docs/index.html ──
  // Cross-pillar numbers come from src/stats.js (run it first in CI);
  // missing/stale file just hides the explorer card numbers.
  const pillarData = fs.existsSync(PILLAR_FILE)
    ? JSON.parse(fs.readFileSync(PILLAR_FILE, 'utf8'))
    : null;
  const html = buildHTML(stats, pubData.metadata.last_updated, pillarData);
  fs.writeFileSync(path.join(DOCS_DIR, 'index.html'), html);

  // ── Write docs/widget.html (embeddable stats-only widget) ──
  const widget = buildWidget(stats, pubData.metadata.last_updated);
  fs.writeFileSync(path.join(DOCS_DIR, 'widget.html'), widget);

  console.log('Dashboard generated: docs/index.html');
  console.log('Widget generated: docs/widget.html');
  console.log('Data exported: docs/data.json');
  console.log('Stats: ' + stats.summary.totalPublications + ' publications, '
    + stats.summary.totalCitations + ' citations');
}

// Generic/overly broad subject terms to exclude from the topic chart.
// These come from MeSH headings or broad S2 categories that add noise
// without telling a useful story about AuScope research areas.
const GENERIC_SUBJECTS = new Set([
  'animals', 'humans', 'male', 'female', 'adult',
  'geology', 'engineering', 'environmental science',
  'computer science', 'mathematics', 'chemistry', 'physics',
  'models, theoretical', 'logistic models', 'biomass',
  'tooth', 'bone and bones',
  'compulsive behavior',
  'ecosystem', 'biodiversity', 'phylogeny',
  'oxygen', 'temperature', 'water',
  'time factors', 'reproducibility of results'
]);

function computeStats(pubs, datasets) {
  // Summary
  let totalCitations = 0;
  let citedPubs = 0;
  const journals = {};
  const yearCounts = {};
  const topicCounts = {};
  let noSubjectCount = 0;
  const allInstitutions = {};
  const allCountries = {};
  const allAuthors = {};

  for (const p of pubs) {
    const cited = parseInt(p.cited) || 0;
    totalCitations += cited;
    if (cited > 0) citedPubs++;
    if (p.journal) journals[p.journal] = true;

    // Collect unique institutions and countries
    for (const inst of (p.institutions || [])) {
      if (inst) allInstitutions[inst] = true;
    }
    for (const cc of (p.countries || [])) {
      if (cc) allCountries[cc] = true;
    }
    // Collect unique author names (approximate — name-based dedup)
    if (p.authors) {
      p.authors.split(';').forEach(a => {
        a = a.trim();
        if (a) allAuthors[a.toLowerCase()] = a; // lowercase key for dedup, preserve display
      });
    }

    const year = parseInt(p.year);
    if (year && !isNaN(year)) {
      yearCounts[year] = (yearCounts[year] || 0) + 1;
    }

    if (p.subject) {
      p.subject.split(';').forEach(s => {
        s = s.trim();
        if (s && !GENERIC_SUBJECTS.has(s.toLowerCase())) {
          topicCounts[s] = (topicCounts[s] || 0) + 1;
        }
      });
    } else {
      noSubjectCount++;
    }
  }

  const years = Object.keys(yearCounts).map(Number).sort();
  const minYear = years[0] || 0;
  const maxYear = years[years.length - 1] || 0;

  // Citations by publication year (how many citations do papers from year X have)
  const citationsByYear = {};
  for (const p of pubs) {
    const year = parseInt(p.year);
    if (year && !isNaN(year)) {
      citationsByYear[year] = (citationsByYear[year] || 0) + (parseInt(p.cited) || 0);
    }
  }

  // Publications by year (continuous range) with cumulative pubs and citations
  const byYear = [];
  let cumPubs = 0;
  let cumCitations = 0;
  for (let y = minYear; y <= maxYear; y++) {
    const count = yearCounts[y] || 0;
    const citations = citationsByYear[y] || 0;
    cumPubs += count;
    cumCitations += citations;
    byYear.push({ year: y, count, cumulative: cumPubs, citations, cumulativeCitations: cumCitations });
  }

  // Top subjects
  const sortedTopics = Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  const topSubjects = sortedTopics.map(([topic, count]) => ({ topic, count }));

  // Citation buckets
  const bucketDefs = [
    { label: '0', min: 0, max: 0 },
    { label: '1–5', min: 1, max: 5 },
    { label: '6–20', min: 6, max: 20 },
    { label: '21–50', min: 21, max: 50 },
    { label: '51–100', min: 51, max: 100 },
    { label: '100+', min: 101, max: Infinity }
  ];
  const citationBuckets = bucketDefs.map(b => {
    const count = pubs.filter(p => {
      const c = parseInt(p.cited) || 0;
      return c >= b.min && c <= b.max;
    }).length;
    return { label: b.label, count };
  });

  return {
    summary: {
      totalPublications: pubs.length,
      totalDatasets: datasets.length,
      totalCitations,
      citedPublications: citedPubs,
      citedPercent: pubs.length ? parseFloat((citedPubs / pubs.length * 100).toFixed(1)) : 0,
      avgCitations: pubs.length ? parseFloat((totalCitations / pubs.length).toFixed(1)) : 0,
      uniqueJournals: Object.keys(journals).length,
      uniqueAuthors: Object.keys(allAuthors).length,
      uniqueInstitutions: Object.keys(allInstitutions).length,
      uniqueCountries: Object.keys(allCountries).length,
      yearRange: minYear && maxYear ? minYear + '–' + maxYear : 'N/A',
      noSubjectCount
    },
    byYear,
    topSubjects,
    citationBuckets,
    evidence: computeEvidence(pubs),
    programs: computePrograms(pubs)
  };
}

// AuScope program groups, mapped from the search terms that found each
// paper. Manual submission/entry and ROR-verified are provenance tags, not
// programs — deliberately absent. A paper found by terms from several
// groups counts in each (noted on the chart).
const PROGRAM_GROUPS = [
  { name: 'Simulation & modelling software', terms: ['GPlates', 'EarthByte', 'Underworld2', 'G-Adopt geodynamic', 'Simulation Analysis Modelling AuScope'] },
  { name: 'Geochemistry & characterisation', terms: ['SHRIMP II Curtin', 'AusGeochem', 'Hylogger CSIRO', 'Western Australia Argon Isotope Facility', 'National Virtual Core Library', 'Geoscience Atom Probe', 'AuScope Geochemistry Network', 'Noble Gas Geochronology Laboratory', 'National Argon Map', 'Characterisation AuScope'] },
  { name: 'Geodesy & VLBI', terms: ['Katherine VLBI', 'Yarragadee VLBI', 'AuScope VLBI', 'Mt Pleasant VLBI', 'Geospatial Geodesy AuScope'] },
  { name: 'Earth imaging & sounding', terms: ['AusLAMP', 'AusPass', 'Australian Geophysical Observing System', 'Earth Imaging Sounding AuScope'] },
  { name: 'Education & outreach', terms: ['Australian Seismometers in Schools', 'Outreach Engagement AuScope'] },
  { name: 'AVRE & data systems', terms: ['AuScope Discovery Portal', 'AVRE AuScope', 'AuScope Virtual Research Environment', 'Research Data Systems AuScope', 'Australian Scalable Drone Cloud'] },
  { name: 'AuScope (general)', terms: ['AuScope', 'International Collaboration AuScope', 'Earth Composition Evolution AuScope', 'Earth Sampling AuScope', 'Geophysics2030'] }
];

const TERM_TO_GROUP = {};
PROGRAM_GROUPS.forEach(function(g) {
  g.terms.forEach(function(t) { TERM_TO_GROUP[t] = g.name; });
});

// Per-record program list + per-group counts (a record counts once per group).
function recordPrograms(p) {
  const seen = {};
  (p.searchTerms || []).forEach(function(t) {
    const g = TERM_TO_GROUP[t];
    if (g) seen[g] = true;
  });
  return Object.keys(seen);
}

function computePrograms(pubs) {
  const counts = {};
  for (const p of pubs) {
    recordPrograms(p).forEach(function(g) { counts[g] = (counts[g] || 0) + 1; });
  }
  return PROGRAM_GROUPS
    .map(function(g) { return { name: g.name, count: counts[g.name] || 0 }; })
    .filter(function(g) { return g.count > 0; })
    .sort(function(a, b) { return b.count - a.count; });
}

// Evidence ladder distribution (field written by src/evidence.js).
function computeEvidence(pubs) {
  const counts = {};
  let tagged = 0;
  for (const p of pubs) {
    if (!p.evidence) continue;
    tagged++;
    counts[p.evidence] = (counts[p.evidence] || 0) + 1;
  }
  return tagged ? counts : null;
}

// Evidence ladder section: how strongly each publication is linked to
// AuScope, best evidence first. The honest split IS the feature — keyword-
// only papers are shown, not hidden.
const EVIDENCE_LADDER = [
  { key: 'verified', label: 'Verified', desc: 'AuScope ROR or funder ID on the paper', fill: '#282572' },
  { key: 'candidate', label: 'Candidate', desc: 'watchlist ORCID + partner co-affiliation', fill: '#4a43b8' },
  { key: 'text-attributed', label: 'Acknowledged in text', desc: 'AuScope/facility acknowledgement found', fill: '#6c66d6' },
  { key: 'text-infrastructure', label: 'Infrastructure-enabled', desc: 'infrastructure-use wording found', fill: '#8f8ae0' },
  { key: 'text-software', label: 'AuScope software used', desc: 'GPlates, Underworld, and other tools', fill: '#b3afe9' },
  { key: 'keyword', label: 'Keyword match only', desc: 'no confirmed signal yet — under review', fill: '#cbd5e1' }
];

function buildEvidenceSection(evidence) {
  if (!evidence) return '';
  const max = Math.max.apply(null, EVIDENCE_LADDER.map(function(e) { return evidence[e.key] || 0; }));
  const rows = EVIDENCE_LADDER.map(function(e) {
    const n = evidence[e.key] || 0;
    const w = max ? Math.max(2, Math.round(n / max * 100)) : 2;
    return '            <a class="bar-row" href="publications.html?evidence=' + e.key + '" title="' + e.desc + '" style="text-decoration:none;color:inherit">\n'
      + '                <div class="bar-label">' + e.label + '</div>\n'
      + '                <div class="bar-track"><div class="bar-fill" style="width:' + w + '%;background:' + e.fill + '"></div></div>\n'
      + '                <div class="bar-value">' + n.toLocaleString() + '</div>\n'
      + '            </a>';
  }).join('\n');
  return '\n    <!-- ═══ Evidence ladder (from src/evidence.js) ═══ -->\n'
    + '    <div class="explorers">\n'
    + '        <h2>Evidence behind the publications count</h2>\n'
    + '        <div class="note">Every publication is graded by its strongest verifiable link to AuScope — identifier evidence first, then text acknowledgement, then keyword match. Click a row to browse those papers.</div>\n'
    + '        <div class="bar-chart">\n' + rows + '\n        </div>\n'
    + '    </div>\n';
}

// Publications by program: search-term tags mapped to AuScope program groups.
function buildProgramSection(programs) {
  if (!programs || !programs.length) return '';
  const max = programs[0].count;
  const rows = programs.map(function(g) {
    const w = Math.max(2, Math.round(g.count / max * 100));
    return '            <a class="bar-row" href="publications.html?program=' + encodeURIComponent(g.name) + '" style="text-decoration:none;color:inherit">\n'
      + '                <div class="bar-label">' + g.name + '</div>\n'
      + '                <div class="bar-track"><div class="bar-fill" style="width:' + w + '%"></div></div>\n'
      + '                <div class="bar-value">' + g.count.toLocaleString() + '</div>\n'
      + '            </a>';
  }).join('\n');
  return '\n    <!-- ═══ Publications by program ═══ -->\n'
    + '    <div class="explorers">\n'
    + '        <h2>Publications by AuScope program</h2>\n'
    + '        <div class="note">Grouped from the search terms that found each paper — a paper crediting several programs counts in each. Papers added manually carry no program tag yet. Click a row to browse.</div>\n'
    + '        <div class="bar-chart">\n' + rows + '\n        </div>\n'
    + '    </div>\n';
}

// Hero tiles: cross-pillar headline numbers. Researchers/institutions/
// countries are deliberately absent — computed over the unverified keyword
// corpus they inflate beyond belief; they return once evidence tiers let us
// count them over verified publications only.
function buildHeroTiles(s, pillarData) {
  const tiles = [
    { n: s.totalPublications, label: 'Publications' },
    { n: s.totalCitations, label: 'Total Citations' }
  ];
  const p = pillarData && pillarData.pillars;
  if (p) {
    if (p.datasets) tiles.push({ n: p.datasets.total, label: 'Datasets' });
    if (p.samples && p.samples.declared) tiles.push({ n: p.samples.declared, label: 'Samples' });
    if (p.stations) tiles.push({ n: p.stations.total, label: 'Seismic Stations' });
    if (p.instruments) {
      tiles.push({ n: p.instruments.units, label: 'Instruments' });
      // Surveys deliberately NOT a hero tile: the registry's 9 DOI-registered
      // surveys are a PID-coverage count, not a count of AuScope fieldwork —
      // a hero number that needs a footnote invites the wrong question.
      // They appear on the explorer card below with precise wording.
    }
  }
  return tiles.map(function(t) {
    return '            <div class="stat-card">\n'
      + '                <div class="number">' + t.n.toLocaleString() + '</div>\n'
      + '                <div class="label">' + t.label + '</div>\n'
      + '            </div>';
  }).join('\n');
}

// Explorer cards: cross-pillar numbers from src/stats.js, each linking to
// the page that IS the evidence behind the number. Skips gracefully when
// stats-data.json is absent or a pillar failed to fetch.
function buildExplorerCards(pillarData) {
  if (!pillarData || !pillarData.pillars) return '';
  const p = pillarData.pillars;
  const cards = [];

  if (p.publications) {
    cards.push({ href: 'publications.html', num: p.publications.total.toLocaleString(),
      name: 'Publications', sub: 'evidence-graded · browse all' });
  }
  if (p.datasets) {
    const platforms = Object.keys(p.datasets.byPlatform || {}).length;
    cards.push({ href: 'datasets.html', num: p.datasets.total.toLocaleString(),
      name: 'Datasets', sub: platforms + ' platforms' });
  }
  if (p.samples && p.samples.declared) {
    // Nearly all samples are covered by their DATASET's DOI; the sampleDois
    // count is samples with their own individual PhysicalObject DOI —
    // wording must not imply the rest are un-PID'd.
    cards.push({ href: 'earthbank.html', num: p.samples.declared.toLocaleString(),
      name: 'Samples',
      sub: 'in DOI-registered datasets' });
  }
  if ((p.datasets && (p.datasets.byPlatform || {}).AusPass)) {
    const stations = p.stations ? p.stations.total.toLocaleString() + ' stations' : 'stations + citations';
    cards.push({ href: 'auspass.html', num: p.datasets.byPlatform.AusPass.toLocaleString(),
      name: 'AusPass networks', sub: stations });
  }
  if (p.instruments) {
    cards.push({ href: 'instruments.html', num: p.instruments.units.toLocaleString(),
      name: 'Instruments', sub: 'PIDInst DOIs · metadata health' });
    cards.push({ href: 'instruments.html', num: String(p.instruments.surveys),
      name: 'DOI-registered surveys', sub: 'each lists its PIDInst components · '
        + p.instruments.linkedDatasets + ' datasets · '
        + p.instruments.linkedPapers + ' papers' });
  }
  if (p.nvcl) {
    cards.push({ href: 'nvcl.html', num: Math.round(p.nvcl.scannedKm).toLocaleString() + ' km',
      name: 'NVCL core scanned', sub: p.nvcl.boreholes.toLocaleString() + ' boreholes · '
        + p.nvcl.nodes + ' state nodes · verifiable live' });
  }
  if (p.ausis) {
    cards.push({ href: 'ausis.html',
      num: p.ausis.stations.toLocaleString(),
      name: 'Seismometers in schools',
      sub: p.ausis.active + ' active'
        + (p.ausis.streaming ? ' · ' + p.ausis.streaming + ' streaming now' : '')
        + ' · since ' + p.ausis.since });
  }
  if (!cards.length) return '';

  const cardHtml = cards.map(function(c) {
    return '        <a class="explorer-card" href="' + c.href + '">\n'
      + '            <div class="num">' + c.num + '</div>\n'
      + '            <div class="name">' + c.name + '</div>\n'
      + '            <div class="sub">' + c.sub + '</div>\n'
      + '        </a>';
  }).join('\n');

  let out = '\n    <!-- ═══ Explorer cards (from src/stats.js) ═══ -->\n'
    + '    <div class="explorers">\n'
    + '        <h2>Explore the evidence</h2>\n'
    + '        <div class="note">Every number links to the live records behind it.</div>\n'
    + '        <div class="explorer-grid">\n' + cardHtml + '\n        </div>\n';

  // Most-deployed instrument models (survey memberships per model)
  const tm = p.instruments && p.instruments.topModels;
  if (tm && tm.length) {
    const maxDep = tm[0].deployments;
    const rows = tm.map(function(t) {
      const w = Math.max(2, Math.round(t.deployments / maxDep * 100));
      return '            <div class="bar-row">\n'
        + '                <div class="bar-label">' + t.model + '</div>\n'
        + '                <div class="bar-track"><div class="bar-fill" style="width:' + w + '%"></div></div>\n'
        + '                <div class="bar-value">' + t.deployments + '</div>\n'
        + '            </div>';
    }).join('\n');
    out += '        <h2 style="margin-top:24px">Most deployed instruments</h2>\n'
      + '        <div class="note">Survey deployments per instrument model, from the PIDInst registry\'s survey&rarr;component links.</div>\n'
      + '        <div class="bar-chart">\n' + rows + '\n        </div>\n';
  }

  return out + '    </div>\n';
}

function buildHTML(stats, lastUpdated, pillarData) {
  const s = stats.summary;
  const updated = lastUpdated ? new Date(lastUpdated).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : 'N/A';
  const explorerCards = buildExplorerCards(pillarData);

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AuScope Research Impact</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #1e293b;
            background: #ffffff;
            line-height: 1.5;
        }

        /* ── Hero Stats (TERN-style) ── */
        .hero {
            background: #282572; /* flat AuScope purple — page embeds as an iframe on auscope.org.au */
            color: #ffffff;
            padding: 40px 24px 32px;
            text-align: center;
        }
        .hero h1 {
            font-size: 24px;
            font-weight: 700;
            margin-bottom: 4px;
            letter-spacing: -0.5px;
        }
        .hero .subtitle {
            font-size: 13px;
            opacity: 0.8;
            margin-bottom: 28px;
        }
        .hero .more-than {
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 2px;
            color: #EF7256; /* AuScope tangerine — the one accent on the page */
            margin-bottom: 16px;
        }
        .stat-grid {
            display: flex;
            justify-content: center;
            flex-wrap: wrap;
            gap: 12px;
            max-width: 900px;
            margin: 0 auto;
        }
        .stat-card {
            flex: 1;
            min-width: 140px;
            max-width: 200px;
            padding: 16px 12px;
            background: rgba(255,255,255,0.12);
            border-radius: 10px;
            backdrop-filter: blur(4px);
        }
        .stat-card .number {
            font-size: 32px;
            font-weight: 800;
            line-height: 1.1;
            color: #ffffff;
        }
        .stat-card .label {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            opacity: 0.85;
            margin-top: 4px;
        }

        /* ── Explorer cards ── */
        .explorers {
            max-width: 960px;
            margin: 0 auto;
            padding: 28px 24px 0;
        }
        .explorers h2 {
            font-size: 16px;
            font-weight: 700;
            color: #282572;
            margin-bottom: 4px;
        }
        .explorers .note {
            font-size: 12px;
            color: #64748b;
            margin-bottom: 14px;
        }
        .explorer-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 12px;
        }
        .explorer-card {
            display: block;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 14px 16px;
            text-decoration: none;
            color: inherit;
            transition: border-color 0.15s, box-shadow 0.15s;
        }
        .explorer-card:hover {
            border-color: #282572;
            box-shadow: 0 2px 8px rgba(37, 99, 235, 0.12);
        }
        .explorer-card .num {
            font-size: 24px;
            font-weight: 700;
            color: #282572;
        }
        .explorer-card .name {
            font-size: 13px;
            font-weight: 600;
            color: #0f172a;
            margin-top: 2px;
        }
        .explorer-card .sub {
            font-size: 11px;
            color: #64748b;
            margin-top: 2px;
        }

        /* ── Charts Section ── */
        .charts {
            max-width: 960px;
            margin: 0 auto;
            padding: 32px 24px;
        }
        .chart-section {
            margin-bottom: 36px;
        }
        .chart-section h2 {
            font-size: 16px;
            font-weight: 700;
            color: #282572;
            margin-bottom: 16px;
        }
        .chart-section .note {
            font-size: 11px;
            color: #94a3b8;
            margin-bottom: 12px;
            font-style: italic;
        }

        /* ── Bar chart (CSS-only) ── */
        .bar-chart { display: flex; flex-direction: column; gap: 6px; }
        .bar-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
        .bar-label { width: 200px; text-align: right; color: #475569; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
        .bar-track { flex: 1; height: 22px; background: #f1f5f9; border-radius: 4px; overflow: hidden; }
        .bar-fill { height: 100%; background: #282572; border-radius: 4px; min-width: 2px; transition: width 0.3s; }
        .bar-value { width: 40px; font-weight: 600; color: #282572; font-size: 12px; }

        /* ── SVG charts ── */

        /* ── Citation buckets ── */
        .bucket-chart { display: flex; align-items: flex-end; gap: 8px; height: 320px; }
        .bucket-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
        .bucket-bar { width: 80%; background: #282572; border-radius: 4px 4px 0 0; min-height: 2px; flex-shrink: 0; }
        .bucket-label { font-size: 11px; color: #64748b; margin-top: 6px; }
        .bucket-count { font-size: 11px; color: #282572; font-weight: 600; margin-bottom: 3px; }

        /* ── Footer ── */
        .footer {
            text-align: center;
            padding: 16px 24px 24px;
            font-size: 11px;
            color: #94a3b8;
            border-top: 1px solid #e2e8f0;
            max-width: 960px;
            margin: 0 auto;
        }
        .footer a { color: #282572; text-decoration: none; }
        .footer a:hover { text-decoration: underline; }

        @media (max-width: 600px) {
            .stat-grid { gap: 8px; }
            .stat-card { min-width: 100px; padding: 12px 8px; }
            .stat-card .number { font-size: 24px; }
            .bar-label { width: 120px; }
        }
    </style>
</head>
<body>
    <!-- ═══ Hero Stats ═══ -->
    <div class="hero">
        <h1>AuScope Research Impact</h1>
        <p class="subtitle">Tracking publications and citations across AuScope research infrastructure</p>
        <div class="more-than">AuScope Impact at a Glance</div>
        <div class="stat-grid">
${buildHeroTiles(s, pillarData)}
        </div>
    </div>

${explorerCards}
${buildEvidenceSection(stats.evidence)}
${buildProgramSection(stats.programs)}
    <!-- ═══ Charts ═══ -->
    <div class="charts">
        <!-- Publications by Year -->
        <div class="chart-section">
            <h2>Publications by Year</h2>
            ${buildYearChart(stats.byYear)}
        </div>

        <!-- Cumulative Citations -->
        <div class="chart-section">
            <h2>Cumulative Citations</h2>
            ${buildCumulativeChart(stats.byYear)}
        </div>

        <!-- Top Subjects -->
        <div class="chart-section">
            <h2>Top Research Subjects</h2>
            ${s.noSubjectCount > 0 ? '<p class="note">' + s.noSubjectCount + ' of ' + s.totalPublications + ' publications lack subject data</p>' : ''}
            ${buildBarChart(stats.topSubjects)}
        </div>

        <!-- Citation Distribution -->
        <div class="chart-section">
            <h2>Citation Distribution</h2>
            ${buildBucketChart(stats.citationBuckets)}
        </div>
    </div>

    <!-- ═══ Footer ═══ -->
    <div class="footer">
        Explore:
        <a href="publications.html">Publications</a> &middot;
        <a href="datasets.html">Datasets</a> &middot;
        <a href="earthbank.html">EarthBank</a> &middot;
        <a href="auspass.html">AusPass</a> &middot;
        <a href="instruments.html">Instrument Registry</a> &middot;
        <a href="ausis.html">AuSIS</a> &middot;
        <a href="nvcl.html">NVCL</a>
        <br>
        Last updated: ${updated} &middot;
        Powered by <a href="https://openalex.org" target="_blank">OpenAlex</a>,
        <a href="https://www.semanticscholar.org" target="_blank">Semantic Scholar</a>, and
        <a href="https://europepmc.org" target="_blank">Europe PMC</a>
        &middot; <a href="https://www.auscope.org.au" target="_blank">AuScope</a>
    </div>
</body>
</html>`;
}

/**
 * Generate nice round tick values for a chart axis.
 * E.g. for max=21096, count=5 → [0, 5000, 10000, 15000, 20000]
 */
function niceAxisTicks(maxValue, count) {
  if (maxValue <= 0) return [0];
  const rawStep = maxValue / count;
  // Round step to nearest nice number (1, 2, 5, 10, 20, 50, 100, ...)
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / magnitude;
  let niceStep;
  if (residual <= 1.5) niceStep = 1 * magnitude;
  else if (residual <= 3.5) niceStep = 2 * magnitude;
  else if (residual <= 7.5) niceStep = 5 * magnitude;
  else niceStep = 10 * magnitude;

  const ticks = [];
  for (let v = 0; v <= maxValue; v += niceStep) {
    ticks.push(v);
  }
  return ticks;
}

function buildYearChart(byYear) {
  if (!byYear.length) return '<p>No data</p>';

  const maxCount = Math.max(...byYear.map(y => y.count), 1);
  const svgW = 800;
  const svgH = 280;
  const padL = 50;
  const padR = 16;
  const padT = 16;
  const padB = 40;
  const plotW = svgW - padL - padR;
  const plotH = svgH - padT - padB;
  const barGap = 2;
  const barW = Math.max((plotW / byYear.length) - barGap, 2);

  const yTicks = niceAxisTicks(maxCount, 5);

  let svg = '<svg viewBox="0 0 ' + svgW + ' ' + svgH + '" style="width:100%;max-width:' + svgW + 'px;height:auto;">';

  // Grid lines
  for (const val of yTicks) {
    const y = padT + plotH - (val / maxCount) * plotH;
    svg += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (padL + plotW) + '" y2="' + y.toFixed(1) + '" stroke="#e2e8f0" stroke-width="1" />';
    svg += '<text x="' + (padL - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" font-size="11" fill="#64748b">' + val.toLocaleString() + '</text>';
  }

  // Bars
  for (let i = 0; i < byYear.length; i++) {
    const y = byYear[i];
    const x = padL + i * (barW + barGap) + barGap / 2;
    const barH = y.count > 0 ? Math.max((y.count / maxCount) * plotH, 2) : 0;
    const barY = padT + plotH - barH;

    if (barH > 0) {
      svg += '<rect x="' + x.toFixed(1) + '" y="' + barY.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + barH.toFixed(1) + '" fill="#282572" rx="2" />';
    }

    // Count label above bar (only if there's room)
    if (y.count > 0 && barW > 10) {
      svg += '<text x="' + (x + barW / 2).toFixed(1) + '" y="' + (barY - 4).toFixed(1) + '" text-anchor="middle" font-size="9" fill="#282572" font-weight="600">' + y.count + '</text>';
    }
  }

  // X-axis labels (every 5 years)
  for (let i = 0; i < byYear.length; i++) {
    const y = byYear[i];
    if (y.year % 5 === 0 || i === byYear.length - 1) {
      const x = padL + i * (barW + barGap) + barW / 2;
      svg += '<text x="' + x.toFixed(1) + '" y="' + (padT + plotH + 20) + '" text-anchor="middle" font-size="11" fill="#64748b">' + y.year + '</text>';
    }
  }

  // Axis lines
  svg += '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (padT + plotH) + '" stroke="#cbd5e1" stroke-width="1" />';
  svg += '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (padL + plotW) + '" y2="' + (padT + plotH) + '" stroke="#cbd5e1" stroke-width="1" />';

  svg += '</svg>';
  return svg;
}

function buildCumulativeChart(byYear) {
  if (!byYear.length) return '<p>No data</p>';

  const maxCum = byYear[byYear.length - 1].cumulativeCitations;
  if (!maxCum) return '<p>No citation data</p>';

  const svgW = 800;
  const svgH = 280;
  const padL = 50;
  const padR = 16;
  const padT = 16;
  const padB = 40;
  const plotW = svgW - padL - padR;
  const plotH = svgH - padT - padB;

  // Build line points
  const points = byYear.map((y, i) => {
    const x = padL + (i / (byYear.length - 1)) * plotW;
    const yPos = padT + plotH - (y.cumulativeCitations / maxCum) * plotH;
    return x.toFixed(1) + ',' + yPos.toFixed(1);
  });

  // Filled area
  const areaPoints = points.join(' ')
    + ' ' + (padL + plotW).toFixed(1) + ',' + (padT + plotH).toFixed(1)
    + ' ' + padL.toFixed(1) + ',' + (padT + plotH).toFixed(1);

  // Y-axis tick values — nice round numbers
  const yTicks = niceAxisTicks(maxCum, 5).map(value => ({
    value,
    y: padT + plotH - (value / maxCum) * plotH
  }));

  // X-axis labels (every 5 years)
  const xLabels = byYear.filter((y, i) => y.year % 5 === 0 || i === byYear.length - 1);

  let svg = '<svg viewBox="0 0 ' + svgW + ' ' + svgH + '" style="width:100%;max-width:' + svgW + 'px;height:auto;">';

  // Grid lines
  for (const tick of yTicks) {
    svg += '<line x1="' + padL + '" y1="' + tick.y.toFixed(1) + '" x2="' + (padL + plotW) + '" y2="' + tick.y.toFixed(1) + '" stroke="#e2e8f0" stroke-width="1" />';
  }

  // Filled area under line
  svg += '<polygon points="' + areaPoints + '" fill="#282572" fill-opacity="0.08" />';

  // Line
  svg += '<polyline points="' + points.join(' ') + '" fill="none" stroke="#282572" stroke-width="2.5" stroke-linejoin="round" />';

  // End dot
  const lastPt = points[points.length - 1].split(',');
  svg += '<circle cx="' + lastPt[0] + '" cy="' + lastPt[1] + '" r="4" fill="#282572" />';

  // Y-axis labels
  for (const tick of yTicks) {
    svg += '<text x="' + (padL - 8) + '" y="' + (tick.y + 4).toFixed(1) + '" text-anchor="end" font-size="11" fill="#64748b">'
      + tick.value.toLocaleString() + '</text>';
  }

  // X-axis labels
  for (const y of xLabels) {
    const i = byYear.indexOf(y);
    const x = padL + (i / (byYear.length - 1)) * plotW;
    svg += '<text x="' + x.toFixed(1) + '" y="' + (padT + plotH + 20) + '" text-anchor="middle" font-size="11" fill="#64748b">'
      + y.year + '</text>';
  }

  // Axis lines
  svg += '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (padT + plotH) + '" stroke="#cbd5e1" stroke-width="1" />';
  svg += '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (padL + plotW) + '" y2="' + (padT + plotH) + '" stroke="#cbd5e1" stroke-width="1" />';

  svg += '</svg>';
  return svg;
}

function buildBarChart(subjects) {
  if (!subjects.length) return '<p>No subject data available</p>';
  const maxCount = subjects[0].count;

  let html = '<div class="bar-chart">';
  for (const s of subjects) {
    const pct = Math.round((s.count / maxCount) * 100);
    html += '<div class="bar-row">'
      + '<div class="bar-label" title="' + escapeHtml(s.topic) + '">' + escapeHtml(s.topic) + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>'
      + '<div class="bar-value">' + s.count + '</div>'
      + '</div>';
  }
  html += '</div>';
  return html;
}

function buildBucketChart(buckets) {
  if (!buckets.length) return '<p>No data</p>';
  const maxCount = Math.max(...buckets.map(b => b.count), 1);
  const maxBarPx = 280; // max bar height in pixels

  let html = '<div class="bucket-chart">';
  for (const b of buckets) {
    const barPx = Math.max(Math.round((b.count / maxCount) * maxBarPx), b.count > 0 ? 3 : 0);
    html += '<div class="bucket-col">'
      + '<div class="bucket-count">' + b.count + '</div>'
      + '<div class="bucket-bar" style="height:' + barPx + 'px"></div>'
      + '<div class="bucket-label">' + b.label + '</div>'
      + '</div>';
  }
  html += '</div>';
  return html;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildWidget(stats, lastUpdated) {
  const s = stats.summary;
  const updated = lastUpdated ? new Date(lastUpdated).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : 'N/A';

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AuScope Research Impact</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: transparent;
        }
        .widget {
            background: #282572;
            color: #ffffff;
            padding: 20px 24px 18px;
            text-align: center;
            border-radius: 12px;
            max-width: 1100px;
            margin: 0 auto;
        }
        .widget h2 {
            font-size: 20px;
            font-weight: 700;
            margin-bottom: 4px;
            letter-spacing: -0.3px;
        }
        .widget .subtitle {
            font-size: 12px;
            opacity: 0.75;
            margin-bottom: 20px;
        }
        .heading {
            font-size: 15px;
            text-transform: uppercase;
            letter-spacing: 2px;
            opacity: 0.6;
            margin-bottom: 12px;
            text-align: center;
        }
        .stat-table {
            display: table;
            margin: 0 auto;
            border-spacing: 16px 20px;
        }
        .stat-row {
            display: table-row;
        }
        .stat-cell {
            display: table-cell;
            vertical-align: middle;
            padding: 8px 0;
        }
        .stat-cell-icon {
            display: table-cell;
            vertical-align: middle;
            width: 44px;
            text-align: right;
            padding-right: 10px;
        }
        .stat-cell-text {
            display: table-cell;
            vertical-align: middle;
            width: 180px;
        }
        .stat-icon {
            width: 40px;
            height: 40px;
            opacity: 0.5;
        }
        .stat-card {
            display: inline-block;
            text-align: center;
        }
        .stat-card .number {
            font-size: 50px;
            font-weight: 800;
            line-height: 1.1;
        }
        .stat-card .label {
            font-size: 13px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            opacity: 0.8;
            margin-top: 6px;
        }
        .updated {
            margin-top: 16px;
            font-size: 10px;
            opacity: 0.5;
        }
        .updated a {
            color: #ffffff;
            opacity: 0.7;
            text-decoration: none;
        }
        .updated a:hover { text-decoration: underline; opacity: 1; }

    </style>
</head>
<body>
    <div class="widget">
        <div class="heading">AuScope Impact at a Glance</div>
        <div class="stat-table">
            <div class="stat-row">
                <div class="stat-cell-icon"><svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg></div>
                <div class="stat-cell-text stat-card"><div class="number">${s.totalPublications.toLocaleString()}</div><div class="label">Publications</div></div>
                <div class="stat-cell-icon"><svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></div>
                <div class="stat-cell-text stat-card"><div class="number">${s.totalCitations.toLocaleString()}</div><div class="label">Citations</div></div>
                <div class="stat-cell-icon"><svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></div>
                <div class="stat-cell-text stat-card"><div class="number">${s.totalDatasets.toLocaleString()}</div><div class="label">Datasets</div></div>
            </div>
            <div class="stat-row">
                <div class="stat-cell-icon"><svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>
                <div class="stat-cell-text stat-card"><div class="number">${s.uniqueAuthors.toLocaleString()}</div><div class="label">Researchers</div></div>
                <div class="stat-cell-icon"><svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div>
                <div class="stat-cell-text stat-card"><div class="number">${s.uniqueInstitutions.toLocaleString()}</div><div class="label">Institutions</div></div>
                <div class="stat-cell-icon"><svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></div>
                <div class="stat-cell-text stat-card"><div class="number">${s.uniqueCountries}</div><div class="label">Countries</div></div>
            </div>
        </div>
    </div>
<script>
(function() {
  var duration = 1000;
  var els = document.querySelectorAll('.stat-card .number');
  els.forEach(function(el) {
    var text = el.textContent.trim();
    var target = parseFloat(text.replace(/,/g, ''));
    if (isNaN(target) || target === 0) return;
    var isFloat = text.indexOf('.') >= 0;
    var start = 0;
    var startTime = null;
    el.textContent = '0';
    function step(ts) {
      if (!startTime) startTime = ts;
      var progress = Math.min((ts - startTime) / duration, 1);
      var value = Math.floor(progress * target);
      if (isFloat) value = (progress * target).toFixed(1);
      el.textContent = Number(value).toLocaleString();
      if (progress < 1) requestAnimationFrame(step);
      else el.textContent = target.toLocaleString(undefined, isFloat ? {minimumFractionDigits:1, maximumFractionDigits:1} : {});
    }
    requestAnimationFrame(step);
  });
})();
</script>
</body>
</html>`;
}

run();
