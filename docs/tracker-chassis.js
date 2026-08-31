// ============================================================
// tracker-chassis.js — shared utilities + page machinery for the
// AuScope tracker pages (earthbank.html, auspass.html, datasets.html,
// future instruments page).
//
// Plain globals, no modules. Load via <script src="tracker-chassis.js">
// before the page's inline script. The fleet machinery reads the page's
// global `state` (create it with createTrackerState).
// ============================================================

// ============================================================
// UTILITIES
// ============================================================
function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normaliseDoi(s) {
    if (!s) return '';
    return String(s).trim().replace(/^https?:\/\/(www\.)?(dx\.)?doi\.org\//i, '').toLowerCase();
}

function fixEncoding(s) {
    if (!s) return '';
    return String(s)
        .replace(/\u00C3\u00A9/g, '\u00e9')
        .replace(/\u00C3\u00A8/g, '\u00e8')
        .replace(/\u00C3\u00AA/g, '\u00ea')
        .replace(/\u00C3\u00A0/g, '\u00e0')
        .replace(/\u00C3\u00A2/g, '\u00e2')
        .replace(/\u00C3\u00B6/g, '\u00f6')
        .replace(/\u00C3\u00BC/g, '\u00fc')
        .replace(/\u00C3\u00A4/g, '\u00e4')
        .replace(/\u00C3\u00B1/g, '\u00f1')
        .replace(/\u00E2\u0080\u0099/g, '\u2019')
        .replace(/\u00E2\u0080\u009C/g, '\u201c')
        .replace(/\u00E2\u0080\u009D/g, '\u201d')
        .replace(/\u00E2\u0080\u0094/g, '\u2014')
        .replace(/\u00E2\u0080\u0093/g, '\u2013')
        .replace(/\ufffd/g, '\u2013');
}

// Accepts an array of creator objects ({family,given} | {familyName,givenName}
// | {name}) or plain name strings; caps at first 3 + ' et al.'.
function formatAuthors(list) {
    if (!list || list.length === 0) return '';
    var names = list.map(function(c) {
        if (c && typeof c === 'object') {
            if (c.family && c.given) return c.family + ', ' + c.given.charAt(0) + '.';
            if (c.familyName && c.givenName) return c.familyName + ', ' + c.givenName.charAt(0) + '.';
            return c.name || c.literal || '';
        }
        return c;
    }).filter(Boolean);
    if (names.length === 0) return '';
    if (names.length <= 3) return names.join(', ');
    return names.slice(0, 3).join(', ') + ' et al.';
}

function debounce(fn, ms) {
    var t;
    return function() {
        var args = arguments, ctx = this;
        clearTimeout(t);
        t = setTimeout(function() { fn.apply(ctx, args); }, ms);
    };
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function syntaxHighlightJson(json) {
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function(match) {
        var cls = 'num';
        if (/^"/.test(match)) cls = /:$/.test(match) ? 'key' : 'str';
        else if (/true|false/.test(match)) cls = 'bool';
        else if (/null/.test(match)) cls = 'null';
        return '<span class="' + cls + '">' + match + '</span>';
    });
}

// Silent copy primitive — callers own their own toasts.
function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).catch(function() { fallbackCopy(text); });
    } else {
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
}

var toastTimer;
function showToast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { t.classList.remove('show'); }, 2200);
}

// ============================================================
// IMAGE FALLBACKS
// ============================================================
// If an asset image fails to load (404 / wrong path / offline), swap it
// with a styled text equivalent so the page stays usable. Tag each
// fallback-eligible <img> with data-fallback="orcid" | "ror" | "auscope".
document.addEventListener('error', function(e) {
    var img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    var fb = img.getAttribute('data-fallback');
    if (!fb) return;
    var span = document.createElement('span');
    if (fb === 'orcid') {
        span.className = 'orcid-fallback';
        span.textContent = 'iD';
        span.title = img.getAttribute('alt') || 'ORCID iD';
    } else if (fb === 'ror') {
        span.className = 'ror-fallback';
        span.textContent = 'ROR';
        span.title = img.getAttribute('alt') || 'ROR';
    } else if (fb === 'auscope') {
        span.className = 'auscope-fallback';
        span.textContent = 'AuScope';
    } else {
        return;
    }
    if (img.parentNode) img.parentNode.replaceChild(span, img);
}, true); // capture phase — `error` does not bubble

