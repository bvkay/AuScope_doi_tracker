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
    citationDistribution: stats.citationBuckets
  }, null, 2));

  // ── Write docs/index.html ──
  const html = buildHTML(stats, pubData.metadata.last_updated);
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
    citationBuckets
  };
}

function buildHTML(stats, lastUpdated) {
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
            color: #1e293b;
            background: #ffffff;
            line-height: 1.5;
        }

        /* ── Hero Stats (TERN-style) ── */
        .hero {
            background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%);
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
            opacity: 0.7;
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
            color: #1e40af;
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
        .bar-fill { height: 100%; background: #2563eb; border-radius: 4px; min-width: 2px; transition: width 0.3s; }
        .bar-value { width: 40px; font-weight: 600; color: #1e40af; font-size: 12px; }

        /* ── SVG charts ── */

        /* ── Citation buckets ── */
        .bucket-chart { display: flex; align-items: flex-end; gap: 8px; height: 320px; }
        .bucket-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
        .bucket-bar { width: 80%; background: #2563eb; border-radius: 4px 4px 0 0; min-height: 2px; flex-shrink: 0; }
        .bucket-label { font-size: 11px; color: #64748b; margin-top: 6px; }
        .bucket-count { font-size: 11px; color: #2563eb; font-weight: 600; margin-bottom: 3px; }

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
        .footer a { color: #2563eb; text-decoration: none; }
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
            <div class="stat-card">
                <div class="number">${s.totalPublications.toLocaleString()}</div>
                <div class="label">Publications</div>
            </div>
            <div class="stat-card">
                <div class="number">${s.totalCitations.toLocaleString()}</div>
                <div class="label">Total Citations</div>
            </div>
            <div class="stat-card">
                <div class="number">${s.uniqueAuthors.toLocaleString()}</div>
                <div class="label">Researchers</div>
            </div>
            <div class="stat-card">
                <div class="number">${s.uniqueInstitutions.toLocaleString()}</div>
                <div class="label">Institutions</div>
            </div>
            <div class="stat-card">
                <div class="number">${s.uniqueCountries}</div>
                <div class="label">Countries</div>
            </div>
        </div>
    </div>

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
      svg += '<rect x="' + x.toFixed(1) + '" y="' + barY.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + barH.toFixed(1) + '" fill="#2563eb" rx="2" />';
    }

    // Count label above bar (only if there's room)
    if (y.count > 0 && barW > 10) {
      svg += '<text x="' + (x + barW / 2).toFixed(1) + '" y="' + (barY - 4).toFixed(1) + '" text-anchor="middle" font-size="9" fill="#2563eb" font-weight="600">' + y.count + '</text>';
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
  svg += '<polygon points="' + areaPoints + '" fill="#2563eb" fill-opacity="0.08" />';

  // Line
  svg += '<polyline points="' + points.join(' ') + '" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linejoin="round" />';

  // End dot
  const lastPt = points[points.length - 1].split(',');
  svg += '<circle cx="' + lastPt[0] + '" cy="' + lastPt[1] + '" r="4" fill="#2563eb" />';

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
            margin-bottom: 16px;
        }
        .stat-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 10px 16px;
            max-width: 960px;
            margin: 0 auto;
        }
        .stat-card {
            padding: 12px 10px;
        }
        .stat-icon {
            width: 36px;
            height: 36px;
            opacity: 0.6;
            margin-bottom: 8px;
        }
        .stat-card .number {
            font-size: 42px;
            font-weight: 800;
            line-height: 1.1;
        }
        .stat-card .label {
            font-size: 15px;
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

        @media (max-width: 600px) {
            .stat-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
            .stat-card .number { font-size: 24px; }
        }
    </style>
</head>
<body>
    <div class="widget">
        <div class="heading">AuScope Impact at a Glance</div>
        <div class="stat-grid">
            <div class="stat-card">
                <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>
                <div class="number">${s.totalPublications.toLocaleString()}</div>
                <div class="label">Publications</div>
            </div>
            <div class="stat-card">
                <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                <div class="number">${s.totalCitations.toLocaleString()}</div>
                <div class="label">Total Citations</div>
            </div>
            <div class="stat-card">
                <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                <div class="number">${s.uniqueAuthors.toLocaleString()}</div>
                <div class="label">Researchers</div>
            </div>
            <div class="stat-card">
                <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                <div class="number">${s.uniqueInstitutions.toLocaleString()}</div>
                <div class="label">Institutions</div>
            </div>
            <div class="stat-card">
                <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                <div class="number">${s.uniqueCountries}</div>
                <div class="label">Countries</div>
            </div>
            <div class="stat-card">
                <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
                <div class="number">${s.totalDatasets.toLocaleString()}</div>
                <div class="label">Datasets</div>
            </div>
            <div class="stat-card">
                <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                <div class="number">${s.citedPercent}%</div>
                <div class="label">Publications Cited</div>
            </div>
            <div class="stat-card">
                <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
                <div class="number">${s.avgCitations}</div>
                <div class="label">Mean Citations / Paper</div>
            </div>
        </div>
    </div>
</body>
</html>`;
}

run();
