// ============================================================
// tracker-citations.js — unified citation / reciprocity pipeline
// Shared by earthbank.html and auspass.html (and future facility pages).
//
// Load order: this file must be loaded AFTER tracker-chassis.js — it uses
// the chassis globals escapeHtml, escapeAttr, normaliseDoi, fixEncoding,
// formatAuthors, sleep, showToast, copyToClipboard. Load both via
// <script src> before the page's inline script.
//
// Citation cache entries are keyed by normaliseDoi(doi):
//   { count, fullCitations, sources: { datacite, opencitations, openalex },
//     reciprocity (numeric stats object) }
// ============================================================

// Relation types from the record's relatedIdentifiers that count as
// "this paper cites the dataset". When an external citation's DOI matches
// any of these declared relations, reciprocity is satisfied.
// IsCitedBy is the canonical reciprocal of "Cites"; the others are stronger
// relations (a paper that supplements/describes/documents a dataset
// inevitably cites it).
var CITING_RELATIONS = {
    'IsCitedBy': true,
    'IsReferencedBy': true,
    'IsSupplementTo': true,
    'IsDescribedBy': true,
    'IsDocumentedBy': true
};

// ----- Citation counts (table pills pass) -----

async function fetchCitationCount(doi, retries) {
    if (!doi) return 0;
    if (retries === undefined) retries = 2;
    // Normalise to lowercase. FDSN-style DOIs often have uppercase segments
    // (e.g. "10.7914/SN/1E_2013"); DataCite's GraphQL endpoint is stricter
    // than its REST API and 400s on those. DataCite treats DOIs as
    // case-insensitive so lowercasing is safe and canonical.
    var lcDoi = doi.toLowerCase();
    var resp = await fetch('https://api.datacite.org/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'query($id: ID!) { work(id: $id) { citationCount } }', variables: { id: lcDoi } })
    });
    if (resp.status === 429 && retries > 0) {
        await sleep(3000);
        return fetchCitationCount(doi, retries - 1);
    }
    if (!resp.ok) return 0;
    var result = await resp.json();
    if (result.errors && result.errors[0] && result.errors[0].status === '429' && retries > 0) {
        await sleep(3000);
        return fetchCitationCount(doi, retries - 1);
    }
    return (result.data && result.data.work) ? (result.data.work.citationCount || 0) : 0;
}

// Monotonic run token: a new loadCitationCounts call (e.g. after Reload)
// supersedes any in-flight pass instead of being silently dropped.
var citationCountsRun = 0;

// cfg = { getEntities, cache, onBatch, progressEl }
//   getEntities() -> array of entities with .doi; each gets .citationCount set
//   cache         -> citation cache object (keyed by normaliseDoi(doi))
//   onBatch(done, total) -> called after each batch so the page can re-render
//   progressEl    -> optional element for "loaded X / Y" progress text
async function loadCitationCounts(cfg) {
    var runId = ++citationCountsRun;
    var cache = cfg.cache;
    var withDoi = cfg.getEntities().filter(function(d) { return d.doi; });
    var batchSize = 5;
    var done = 0;
    var subEl = cfg.progressEl || null;

    for (var i = 0; i < withDoi.length; i += batchSize) {
        if (runId !== citationCountsRun) return;
        var batch = withDoi.slice(i, i + batchSize);
        await Promise.all(batch.map(function(ds) {
            var key = normaliseDoi(ds.doi);
            if (cache[key] && typeof cache[key].count === 'number') {
                ds.citationCount = cache[key].count;
                done++;
                return Promise.resolve();
            }
            return fetchCitationCount(ds.doi).then(function(c) {
                ds.citationCount = c;
                cache[key] = cache[key] || {};
                cache[key].count = c;
                done++;
            }).catch(function() {
                ds.citationCount = 0;
                done++;
            });
        }));
        if (runId !== citationCountsRun) return;
        if (subEl) subEl.textContent = 'loaded ' + done + ' / ' + withDoi.length;
        if (cfg.onBatch) cfg.onBatch(done, withDoi.length);
    }
    if (runId !== citationCountsRun) return;
    if (subEl) subEl.textContent = 'via DataCite GraphQL';
}

