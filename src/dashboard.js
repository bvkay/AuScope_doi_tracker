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
const vm = require('vm');

const DOCS_DIR = path.join(__dirname, '..', 'docs');
const PUB_FILE = path.join(__dirname, '..', 'data', 'publications.json');
const DS_FILE = path.join(__dirname, '..', 'data', 'datasets.json');
const PILLAR_FILE = path.join(DOCS_DIR, 'stats-data.json');
const FACILITY_FILE = path.join(__dirname, '..', 'data', 'facility-names.json');
const GITHUB_SOFTWARE_FILE = path.join(__dirname, '..', 'data', 'github-software.json');

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

// ── The shared chassis, executed at BUILD time ──
// index.html is a static page: its numbers are frozen when this script
// runs, so the hero must be in the HTML source, not painted by JS after
// load. But the honest-number convention (grade chip + as-of stamp +
// link + copy-with-caveat), the 73-entry glossary and the accessible
// [i] buttons all live in docs/tracker-chassis.js, and a second copy of
// that wording here would drift within a month.
//
// So we run the chassis in a sandbox with DOM stubs and call its own
// renderStat/glossaryIcon/renderGlossaryList to emit the markup. One
// definition of "Measured", one definition of "Keyword only", one set
// of aria wiring — used by the runtime pages AND by this generator.
// If the chassis ever fails to load, the build keeps going with plain
// markup rather than shipping a blank hero.
const NOT_PUBLICATIONS = ['software', 'peer review'];
const CHASSIS_FILE = path.join(DOCS_DIR, 'tracker-chassis.js');
const SITE_BASE = 'https://bvkay.github.io/AuScope_doi_tracker/';

function loadChassis() {
  if (!fs.existsSync(CHASSIS_FILE)) return null;
  const noop = function() {};
  const stubEl = {
    addEventListener: noop, removeEventListener: noop, appendChild: noop,
    insertBefore: noop, setAttribute: noop, removeAttribute: noop,
    getAttribute: function() { return null; }, closest: function() { return null; },
    querySelector: function() { return null; }, querySelectorAll: function() { return []; },
    classList: { add: noop, remove: noop, toggle: noop, contains: function() { return false; } },
    style: {}, firstChild: null, parentNode: null, dataset: {}
  };
  const doc = {
    addEventListener: noop, readyState: 'loading',
    createElement: function() { return Object.assign({}, stubEl); },
    getElementById: function() { return null; },
    querySelector: function() { return null; }, querySelectorAll: function() { return []; },
    body: stubEl, head: stubEl, documentElement: stubEl
  };
  const sandbox = {
    console: { log: noop, warn: noop, error: noop },
    document: doc, URL: URL, URLSearchParams: URLSearchParams,
    location: { href: SITE_BASE + 'index.html', search: '' },
    navigator: { clipboard: null }, fetch: undefined,
    setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
    requestAnimationFrame: noop,
    AbortController: typeof AbortController !== 'undefined' ? AbortController : function() {},
    matchMedia: function() { return { matches: false, addListener: noop, addEventListener: noop }; },
    addEventListener: noop
  };
  try {
    const ctx = vm.createContext(sandbox);
    ctx.window = ctx;
    vm.runInContext(fs.readFileSync(CHASSIS_FILE, 'utf8'), ctx, { filename: 'tracker-chassis.js' });
    if (typeof ctx.renderStat !== 'function') return null;
    return ctx;
  } catch (e) {
    console.warn('tracker-chassis.js could not be loaded at build time (' + e.message
      + '); falling back to plain markup.');
    return null;
  }
}

const CHASSIS = loadChassis();

// renderStat, but never fatal. A missing chassis degrades to a plain
// number with its grade and date still attached in text — the honesty
// survives even when the styling does not.
function statTile(spec) {
  // The sandbox's location.href is the live hub URL, so the chassis's
  // own statCitation resolves a relative href to an absolute one — a
  // caveat pasted into a slide deck carries a link that still works.
  if (CHASSIS) return CHASSIS.renderStat(spec);
  const n = spec.value == null ? '—' : Number(spec.value).toLocaleString('en-AU');
  return '<div class="stat honest"><div class="label">' + escapeHtml(spec.label || '') + '</div>'
    + '<div class="value">' + (spec.href ? '<a href="' + spec.href + '">' + n + '</a>' : n) + '</div>'
    + '<div class="grade-row">' + escapeHtml(spec.grade || 'measured')
    + ' &middot; ' + escapeHtml(fmtDate(spec.asOf)) + '</div>'
    + (spec.note ? '<div class="stat-note">' + escapeHtml(spec.note) + '</div>' : '') + '</div>';
}

// The [i] gloss button, from the chassis glossary. Empty string when the
// term is unknown, so a typo drops the icon rather than shipping "undefined".
function gloss(key) {
  return CHASSIS ? CHASSIS.glossaryIcon(key) : '';
}
function glossTerm(key, text) {
  return CHASSIS ? CHASSIS.glossaryTerm(key, text) : escapeHtml(text != null ? text : key);
}
function glossList(keys) {
  if (!CHASSIS) return '';
  return CHASSIS.renderGlossaryList(keys.filter(function(k) { return CHASSIS.trackerTerm(k); }));
}
function fmtDate(v) {
  if (!v) return 'date not stamped';
  if (CHASSIS) return CHASSIS.formatAsOf(v);
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v)
    : 'as of ' + d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function run() {
  // Load data
  const pubData = fs.existsSync(PUB_FILE)
    ? JSON.parse(fs.readFileSync(PUB_FILE, 'utf8'))
    : { metadata: {}, records: [] };

  const dsData = fs.existsSync(DS_FILE)
    ? JSON.parse(fs.readFileSync(DS_FILE, 'utf8'))
    : { metadata: {}, records: [] };

  // Software version releases (Zenodo/GitHub archive DOIs, type 'software')
  // and referee or editor comments on a preprint (type 'peer review')
  // are outputs of the software pillar, not publications — counting a
  // v2.0.0 tag as a paper would not survive an audit. They stay in
  // publications.json (typed) but out of every publication count and page.
  const pubs = (pubData.records || []).filter(p => NOT_PUBLICATIONS.indexOf(p.type || '') === -1);
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
      date: p.publicationDate || '',
      journal: decodeEntities(String(p.journal || '')),
      type: p.type || '',
      cited: parseInt(p.cited) || 0,
      evidence: p.evidence || 'keyword',
      programs: recordPrograms(p),
      terms: p.searchTerms || [],
      oa: /^yes$/i.test(String(p.isOA || ''))
    };
  });
  fs.writeFileSync(path.join(DOCS_DIR, 'publications-data.json'), JSON.stringify({
    generated: new Date().toISOString(),
    records: slim
  }));

  // Same-origin feed for the cross-platform dataset registry: one slim row
  // per dataset record. `subset` distinguishes NCI MT from NCI DAS — the
  // platform_projects attribution in project-mapping.json keys on it.
  fs.writeFileSync(path.join(DOCS_DIR, 'datasets-data.json'), JSON.stringify({
    generated: dsData.metadata && dsData.metadata.last_updated || new Date().toISOString(),
    records: (dsData.records || []).map(function(r) {
      return {
        doi: r.doi || '', name: r.name || r.title || '',
        authors: r.authors || '', year: r.year || null,
        platform: r.platform || '', subset: r.subset || '',
        type: r.type || '',
        parentDoi: r.parentDoi || '', childCount: r.childCount || 0,
      };
    })
  }));

  // Software registry feed: the AuScope GitHub org snapshot plus, per
  // curated tool in facility-names.json tier-3, the publications whose
  // EVIDENCE GRADE is text-software and whose text matches the tool's
  // patterns — the same graded honesty as everything else, never a raw
  // keyword sweep over the whole corpus.
  const facilityData = fs.existsSync(FACILITY_FILE)
    ? JSON.parse(fs.readFileSync(FACILITY_FILE, 'utf8')) : {};
  const githubData = fs.existsSync(GITHUB_SOFTWARE_FILE)
    ? JSON.parse(fs.readFileSync(GITHUB_SOFTWARE_FILE, 'utf8')) : { metadata: {}, records: [] };
  fs.writeFileSync(path.join(DOCS_DIR, 'software-data.json'), JSON.stringify({
    generated: new Date().toISOString(),
    records: buildSoftwareRegistry(pubs, facilityData),
    github: githubData.records || [],
    githubMetadata: githubData.metadata || {},
  }, null, 2));

  // ── Write docs/index.html ──
  // Cross-pillar numbers come from src/stats.js (run it first in CI);
  // missing/stale file just hides the explorer card numbers.
  const pillarData = fs.existsSync(PILLAR_FILE)
    ? JSON.parse(fs.readFileSync(PILLAR_FILE, 'utf8'))
    : null;
  const lensData = computeLensData(datasets);
  const pp = (pillarData && pillarData.pillars) || {};
  // Each figure carries the date of ITS OWN source, not the date this
  // script happened to run. A dataset count stamped with the build time
  // claims a freshness the underlying file does not have. The instrument
  // registry is read live by src/stats.js, so its date is the build date.
  // Publications are dated by the last SEARCH merge (search_updated, set
  // only by src/search.js), not by the last write: maintenance and date
  // enrichment stamp last_updated on every run and made a store whose
  // search was two months old read as fresh.
  const pubAsOf = pubData.metadata && (pubData.metadata.search_updated || pubData.metadata.last_updated) || null;
  const asOf = {
    publications: pubAsOf,
    datasets: dsData.metadata && dsData.metadata.last_updated || null,
    ausmt: (pp.ausmt && pp.ausmt.generated) || null,
    runs: (pp.ausmt && pp.ausmt.runsFetched) || null,
    fair: (pp.datasets && pp.datasets.fairMeta && pp.datasets.fairMeta.last_updated) || null,
    built: (pillarData && pillarData.generated) || null
  };
  const connects = loadConnectsChain();
  if (!connects) console.warn('pid-demonstrator-data.json lacks the default chain; "How it connects" omitted.');
  const html = buildHTML(stats, pubAsOf, pillarData, lensData, datasets.length, asOf, connects);
  fs.writeFileSync(path.join(DOCS_DIR, 'index.html'), html);

  // ── Write docs/widget.html (embeddable stats-only widget) ──
  const widget = buildWidget(stats, pubAsOf, pillarData);
  fs.writeFileSync(path.join(DOCS_DIR, 'widget.html'), widget);

  console.log('Dashboard generated: docs/index.html');
  console.log('Widget generated: docs/widget.html');
  console.log('Data exported: docs/data.json');
  console.log('Stats: ' + stats.summary.totalPublications + ' publications, '
    + stats.summary.totalCitations + ' citations');
  const sp = stats.summary.evidenceSplit;
  console.log('Headline: ' + sp.documented.pubs + ' documented (' + sp.documented.citations + ' citations), '
    + sp.candidate.pubs + ' candidates (' + sp.candidate.citations + '), '
    + sp.software.pubs + ' software, ' + sp.unverified.pubs + ' unverified');
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