// ============================================================
// SEARCH BLOB
// ============================================================
// fieldsFn(entity) returns the array of searchable bits; result is
// memoised on entity._search.
function buildSearchBlob(entity, fieldsFn) {
    if (entity._search) return entity._search;
    entity._search = fieldsFn(entity).filter(Boolean).join(' ').toLowerCase();
    return entity._search;
}

// ============================================================
// CSV EXPORT
// ============================================================
// config = { columns: [{ header, value(entity) }], rows, filenamePrefix }
function exportCsv(config) {
    var rows = config.rows;
    if (!rows || rows.length === 0) { showToast('Nothing to export.'); return; }
    var headers = config.columns.map(function(c) { return c.header; });
    var dataRows = rows.map(function(entity) {
        return config.columns.map(function(c) { return c.value(entity); });
    });
    var csv = [headers].concat(dataRows).map(function(r) {
        return r.map(function(v) {
            v = v == null ? '' : String(v);
            if (v.indexOf(',') >= 0 || v.indexOf('"') >= 0 || v.indexOf('\n') >= 0) v = '"' + v.replace(/"/g, '""') + '"';
            return v;
        }).join(',');
    }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = config.filenamePrefix + '-' + new Date().toISOString().substring(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Exported ' + rows.length + ' rows to CSV.');
}

// ============================================================
// FLEET PANEL
// ============================================================
// One configurable component. config = {
//   categories,        — the page's fleetCategories array
//   getEntities,       — function() -> full entity list (state.datasets etc.)
//   contextFilter,     — function(entity) -> bool; the page's non-fleet
//                        filters ONLY (search/type/year...) — never the
//                        fleet filter itself
//   noun,              — 'records' | 'networks' | ...
//   elements: { panelId, summaryId },
//                      — panelId: the <details> fleet panel (contains
//                        .fleet-grid + .fleet-context); summaryId: the
//                        results line where renderTable puts the
//                        .fleet-filter-chip (chip clear is delegated here —
//                        no inline onclick)
//   onFilterChanged    — called after the fleet filter toggles/clears
//                        (typically the page's renderTable)
// }
// Reads/writes the page's global `state.fleetFilter`.
var fleetConfig = null;

function initFleetPanel(config) {
    fleetConfig = config;
    var panel = document.getElementById(config.elements.panelId);
    var grid = panel ? panel.querySelector('.fleet-grid') : null;
    if (grid) {
        grid.addEventListener('click', function(e) {
            var item = e.target.closest('.fleet-item');
            if (!item || item.classList.contains('zero')) return;
            toggleFleetFilter(item.getAttribute('data-fleet-id'));
        });
    }
    var summaryEl = document.getElementById(config.elements.summaryId);
    if (summaryEl) {
        summaryEl.addEventListener('click', function(e) {
            var btn = e.target.closest('.fleet-filter-chip button');
            if (!btn) return;
            state.fleetFilter = null;
            renderFleetPanel();
            fleetConfig.onFilterChanged();
        });
    }
}

// Compute fleet stats over the same record set the table sees, but excluding
// the fleet filter itself — otherwise clicking an item would shrink the panel
// it's clicked from. The page's other filters DO apply (via contextFilter),
// so the panel respects what the user is currently looking at.
function computeFleetStats() {
    var contextRecords = fleetConfig.getEntities().filter(fleetConfig.contextFilter);
    var sections = fleetConfig.categories.map(function(s) {
        return {
            section: s.section,
            items: s.items.map(function(item) {
                return {
                    id: item.id,
                    label: item.label,
                    count: contextRecords.filter(item.predicate).length
                };
            })
        };
    });
    return { total: contextRecords.length, sections: sections };
}

function renderFleetPanel() {
    if (!fleetConfig) return;
    var panel = document.getElementById(fleetConfig.elements.panelId);
    if (!panel) return;
    var grid = panel.querySelector('.fleet-grid');
    var contextEl = panel.querySelector('.fleet-context');
    if (!grid) return;
    var entities = fleetConfig.getEntities();
    if (entities.length === 0) {
        grid.innerHTML = '';
        if (contextEl) contextEl.textContent = '';
        return;
    }

    var stats = computeFleetStats();
    var anyFilterActive = stats.total !== entities.length;
    if (contextEl) {
        contextEl.textContent = '· ' + stats.total + ' ' + fleetConfig.noun
            + (anyFilterActive ? ' (filtered)' : '')
            + ' · click any line to filter the table';
    }

    var html = '';
    stats.sections.forEach(function(section) {
        html += '<div class="fleet-section">';
        html += '<h4>' + escapeHtml(section.section) + '</h4>';
        section.items.forEach(function(item) {
            var isActive = state.fleetFilter && state.fleetFilter.id === item.id;
            var isZero = item.count === 0;
            var classes = 'fleet-item';
            if (isActive) classes += ' active';
            if (isZero) classes += ' zero';
            html += '<div class="' + classes + '" data-fleet-id="' + escapeAttr(item.id) + '">'
                + '<span class="count">' + item.count + '</span>'
                + '<span class="label">' + escapeHtml(item.label) + '</span>'
                + '</div>';
        });
        html += '</div>';
    });
    grid.innerHTML = html;
}

function toggleFleetFilter(id) {
    if (state.fleetFilter && state.fleetFilter.id === id) {
        state.fleetFilter = null;
    } else {
        var found = null;
        for (var i = 0; i < fleetConfig.categories.length && !found; i++) {
            for (var j = 0; j < fleetConfig.categories[i].items.length; j++) {
                if (fleetConfig.categories[i].items[j].id === id) {
                    found = fleetConfig.categories[i].items[j];
                    break;
                }
            }
        }
        if (found) {
            state.fleetFilter = { id: found.id, label: found.label, predicate: found.predicate };
            var panel = document.getElementById(fleetConfig.elements.panelId);
            if (panel) panel.open = true;
        }
    }
    renderFleetPanel();
    fleetConfig.onFilterChanged();
}

// ============================================================
// STATE
// ============================================================
function createTrackerState(extraFields) {
    var state = {
        sortKey: 'year',
        sortDir: 'desc',
        filter: { search: '' },
        fleetFilter: null,    // { id, label, predicate } — set when user clicks a fleet item
        expanded: new Set(),  // row keys of expanded rows
        citationCache: {},    // doi -> { count, fullCitations, sources, reciprocity }
        citationLoadInFlight: false
    };
    if (extraFields) {
        for (var k in extraFields) {
            if (Object.prototype.hasOwnProperty.call(extraFields, k)) state[k] = extraFields[k];
        }
    }
    return state;
}

// ============================================================
// SITE TABS — one nav bar across the page families.
// Opt-in: pages declare <body data-site-tab="datasets"> (or "" for
// the bar with nothing highlighted). No attribute, no bar — which is
// what keeps it off the widget and the standalone map embeds.
// NOTE: index.html and datasets.html are standalone (no chassis);
// they embed this markup statically — if SITE_TABS changes, update
// buildSiteTabs() in src/dashboard.js and datasets.html to match.
// ============================================================
var SITE_TABS = [
    { id: 'impact', label: 'Impact', href: 'index.html' },
    { id: 'publications', label: 'Publications', href: 'publications.html' },
    { id: 'datasets', label: 'Datasets', href: 'dataset-registry.html' },
    { id: 'fair', label: 'FAIR', href: 'fair-trends.html' },
    { id: 'projects', label: 'Projects', href: 'project-mapping.html' },
    { id: 'software', label: 'Software', href: 'software-registry.html' }
];

(function() {
    function inject() {
        var active = document.body.getAttribute('data-site-tab');
        if (active === null) return;                    // page opted out
        var wrap = document.querySelector('.wrap') || document.body;
        var nav = document.createElement('nav');
        nav.className = 'site-tabs';
        nav.setAttribute('aria-label', 'Site sections');
        nav.innerHTML = SITE_TABS.map(function(t) {
            return '<a href="' + t.href + '"'
                + (t.id === active ? ' class="active" aria-current="page"' : '')
                + '>' + t.label + '</a>';
        }).join('');
        var topbar = wrap.querySelector('.topbar');
        if (topbar && topbar.nextSibling) wrap.insertBefore(nav, topbar.nextSibling);
        else wrap.insertBefore(nav, wrap.firstChild);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject);
    } else {
        inject();
    }
})();