// ----- Source fetchers -----
// All three return the same non-throwing shape:
//   { source, error, citations[], reportedCount }
// Citation item shape: { doi (normalised), rawDoi, authors (string), year,
//                        title ('Untitled' fallback), journal ('N/A' fallback) }

async function fetchDataCiteCitations(doi) {
    if (!doi) return { source: 'datacite', error: null, citations: [], reportedCount: 0 };
    var lcDoi = doi.toLowerCase();
    var query = 'query($id: ID!) { work(id: $id) { citationCount citations { totalCount nodes { doi titles { title } publicationYear creators { name givenName familyName } publisher { name } container { title } types { resourceTypeGeneral } } } } }';
    var resp = await fetch('https://api.datacite.org/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query, variables: { id: lcDoi } })
    });
    if (!resp.ok) return { source: 'datacite', error: 'HTTP ' + resp.status, citations: [], reportedCount: 0 };
    var result = await resp.json();
    if (result.errors) return { source: 'datacite', error: result.errors[0].message, citations: [], reportedCount: 0 };
    var work = result.data && result.data.work;
    if (!work) return { source: 'datacite', error: 'DOI not found', citations: [], reportedCount: 0 };
    var nodes = (work.citations && work.citations.nodes) ? work.citations.nodes : [];
    var citations = nodes.map(function(n) {
        return {
            doi: normaliseDoi(n.doi),
            rawDoi: n.doi || 'N/A',
            authors: formatAuthors(n.creators),
            year: n.publicationYear || null,
            title: n.titles && n.titles[0] ? n.titles[0].title : 'Untitled',
            journal: n.container && n.container.title ? n.container.title : (n.publisher && n.publisher.name ? n.publisher.name : 'N/A')
        };
    });
    return { source: 'datacite', error: null, citations: citations, reportedCount: work.citationCount || 0 };
}

async function fetchOpenCitations(doi) {
    if (!doi) return { source: 'opencitations', error: null, citations: [], reportedCount: 0 };
    var resp = await fetch('https://opencitations.net/index/coci/api/v1/citations/' + encodeURIComponent(doi));
    if (!resp.ok) {
        // 404 from COCI means "no citations recorded", not an error
        if (resp.status === 404) return { source: 'opencitations', error: null, citations: [], reportedCount: 0 };
        return { source: 'opencitations', error: 'HTTP ' + resp.status, citations: [], reportedCount: 0 };
    }
    var data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) return { source: 'opencitations', error: null, citations: [], reportedCount: 0 };
    var citations = data.map(function(item) {
        var citingDoi = (item.citing || '').replace(/^https?:\/\/doi\.org\//i, '');
        var year = null;
        if (item.creation) {
            var m = item.creation.match(/^(\d{4})/);
            if (m) year = parseInt(m[1]);
        }
        return { doi: normaliseDoi(citingDoi), rawDoi: citingDoi, authors: 'Unknown', year: year, title: 'Untitled', journal: 'N/A' };
    });
    return { source: 'opencitations', error: null, citations: citations, reportedCount: data.length };
}