// The evidence partition, in one place. Five sets, mutually exclusive and
// exhaustive: documented + candidate + software + unverified = every
// record. "Documented" is the headline: an AuScope identifier or a written
// acknowledgement on the paper itself. Candidates (a watchlist author at a
// partner institution, not yet confirmed) are counted beside the headline,
// never inside it, and the combined figure is never called verified.
// src/stats.js still publishes attributed = documented + candidate for the
// pillar feed and the widget; isAttributed() keeps that aggregate where it
// is still wanted, so the charts, the widget and the hero cannot silently
// disagree about what either word means.
const DOCUMENTED_TIERS = ['verified', 'text-attributed', 'text-infrastructure'];
function evidenceClass(p) {
  const e = p && p.evidence;
  if (DOCUMENTED_TIERS.indexOf(e) !== -1) return 'documented';
  if (e === 'candidate') return 'candidate';
  if (e === 'text-software') return 'software';
  return 'unverified';
}
function isAttributed(p) {
  const c = evidenceClass(p);
  return c === 'documented' || c === 'candidate';
}

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
  // Same three, counted over ATTRIBUTED papers only. The corpus-wide
  // versions are inflated by 1,896 keyword-only records with no
  // confirmed AuScope link, so they must never reach a public surface;
  // the widget used to publish exactly those. Kept in the summary so
  // the widget has a graded number to show instead of dropping the row.
  const attInstitutions = {};
  const attCountries = {};
  const attAuthors = {};
  // And over DOCUMENTED papers only, for the widget, which must count the
  // same population as the hub headline.
  const docInstitutions = {};
  const docCountries = {};
  const docAuthors = {};
  // The headline split, counted from the records themselves so the hero
  // cannot drift from the tiers chart beneath it.
  const split = {
    documented: { pubs: 0, citations: 0 }, candidate: { pubs: 0, citations: 0 },
    software: { pubs: 0, citations: 0 }, unverified: { pubs: 0, citations: 0 }
  };

  for (const p of pubs) {
    const cited = parseInt(p.cited) || 0;
    const cls = evidenceClass(p);
    const attributed = isAttributed(p);
    const documented = cls === 'documented';
    split[cls].pubs++;
    split[cls].citations += cited;
    totalCitations += cited;
    if (cited > 0) citedPubs++;
    if (p.journal) journals[p.journal] = true;

    // Collect unique institutions and countries
    for (const inst of (p.institutions || [])) {
      if (inst) {
        allInstitutions[inst] = true;
        if (attributed) attInstitutions[inst] = true;
        if (documented) docInstitutions[inst] = true;
      }
    }
    for (const cc of (p.countries || [])) {
      if (cc) {
        allCountries[cc] = true;
        if (attributed) attCountries[cc] = true;
        if (documented) docCountries[cc] = true;
      }
    }
    // Collect unique author names (approximate: name-based dedup)
    if (p.authors) {
      p.authors.split(';').forEach(a => {
        a = a.trim();
        if (a) {
          allAuthors[a.toLowerCase()] = a; // lowercase key for dedup, preserve display
          if (attributed) attAuthors[a.toLowerCase()] = a;
          if (documented) docAuthors[a.toLowerCase()] = a;
        }
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

  // Per-year counts split by evidence class. The hub's charts used to
  // plot the raw corpus under an evidence-graded hero: the citation
  // curve ran to 67,576 while the headline said 18,423. Carrying the
  // split through to the chart data is what lets the charts agree with
  // the number they sit beneath.
  const tierYear = {};   // year -> { documented, candidate, software, unverified, docCites, attrCites, allCites }
  function bucket(y) {
    if (!tierYear[y]) {
      tierYear[y] = { documented: 0, candidate: 0, software: 0, unverified: 0, docCites: 0, attrCites: 0, allCites: 0 };
    }
    return tierYear[y];
  }
  for (const p of pubs) {
    const year = parseInt(p.year);
    if (!year || isNaN(year)) continue;
    const cls = evidenceClass(p);
    const cited = parseInt(p.cited) || 0;
    const b = bucket(year);
    b[cls]++;
    b.allCites += cited;
    if (cls === 'documented') b.docCites += cited;
    if (cls === 'documented' || cls === 'candidate') b.attrCites += cited;
  }

  // Publications by year (continuous range) with cumulative pubs and
  // citations. data.json consumers keep `attributed` (documented plus
  // candidate) with its old meaning; `documented` and `candidate` sit
  // beside it.
  const byYear = [];
  let cumPubs = 0;
  let cumCitations = 0;
  let cumAttrCitations = 0;
  let cumAttr = 0;
  let cumDoc = 0;
  let cumDocCitations = 0;
  for (let y = minYear; y <= maxYear; y++) {
    const count = yearCounts[y] || 0;
    const citations = citationsByYear[y] || 0;
    const t = tierYear[y] || { documented: 0, candidate: 0, software: 0, unverified: 0, docCites: 0, attrCites: 0 };
    cumPubs += count;
    cumCitations += citations;
    cumAttr += t.documented + t.candidate;
    cumAttrCitations += t.attrCites;
    cumDoc += t.documented;
    cumDocCitations += t.docCites;
    byYear.push({
      year: y, count, cumulative: cumPubs, citations, cumulativeCitations: cumCitations,
      documented: t.documented, candidate: t.candidate,
      attributed: t.documented + t.candidate, software: t.software, unverified: t.unverified,
      docCitations: t.docCites,
      attrCitations: t.attrCites,
      cumulativeDocumented: cumDoc,
      cumulativeDocCitations: cumDocCitations,
      cumulativeAttributed: cumAttr,
      cumulativeAttrCitations: cumAttrCitations
    });
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
      attributedAuthors: Object.keys(attAuthors).length,
      attributedInstitutions: Object.keys(attInstitutions).length,
      attributedCountries: Object.keys(attCountries).length,
      documentedAuthors: Object.keys(docAuthors).length,
      documentedInstitutions: Object.keys(docInstitutions).length,
      documentedCountries: Object.keys(docCountries).length,
      yearRange: minYear && maxYear ? minYear + '–' + maxYear : 'N/A',
      noSubjectCount,
      evidenceSplit: split
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
  { name: 'Geochemistry & characterisation', terms: ['SHRIMP II Curtin', 'AusGeochem', 'Hylogger CSIRO', 'Western Australia Argon Isotope Facility', 'National Virtual Core Library', 'Geoscience Atom Probe', 'AuScope Geochemistry Network', 'Noble Gas Geochronology Laboratory', 'National Argon Map', 'Characterisation AuScope', 'EarthBank data citation', 'NVCL data citation'] },
  { name: 'Geodesy & VLBI', terms: ['Katherine VLBI', 'Yarragadee VLBI', 'AuScope VLBI', 'Mt Pleasant VLBI', 'Geospatial Geodesy AuScope'] },
  { name: 'Earth imaging & sounding', terms: ['AusLAMP', 'AusPass', 'AusPass seismic', 'Australian Geophysical Observing System', 'Earth Imaging Sounding AuScope', 'AusPass data citation', 'NCI data citation'] },
  { name: 'Education & outreach', terms: ['Australian Seismometers in Schools', 'Outreach Engagement AuScope'] },
  { name: 'AVRE & data systems', terms: ['AuScope Discovery Portal', 'AVRE AuScope', 'AuScope Virtual Research Environment', 'Research Data Systems AuScope', 'Australian Scalable Drone Cloud'] },
  { name: 'AuScope (general)', terms: ['AuScope', 'International Collaboration AuScope', 'Earth Composition Evolution AuScope', 'Earth Sampling AuScope', 'Geophysics2030'] }
];

const TERM_TO_GROUP = {};
PROGRAM_GROUPS.forEach(function(g) {
  g.terms.forEach(function(t) { TERM_TO_GROUP[t] = g.name; });
});

// Per-record program list + per-group counts (a record counts once per group).
// curatedPrograms comes from the evidence-overrides valve — manual
// submissions carry no discoverable search term, so a curator can tag them.
function recordPrograms(p) {
  const seen = {};
  (p.searchTerms || []).forEach(function(t) {
    const g = TERM_TO_GROUP[t];
    if (g) seen[g] = true;
  });
  (p.curatedPrograms || []).forEach(function(g) { seen[g] = true; });
  return Object.keys(seen);
}

// Per group: the whole corpus count (which is what the deep link will
// show, so the two must agree) AND the attributed subset inside it. The
// chart draws both, so a reader can see at a glance how much of a
// program's apparent output is actually evidence-linked.
function computePrograms(pubs) {
  const counts = {};
  const documented = {};
  for (const p of pubs) {
    const isDoc = evidenceClass(p) === 'documented';
    recordPrograms(p).forEach(function(g) {
      counts[g] = (counts[g] || 0) + 1;
      if (isDoc) documented[g] = (documented[g] || 0) + 1;
    });
  }
  return PROGRAM_GROUPS
    .map(function(g) {
      return { name: g.name, count: counts[g.name] || 0, documented: documented[g.name] || 0 };
    })
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
  { key: 'keyword', label: 'Keyword match only', desc: 'no confirmed signal yet', fill: '#cbd5e1' }
];

// The evidence section. It sits DIRECTLY under the hero, not two and a
// half screens below it: the audit measured 2,047px between the headline
// number and the grading that qualifies it, which meant every reader who
// stopped scrolling took the number ungraded. The grading is the product.
//
// Two parts: the partition as one line of arithmetic the reader can
// check, and the six tiers it is built from, each flagged in headline /
// under review / excluded. Tier definitions live in "How we count".
function buildEvidenceSection(evidence, split) {
  if (!evidence) return '';
  const max = Math.max.apply(null, EVIDENCE_LADDER.map(function(e) { return evidence[e.key] || 0; }));
  const FLAG = {
    in: { cls: 'in', text: '<span aria-hidden="true">✓</span> in headline', aria: 'Counted in the headline figure.' },
    review: { cls: 'review', text: '<span aria-hidden="true">◐</span> under review', aria: 'Counted beside the headline as a candidate under review.' },
    out: { cls: 'out', text: '<span aria-hidden="true">✕</span> excluded', aria: 'Not counted in the headline figure.' }
  };
  const rows = EVIDENCE_LADDER.map(function(e) {
    const n = evidence[e.key] || 0;
    const w = max ? Math.max(2, Math.round(n / max * 100)) : 2;
    const f = DOCUMENTED_TIERS.indexOf(e.key) !== -1 ? FLAG.in : e.key === 'candidate' ? FLAG.review : FLAG.out;
    return '            <a class="bar-row evidence-row" href="publications.html?evidence=' + e.key + '"\n'
      + '               aria-label="' + escapeHtml(e.label + ': ' + n.toLocaleString() + ' publications. ' + e.desc
        + '. ' + f.aria) + '">\n'
      + '                <div class="bar-label">' + escapeHtml(e.label) + '</div>\n'
      + '                <div class="bar-track"><div class="bar-fill" style="width:' + w + '%;background:' + e.fill + '"></div></div>\n'
      + '                <div class="bar-value">' + n.toLocaleString() + '</div>\n'
      + '                <div class="bar-counted ' + f.cls + '">' + f.text + '</div>\n'
      + '            </a>';
  }).join('\n');

  // The partition, spelled out as arithmetic the reader can check, from
  // the same records the hero counts.
  let partition = '';
  if (split) {
    const total = split.documented.pubs + split.candidate.pubs + split.software.pubs + split.unverified.pubs;
    partition = '        <p class="partition-sum">' + split.documented.pubs.toLocaleString() + ' documented &plus; '
      + split.candidate.pubs.toLocaleString() + ' candidates &plus; '
      + split.software.pubs.toLocaleString() + ' software &plus; ' + split.unverified.pubs.toLocaleString()
      + ' unverified &equals; ' + total.toLocaleString()
      + ' records searched.</p>\n';
  }

  return '\n    <!-- ═══ Evidence tiers, kept adjacent to the hero they qualify ═══ -->\n'
    + '    <div class="explorers evidence-section" id="evidence">\n'
    + '        <h2>Evidence tiers</h2>\n'
    + partition
    + '        <div class="bar-chart evidence-ladder">\n' + rows + '\n        </div>\n'
    + '    </div>\n';
}

// Publications by program: search-term tags mapped to AuScope program groups.
function buildProgramSection(programs) {
  if (!programs || !programs.length) return '';
  const max = programs[0].count;
  const rows = programs.map(function(g) {
    const w = Math.max(2, Math.round(g.count / max * 100));
    // Solid segment = evidence-attributed; the pale remainder is the
    // ungraded corpus. Same bar, two shades, so the graded share is
    // legible without hiding what the deep link will actually show.
    const wa = g.count ? Math.round(g.documented / max * 100) : 0;
    return '            <a class="bar-row" href="publications.html?program=' + encodeURIComponent(g.name) + '"\n'
      + '               aria-label="' + escapeHtml(g.name + ': ' + g.count.toLocaleString()
        + ' publications found, of which ' + g.documented.toLocaleString() + ' have documented attribution') + '">\n'
      + '                <div class="bar-label">' + escapeHtml(g.name) + '</div>\n'
      + '                <div class="bar-track"><div class="bar-fill pale" style="width:' + w + '%">'
      + '<div class="bar-fill solid" style="width:' + (w ? Math.round(wa / w * 100) : 0) + '%"></div></div></div>\n'
      + '                <div class="bar-value"><strong>' + g.documented.toLocaleString() + '</strong>'
      + '<span class="of">/' + g.count.toLocaleString() + '</span></div>\n'
      + '            </a>';
  }).join('\n');
  // The "never add a program figure to a lens figure" caveat lives in
  // "How we count"; the one-line reading key stays with the chart.
  return '\n    <!-- ═══ Publications by program ═══ -->\n'
    + '    <div class="explorers">\n'
    + '        <h2>Publications by AuScope program</h2>\n'
    + '        <div class="note">Solid = documented; pale = found by the search term, unconfirmed. A paper can count in several.</div>\n'
    + '        <div class="bar-chart program-chart">\n' + rows + '\n        </div>\n'
    + '    </div>\n';
}

// Hero tiles: cross-pillar headline numbers. Researchers/institutions/
// countries are deliberately absent — computed over the unverified keyword
// corpus they inflate beyond belief; they return once evidence tiers let us
// count them over verified publications only.

// A compact grade + date stamp for a card. The hero uses the chassis's
// full renderStat; a fourteen-card grid cannot carry fourteen three-line
// grade blocks, but it can carry the same vocabulary in one line. Grade
// labels, glyphs and tooltips come from the chassis so the words match
// the hero exactly.
function cardStamp(grade, asOf) {
  const g = (CHASSIS && CHASSIS.TRACKER_GRADES && CHASSIS.TRACKER_GRADES[grade])
    || { label: grade || 'measured', glyph: '●', key: 'grade-' + (grade || 'measured') };
  const tip = CHASSIS ? CHASSIS.termTip(g.key) : '';
  return '<div class="card-stamp">'
    + '<span class="grade-chip g-' + escapeHtml(grade || 'measured') + '"'
    + (tip ? ' title="' + escapeHtml(tip) + '"' : '') + '>'
    + '<span class="grade-glyph" aria-hidden="true">' + g.glyph + '</span>'
    + escapeHtml(g.label) + '</span>'
    + '<span class="grade-sep" aria-hidden="true">·</span>'
    + '<span class="as-of' + (asOf ? '' : ' undated') + '">' + escapeHtml(fmtDate(asOf)) + '</span>'
    + '</div>';
}

function explorerCardHtml(c) {
  const ext = /^https?:/i.test(c.href) ? ' target="_blank" rel="noopener"' : '';
  return '            <a class="explorer-card" href="' + c.href + '"' + ext + '>\n'
    + '                <div class="num">' + c.num + '</div>\n'
    + '                <div class="name">' + c.name + '</div>\n'
    + '                <div class="sub">' + c.sub + '</div>\n'
    + '                ' + cardStamp(c.grade, c.asOf) + '\n'
    + '            </a>';
}

// Explorer cards: cross-pillar numbers from src/stats.js, each linking to
// the page that IS the evidence behind the number. Skips gracefully when
// stats-data.json is absent or a pillar failed to fetch.
//
// Two changes from the flat grid the audit measured at 2,500px:
//   * the three publication cards have moved up into the evidence
//     section, next to the grading that explains them;
//   * what remains is grouped — datasets, then infrastructure — so a
//     reader scans two short lists rather than one long undifferentiated
//     one, and each card states how firmly its number is known and when.
function buildExplorerCards(pillarData, asOf) {
  if (!pillarData || !pillarData.pillars) return '';
  asOf = asOf || {};
  const p = pillarData.pillars;
  const built = pillarData.generated || null;
  const dsAsOf = asOf.datasets || built;
  const datasetCards = [];
  const infraCards = [];

  // ── Datasets, one card per platform / data-type tracker ──
  // (datasets.html remains only as a quiet router page; deliberately
  // not carded here.)
  if (p.datasets) {
    const bp = p.datasets.byPlatform || {};
    const fair = p.datasets.fairAvg || {};
    const fairSub = function(key) {
      return fair[key] != null ? ' · avg F-UJI ' + fair[key] + '%' : '';
    };
    // Collection records (DOI-registered children) sit above the counted
    // datasets; the card says how many so the number is not read as all.
    const coll = p.datasets.collections || {};
    const tail = function(key) {
      const n = coll[key] || 0;
      return (n ? ' · ' + n + ' collection record' + (n === 1 ? '' : 's') : '') + fairSub(key);
    };
    if (bp.EarthBank) {
      datasetCards.push({ href: 'earthbank.html', num: bp.EarthBank.toLocaleString(),
        name: 'EarthBank datasets', sub: 'DataCite metadata health' + tail('EarthBank'),
        grade: 'measured', asOf: dsAsOf });
    }
    if (bp.AusPass) {
      datasetCards.push({ href: 'auspass.html', num: bp.AusPass.toLocaleString(),
        name: 'AusPass networks', sub: 'FDSN network DOIs' + tail('AusPass'),
        grade: 'measured', asOf: dsAsOf });
    }
    if (bp['NCI MT']) {
      datasetCards.push({ href: 'nci-mt.html', num: bp['NCI MT'].toLocaleString(),
        name: 'NCI MT datasets', sub: 'AusLAMP + legacy surveys' + tail('NCI MT'),
        grade: 'measured', asOf: dsAsOf });
    }
    if (bp['NCI DAS']) {
      datasetCards.push({ href: 'nci-das.html', num: bp['NCI DAS'].toLocaleString(),
        name: 'NCI DAS datasets', sub: 'ALIRT · FISSLE · SISSLE' + tail('NCI DAS'),
        grade: 'measured', asOf: dsAsOf });
    }
    if (bp['NCI MATE']) {
      // "model datasets" contradicted itself once the type was read properly:
      // DataCite registers all 11 as resourceTypeGeneral `Model`, not `Dataset`.
      datasetCards.push({ href: 'dataset-registry.html?platform=NCI%20MATE',
        num: bp['NCI MATE'].toLocaleString(),
        name: 'M@TE models', sub: 'Model Atlas of the Earth' + tail('NCI MATE'),
        grade: 'measured', asOf: dsAsOf });
    }
    if (bp['AuScope Data Repository']) {
      datasetCards.push({ href: 'dataset-registry.html?platform=AuScope%20Data%20Repository',
        num: bp['AuScope Data Repository'].toLocaleString(),
        name: 'AuScope Data Repository', sub: 'datasets with no platform of their own' + tail('AuScope Data Repository'),
        grade: 'measured', asOf: dsAsOf });
    }
    if (bp.NVCL) {
      datasetCards.push({ href: 'nvcl.html', num: bp.NVCL.toLocaleString(),
        name: 'NVCL collection DOIs', sub: 'state drill-core archives' + tail('NVCL'),
        grade: 'measured', asOf: dsAsOf });
    }
  }

  // ── Infrastructure in the field ──
  // Inventory, not impact: these were in the hero until this rebuild,
  // where a big number next to "publications" read as an output.
  if (p.stations) {
    infraCards.push({ href: 'auspass.html', num: p.stations.total.toLocaleString(),
      name: 'Seismic stations', sub: 'served through the AusPass FDSN service',
      grade: 'snapshot', asOf: built });
  }
  if (p.instruments) {
    infraCards.push({ href: 'instruments.html', num: p.instruments.units.toLocaleString(),
      name: 'Registered instruments', sub: 'PIDINST DOIs · metadata health',
      grade: 'measured', asOf: built });
  }
  if (p.ausmt) {
    infraCards.push({ href: 'https://ausmt.auscope.org.au/', num: p.ausmt.surveys.toLocaleString(),
      name: 'AusMT surveys', sub: p.ausmt.stations.toLocaleString()
        + ' stations · open MT transfer functions · ausmt.auscope.org.au ↗',
      grade: 'snapshot', asOf: p.ausmt.generated || built });
    // MT deployment register: sourced ONLY from AusMT per-station runs
    // metadata (station.json) — the instrument registry's survey records
    // are deliberately not used for deployment accounting.
    if (p.ausmt.instrumentsDeployed) {
      // Rounded to the nearest hundred: 12,876.9 claimed a precision the
      // run records do not have, and the coverage travels with the figure.
      const days = Math.round((p.ausmt.recordingDays || 0) / 100) * 100;
      infraCards.push({ href: 'mt-deployments.html', num: p.ausmt.instrumentsDeployed.toLocaleString(),
        name: 'Instruments deployed in MT surveys',
        sub: 'about ' + days.toLocaleString() + ' recording-days in the '
          + p.ausmt.surveysPopulated + ' of ' + p.ausmt.surveys + ' linked surveys',
        grade: 'partial', asOf: p.ausmt.runsFetched || p.ausmt.generated || built });
    }
  }
  if (p.gnss) {
    infraCards.push({ href: 'gnss.html', num: p.gnss.stations.toLocaleString(),
      name: 'GNSS reference stations',
      sub: 'AuScope-funded, in GA’s CORS network'
        + (p.gnss.since ? ' · built ' + p.gnss.since + '–' + p.gnss.latest : ''),
      grade: 'snapshot', asOf: built });
  }
  if (p.ausis) {
    // "48 streaming now" was the finding-6 defect: present tense on a
    // figure frozen at build time, which is why the hub and the live
    // page appeared to disagree. The tense is what was wrong, not the
    // arithmetic — so the number keeps its date and drops the "now".
    infraCards.push({ href: 'ausis.html', num: p.ausis.stations.toLocaleString(),
      name: 'Seismometers in schools',
      sub: p.ausis.active + ' active'
        + (p.ausis.streaming ? ' · ' + p.ausis.streaming + ' streaming at last check' : '')
        + ' · since ' + p.ausis.since,
      grade: 'snapshot', asOf: built });
  }
  if (p.nvcl) {
    var nvclNum = p.nvcl.estimatedKm
      ? '≈ ' + Math.round(p.nvcl.combinedKm).toLocaleString() + ' km'
      : Math.round(p.nvcl.scannedKm).toLocaleString() + ' km';
    var nvclSub = p.nvcl.estimatedKm
      ? Math.round(p.nvcl.scannedKm).toLocaleString() + ' km measured · '
        + p.nvcl.boreholes.toLocaleString() + ' boreholes · ' + p.nvcl.nodes + ' state nodes'
      : p.nvcl.boreholes.toLocaleString() + ' boreholes · ' + p.nvcl.nodes
        + ' state nodes · verifiable live';
    infraCards.push({ href: 'nvcl.html', num: nvclNum, name: 'NVCL core scanned', sub: nvclSub,
      grade: p.nvcl.estimatedKm ? 'estimate' : 'measured', asOf: p.nvcl.asOf || built });
  }
  if (p.samples && p.samples.declared) {
    // Nearly all samples are covered by their DATASET's DOI; the sampleDois
    // count is samples with their own individual PhysicalObject DOI —
    // wording must not imply the rest are un-PID'd.
    infraCards.push({ href: 'earthbank.html', num: p.samples.declared.toLocaleString(),
      name: 'EarthBank samples', sub: 'declared in DOI-registered datasets',
      grade: 'measured', asOf: dsAsOf });
  }

  if (!datasetCards.length && !infraCards.length) return '';

  // The F-UJI metric version and assessment date, and the "every number
  // links to its records" sentence, moved into "How we count".
  let out = '\n    <!-- ═══ Explorer cards (from src/stats.js) ═══ -->\n'
    + '    <div class="explorers" id="explore">\n'
    + '        <h2>Explore the evidence</h2>\n';

  if (datasetCards.length) {
    out += '        <h3 class="group-head">Registered datasets, by platform</h3>\n'
      + '        <div class="explorer-grid">\n'
      + datasetCards.map(explorerCardHtml).join('\n') + '\n        </div>\n';
  }

  if (infraCards.length) {
    out += '        <h3 class="group-head">Infrastructure in the field</h3>\n'
      + '        <div class="explorer-grid">\n'
      + infraCards.map(explorerCardHtml).join('\n') + '\n        </div>\n';
  }

  // Most-deployed instrument models (survey memberships per model).
  // Detail, so it opens on request rather than occupying half a screen.
  const tm = p.instruments && p.instruments.topModels;
  if (tm && tm.length) {
    const maxDep = tm[0].deployments;
    const rows = tm.map(function(t) {
      const w = Math.max(2, Math.round(t.deployments / maxDep * 100));
      return '                <div class="bar-row">\n'
        + '                    <div class="bar-label">' + escapeHtml(t.model) + '</div>\n'
        + '                    <div class="bar-track"><div class="bar-fill" style="width:' + w + '%"></div></div>\n'
        + '                    <div class="bar-value">' + t.deployments + '</div>\n'
        + '                </div>';
    }).join('\n');
    out += '        <details class="disclosure">\n'
      + '            <summary>Most deployed instrument models (' + tm.length + ')</summary>\n'
      + '            <div class="note">Survey deployments per instrument model, from the PIDINST registry’s'
      + ' survey&rarr;component links. A model counts once per survey it appears in.</div>\n'
      + '            <div class="bar-chart">\n' + rows + '\n            </div>\n'
      + '        </details>\n';
  }

  return out + '    </div>\n';
}

// Per curated tool: the text-software-evidence publications matching its
// patterns, with citation totals and coverage years. (Ported from Rebecca
// Farrington's fork — her design already gated on the evidence tier.)
function buildSoftwareRegistry(pubs, facilityData) {
  const facilities = (((facilityData || {}).tier3_software_use || {}).facilities || {});
  return Object.keys(facilities).map(function(name) {
    const patterns = facilities[name].patterns || [];
    const needles = patterns.map(function(pt) { return String(pt).toLowerCase(); });
    // A tool cannot have been used before it existed: facility-names.json
    // may give a "since" year, and earlier papers are search-term noise.
    const since = Number(facilities[name].since) || 0;
    // Every graded paper that matches the tool, whatever its grade: a paper
    // with an AuScope identifier or acknowledgement still reports using the
    // software (the G-ADOPT platform paper itself is graded candidate), and
    // the grade travels with the row. Keyword-only records stay out.
    const matches = pubs.filter(function(p) {
      if (!p.evidence || p.evidence === 'keyword') return false;
      if (since && Number(p.year) && Number(p.year) < since) return false;
      const text = [p.title, p.subject].concat(p.searchTerms || []).filter(Boolean).join(' ').toLowerCase();
      return needles.some(function(n) { return text.indexOf(n) !== -1; });
    }).map(function(p) {
      return {
        doi: p.doi || '', title: decodeEntities(String(p.title || '')),
        authors: decodeEntities(String(p.authors || '')), year: p.year || '',
        journal: decodeEntities(String(p.journal || '')),
        cited: parseInt(p.cited) || 0, oa: /^yes$/i.test(String(p.isOA || '')),
        evidence: p.evidence,
      };
    });
    const years = matches.map(function(p) { return Number(p.year); }).filter(Boolean);
    return {
      name: name, aliases: patterns,
      publications: matches.length,
      citations: matches.reduce(function(n, p) { return n + p.cited; }, 0),
      earliestYear: years.length ? Math.min.apply(Math, years) : null,
      latestYear: years.length ? Math.max.apply(Math, years) : null,
      records: matches.sort(function(a, b) {
        return (Number(b.year) || 0) - (Number(a.year) || 0) || a.title.localeCompare(b.title);
      }),
    };
  });
}

// ── The Downward-Looking Telescope ──
// Joins the dataset roster to the shared Project Mapping sheet's taxonomy at
// BUILD time (project-mapping.json + fair-scores.json), so the hub carries no
// client-side fetches for it. Every lens in the sheet gets a band — a lens
// with no registered datasets yet says so, because the taxonomy itself is the
// story the page tells.
function computeLensData(datasets) {
  const MAP_FILE = path.join(__dirname, '..', 'data', 'project-mapping.json');
  const FAIR_FILE = path.join(__dirname, '..', 'data', 'fair-scores.json');
  if (!fs.existsSync(MAP_FILE)) return null;
  let mapping, fair = { scores: {} };
  try { mapping = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); } catch (e) { return null; }
  if (fs.existsSync(FAIR_FILE)) {
    try { fair = JSON.parse(fs.readFileSync(FAIR_FILE, 'utf8')); } catch (e) { /* optional */ }
  }
  const norm = d => String(d || '').trim().replace(/^https?:\/\/(www\.)?(dx\.)?doi\.org\//i, '').toLowerCase();

  const lenses = {};
  (mapping.metadata.lenses || []).forEach(function(name) {
    lenses[name] = { name: name, programs: [], projects: 0, datasets: 0, fairSum: 0, fairN: 0, platforms: {} };
  });
  (mapping.mappings || []).forEach(function(m) {
    const l = lenses[m.lens];
    if (l && m.program && l.programs.indexOf(m.program) === -1) l.programs.push(m.program);
  });
  // Projects per lens — the taxonomy's real shape, independent of whether
  // any evidence has been attached to it yet. Reported alongside the
  // dataset count so the gap between "mapped" and "evidenced" is visible
  // rather than implied.
  Object.keys(mapping.projects || {}).forEach(function(id) {
    const l = lenses[(mapping.projects[id] || {}).lens];
    if (l) l.projects++;
  });
  (datasets || []).forEach(function(r) {
    // Same population as the platform cards: no collection records, no samples.
    if (r.childCount > 0 || (r.platform === 'EarthBank' && r.type === 'PhysicalObject')) return;
    const key = r.platform === 'NCI' ? 'NCI:' + (r.subset || '') : r.platform;
    const pid = (mapping.platform_projects || {})[key];
    const proj = pid && mapping.projects[pid];
    const l = proj && lenses[proj.lens];
    if (!l) return;
    l.datasets++;
    l.platforms[r.platform === 'NCI' ? 'NCI ' + r.subset : r.platform] = true;
    const f = (fair.scores || {})[norm(r.doi)];
    if (f && f.score != null) { l.fairSum += f.score; l.fairN++; }
  });
  const bands = (mapping.metadata.lenses || []).map(function(name) {
    const l = lenses[name];
    return {
      name: name,
      programs: l.programs,
      projects: l.projects,
      datasets: l.datasets,
      fairAvg: l.fairN ? Math.round(l.fairSum / l.fairN) : null,
      platforms: Object.keys(l.platforms),
    };
  });
  // Coverage, measured — this is what decides how much weight the lenses
  // can carry on the page. A taxonomy that resolves through five hand-
  // written platform links cannot be the site's navigation spine, and
  // the page has to say so rather than imply otherwise by design.
  const projectIds = Object.keys(mapping.projects || {});
  const evidencedProjects = {};
  Object.keys(mapping.platform_projects || {}).forEach(function(k) {
    evidencedProjects[mapping.platform_projects[k]] = true;
  });
  return {
    bands: bands,
    coverage: {
      projects: projectIds.length,
      projectsWithEvidence: Object.keys(evidencedProjects).length,
      platformLinks: Object.keys(mapping.platform_projects || {}).length,
      lensesWithDatasets: bands.filter(function(b) { return b.datasets > 0; }).length,
      lensesTotal: bands.length,
      fetched: (mapping.metadata || {}).fetched || null,
      sheet: (mapping.metadata || {}).source || null
    }
  };
}

// The sheet's labels are used verbatim for URLs and lookups (the chassis
// glossary aliases them), so the sheet stays the single source of truth.
// LENS_DISPLAY corrects the sheet's "Cuture" typo in display text only.
const LENS_DISPLAY = { 'Community, Cuture & Collaboration': 'Community, Culture & Collaboration' };
function lensName(name) { return LENS_DISPLAY[name] || name; }

// The Downward-Looking Telescope as framing only. Lens is inherited from a
// dataset's platform through a handful of hand-written links, so a lens
// dataset total is a relabelled platform count, and the lens join also
// swept in EarthBank sample records that the platform cards exclude (237
// against 190 on 12 Nov 2026). No totals until lens is recorded on the
// records themselves: six named lenses, one coverage line, one link.
function buildLensSection(lensData) {
  if (!lensData || !lensData.bands || !lensData.bands.length) return '';
  const cov = lensData.coverage || {};
  const chips = lensData.bands.map(function(l) {
    // URLs keep the sheet's label (the registry filters on it); only the
    // display text is corrected.
    const href = l.datasets > 0
      ? 'dataset-registry.html?lens=' + encodeURIComponent(l.name)
      : 'project-mapping.html';
    return '<a class="lens-chip" href="' + href + '">' + escapeHtml(lensName(l.name)) + '</a>';
  }).join('');
  return '\n    <!-- ═══ Downward-Looking Telescope: framing, no totals ═══ -->\n'
    + '    <div class="explorers lens-section" id="lenses">\n'
    + '        <h2>Through the Downward-Looking Telescope</h2>\n'
    + '        <div class="lens-chips">' + chips + '</div>\n'
    + '        <p class="lens-gap">Coverage still being mapped: lens is inherited from a dataset’s platform, not recorded on it. '
    + '<a href="project-mapping.html">All ' + (cov.projects || 0) + ' mapped projects &rarr;</a></p>\n'
    + '    </div>\n';
}

// "How we count": every definition, grade and metric note in one closed
// panel. One short caveat may stay beside a metric where it changes the
// reading; everything else lives here. Definitions come from the chassis
// glossary, so the words here are the words the [i] buttons show elsewhere.
function gradeChip(key) {
  const g = (CHASSIS && CHASSIS.TRACKER_GRADES && CHASSIS.TRACKER_GRADES[key]) || { label: key, glyph: '' };
  return '<span class="grade-chip g-' + key + '"><span class="grade-glyph" aria-hidden="true">' + g.glyph + '</span>'
    + escapeHtml(g.label) + '</span>';
}
function buildHowWeCount(lensData, pillarData, built) {
  const cov = (lensData && lensData.coverage) || {};
  const p = (pillarData && pillarData.pillars) || {};
  const fairMeta = (p.datasets && p.datasets.fairMeta) || {};
  const ausmt = p.ausmt || null;
  const tiers = glossList(['documented'].concat(EVIDENCE_LADDER.map(function(e) { return e.key; })));
  const terms = glossList([
    'attributed', 'unverified-matches', 'citations', 'evidence',
    'grade-measured', 'grade-snapshot', 'grade-estimate', 'grade-partial', 'grade-unavailable',
    'lens', 'fair', 'fuji', 'doi', 'pidinst'
  ]);
  return '\n    <!-- ═══ How we count ═══ -->\n'
    + '    <div class="explorers method">\n'
    + '        <details class="disclosure how-we-count" id="method">\n'
    + '            <summary>How we count</summary>\n'
    + '            <p class="method-body">' + gradeChip('measured') + ' from our own records &middot; '
    + gradeChip('snapshot') + ' from an external service at build time &middot; '
    + gradeChip('estimate') + ' derived &middot; '
    + gradeChip('partial') + ' incomplete source, read as a floor &middot; '
    + gradeChip('unavailable') + ' a dash is never a zero.</p>\n'
    + '            <p class="method-body">Figures are dated snapshots' + (built ? ' (' + fmtDate(built) + ')' : '')
    + '; the platform pages read live and can differ.</p>\n'
    + '            <h3>Evidence tiers</h3>\n'
    + '            <p class="method-body">The headline counts documented attribution: an AuScope identifier or a written'
    + ' acknowledgement on the paper. Candidates are counted beside it until confirmed. Keyword matches and software use'
    + ' are listed, never claimed.</p>\n'
    + (tiers ? '            ' + tiers + '\n' : '')
    + '            <h3>Lenses and programs</h3>\n'
    + '            <p class="method-body">The lens taxonomy is real (' + (cov.projects || 0)
    + ' projects across six lenses) but lens is not a field on any dataset, publication or instrument record. It is'
    + ' inherited through ' + (cov.platformLinks || 0) + ' hand-written platform-to-project links, which reach '
    + (cov.lensesWithDatasets || 0) + ' of ' + (cov.lensesTotal || 6) + ' lenses, so lens totals are not published.'
    + ' Program groups come from this tracker’s search terms, not the Project Mapping sheet; never add a figure'
    + ' from one to a figure from the other.</p>\n'
    + '            <h3>Datasets, FAIR and infrastructure</h3>\n'
    + '            <p class="method-body">Dataset counts are DOI-registered data products per platform. A record with'
    + ' DOI-registered children is a collection, listed but not counted; EarthBank sample records are counted separately.'
    + (fairMeta.metric_version ? ' F-UJI scores use metric set v' + fairMeta.metric_version
      + (fairMeta.last_updated ? ', assessed ' + dateOnly(fairMeta.last_updated) : '')
      + '; a card shows the platform average.' : '')
    + (ausmt && ausmt.surveysPopulated ? ' MT deployment figures come from AusMT run-level records, present for '
      + ausmt.surveysPopulated + ' of ' + ausmt.surveys + ' surveys, so they are floors.' : '')
    + ' Inventory figures (stations, instruments, boreholes) never feed the headline.</p>\n'
    + (terms ? '            <details class="disclosure">\n'
      + '                <summary>Glossary</summary>\n'
      + '                ' + terms + '\n'
      + '            </details>\n' : '')
    + '        </details>\n'
    + '    </div>\n';
}

// Date without the "as of" prefix, for strips and sentences that supply
// their own verb.
function dateOnly(v) { return v ? fmtDate(v).replace(/^as of /, '') : ''; }

// ── Freshness strip ──
// One visible line of source dates. The page used to imply one build date.
// The publication store has been frozen since 15 Sep 2026: the monthly
// search workflow is cancelled at its 90-minute timeout on every run, and
// that fix is tracked separately.
const CITATIONS_FROZEN_NOTE = 'citations frozen: the monthly search run times out';
function buildFreshnessStrip(asOf) {
  asOf = asOf || {};
  const items = [];
  function item(k, dates, flag) {
    const ds = [].concat(dates).filter(Boolean);
    if (!ds.length) return;
    items.push('        <span class="fresh-item"><span class="fresh-k">' + k + '</span>' + ds.join(', ')
      + (flag ? ' <span class="fresh-flag">(' + flag + ')</span>' : '') + '</span>');
  }
  const pubDate = dateOnly(asOf.publications), dsDate = dateOnly(asOf.datasets);
  // The frozen note shows only while the publication store is more than a
  // month old; the hourly search batches lift it once a cycle lands.
  const pubAge = asOf.publications && asOf.built
    ? (new Date(asOf.built) - new Date(asOf.publications)) / 86400000 : 0;
  const frozen = pubAge > 30 ? CITATIONS_FROZEN_NOTE : '';
  if (pubDate === dsDate) {
    item('Publications, citations and datasets', pubDate, frozen);
  } else {
    item('Publications and citations', pubDate, frozen);
    item('Datasets', dsDate);
  }
  item('AusMT', [dateOnly(asOf.ausmt),
    asOf.runs && dateOnly(asOf.runs) !== dateOnly(asOf.ausmt) ? 'runs ' + dateOnly(asOf.runs) : null]);
  item('Instruments', dateOnly(asOf.built));
  item('FAIR', dateOnly(asOf.fair));
  if (!items.length) return '';
  return '    <div class="freshness" aria-label="Source dates">\n'
    + '        <span class="fresh-item fresh-title">Source dates</span>\n'
    + items.join('\n') + '\n'
    + '        <a class="fresh-how" href="#method">How we count</a>\n'
    + '    </div>\n';
}

// ── How it connects ──
// The PID demonstrator's own default chain, read from its feed (built in
// this repo by src/pid-demonstrator-data.js): instrument DOI, survey
// record, dataset DOIs, paper. Pinned to the instrument and survey the
// live page opens on, so the row and the demonstrator agree; the titles
// and DOIs are read from the feed, never typed in. If the feed lacks the
// chain, the row is dropped rather than drawn from memory.
const PID_FEED_FILE = path.join(DOCS_DIR, 'pid-demonstrator-data.json');
const DEMO_URL = 'https://auscope.github.io/AuScope_Outreach/widgets/pid-demonstrator.html';
const DEMO_INSTRUMENT = '10.82388/ir7azuq1';   // LEMI-423 #0006
const DEMO_SURVEY = 'ccmt-2017';               // Curnamona 2017
function loadConnectsChain() {
  if (!fs.existsSync(PID_FEED_FILE)) return null;
  let feed;
  try { feed = JSON.parse(fs.readFileSync(PID_FEED_FILE, 'utf8')); } catch (e) { return null; }
  const inst = (feed.instruments || []).filter(function(i) { return i && i.doi === DEMO_INSTRUMENT; })[0];
  const sv = feed.surveys && feed.surveys[DEMO_SURVEY];
  if (!inst || !sv || !sv.registry_doi) return null;
  const ds = (sv.dataset_dois || []).filter(function(d) { return d && d.doi; });
  // Same choice the demonstrator makes: a collection DOI first, else the
  // first dataset DOI.
  const collections = ds.filter(function(d) { return d.identifies === 'collection'; });
  const primary = (collections.length ? collections : ds)[0] || null;
  const paper = (sv.papers || []).filter(function(p) { return p && p.doi; })[0] || null;
  if (!primary || !paper) return null;
  return {
    instrument: { name: (inst.model || 'Instrument') + (inst.serial ? ' ' + inst.serial : ''), doi: inst.doi },
    survey: { name: sv.title || DEMO_SURVEY, doi: sv.registry_doi },
    dataset: {
      name: ds.length + ' dataset DOI' + (ds.length === 1 ? '' : 's') + (primary.custodian ? ' at ' + primary.custodian : ''),
      doi: primary.doi
    },
    paper: { name: [paper.journal, paper.year].filter(Boolean).join(' ') || 'Paper', doi: paper.doi, title: paper.title || '' },
    asOf: (feed.metadata && (feed.metadata.fetched || feed.metadata.generated)) || null
  };
}
function buildConnectsSection(c) {
  if (!c) return '';
  function box(k, name, doi, title) {
    return '            <li><div class="k">' + escapeHtml(k) + '</div><div class="n"'
      + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + escapeHtml(name) + '</div>'
      + '<div class="d"><a href="https://doi.org/' + escapeHtml(doi) + '" target="_blank" rel="noopener">'
      + escapeHtml(doi) + '</a></div></li>';
  }
  return '\n    <!-- ═══ How it connects: one real chain from the PID demonstrator ═══ -->\n'
    + '    <div class="explorers connects" id="connects">\n'
    + '        <h2>How it connects</h2>\n'
    + '        <ol class="chain">\n'
    + box('Instrument', c.instrument.name, c.instrument.doi) + '\n'
    + box('Deployment', c.survey.name, c.survey.doi) + '\n'
    + box('Dataset', c.dataset.name, c.dataset.doi) + '\n'
    + box('Paper', c.paper.name, c.paper.doi, c.paper.title) + '\n'
    + '        </ol>\n'
    + '        <div class="chain-foot">'
    + '<a class="live" href="' + DEMO_URL + '" target="_blank" rel="noopener">Watch this DOI resolve live &#8599;</a>'
    + cardStamp('snapshot', c.asOf)
    + '</div>\n'
    + '    </div>\n';
}

function buildHTML(stats, lastUpdated, pillarData, lensData, datasetCount, asOf, connects) {
  asOf = asOf || {};
  const s = stats.summary;
  const updated = lastUpdated ? new Date(lastUpdated).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : 'N/A';
  const built = (pillarData && pillarData.generated) || lastUpdated || null;
  const explorerCards = buildExplorerCards(pillarData, asOf);

  const pp = (pillarData && pillarData.pillars) || {};
  // Headline publication numbers are EVIDENCE-GRADED and SPLIT. The corpus
  // sum (2,763 / 66,163) is not publishable: most of those citations come
  // from keyword-only records with no confirmed AuScope link. The headline
  // is the DOCUMENTED subset (an identifier or a written acknowledgement
  // on the paper); candidates are counted beside it, never inside it, and
  // the combined figure is never called verified. Both come from the
  // records, and must agree with src/stats.js's attributed aggregate
  // (documented + candidate) or the build says so.
  const split = s.evidenceSplit || null;
  const documented = split && split.documented.pubs ? split.documented : null;
  const candidates = split ? split.candidate : null;
  const pillarAtt = pp.publications && pp.publications.attributed;
  if (documented && pillarAtt && pillarAtt.pubs !== documented.pubs + candidates.pubs) {
    console.warn('stats-data.json attributed (' + pillarAtt.pubs + ') != documented + candidates ('
      + (documented.pubs + candidates.pubs) + '); rerun src/stats.js');
  }
  const dsTotal = (pp.datasets && pp.datasets.total) || datasetCount || null;

  // THREE tiles, no buttons. Candidates are not a headline number: they
  // appear in the caveat line and the tiers chart, never as a tile.
  // Seismic stations and instrument counts are infrastructure inventory
  // and keep their cards further down. The [i] definitions and the grade
  // tooltips moved into "How we count" (plainGrade), and the number links
  // to its records. Ben dropped Copy with caveat from the hero on 13 Nov
  // 2026; the chassis still offers it to the other pages.
  const heroTiles = [
    documented ? {
      value: documented.pubs, label: 'Documented publications',
      grade: 'measured', asOf: lastUpdated, href: '#evidence', plainGrade: true
    } : {
      value: s.totalPublications, label: 'Publications', grade: 'unverified',
      asOf: lastUpdated, href: 'publications.html', plainGrade: true,
      note: 'Evidence grading unavailable for this build: a search count, not an impact figure.'
    },
    documented ? {
      value: documented.citations, label: 'Citations to them',
      grade: 'measured', asOf: lastUpdated, href: '#evidence', plainGrade: true
    } : null,
    dsTotal ? {
      value: dsTotal, label: 'Registered datasets',
      grade: 'measured', asOf: asOf.datasets || built,
      href: 'dataset-registry.html', plainGrade: true
    } : null
  ].filter(Boolean).map(statTile).join('\n');

  const answer = documented ? (
    // One sentence. The candidates tile beside it carries the 116; the
    // definition of "documented" is on the tile's caveat and in How we count.
    '            <p class="answer-lead"><strong>' + documented.pubs.toLocaleString()
      + ' publications</strong> carry documented AuScope attribution, cited <strong>'
      + documented.citations.toLocaleString() + ' times</strong>.</p>\n'
    // No exclusion line: the tiers chart directly below lists the
    // candidates and the unverified matches with their counts.
  ) : '            <p class="answer-lead">Evidence grading is unavailable for this build.</p>\n';

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AuScope Research Impact</title>
    <link rel="stylesheet" href="tracker-shared.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #1e293b;
            background: #ffffff;
            line-height: 1.5;
            overflow-x: hidden; /* nothing on this page may scroll the body sideways */
        }

        /* ── Hero: the one-screen answer ── */
        /* Header markup + styles come from tracker-shared.css and
           tracker-chassis.js — no local copies. */
        .hero {
            background: #282572; /* flat AuScope purple — page embeds as an iframe on auscope.org.au */
            color: #ffffff;
            padding: 30px 24px 28px;
        }
        .hero-inner { max-width: 960px; margin: 0 auto; }
        .answer-lead {
            font-size: 21px;
            line-height: 1.42;
            font-weight: 400;
            max-width: 46em;
            letter-spacing: -0.2px;
        }
        .answer-lead strong { font-weight: 800; }

        /* The chassis stat block, restyled for a dark ground. Same markup,
           same classes, same aria — only the palette changes. */
        .stat-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 12px;
            margin-top: 22px;
        }
        .hero .stat.honest {
            background: rgba(255,255,255,0.10);
            border: 1px solid rgba(255,255,255,0.24);
            border-radius: 10px;
            padding: 15px 16px 14px;
            gap: 3px;
        }
        .hero .stat.honest .label {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            font-weight: 700;
            color: #ffffff;
            opacity: 0.92;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .hero .stat.honest .value { font-size: 38px; font-weight: 800; line-height: 1.05; color: #fff; }
        .hero .stat.honest .value a.stat-link { color: #ffffff; text-decoration: none; }
        .hero .stat.honest .value a.stat-link:hover { color: #ffd9cf; background: none; }
        .hero .stat.honest .fig-value { font-variant-numeric: tabular-nums; }
        .hero .grade-row { margin-top: 3px; }
        .hero .grade-chip {
            background: rgba(255,255,255,0.14);
            border-color: rgba(255,255,255,0.42);
            color: #ffffff;
        }
        .hero .grade-chip.g-unverified { background: rgba(239,114,86,0.28); border-color: #EF7256; }
        .hero .grade-sep, .hero .as-of { color: #cfcdea; }
        .hero .as-of.undated { color: #ffd9cf; background: rgba(239,114,86,0.25); }
        .hero .stat-note { color: #cfcdea; font-size: 11.5px; }
        .hero .info-i {
            color: #ffffff;
            border-color: rgba(255,255,255,0.55);
            background: rgba(255,255,255,0.12);
        }
        .hero .info-i:hover, .hero .info-i.tip-open { background: #ffffff; color: #282572; }
        /* ── Freshness strip: one date per source, never one build date ── */
        .freshness {
            max-width: 960px; margin: 0 auto; padding: 10px 24px 0;
            display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: baseline;
            font-size: 12px; color: #475569; font-variant-numeric: tabular-nums;
        }
        .freshness .fresh-title { font-weight: 700; color: #0f172a; text-transform: uppercase; letter-spacing: 0.6px; font-size: 11px; }
        .freshness .fresh-k { font-weight: 600; color: #0f172a; margin-right: 5px; }
        .freshness .fresh-flag { color: #92400e; }
        .freshness .fresh-how { margin-left: auto; color: #282572; font-weight: 600; text-decoration: none; }
        .freshness .fresh-how:hover { text-decoration: underline; }

        /* ── How it connects: one real chain, read from the demonstrator feed ── */
        .connects { padding-top: 30px; }
        .chain { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; list-style: none; margin-top: 10px; }
        .chain li { border: 1px solid #e5e7eb; border-radius: 8px; padding: 11px 13px; position: relative; background: #ffffff; }
        .chain li + li::before {
            content: '→'; position: absolute; left: -13px; top: 50%; transform: translateY(-50%);
            color: #94a3b8; font-size: 14px; line-height: 1; background: #ffffff;
        }
        .chain .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.6px; font-weight: 700; color: #475569; }
        .chain .n { font-size: 13px; font-weight: 600; color: #0f172a; margin-top: 2px; }
        .chain .d { font-size: 11.5px; margin-top: 3px; font-variant-numeric: tabular-nums; word-break: break-all; }
        .chain .d a { color: #282572; text-decoration: none; }
        .chain .d a:hover { text-decoration: underline; }
        .chain-foot { font-size: 12.5px; color: #475569; margin-top: 11px; display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; }
        .chain-foot a.live { color: #282572; font-weight: 600; text-decoration: none; }
        .chain-foot a.live:hover { text-decoration: underline; }
        .chain-foot .card-stamp { margin: 0; padding: 0; border: 0; }


        /* ── Shared section chrome ── */
        .explorers {
            max-width: 960px;
            margin: 0 auto;
            padding: 26px 24px 0;
        }
        .explorers h2 {
            font-size: 17px;
            font-weight: 700;
            color: #282572;
            margin-bottom: 4px;
            display: flex;
            align-items: center;
            gap: 6px;
            flex-wrap: wrap;
        }
        .explorers h3.group-head, .explorers h3.ladder-head {
            font-size: 13px;
            font-weight: 700;
            color: #0f172a;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            margin: 22px 0 3px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .explorers .note {
            font-size: 12.5px;
            color: #475569;
            margin-bottom: 14px;
            max-width: 74ch;
        }
        .explorers .note.group-note { margin-bottom: 11px; font-size: 12px; }
        .caveat {
            font-size: 12px;
            color: #475569;
            margin-top: 12px;
            padding: 9px 12px;
            border-left: 3px solid #cbd5e1;
            background: #f8fafc;
            max-width: 74ch;
        }

        /* ── Evidence section ── */
        .evidence-section { padding-top: 30px; }
        .partition-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
            gap: 12px;
        }
        .partition-grid .stat.honest {
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 14px 16px;
            background: #ffffff;
        }
        .partition-grid .stat.honest .label {
            font-size: 12px; font-weight: 700; color: #0f172a;
            display: flex; align-items: center; gap: 5px;
        }
        .partition-grid .stat.honest .value { font-size: 30px; font-weight: 800; color: #282572; }
        .partition-grid .stat.honest .value a.stat-link { color: #282572; }
        .partition-grid .stat.honest.grade-unverified { background: #f8fafc; }
        .partition-grid .stat.honest.grade-unverified .value { color: #5e6a7a; }
        .partition-sum {
            font-size: 12.5px;
            color: #475569;
            margin-top: 12px;
            font-variant-numeric: tabular-nums;
        }

        /* ── Bar charts (CSS-only) ── */
        .bar-chart { display: flex; flex-direction: column; gap: 6px; }
        .bar-row {
            display: flex; align-items: center; gap: 8px; font-size: 12px;
            flex-wrap: wrap; text-decoration: none; color: inherit;
            border-radius: 5px; padding: 2px 4px; margin: 0 -4px;
        }
        a.bar-row:hover { background: #f3f3fa; }
        .bar-label { width: 190px; text-align: right; color: #334155; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
        .bar-track { flex: 1 1 120px; height: 22px; background: #f1f5f9; border-radius: 4px; overflow: hidden; min-width: 90px; }
        .bar-fill {
            height: 100%; background: #282572; border-radius: 4px; min-width: 2px;
            /* The ladder's palest tiers measured 1.4:1 against the track.
               An inset edge makes every bar visible while keeping the
               dark-to-light ramp that carries the grading meaning. */
            box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.22);
        }
        .bar-fill.pale { background: #d9d7ee; }
        .bar-fill.solid { background: #282572; border-radius: 4px 0 0 4px; height: 100%; }
        .bar-value { width: 74px; font-weight: 600; color: #282572; font-size: 12px; font-variant-numeric: tabular-nums; }
        .bar-value .of { color: #5e6a7a; font-weight: 500; }
        .bar-counted { width: 108px; font-size: 11px; font-weight: 600; flex-shrink: 0; }
        .bar-counted.in { color: #15803d; }
        .bar-counted.review { color: #5b21b6; }
        .bar-counted.out { color: #92400e; }
        .evidence-ladder .bar-label { width: 170px; }
        .evidence-ladder .bar-value { width: 52px; text-align: right; }

        /* ── Lens bands ── */
        .lens-section { padding-top: 30px; }
        .lens-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(272px, 1fr)); gap: 12px; }
        .lens-band {
            border: 1px solid #e5e7eb; border-left: 4px solid #282572;
            border-radius: 0 8px 8px 0; padding: 13px 16px; background: #ffffff;
            display: flex; flex-direction: column; gap: 4px;
        }
        .lens-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .lens-head h3 { font-size: 14.5px; font-weight: 700; color: #282572; }
        .lens-link { font-size: 12.5px; color: #282572; font-weight: 600; margin-top: 4px; }
        .lens-stats { font-size: 12.5px; color: #475569; }
        .lens-num { font-weight: 700; color: #0f172a; font-size: 15px; }
        .lens-src { font-size: 11px; color: #5e6a7a; }
        .lens-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
        .lens-chip {
            font-size: 12.5px; padding: 5px 13px; border-radius: 16px; background: #f3f3fa; color: #45418f;
            border: 1px solid #dcdbf0; text-decoration: none; font-weight: 600;
        }
        .lens-chip:hover { background: #282572; border-color: #282572; color: #ffffff; }
        .lens-gap {
            font-size: 12.5px; color: #475569; margin-top: 13px;
            padding: 10px 13px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 7px;
            max-width: 88ch;
        }
        .lens-gap-n { color: #5e6a7a; }
        .lens-honesty {
            font-size: 12.5px; color: #475569; margin-top: 11px; max-width: 88ch;
            padding-left: 12px; border-left: 3px solid #EF7256;
        }
        .lens-more { font-size: 12.5px; margin-top: 11px; }
        .lens-more a, .lens-link { color: #282572; text-decoration: none; }
        .lens-more a:hover, .lens-link:hover { text-decoration: underline; }

        /* ── Explorer cards ── */
        .explorer-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(216px, 1fr));
            gap: 12px;
        }
        .explorer-card {
            /* Flex, not block: a card whose sub wraps to two lines used to push
               its own grade stamp down and break the row's baseline. The stamp
               is pinned to the bottom instead, so wrapping never misaligns it. */
            display: flex;
            flex-direction: column;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 13px 15px;
            text-decoration: none;
            color: inherit;
            transition: border-color 0.15s, box-shadow 0.15s;
        }
        .explorer-card:hover {
            border-color: #282572;
            box-shadow: 0 2px 8px rgba(40, 37, 114, 0.12);
        }
        .explorer-card .num { font-size: 23px; font-weight: 700; color: #282572; line-height: 1.15; }
        .explorer-card .name { font-size: 12.5px; font-weight: 600; color: #0f172a; margin-top: 2px; }
        .explorer-card .sub { font-size: 11px; color: #475569; margin-top: 2px; }
        .explorer-card .card-stamp { margin-top: auto; padding-top: 8px; }
        .card-stamp {
            display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
            margin-top: 8px; padding-top: 7px; border-top: 1px solid #f1f5f9;
            font-size: 10.5px;
        }
        .card-stamp .as-of { font-size: 10.5px; }

        /* ── Progressive disclosure ── */
        .disclosure {
            margin-top: 16px;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 0 14px;
            background: #ffffff;
        }
        .disclosure > summary {
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            color: #282572;
            padding: 11px 0;
            list-style: none;
            display: flex;
            align-items: center;
            gap: 7px;
        }
        .disclosure > summary::-webkit-details-marker { display: none; }
        .disclosure > summary::before {
            content: '▸';
            font-size: 11px;
            transition: transform 0.15s;
        }
        .disclosure[open] > summary::before { transform: rotate(90deg); }
        .disclosure > summary:focus-visible { outline: 2px solid #1d4ed8; outline-offset: 2px; border-radius: 4px; }
        .disclosure > *:last-child { padding-bottom: 14px; }
        .disclosure .note { margin-top: 2px; }

        /* ── Methodology ── */
        .method { padding-bottom: 8px; }
        .method-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
        .method-card {
            border: 1px solid #e5e7eb; border-radius: 8px; padding: 13px 15px; background: #f8fafc;
        }
        .method-card h3 { font-size: 12.5px; font-weight: 700; color: #282572; margin-bottom: 5px; }
        .method-card p, .method-body { font-size: 12px; color: #334155; line-height: 1.55; }
        .method-body { margin-bottom: 9px; max-width: 88ch; }
        .how-we-count h3 { font-size: 12.5px; font-weight: 700; color: #282572; margin: 14px 0 5px; }
        .how-we-count > .method-body:first-of-type { margin-top: 4px; }
        .method-card .grade-chip { margin-right: 2px; }

        /* ── Charts ── */
        .charts { max-width: 960px; margin: 0 auto; padding: 26px 24px 8px; }
        .chart-section { margin-bottom: 30px; }
        .chart-section h2 { font-size: 17px; font-weight: 700; color: #282572; margin-bottom: 3px; }
        .chart-section .note { font-size: 12.5px; color: #475569; margin-bottom: 12px; max-width: 74ch; }
        .chart-scroll { overflow-x: auto; }
        .chart-legend {
            display: flex; flex-wrap: wrap; gap: 14px; margin-top: 8px;
            font-size: 11.5px; color: #475569;
        }
        .chart-legend span { display: inline-flex; align-items: center; gap: 5px; }
        .swatch { width: 11px; height: 11px; border-radius: 2px; display: inline-block; border: 1px solid rgba(15, 23, 42, 0.3); }

        /* ── Footer ── */
        .footer {
            text-align: center;
            padding: 18px 24px 26px;
            font-size: 11.5px;
            color: #475569;
            border-top: 1px solid #e2e8f0;
            max-width: 960px;
            margin: 26px auto 0;
        }
        .footer a { color: #282572; text-decoration: none; }
        .footer a:hover { text-decoration: underline; }
        .footer .built { margin-top: 7px; color: #5e6a7a; }

        @media (max-width: 640px) {
            .hero { padding: 22px 16px 24px; }
            .answer-lead { font-size: 18px; }
            /* Tighter tiles on a phone. The hero stacks to three cards
               here, and every pixel it spends is a pixel between the
               reader and the grading section below it. */
            .stat-grid { grid-template-columns: 1fr; gap: 9px; margin-top: 18px; }
            .hero .stat.honest { padding: 11px 13px 12px; }
            .hero .stat.honest .value { font-size: 28px; }
            .hero .stat-note { font-size: 11px; line-height: 1.4; }
            .explorers, .charts { padding-left: 16px; padding-right: 16px; }
            .explorer-grid, .partition-grid, .lens-grid, .method-grid, .chain { grid-template-columns: 1fr; }
            .chain li + li::before { content: '↓'; left: 50%; top: -13px; transform: translateX(-50%); }
            .freshness .fresh-how { margin-left: 0; }
            .bar-label { width: 100%; text-align: left; font-weight: 600; }
            .evidence-ladder .bar-label { width: 100%; }
            .bar-value, .evidence-ladder .bar-value { width: auto; min-width: 56px; text-align: left; }
            .bar-counted { width: auto; }
            .footer { padding-left: 16px; padding-right: 16px; }
        }
    </style>
</head>
<body data-site-tab="impact">
    <!-- ═══ Header — owned by tracker-shared.css + tracker-chassis.js.
         The chassis injects the site tabs after this topbar; there is no
         static tab markup on any page. ═══ -->
    <div class="site-head">
        <div class="topbar">
            <div class="brand">
                <h1><img src="assets/auscope-logo.png" class="auscope-logo" alt="AuScope"
                         onerror="this.outerHTML='<span class=&quot;auscope-fallback&quot;>AuScope</span>'"><span class="accent">AuScope</span> Research Impact</h1>
                <p>Publications, datasets and infrastructure service across AuScope research infrastructure.</p>
            </div>
            <div class="links">
                <a href="https://www.auscope.org.au" target="_blank" rel="noopener">auscope.org.au &#8599;</a>
            </div>
        </div>
    </div>
    <script src="tracker-chassis.js"></script>

    <!-- ═══ Hero — the one-screen answer, then the three figures that
         answer it. Flat AuScope purple; the page embeds as an iframe. ═══ -->
    <div class="hero" id="main">
        <div class="hero-inner">
${answer}            <div class="stat-grid">
${heroTiles}
            </div>
        </div>
    </div>
${buildFreshnessStrip(asOf)}
${buildEvidenceSection(stats.evidence, split)}
${buildConnectsSection(connects)}
${buildLensSection(lensData)}
${explorerCards}
${buildProgramSection(stats.programs)}
    <!-- ═══ Charts ═══ -->
    <div class="charts">
        <!-- Publications by year, split by evidence class -->
        <div class="chart-section">
            <h2>Publications found by year</h2>
            <div class="note">Darkest band = documented and counted. The paler bands are not counted.</div>
            <div class="chart-scroll">${buildYearChart(stats.byYear)}</div>
            <div class="chart-legend" role="list">
                <span role="listitem"><i class="swatch" style="background:#282572"></i> Documented, counted</span>
                <span role="listitem"><i class="swatch" style="background:#7c76d9"></i> Candidate, under review</span>
                <span role="listitem"><i class="swatch" style="background:#b3afe9"></i> AuScope software, counted separately</span>
                <span role="listitem"><i class="swatch" style="background:#cbd5e1"></i> Unverified keyword match, excluded</span>
            </div>
        </div>

        <!-- Cumulative citations: documented only, matching the hero -->
        <div class="chart-section">
            <h2>Cumulative citations to documented publications</h2>
            <div class="note">Documented papers only; candidates and the unverified pool are not plotted.</div>
            <div class="chart-scroll">${buildCumulativeChart(stats.byYear)}</div>
        </div>
    </div>

${buildHowWeCount(lensData, pillarData, built)}

    <!-- ═══ Footer ═══ -->
    <div class="footer">
        Explore:
        <a href="publications.html">Publications</a> &middot;
        <a href="dataset-registry.html">Dataset Registry</a> &middot;
        <a href="project-mapping.html">Projects &amp; lenses</a> &middot;
        <a href="fair-trends.html">FAIR</a> &middot;
        <a href="software-registry.html">Software</a> &middot;
        <a href="datasets.html">Platform trackers</a> &middot;
        <a href="instruments.html">Instruments</a> &middot;
        <a href="ausis.html">AuSIS</a> &middot;
        <a href="nvcl.html">NVCL</a>
        <div class="built">
            Publication records last updated ${updated}${built ? ' &middot; page built ' + fmtDate(built).replace('as of ', '') : ''}.
        </div>
        <div class="built">
            Powered by <a href="https://openalex.org" target="_blank" rel="noopener">OpenAlex</a>,
            <a href="https://www.semanticscholar.org" target="_blank" rel="noopener">Semantic Scholar</a>, and
            <a href="https://europepmc.org" target="_blank" rel="noopener">Europe PMC</a>
            &middot; <a href="https://www.auscope.org.au" target="_blank" rel="noopener">AuScope</a>
        </div>
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

  // Stacked by evidence class. The hub used to plot the raw corpus in
  // one solid colour beneath an evidence-graded hero, so the chart and
  // the headline described different populations. Same bars, three
  // segments: what is counted, what is counted separately, what is
  // excluded — legible without reading the note.
  const maxCount = Math.max.apply(null, byYear.map(function(y) { return y.count; }).concat([1]));
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
  const SEGMENTS = [
    { key: 'documented', fill: '#282572', name: 'documented' },
    { key: 'candidate',  fill: '#7c76d9', name: 'candidate under review' },
    { key: 'software',   fill: '#b3afe9', name: 'AuScope software' },
    { key: 'unverified', fill: '#cbd5e1', name: 'unverified keyword match' }
  ];

  let svg = '<svg viewBox="0 0 ' + svgW + ' ' + svgH + '" style="width:100%;min-width:520px;max-width:'
    + svgW + 'px;height:auto;" role="img" aria-label="Publications found per year from '
    + byYear[0].year + ' to ' + byYear[byYear.length - 1].year
    + ', stacked by evidence class: documented, candidate, AuScope software, and unverified keyword matches.">';

  // Grid lines
  for (const val of yTicks) {
    const y = padT + plotH - (val / maxCount) * plotH;
    svg += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (padL + plotW) + '" y2="' + y.toFixed(1) + '" stroke="#e2e8f0" stroke-width="1" />';
    svg += '<text x="' + (padL - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" font-size="11" fill="#475569">' + val.toLocaleString() + '</text>';
  }

  // Stacked bars, drawn bottom-up so attributed sits on the axis
  for (let i = 0; i < byYear.length; i++) {
    const y = byYear[i];
    const x = padL + i * (barW + barGap) + barGap / 2;
    let cursor = padT + plotH;
    let title = y.year + ': ' + y.count.toLocaleString() + ' found';
    for (const seg of SEGMENTS) {
      const n = y[seg.key] || 0;
      if (!n) continue;
      const h = Math.max((n / maxCount) * plotH, 0.8);
      cursor -= h;
      svg += '<rect x="' + x.toFixed(1) + '" y="' + cursor.toFixed(1) + '" width="' + barW.toFixed(1)
        + '" height="' + h.toFixed(1) + '" fill="' + seg.fill + '" />';
      title += ' · ' + n.toLocaleString() + ' ' + seg.name;
    }
    // One hover target per year rather than per segment
    svg += '<rect x="' + x.toFixed(1) + '" y="' + padT + '" width="' + barW.toFixed(1)
      + '" height="' + plotH.toFixed(1) + '" fill="transparent"><title>' + escapeHtml(title) + '</title></rect>';

    // Documented count above the bar (only where there is room)
    if (y.documented > 0 && barW > 12) {
      const top = padT + plotH - (y.count / maxCount) * plotH;
      svg += '<text x="' + (x + barW / 2).toFixed(1) + '" y="' + (top - 4).toFixed(1)
        + '" text-anchor="middle" font-size="9" fill="#282572" font-weight="600">' + y.documented + '</text>';
    }
  }

  // X-axis labels (every 5 years)
  for (let i = 0; i < byYear.length; i++) {
    const y = byYear[i];
    if (y.year % 5 === 0 || i === byYear.length - 1) {
      const x = padL + i * (barW + barGap) + barW / 2;
      svg += '<text x="' + x.toFixed(1) + '" y="' + (padT + plotH + 20) + '" text-anchor="middle" font-size="11" fill="#475569">' + y.year + '</text>';
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

  // DOCUMENTED citations only. The previous version ran this axis to
  // 60,000 (the ungraded corpus total) directly beneath a hero saying
  // 18,423, so the page's most prominent chart contradicted its most
  // prominent number. The curve now ends exactly where the hero does.
  const maxCum = byYear[byYear.length - 1].cumulativeDocCitations;
  if (!maxCum) return '<p>No citation data</p>';

  const svgW = 800;
  const svgH = 280;
  const padL = 56;
  const padR = 16;
  const padT = 16;
  const padB = 40;
  const plotW = svgW - padL - padR;
  const plotH = svgH - padT - padB;

  const points = byYear.map(function(y, i) {
    const x = padL + (i / (byYear.length - 1)) * plotW;
    const yPos = padT + plotH - (y.cumulativeDocCitations / maxCum) * plotH;
    return x.toFixed(1) + ',' + yPos.toFixed(1);
  });

  const areaPoints = points.join(' ')
    + ' ' + (padL + plotW).toFixed(1) + ',' + (padT + plotH).toFixed(1)
    + ' ' + padL.toFixed(1) + ',' + (padT + plotH).toFixed(1);

  const yTicks = niceAxisTicks(maxCum, 5).map(function(value) {
    return { value: value, y: padT + plotH - (value / maxCum) * plotH };
  });

  const xLabels = byYear.filter(function(y, i) { return y.year % 5 === 0 || i === byYear.length - 1; });

  let svg = '<svg viewBox="0 0 ' + svgW + ' ' + svgH + '" style="width:100%;min-width:520px;max-width:'
    + svgW + 'px;height:auto;" role="img" aria-label="Cumulative citations to documented publications, '
    + byYear[0].year + ' to ' + byYear[byYear.length - 1].year + ', ending at '
    + maxCum.toLocaleString() + ' citations.">';

  for (const tick of yTicks) {
    svg += '<line x1="' + padL + '" y1="' + tick.y.toFixed(1) + '" x2="' + (padL + plotW) + '" y2="' + tick.y.toFixed(1) + '" stroke="#e2e8f0" stroke-width="1" />';
  }

  svg += '<polygon points="' + areaPoints + '" fill="#282572" fill-opacity="0.08" />';
  svg += '<polyline points="' + points.join(' ') + '" fill="none" stroke="#282572" stroke-width="2.5" stroke-linejoin="round" />';

  const lastPt = points[points.length - 1].split(',');
  svg += '<circle cx="' + lastPt[0] + '" cy="' + lastPt[1] + '" r="4" fill="#282572" />';
  svg += '<text x="' + (Number(lastPt[0]) - 6).toFixed(1) + '" y="' + (Number(lastPt[1]) - 10).toFixed(1)
    + '" text-anchor="end" font-size="11" font-weight="700" fill="#282572">'
    + maxCum.toLocaleString() + '</text>';

  for (const tick of yTicks) {
    svg += '<text x="' + (padL - 8) + '" y="' + (tick.y + 4).toFixed(1) + '" text-anchor="end" font-size="11" fill="#475569">'
      + tick.value.toLocaleString() + '</text>';
  }

  for (const y of xLabels) {
    const i = byYear.indexOf(y);
    const x = padL + (i / (byYear.length - 1)) * plotW;
    svg += '<text x="' + x.toFixed(1) + '" y="' + (padT + plotH + 20) + '" text-anchor="middle" font-size="11" fill="#475569">'
      + y.year + '</text>';
  }

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

function buildWidget(stats, lastUpdated, pillarData) {
  const s = stats.summary;
  // The widget is the most public artefact on the site (iframe-embedded), so
  // it carries the GRADED numbers, the count of what is excluded, the date,
  // and a link back to the evidence. An unqualified corpus total here is how
  // a board member ends up quoting 2,926/67,576 in a meeting. Same split
  // as the hub headline: documented only, with candidates and unverified
  // matches named as excluded, so the widget cannot contradict the page.
  const split = s.evidenceSplit || null;
  const graded = !!(split && split.documented.pubs);
  const w = graded ? split.documented : { pubs: s.totalPublications, citations: s.totalCitations };
  const candidates = graded ? split.candidate.pubs : 0;
  const unverified = graded ? split.unverified.pubs : 0;
  const updated = lastUpdated ? new Date(lastUpdated).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : 'N/A';
  // Row two used to publish researcher/institution/country counts taken
  // over the WHOLE corpus (1,432 institutions, inflated by the same
  // keyword-only records the row above it excludes). The widget is the
  // most public artefact on the site, so it was the worst place on the
  // site for an ungraded number. Same three figures, counted over the
  // documented papers only.
  const people = graded
    ? { authors: s.documentedAuthors, institutions: s.documentedInstitutions, countries: s.documentedCountries }
    : { authors: s.uniqueAuthors, institutions: s.uniqueInstitutions, countries: s.uniqueCountries };
  // The pillar total (excludes physical samples, which are not datasets)
  // rather than the raw record count — the widget said 226 while the hub
  // said 179 for the same thing.
  const datasetTotal = (pillarData && pillarData.pillars && pillarData.pillars.datasets
    && pillarData.pillars.datasets.total) || s.totalDatasets;

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
        .wsub { font-size: 11px; opacity: 0.8; margin: -2px 0 16px; line-height: 1.5; }
        .wsub a { color: #fff; text-decoration: underline; }
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
        <div class="wsub">Every figure counts only publications with documented attribution: an AuScope identifier or a written acknowledgement on the paper${graded ? '. Not counted: ' + candidates.toLocaleString() + ' candidates under review and ' + unverified.toLocaleString() + ' unverified keyword matches' : ''} &middot; as at ${updated} &middot; <a href="https://bvkay.github.io/AuScope_doi_tracker/index.html#evidence" target="_blank" rel="noopener">see how this is graded</a></div>
        <div class="stat-table">
            <div class="stat-row">
                <div class="stat-cell-icon"><svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg></div>
                <div class="stat-cell-text stat-card"><div class="number">${w.pubs.toLocaleString()}</div><div class="label">Documented publications</div></div>
                <div class="stat-cell-icon"><svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></div>
                <div class="stat-cell-text stat-card"><div class="number">${w.citations.toLocaleString()}</div><div class="label">Their citations</div></div>
                <div class="stat-cell-icon"><svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></div>
                <div class="stat-cell-text stat-card"><div class="number">${datasetTotal.toLocaleString()}</div><div class="label">Datasets</div></div>
            </div>
            <div class="stat-row">
                <div class="stat-cell-icon"><svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>
                <div class="stat-cell-text stat-card"><div class="number">${people.authors.toLocaleString()}</div><div class="label">Researchers</div></div>
                <div class="stat-cell-icon"><svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div>
                <div class="stat-cell-text stat-card"><div class="number">${people.institutions.toLocaleString()}</div><div class="label">Institutions</div></div>
                <div class="stat-cell-icon"><svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></div>
                <div class="stat-cell-text stat-card"><div class="number">${people.countries.toLocaleString()}</div><div class="label">Countries</div></div>
            </div>
        </div>
    </div>
<script>
/* The count-up is decoration; the true numbers are already in the HTML.
   The old version blanked every figure to "0" the instant it ran and
   relied on requestAnimationFrame to put them back — so an iframe sitting
   below the fold on auscope.org.au, where rAF is throttled or paused,
   could publish "0 ATTRIBUTED PUBLICATIONS" indefinitely. On the most
   public artefact on the site, that is the same defect as a failed fetch
   rendering a zero. Three guards now: no animation at all when motion is
   reduced, no animation until the tile is actually on screen, and a
   timeout that restores the real value if the frames never arrive. */
(function() {
  var els = [].slice.call(document.querySelectorAll('.stat-card .number'));
  if (!els.length) return;
  els.forEach(function(el) { el.setAttribute('data-final', el.textContent.trim()); });

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !window.requestAnimationFrame) return;   // leave the real numbers alone

  function animate(el) {
    if (el._counted) return;
    el._counted = true;
    var text = el.getAttribute('data-final') || '';
    var target = parseFloat(text.replace(/,/g, ''));
    if (isNaN(target) || target === 0) return;
    var duration = 1000, startTime = null;
    var guard = setTimeout(function() { el.textContent = text; }, duration + 1500);
    el.textContent = '0';
    function step(ts) {
      if (!startTime) startTime = ts;
      var progress = Math.min((ts - startTime) / duration, 1);
      if (progress < 1) {
        el.textContent = Math.floor(progress * target).toLocaleString();
        requestAnimationFrame(step);
      } else {
        clearTimeout(guard);
        el.textContent = text;   // always the server-rendered value, exactly
      }
    }
    requestAnimationFrame(step);
  }

  if (!window.IntersectionObserver) { els.forEach(animate); return; }
  var io = new IntersectionObserver(function(entries) {
    entries.forEach(function(e) {
      if (e.isIntersecting) { animate(e.target); io.unobserve(e.target); }
    });
  }, { threshold: 0.25 });
  els.forEach(function(el) { io.observe(el); });
})();
</script>
</body>
</html>`;
}

run();