// email is REQUIRED — OpenAlex polite-pool convention, sent on both requests.
async function fetchOpenAlexCitations(doi, email) {
    if (!doi) return { source: 'openalex', error: null, citations: [], reportedCount: 0 };
    // The cites: filter needs an OpenAlex Work ID (W...), not a DOI, so look
    // the work up first.
    var sr = await fetch('https://api.openalex.org/works/doi:' + encodeURIComponent(doi.toLowerCase()) + '?mailto=' + encodeURIComponent(email));
    if (sr.status === 404) return { source: 'openalex', error: null, citations: [], reportedCount: 0 };
    if (!sr.ok) return { source: 'openalex', error: 'HTTP ' + sr.status, citations: [], reportedCount: 0 };
    var src = await sr.json();
    if (!src.id) return { source: 'openalex', error: null, citations: [], reportedCount: 0 };
    var n = src.cited_by_count || 0;
    if (n === 0) return { source: 'openalex', error: null, citations: [], reportedCount: 0 };
    var oid = src.id.replace(/^https?:\/\/openalex\.org\//i, '');
    // per_page (underscore), not per-page (hyphen) — OpenAlex returns 400 for the latter.
    var cr = await fetch('https://api.openalex.org/works?filter=cites:' + oid
        + '&per_page=200&select=doi,title,publication_year,authorships,primary_location'
        + '&mailto=' + encodeURIComponent(email));
    if (!cr.ok) return { source: 'openalex', error: 'Failed to fetch citing works', citations: [], reportedCount: n };
    var cd = await cr.json();
    var items = cd.results || [];
    var citations = items.map(function(w) {
        var cleanDoi = (w.doi || '').replace(/^https?:\/\/doi\.org\//i, '');
        var authors = (w.authorships || []).slice(0, 6).map(function(a) {
            return a.author && a.author.display_name;
        }).filter(Boolean);
        var journal = 'N/A';
        if (w.primary_location && w.primary_location.source && w.primary_location.source.display_name) {
            journal = w.primary_location.source.display_name;
        }
        return {
            doi: normaliseDoi(cleanDoi),
            rawDoi: cleanDoi || 'N/A',
            authors: formatAuthors(authors),
            year: w.publication_year || null,
            title: w.title || 'Untitled',
            journal: journal
        };
    });
    return { source: 'openalex', error: null, citations: citations, reportedCount: n };
}

// ----- Merge -----
// Takes the three fetcher RESULT objects. Keyed by normalised DOI, or by a
// title prefix for DOI-less citations so they survive the merge.
// fixEncoding is applied here, once, so cached data is already clean.
function mergeCitations(dc, oc, oa) {
    var map = {};
    function add(res) {
        var src = res.source;
        (res.citations || []).forEach(function(c) {
            var key = c.doi || ('notitle_' + (c.title || '').toLowerCase().substring(0, 50));
            if (!map[key]) {
                map[key] = {
                    doi: c.rawDoi,
                    // The 'N/A' rawDoi placeholder must not become a normDoi —
                    // the no-doi reciprocity class keys off an empty normDoi.
                    normDoi: c.doi ? normaliseDoi(c.doi) : '',
                    authors: fixEncoding(c.authors),
                    year: c.year,
                    title: fixEncoding(c.title),
                    journal: fixEncoding(c.journal),
                    sources: [src]
                };
            } else {
                map[key].sources.push(src);
                if (c.authors && c.authors.length > (map[key].authors || '').length) map[key].authors = fixEncoding(c.authors);
                if (c.journal && c.journal !== 'N/A' && map[key].journal === 'N/A') map[key].journal = fixEncoding(c.journal);
                if (c.year && !map[key].year) map[key].year = c.year;
                if (c.title && c.title !== 'Untitled' && map[key].title === 'Untitled') map[key].title = fixEncoding(c.title);
            }
        });
    }
    add(dc);
    add(oc);
    add(oa);
    return Object.values(map);
}

// ----- Reciprocity analysis -----
// Compute reciprocity status for a list of merged external citations against
// the record's declared relatedIdentifiers. Returns { merged, stats }.
//
// The "gap" state is split into two sub-states based on whether DataCite is
// already aware of the citation via auto-discovery (typically Crossref
// reference data). This matters because:
//   - "echo gap" (gap-known): DataCite knows the link, dataset record doesn't
//     echo it. Adding IsCitedBy here is a self-description improvement, but
//     the citation is already discoverable via the global graph.
//   - "novel gap" (gap-novel): only OpenCitations / OpenAlex have the link.
//     Adding IsCitedBy here actually contributes new information to DataCite.
function analyseReciprocity(relatedIdentifiers, merged) {
    var declared = (relatedIdentifiers || [])
        .filter(function(r) {
            return CITING_RELATIONS[r.relationType]
                && (r.relatedIdentifierType || '').toUpperCase() === 'DOI'
                && r.relatedIdentifier;
        })
        .map(function(r) {
            return {
                doi: normaliseDoi(r.relatedIdentifier),
                rawDoi: r.relatedIdentifier,
                relationType: r.relationType
            };
        });
    var declaredMap = {};
    declared.forEach(function(x) { if (x.doi) declaredMap[x.doi] = x; });

    // Tag external citations
    var externalDoiSet = new Set();
    merged.forEach(function(c) { if (c.normDoi) externalDoiSet.add(c.normDoi); });
    merged.forEach(function(c) {
        if (!c.normDoi) { c.reciprocity = 'no-doi'; return; }
        if (declaredMap[c.normDoi]) {
            c.reciprocity = 'declared';
            c.declaredRelation = declaredMap[c.normDoi].relationType;
        } else {
            // Split based on whether DataCite is already a source for this citation.
            // If yes → DataCite's graph already has it via Crossref/auto-discovery,
            // so the dataset record just hasn't echoed it. If no → only external
            // sources know about it; adding IsCitedBy adds new information to DataCite.
            if (c.sources && c.sources.indexOf('datacite') >= 0) {
                c.reciprocity = 'gap-known';
            } else {
                c.reciprocity = 'gap-novel';
            }
        }
    });

    // Add declared-only entries
    declared.forEach(function(x) {
        if (x.doi && !externalDoiSet.has(x.doi)) {
            merged.push({
                doi: x.rawDoi,
                normDoi: x.doi,
                title: '(declared in DataCite — not yet confirmed by external citation index)',
                authors: 'Unknown',
                year: null,
                journal: 'N/A',
                sources: [],
                reciprocity: 'declared-only',
                declaredRelation: x.relationType
            });
        }
    });

    // Sort: novel gaps first (highest curation value), then echo gaps,
    // then declared, then declared-only, then no-doi. Year-desc within each band.
    var rank = { 'gap-novel': 0, 'gap-known': 1, 'declared': 2, 'declared-only': 3, 'no-doi': 4 };
    merged.sort(function(a, b) {
        var ra = rank[a.reciprocity] !== undefined ? rank[a.reciprocity] : 99;
        var rb = rank[b.reciprocity] !== undefined ? rank[b.reciprocity] : 99;
        if (ra !== rb) return ra - rb;
        return (b.year || 0) - (a.year || 0);
    });

    // Stats
    var stats = {
        total: merged.length, external: 0, declared: 0,
        gaps: 0, gapsNovel: 0, gapsKnown: 0,
        declaredOnly: 0, noDoi: 0, totalDeclared: 0
    };
    merged.forEach(function(c) {
        if (c.reciprocity === 'declared') stats.declared++;
        else if (c.reciprocity === 'gap-novel') { stats.gaps++; stats.gapsNovel++; }
        else if (c.reciprocity === 'gap-known') { stats.gaps++; stats.gapsKnown++; }
        else if (c.reciprocity === 'declared-only') stats.declaredOnly++;
        else if (c.reciprocity === 'no-doi') stats.noDoi++;
    });
    stats.external = stats.declared + stats.gaps + stats.noDoi;
    stats.totalDeclared = stats.declared + stats.declaredOnly;

    return { merged: merged, stats: stats };
}

// ----- Renderers -----

// Build an info "(i)" icon with a hover tooltip. Use sparingly — only where
// a one-line explanation genuinely helps the reader understand a DataCite
// concept or page-specific term.
function infoTip(text) {
    return ' <span class="info-i" data-tip="' + escapeAttr(text) + '">i</span>';
}

function renderReciprocityBanner(stats, doi) {
    if (stats.total === 0) return '';
    var bannerCls;
    var headline;
    if (stats.gaps === 0 && stats.external > 0) {
        bannerCls = 'good';
        headline = '✓ All discovered citations are declared in DataCite.';
    } else if (stats.gapsNovel > 0) {
        bannerCls = 'warn';
        headline = stats.gapsNovel + ' citation' + (stats.gapsNovel === 1 ? '' : 's') + ' found only in external sources — DataCite\'s graph doesn\'t have ' + (stats.gapsNovel === 1 ? 'this link' : 'these links') + ' yet.';
    } else if (stats.gapsKnown > 0) {
        bannerCls = 'warn';
        headline = stats.gapsKnown + ' citation' + (stats.gapsKnown === 1 ? '' : 's') + ' already in DataCite — declaring IsCitedBy in this record would echo ' + (stats.gapsKnown === 1 ? 'it' : 'them') + '.';
    } else {
        bannerCls = 'neutral';
        headline = stats.declaredOnly + ' relation' + (stats.declaredOnly === 1 ? '' : 's') + ' declared in DataCite — no external citation source has confirmed yet.';
    }

    var html = '<div class="recip-banner ' + bannerCls + '">';
    html += '<div>';
    html += '<span class="recip-headline">' + escapeHtml(headline) + '</span>';
    html += '<div class="recip-pills">';
    if (stats.external > 0) {
        html += '<span class="recip-pill"><strong>' + stats.external + '</strong> found externally'
            + infoTip('Citations to this record that DataCite, OpenCitations, or OpenAlex have indexed. DataCite picks up citations automatically when the citing paper (registered with Crossref) declares the DOI in its references.')
            + '</span>';
    }
    html += '<span class="recip-pill"><strong>' + stats.totalDeclared + '</strong> declared in DataCite'
        + infoTip('Relations in this record\'s relatedIdentifiers array. Counted relations: IsCitedBy, IsReferencedBy, IsSupplementTo, IsDescribedBy, IsDocumentedBy.')
        + '</span>';
    if (stats.gapsNovel > 0) {
        html += '<span class="recip-pill gap"><strong>' + stats.gapsNovel + '</strong> novel gap' + (stats.gapsNovel === 1 ? '' : 's')
            + infoTip('Citation only OpenCitations or OpenAlex know about — DataCite doesn\'t have the link in its citation graph. Adding IsCitedBy to this record contributes new information to the global graph.')
            + '</span>';
    }
    if (stats.gapsKnown > 0) {
        html += '<span class="recip-pill gap-known"><strong>' + stats.gapsKnown + '</strong> echo gap' + (stats.gapsKnown === 1 ? '' : 's')
            + infoTip('Citation DataCite already discovered (typically because the citing paper declared the reference in Crossref). Adding IsCitedBy to this record echoes information that already exists in the citation graph — useful for self-description but not strictly necessary.')
            + '</span>';
    }
    if (stats.declaredOnly > 0) {
        html += '<span class="recip-pill info"><strong>' + stats.declaredOnly + '</strong> declared only'
            + infoTip('Relations declared in this record\'s relatedIdentifiers array that no external citation index has confirmed yet. Either the citing work is too recent to be indexed, or the relation may need verification.')
            + '</span>';
    }
    if (stats.noDoi > 0) {
        html += '<span class="recip-pill info"><strong>' + stats.noDoi + '</strong> no DOI'
            + infoTip('Citation found without a DOI — reciprocity cannot be determined automatically.')
            + '</span>';
    }
    html += '</div></div>';
    if (stats.gaps > 0) {
        html += '<button class="copy-gaps-btn" data-doi="' + escapeAttr(doi) + '" data-tip="Copies all gap DOIs to clipboard, novel gaps first. Paste into DataCite Fabrica as IsCitedBy relations.">Copy ' + stats.gaps + ' gap DOI' + (stats.gaps === 1 ? '' : 's') + '</button>';
    }
    html += '</div>';
    return html;
}

function renderCitationItem(c, idx) {
    var srcTags = (c.sources || []).map(function(s) {
        if (s === 'datacite') return '<span class="source-tag tag-datacite">DataCite</span>';
        if (s === 'opencitations') return '<span class="source-tag tag-opencitations">OpenCitations</span>';
        if (s === 'openalex') return '<span class="source-tag tag-openalex">OpenAlex</span>';
        return '';
    }).join('');
    var doiLink = c.doi && c.doi !== 'N/A'
        ? '<a href="https://doi.org/' + escapeAttr(c.doi) + '" target="_blank" rel="noopener">' + escapeHtml(c.doi) + '</a>'
        : '<span style="color:var(--text-muted)">no DOI</span>';

    var recipBadge = '';
    var relText = c.declaredRelation
        ? '<span class="relation">(' + escapeHtml(c.declaredRelation) + ')</span>'
        : '';
    if (c.reciprocity === 'declared') {
        recipBadge = '<span class="recip-badge declared" data-tip="Reciprocally declared: external citation sources found this paper, and this record\'s relatedIdentifiers array also declares the link as ' + escapeAttr(c.declaredRelation || 'related') + '.">↔ declared ' + relText + '</span>';
    } else if (c.reciprocity === 'gap-novel') {
        recipBadge = '<span class="recip-badge gap" data-tip="Found only in OpenCitations / OpenAlex. DataCite\'s citation graph doesn\'t have this link yet. Declaring IsCitedBy for this DOI in the record adds new information to DataCite.">⚠ novel gap</span>';
    } else if (c.reciprocity === 'gap-known') {
        recipBadge = '<span class="recip-badge gap-known" data-tip="DataCite already has this citation discovered (typically via Crossref reference data on the citing paper). Adding IsCitedBy in this record echoes information that\'s already in the global graph — improves self-description but lower priority than novel gaps.">⚠ echo gap</span>';
    } else if (c.reciprocity === 'declared-only') {
        recipBadge = '<span class="recip-badge declared-only" data-tip="Declared in this record\'s relatedIdentifiers as ' + escapeAttr(c.declaredRelation || 'related') + ', but no external citation index has confirmed it yet. Either the citing work is too recent to index, or the relation may need verification.">○ declared only ' + relText + '</span>';
    } else if (c.reciprocity === 'no-doi') {
        recipBadge = '<span class="recip-badge no-doi" data-tip="No DOI available — reciprocity cannot be determined automatically.">no DOI</span>';
    }

    var itemClass = 'citation-item';
    if (c.reciprocity === 'gap-novel') itemClass += ' is-gap-novel';
    else if (c.reciprocity === 'gap-known') itemClass += ' is-gap-known';
    else if (c.reciprocity === 'declared-only') itemClass += ' is-declared-only';

    var metaParts = [];
    if (c.authors && c.authors !== 'Unknown') metaParts.push(escapeHtml(c.authors));
    if (c.year) metaParts.push(String(c.year));
    if (c.journal && c.journal !== 'N/A') metaParts.push(escapeHtml(c.journal));
    metaParts.push(doiLink);

    return '<li class="' + itemClass + '">'
        + '<div class="cit-status">' + recipBadge + '</div>'
        + '<div class="cit-body">'
        + '<div class="title">' + (idx + 1) + '. ' + escapeHtml(c.title || 'Untitled') + (srcTags ? '<span class="sources">' + srcTags + '</span>' : '') + '</div>'
        + '<div class="meta">' + metaParts.join(' · ') + '</div>'
        + '</div>'
        + '</li>';
}

function renderSourceChip(label, result) {
    var citations = result.citations || [];
    var cls = result.error ? 'error' : (citations.length > 0 ? 'has-data' : '');
    var title = result.error ? ('Error: ' + result.error) : (citations.length + ' citation' + (citations.length === 1 ? '' : 's') + ' returned');
    return '<span class="src ' + cls + '" title="' + escapeAttr(title) + '"><span class="dot"></span>'
        + escapeHtml(label) + ' (' + (result.error ? 'error' : citations.length) + ')</span>';
}

function renderCitationsPane(doi, merged, stats, sources, paneEl) {
    var html = '';
    html += renderReciprocityBanner(stats, doi);

    html += '<div class="cit-toolbar">';
    html += '<div class="source-summary">'
        + renderSourceChip('DataCite', sources.datacite || { citations: [] })
        + renderSourceChip('OpenCitations', sources.opencitations || { citations: [] })
        + renderSourceChip('OpenAlex', sources.openalex || { citations: [] })
        + '</div>';
    html += '<div style="font-size:12px;color:var(--text-soft);"><strong>' + merged.length + '</strong> entr' + (merged.length === 1 ? 'y' : 'ies') + ' total</div>';
    html += '</div>';

    if (merged.length === 0) {
        html += '<div class="empty-state">No citations found across any source, and no relatedIdentifiers declared in the DataCite record.</div>';
    } else {
        html += '<ul class="citation-list">';
        merged.forEach(function(c, idx) { html += renderCitationItem(c, idx); });
        html += '</ul>';
    }

    paneEl.innerHTML = html;

    // Wire up "Copy gap DOIs" button — closes over merged, which is already
    // sorted novel-first, so the copied list leads with the highest-value DOIs.
    var copyBtn = paneEl.querySelector('.copy-gaps-btn');
    if (copyBtn) {
        copyBtn.addEventListener('click', function() {
            var gapDois = merged.filter(function(c) { return c.reciprocity === 'gap-novel' || c.reciprocity === 'gap-known'; })
                                .map(function(c) { return c.doi || c.normDoi; })
                                .filter(Boolean);
            copyToClipboard(gapDois.join('\n'));
            showToast(gapDois.length + ' gap DOI' + (gapDois.length === 1 ? '' : 's') + ' copied — paste as IsCitedBy relations in DataCite');
        });
    }
}

// ----- Orchestrator -----
// cfg = { entity, cache, paneEl, email, onLoaded }
//   entity   -> { doi, relatedIdentifiers, ... }
//   cache    -> citation cache object (keyed by normaliseDoi(doi))
//   paneEl   -> the detail pane element to render into
//   email    -> mailto address for OpenAlex polite pool (required)
//   onLoaded(stats) -> called after render (fresh load AND cache hit) so the
//     page can update its tab badge, cite pills, and fleet panel.
async function loadCitationsInto(cfg) {
    var entity = cfg.entity;
    var paneEl = cfg.paneEl;
    var cache = cfg.cache;
    if (!entity || !entity.doi) {
        paneEl.innerHTML = '<div class="empty-state" style="color:var(--bad)">Record not found.</div>';
        return;
    }
    var doi = entity.doi;
    var key = normaliseDoi(doi);

    // Cache hit — render instantly, no network round-trip
    var cached = cache[key];
    if (cached && cached.fullCitations && cached.reciprocity) {
        renderCitationsPane(doi, cached.fullCitations, cached.reciprocity, cached.sources || {}, paneEl);
        if (cfg.onLoaded) cfg.onLoaded(cached.reciprocity);
        return;
    }

    paneEl.innerHTML = '<div class="empty-state"><span class="spinner"></span> Querying DataCite, OpenCitations, and OpenAlex…</div>';
    try {
        var results = await Promise.allSettled([
            fetchDataCiteCitations(doi),
            fetchOpenCitations(doi),
            fetchOpenAlexCitations(doi, cfg.email)
        ]);
        var fb = function(r, n) { return r.status === 'fulfilled' ? r.value : { source: n, error: String(r.reason), citations: [], reportedCount: 0 }; };
        var datacite = fb(results[0], 'datacite');
        var oc = fb(results[1], 'opencitations');
        var oa = fb(results[2], 'openalex');

        var merged = mergeCitations(datacite, oc, oa);
        var analysis = analyseReciprocity(entity.relatedIdentifiers, merged);
        merged = analysis.merged;
        var stats = analysis.stats;

        // Cache for fast re-render and badge persistence
        cache[key] = cache[key] || {};
        cache[key].fullCitations = merged;
        cache[key].sources = { datacite: datacite, opencitations: oc, openalex: oa };
        cache[key].reciprocity = stats;

        renderCitationsPane(doi, merged, stats, cache[key].sources, paneEl);
        if (cfg.onLoaded) cfg.onLoaded(stats);
    } catch (e) {
        paneEl.innerHTML = '<div class="empty-state" style="color:var(--bad)">Error loading citations: ' + escapeHtml(e.message) + '</div>';
    }
}

// ----- Cite pill (table column) -----
function renderCitePill(entity, cache) {
    if (!entity.doi) return '<span style="font-size:11px;color:var(--text-muted);">—</span>';
    if (typeof entity.citationCount !== 'number') return '<span class="cite-pill loading">…</span>';
    var cls = entity.citationCount > 0 ? '' : 'zero';
    var html = '<span class="cite-pill ' + cls + '">' + entity.citationCount;
    var cached = cache[normaliseDoi(entity.doi)];
    if (cached && cached.reciprocity) {
        var gaps = (cached.reciprocity.gapsNovel || 0) + (cached.reciprocity.gapsKnown || 0);
        if (gaps > 0) {
            html += '<span class="gap-marker" title="' + gaps + ' gap' + (gaps === 1 ? '' : 's') + '">⚠</span>';
        }
    }
    html += '</span>';
    return html;
}
