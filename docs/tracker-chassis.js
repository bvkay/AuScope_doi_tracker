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
            // Formula-injection guard: Excel executes cells starting = + - @
            if (/^[=+\-@]/.test(v)) v = "'" + v;
            if (v.indexOf(',') >= 0 || v.indexOf('"') >= 0 || v.indexOf('\n') >= 0 || v.indexOf('\r') >= 0) {
                v = '"' + v.replace(/"/g, '""') + '"';
            }
            return v;
        }).join(',');
    }).join('\r\n');
    // BOM so Excel reads UTF-8 (author names otherwise mojibake)
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
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
// Every page — the hub and the router included — gets its bar from
// HERE. There are no static copies anywhere: this array is the single
// source of truth, full stop.
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
        var wrap = document.querySelector('.site-head')
            || document.querySelector('.wrap') || document.body;
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

// ============================================================
// ============================================================
// HONEST-NUMBER MACHINERY
//
// Everything below exists to answer one rule the site claims and,
// until now, could not keep: every number on these pages must carry
// its evidence, its date and its failure mode. A source that does not
// answer must never be rendered as a zero.
//
// Five parts:
//   1. trackerFetch + source ledger  — classify failures, express partial
//   2. progress + skeletons          — say what we are waiting for
//   3. glossary                      — one registry for the site's jargon
//   4. renderStat / setFigure        — the honest-number components
//   5. a11y                          — focusable tips, real sort buttons
//
// All plain globals, ES5 syntax, no build step. Load before the page's
// inline script, same as the rest of this file.
// ============================================================
// ============================================================


// ============================================================
// 1a. trackerFetch — a fetch that always finishes and always says why
// ============================================================
// Resolves (never rejects) with a classified result:
//
//   { ok, outcome, status, data, text, reason, url, label, ms, attempts }
//
//   outcome: 'ok' | 'http-error' | 'network' | 'timeout' | 'malformed'
//            | 'aborted'
//
// Never rejecting is deliberate. An unhandled rejection is exactly how
// earthbank.html hung for 85 seconds and how nci-mt.html published
// "Total citations 0" during a DataCite outage: the failure had nowhere
// to go, so it became a default. Here the failure is the return value,
// and the caller has to look at it.
//
// opts:
//   timeout      ms before we abort (default 15000; 0 disables — don't)
//   parse        'json' | 'text' | 'none'          (default 'json')
//   label        human name for banners             (default the URL)
//   retries      retry count for network/timeout/5xx/429 (default 0)
//   retryDelay   first backoff in ms                (default 600)
//   signal       an external AbortSignal to honour
//   ...plus anything else fetch() takes (headers, method, mode…)

var TRACKER_TIMEOUT_MS = 15000;

var TRACKER_OUTCOME_TEXT = {
    'ok':         'Answered',
    'timeout':    'Timed out',
    'network':    'Could not be reached',
    'http-error': 'Refused the request',
    'malformed':  'Sent something we could not read',
    'aborted':    'Cancelled'
};

function trackerFetch(url, opts) {
    opts = opts || {};
    var timeout  = opts.timeout == null ? TRACKER_TIMEOUT_MS : opts.timeout;
    var parse    = opts.parse || 'json';
    var label    = opts.label || shortUrlLabel(url);
    var maxTries = (opts.retries || 0) + 1;
    var baseWait = opts.retryDelay || 600;
    var started  = Date.now();

    function done(res, attempts) {
        res.url = url;
        res.label = label;
        res.ms = Date.now() - started;
        res.attempts = attempts;
        res.at = new Date().toISOString();
        if (!res.ok && !res.reason) res.reason = TRACKER_OUTCOME_TEXT[res.outcome] || 'Failed';
        return res;
    }

    function attempt(n) {
        return once().then(function(res) {
            var retryable = res.outcome === 'network' || res.outcome === 'timeout'
                || (res.outcome === 'http-error' && (res.status >= 500 || res.status === 429));
            if (res.ok || !retryable || n >= maxTries) return done(res, n);
            return sleep(baseWait * Math.pow(2, n - 1)).then(function() { return attempt(n + 1); });
        });
    }

    function once() {
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = null;
        var timedOut = false;
        var externallyAborted = false;

        var init = {};
        for (var k in opts) {
            if (!Object.prototype.hasOwnProperty.call(opts, k)) continue;
            if (k === 'timeout' || k === 'parse' || k === 'label' || k === 'retries'
                || k === 'retryDelay' || k === 'signal') continue;
            init[k] = opts[k];
        }
        if (controller) init.signal = controller.signal;

        if (opts.signal) {
            if (opts.signal.aborted) externallyAborted = true;
            else opts.signal.addEventListener('abort', function() {
                externallyAborted = true;
                if (controller) controller.abort();
            });
        }
        if (timeout > 0 && controller) {
            timer = setTimeout(function() { timedOut = true; controller.abort(); }, timeout);
        }

        return fetch(url, init).then(function(resp) {
            if (timer) clearTimeout(timer);
            if (!resp.ok) {
                // Read a little of the body: an API that explains itself is
                // worth quoting back in the banner.
                return resp.text().catch(function() { return ''; }).then(function(body) {
                    return {
                        ok: false, outcome: 'http-error', status: resp.status, data: null,
                        text: body ? String(body).slice(0, 400) : '',
                        reason: 'HTTP ' + resp.status + (resp.statusText ? ' ' + resp.statusText : '')
                    };
                });
            }
            if (parse === 'none') {
                return { ok: true, outcome: 'ok', status: resp.status, data: null, text: '', response: resp };
            }
            return resp.text().then(function(body) {
                if (parse === 'text') {
                    return { ok: true, outcome: 'ok', status: resp.status, data: body, text: body };
                }
                try {
                    return { ok: true, outcome: 'ok', status: resp.status, data: JSON.parse(body), text: body };
                } catch (e) {
                    return {
                        ok: false, outcome: 'malformed', status: resp.status, data: null,
                        text: String(body).slice(0, 400),
                        reason: 'Replied with something that is not valid JSON'
                    };
                }
            });
        }).catch(function(err) {
            if (timer) clearTimeout(timer);
            if (timedOut) {
                return {
                    ok: false, outcome: 'timeout', status: 0, data: null,
                    reason: 'No answer within ' + Math.round(timeout / 1000) + ' s'
                };
            }
            if (externallyAborted) {
                return { ok: false, outcome: 'aborted', status: 0, data: null, reason: 'Request cancelled' };
            }
            return {
                ok: false, outcome: 'network', status: 0, data: null,
                reason: 'Could not be reached' + (err && err.message ? ' (' + err.message + ')' : '')
            };
        });
    }

    return attempt(1);
}

function shortUrlLabel(url) {
    try {
        var u = new URL(url, window.location.href);
        if (u.origin === window.location.origin) return u.pathname.split('/').pop() || url;
        return u.hostname.replace(/^www\./, '');
    } catch (e) { return String(url); }
}


// ============================================================
// 1b. Source ledger — partial failure, expressed
// ============================================================
// A page names the sources it depends on up front, then reports what
// each one did. The ledger turns that into one honest sentence
// ("3 of 4 sources answered") and one banner, and it is the thing
// setFigure/renderStat consult before they agree to print a number.
//
//   var sources = createSourceLedger({ bannerEl: 'source-banner' });
//   sources.declare('datacite', 'DataCite', { critical: true });
//   sources.declare('fuji', 'F-UJI scores');
//   ...
//   sources.fail('datacite', result);        // result from trackerFetch
//   sources.partial('fuji', { done: 16, total: 242 });
//
// Statuses: 'pending' | 'loading' | 'ok' | 'partial' | 'failed' | 'skipped'

function createSourceLedger(opts) {
    opts = opts || {};
    var order = [];
    var byKey = {};
    var listeners = [];
    var bannerEl = null;

    function entry(key) {
        if (!byKey[key]) {
            byKey[key] = { key: key, label: key, status: 'pending', note: '', reason: '',
                           done: null, total: null, critical: false, outcome: null };
            order.push(key);
        }
        return byKey[key];
    }

    function changed() {
        var st = ledger.state();
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](st, ledger); } catch (e) {}
        }
        if (bannerEl) renderSourceBanner(bannerEl, st, opts);
        return ledger;
    }

    var ledger = {
        declare: function(key, label, cfg) {
            var e = entry(key);
            e.label = label || key;
            if (cfg) {
                if (cfg.critical) e.critical = true;
                if (cfg.note) e.note = cfg.note;
            }
            return changed();
        },
        start: function(key, note) {
            var e = entry(key);
            e.status = 'loading';
            if (note != null) e.note = note;
            return changed();
        },
        ok: function(key, note) {
            var e = entry(key);
            e.status = 'ok'; e.reason = ''; e.outcome = 'ok';
            if (note != null) e.note = note;
            return changed();
        },
        // done/total describe how much of a walk completed. If some of the
        // set failed, this is 'partial': the number is real but incomplete,
        // and every figure derived from it must say so.
        partial: function(key, info) {
            var e = entry(key);
            info = info || {};
            e.status = 'partial';
            if (info.done != null) e.done = info.done;
            if (info.total != null) e.total = info.total;
            if (info.note != null) e.note = info.note;
            if (info.reason != null) e.reason = info.reason;
            return changed();
        },
        // Accepts a trackerFetch result or a plain string.
        fail: function(key, resultOrReason) {
            var e = entry(key);
            e.status = 'failed';
            if (resultOrReason && typeof resultOrReason === 'object') {
                e.reason = resultOrReason.reason || 'Failed';
                e.outcome = resultOrReason.outcome || 'network';
            } else {
                e.reason = resultOrReason ? String(resultOrReason) : 'Failed';
                e.outcome = 'network';
            }
            return changed();
        },
        skip: function(key, note) {
            var e = entry(key);
            e.status = 'skipped';
            if (note != null) e.note = note;
            return changed();
        },
        get: function(key) { return byKey[key] || null; },

        // The question setFigure asks: may I print a number from this?
        healthy: function(key) {
            var e = byKey[key];
            return !!e && (e.status === 'ok' || e.status === 'partial');
        },
        broken: function(key) {
            var e = byKey[key];
            return !!e && e.status === 'failed';
        },
        degraded: function(key) {
            var e = byKey[key];
            return !!e && e.status === 'partial';
        },
        reasonFor: function(key) {
            var e = byKey[key];
            if (!e) return '';
            return e.reason || (e.label + ' did not answer');
        },

        state: function() {
            var sources = order.map(function(k) { return byKey[k]; });
            var expected = sources.filter(function(s) { return s.status !== 'skipped'; });
            var answered = expected.filter(function(s) { return s.status === 'ok' || s.status === 'partial'; });
            var failed   = expected.filter(function(s) { return s.status === 'failed'; });
            var partial  = expected.filter(function(s) { return s.status === 'partial'; });
            var waiting  = expected.filter(function(s) { return s.status === 'loading' || s.status === 'pending'; });

            var level;
            if (failed.length && failed.length === expected.length) level = 'failed';
            else if (failed.some(function(s) { return s.critical; })) level = 'failed';
            else if (failed.length || partial.length) level = 'degraded';
            else if (waiting.length) level = 'loading';
            else level = 'ok';

            var headline, detail;
            if (level === 'loading') {
                headline = 'Loading ' + waiting.length + ' of ' + expected.length
                    + ' source' + (expected.length === 1 ? '' : 's');
                detail = waiting.map(function(s) { return s.label; }).join(', ') + ' still to answer.';
            } else if (level === 'ok') {
                headline = 'All ' + expected.length + ' source' + (expected.length === 1 ? '' : 's') + ' answered';
                detail = 'Every figure on this page is backed by a live response.';
            } else {
                headline = answered.length + ' of ' + expected.length + ' sources answered';
                var bits = [];
                failed.forEach(function(s) { bits.push(s.label + ' — ' + (s.reason || 'failed')); });
                partial.forEach(function(s) {
                    bits.push(s.label + ' — ' + (s.done != null && s.total != null
                        ? s.done + ' of ' + s.total + ' records loaded'
                        : 'incomplete'));
                });
                detail = bits.join('. ') + '.';
                if (failed.length) {
                    detail += ' Figures that depend on '
                        + (failed.length === 1 ? 'it' : 'them')
                        + ' show — rather than a number: this is missing data, not a zero.';
                }
            }
            return {
                level: level, headline: headline, detail: detail,
                answered: answered.length, expected: expected.length,
                failed: failed, partial: partial, waiting: waiting,
                sources: sources
            };
        },

        onChange: function(fn) { listeners.push(fn); return ledger; },
        bindBanner: function(el) { bannerEl = el; return changed(); },
        refresh: changed
    };

    if (opts.bannerEl) ledger.bindBanner(opts.bannerEl);
    return ledger;
}


// ============================================================
// 1c. renderSourceBanner — an outage you cannot miss
// ============================================================
// Colour is never the only carrier: every level also has a glyph and a
// word ("Failed" / "Partial" / "Loading"), so the banner survives
// greyscale printing, colour blindness and a screen reader.
//
// state may be a ledger, a ledger state object, or a plain
// { level, headline, detail } literal.

var TRACKER_BANNER_LEVELS = {
    ok:       { glyph: '✓', word: 'All sources answered', live: 'polite', role: 'status' },
    loading:  { glyph: '◌', word: 'Loading',              live: 'polite', role: 'status' },
    degraded: { glyph: '◐', word: 'Partial data',         live: 'polite', role: 'status' },
    failed:   { glyph: '✕', word: 'Source unavailable',   live: 'assertive', role: 'alert' }
};

function renderSourceBanner(el, state, opts) {
    opts = opts || {};
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return;
    if (state && typeof state.state === 'function') state = state.state();
    if (!state) { el.innerHTML = ''; return; }

    var level = state.level || 'ok';
    var meta = TRACKER_BANNER_LEVELS[level] || TRACKER_BANNER_LEVELS.degraded;

    // A clean page should not carry a banner. Pass showWhenOk to keep one.
    if (level === 'ok' && !opts.showWhenOk) { el.innerHTML = ''; el.hidden = true; return; }
    if (level === 'loading' && opts.hideWhenLoading) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;

    var list = '';
    if (state.sources && state.sources.length && level !== 'ok') {
        list = '<ul class="src-banner-list">' + state.sources.map(function(s) {
            var cls = 'src-chip s-' + s.status;
            var glyph = s.status === 'ok' ? '✓'
                : s.status === 'failed' ? '✕'
                : s.status === 'partial' ? '◐'
                : s.status === 'skipped' ? '–' : '◌';
            var suffix = '';
            if (s.status === 'partial' && s.done != null && s.total != null) {
                suffix = ' <span class="src-chip-note">' + s.done + '/' + s.total + '</span>';
            } else if (s.status === 'failed' && s.reason) {
                suffix = ' <span class="src-chip-note">' + escapeHtml(s.reason) + '</span>';
            } else if (s.note) {
                suffix = ' <span class="src-chip-note">' + escapeHtml(s.note) + '</span>';
            }
            return '<li class="' + cls + '"><span class="src-chip-glyph" aria-hidden="true">' + glyph + '</span>'
                + '<span class="sr-only">' + escapeHtml(s.status) + ': </span>'
                + escapeHtml(s.label) + suffix + '</li>';
        }).join('') + '</ul>';
    }

    var retry = opts.onRetry
        ? '<button type="button" class="src-banner-retry">Try again</button>'
        : '';

    el.className = (el.className || '').replace(/\bsrc-banner-host\b/g, '').trim() + ' src-banner-host';
    el.innerHTML =
        '<div class="src-banner level-' + level + '" role="' + meta.role + '" aria-live="' + meta.live + '">'
        + '<span class="src-banner-glyph" aria-hidden="true">' + meta.glyph + '</span>'
        + '<div class="src-banner-body">'
        + '<strong class="src-banner-head"><span class="src-banner-word">' + escapeHtml(meta.word) + '</span>'
        + '<span class="src-banner-sep" aria-hidden="true"> · </span>'
        + escapeHtml(state.headline || '') + '</strong>'
        + (state.detail ? '<span class="src-banner-detail">' + escapeHtml(state.detail) + '</span>' : '')
        + list
        + '</div>' + retry + '</div>';

    if (opts.onRetry) {
        var btn = el.querySelector('.src-banner-retry');
        if (btn) btn.addEventListener('click', function() { opts.onRetry(); });
    }
}


// ============================================================
// 2. Loading states — say what you are waiting for, and how far in
// ============================================================
// "loading…" with no end is indistinguishable from a hang. The
// GeoNetwork tree walk and the DataCite pagination are genuinely slow,
// so they must show the shape of the wait: which source, how many of
// how many, and — if nothing has moved for a while — that it has
// stalled.
//
//   var p = createProgress('load-note', { label: 'Walking the GeoNetwork tree' });
//   p.set(120, 242, 'reading collections');
//   p.done('242 collections loaded');   // or  p.fail('DataCite timed out')

function createProgress(el, opts) {
    opts = opts || {};
    if (typeof el === 'string') el = document.getElementById(el);
    var stallMs = opts.stallMs == null ? 20000 : opts.stallMs;
    var label = opts.label || 'Loading';
    var note = opts.note || '';
    var done = null, total = opts.total == null ? null : opts.total;
    var stallTimer = null;
    var stalled = false;
    var finished = false;

    function pct() {
        if (done == null || !total) return null;
        return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    }

    function armStall() {
        if (stallTimer) clearTimeout(stallTimer);
        if (finished || stallMs <= 0) return;
        stalled = false;
        stallTimer = setTimeout(function() { stalled = true; paint(); }, stallMs);
    }

    function paint() {
        if (!el) return;
        var p = pct();
        var counter = (done != null && total)
            ? done.toLocaleString('en-AU') + ' of ' + total.toLocaleString('en-AU')
            : (done != null ? done.toLocaleString('en-AU') : '');
        var cls = 'tracker-progress' + (stalled ? ' stalled' : '') + (finished ? ' finished' : '');
        var bar = '';
        if (p != null) {
            bar = '<div class="tp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"'
                + ' aria-valuenow="' + p + '" aria-label="' + escapeAttr(label) + '">'
                + '<div class="tp-fill" style="width:' + p + '%"></div></div>';
        } else if (!finished) {
            bar = '<div class="tp-bar indeterminate" aria-hidden="true"><div class="tp-fill"></div></div>';
        }
        var stallNote = stalled
            ? '<span class="tp-stall">Still waiting — this source is slow to answer. Nothing is broken yet.</span>'
            : '';
        el.innerHTML = '<div class="' + cls + '" role="status" aria-live="polite">'
            + '<div class="tp-head">'
            + (finished ? '' : '<span class="spinner" aria-hidden="true"></span>')
            + '<span class="tp-label">' + escapeHtml(label) + '</span>'
            + (counter ? '<span class="tp-count">' + escapeHtml(counter) + '</span>' : '')
            + (p != null ? '<span class="tp-pct">' + p + '%</span>' : '')
            + '</div>' + bar
            + (note ? '<div class="tp-note">' + escapeHtml(note) + '</div>' : '')
            + stallNote
            + '</div>';
    }

    armStall();
    paint();

    return {
        set: function(d, t, l) {
            done = d;
            if (t != null) total = t;
            if (l != null) label = l;
            armStall(); paint();
            return this;
        },
        step: function(l, n) {
            if (l != null) label = l;
            if (n != null) note = n;
            armStall(); paint();
            return this;
        },
        note: function(n) { note = n == null ? '' : n; paint(); return this; },
        done: function(msg) {
            finished = true;
            if (stallTimer) clearTimeout(stallTimer);
            if (!el) return this;
            el.innerHTML = msg
                ? '<div class="tracker-progress finished" role="status">'
                  + '<span class="tp-tick" aria-hidden="true">✓</span>'
                  + '<span class="tp-label">' + escapeHtml(msg) + '</span></div>'
                : '';
            return this;
        },
        // A failed load is not an empty load. Say so where the spinner was.
        fail: function(reason, retryFn) {
            finished = true;
            if (stallTimer) clearTimeout(stallTimer);
            if (!el) return this;
            el.innerHTML = '<div class="tracker-progress failed" role="alert">'
                + '<span class="tp-cross" aria-hidden="true">✕</span>'
                + '<span class="tp-label">' + escapeHtml(label) + ' failed</span>'
                + '<span class="tp-reason">' + escapeHtml(reason || 'no reason given') + '</span>'
                + (retryFn ? '<button type="button" class="tp-retry">Try again</button>' : '')
                + '</div>';
            if (retryFn) {
                var b = el.querySelector('.tp-retry');
                if (b) b.addEventListener('click', function() { retryFn(); });
            }
            return this;
        },
        destroy: function() {
            if (stallTimer) clearTimeout(stallTimer);
            if (el) el.innerHTML = '';
        }
    };
}

// Placeholder rows so a slow table shows its own shape rather than a
// blank rectangle. opts: { rows, cols, tbody:true }
function renderSkeleton(el, opts) {
    opts = opts || {};
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return;
    var rows = opts.rows || 6;
    var cols = opts.cols || 4;
    var isTbody = el.tagName === 'TBODY' || opts.tbody;
    var html = '';
    for (var r = 0; r < rows; r++) {
        var cells = '';
        for (var c = 0; c < cols; c++) {
            var w = [90, 60, 75, 45, 80][(r + c) % 5];
            cells += isTbody
                ? '<td><span class="skel-bar" style="width:' + w + '%"></span></td>'
                : '<div class="skel-cell"><span class="skel-bar" style="width:' + w + '%"></span></div>';
        }
        html += isTbody ? '<tr class="skel-row" aria-hidden="true">' + cells + '</tr>'
                        : '<div class="skel-row" aria-hidden="true">' + cells + '</div>';
    }
    el.innerHTML = html;
    el.setAttribute('data-skeleton', '1');
}

function clearSkeleton(el) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (el && el.getAttribute('data-skeleton')) {
        el.innerHTML = '';
        el.removeAttribute('data-skeleton');
    }
}


// ============================================================
// 3. GLOSSARY — one registry for every piece of jargon the site shows
// ============================================================
// The rule: if a term is shown, its definition must be reachable from
// where it is shown — by mouse, by keyboard and by screen reader. Bare
// codes like "F3-01M" and bare tier names like "candidate" are not
// self-explanatory to a board member, a journalist or a new starter.
//
//   term('fuji')                -> the entry object
//   termTip('FsF-F3-01M')       -> a tooltip-ready sentence
//   glossaryIcon('recording-days')  -> focusable [i] affordance
//   glossaryTerm('fuji', 'F-UJI')   -> the word itself, marked and glossed
//
// Entries: { term, short, long, aliases, href }
//   short — the expansion or one-line identity ("Findable, Accessible…")
//   long  — the sentence a non-specialist needs

var TRACKER_GLOSSARY = {

    // ---------- Evidence grading (wording matches publications.html) ----------
    'evidence': {
        term: 'Evidence grade',
        short: 'How firmly a paper is linked to AuScope.',
        long: "Every publication is graded by its strongest verifiable link: an identifier on the paper first, then an acknowledgement in the text, then a bare keyword match. Only the first two kinds are counted in headline figures."
    },
    'verified': {
        term: 'Verified',
        short: 'Identifier evidence.',
        long: "This paper carries AuScope's organisational identifier — the strongest machine-verifiable link, checkable by anyone from the paper's own metadata."
    },
    'candidate': {
        term: 'Candidate',
        short: 'Strong identifier evidence, awaiting confirmation.',
        long: "An author on this paper is a known AuScope-affiliated researcher at a partner institution. Strong evidence, but the organisational identifier is not yet on the record."
    },
    'text-attributed': {
        term: 'Acknowledged in text',
        short: 'Written acknowledgement.',
        long: "The paper's text explicitly acknowledges AuScope or one of its facilities."
    },
    'text-infrastructure': {
        term: 'Infrastructure-enabled',
        short: 'Used AuScope-supported infrastructure.',
        long: "The paper's text shows the research used AuScope-supported infrastructure, without naming AuScope in the acknowledgements."
    },
    'text-software': {
        term: 'AuScope software',
        short: 'Used AuScope-supported software.',
        long: 'The paper reports using AuScope-supported software such as GPlates or Underworld. Counted separately from attributed publications, because the software is used far beyond AuScope.'
    },
    'keyword': {
        term: 'Keyword only',
        short: 'No confirmed link yet.',
        long: 'Found through an AuScope-related search term, with no identifier and no acknowledgement found. Under review, and excluded from every headline figure on this site.',
        aliases: ['keyword-only', 'unverified']
    },
    'attributed': {
        term: 'Attributed publications',
        short: 'The headline count.',
        long: 'Papers carrying either an AuScope identifier or an explicit written acknowledgement — verified, candidate, acknowledged-in-text and infrastructure-enabled combined. Every headline figure on this site counts only these.'
    },
    'unverified-matches': {
        term: 'Unverified keyword matches',
        short: 'Excluded from the headline.',
        long: 'Papers found by an AuScope-related keyword search with no confirmed link yet. They are listed separately, and excluded from every headline figure, so the exclusion is visible rather than assumed.'
    },
    'citations': {
        term: 'Citations',
        short: 'Times a paper has been cited, per OpenAlex.',
        long: 'Counts come from OpenAlex and only ever increase in this tracker: a lower number from a later API call is treated as an API inconsistency, not as a correction.'
    },

    // ---------- Number grades (used by renderStat) ----------
    'grade-measured': {
        term: 'Measured',
        short: 'Counted from records the tracker holds.',
        long: 'A direct count of records in the tracker at the stated date. Click the number to see the rows it counts.'
    },
    'grade-snapshot': {
        term: 'Snapshot',
        short: 'Frozen at the build date.',
        long: 'Captured when this page was last built, not read live. The world may have moved since the stated date.'
    },
    'grade-partial': {
        term: 'Partial',
        short: 'Some sources did not answer.',
        long: 'This figure is real but incomplete: at least one source it depends on failed or was still loading. Treat it as a floor, not a total.'
    },
    'grade-estimate': {
        term: 'Estimate',
        short: 'Derived, not counted.',
        long: 'Calculated or extrapolated from other figures rather than counted directly. The method is stated next to the number.'
    },
    'grade-unverified': {
        term: 'Unverified',
        short: 'Not evidence-linked.',
        long: 'Shown for completeness only. Not counted in any headline figure on this site.'
    },
    'grade-unavailable': {
        term: 'Unavailable',
        short: 'The source did not answer.',
        long: 'The source behind this number failed or timed out, so no number is shown. This is missing data, not a zero.'
    },

    // ---------- FAIR / F-UJI ----------
    'fair': {
        term: 'FAIR',
        short: 'Findable, Accessible, Interoperable, Reusable.',
        long: 'Four principles for research data that a machine, not just a person, can find and use. FAIR is about how well a dataset is described and published — not about how good the science is.'
    },
    'fuji': {
        term: 'F-UJI',
        short: 'An automated FAIR-assessment tool.',
        long: "F-UJI reads a dataset's public metadata and scores it against a fixed metric set. It measures the record, not the data: a superb dataset with a thin DataCite record scores poorly, and that is the point — the record is what a machine sees.",
        aliases: ['f-uji'],
        href: 'https://www.f-uji.net/'
    },
    'fuji-score': {
        term: 'F-UJI score',
        short: 'Percentage of the metric set passed.',
        long: 'The share of F-UJI metric points a record earns. AuScope scores against metric set v0.8 — 17 metrics, 26 points. Scores from different metric versions are not comparable.'
    },
    'fuji-band': {
        term: 'Reading an F-UJI score',
        short: '35-60% is the normal band for metric set v0.8.',
        long: 'Under v0.8, well-run repositories typically land between 35% and 60%; scores run structurally low because several metrics are near-unreachable for collection-level DOIs. An average of 50% is above the middle of that band, not a bare pass. Read these as relative — between platforms and over time — never as a mark out of 100.',
        aliases: ['fuji-normal-band']
    },
    'metric-version': {
        term: 'Metric version',
        short: 'Which F-UJI rulebook produced the score.',
        long: 'AuScope pins F-UJI to metric set v0.8 so scores stay comparable over time. A score from a different metric version measures different things and cannot be compared to these.'
    },

    // ---------- The 17 F-UJI v0.8 metrics, in plain English ----------
    'FsF-F1-01MD': {
        term: 'Globally unique identifier',
        short: 'Does the record have an identifier that is unique worldwide?',
        long: 'The dataset carries an identifier no other thing shares — a DOI, a handle, a URI. Without one, two datasets can be confused for each other.'
    },
    'FsF-F1-02MD': {
        term: 'Persistent identifier',
        short: 'Is that identifier one somebody has promised to keep working?',
        long: 'A DOI or handle backed by a registry, rather than a plain web address that stops working when a server is retired.'
    },
    'FsF-F2-01M': {
        term: 'Core descriptive metadata',
        short: 'Does the record say who, what, when and about what?',
        long: 'Creator, title, identifier, publisher, publication date, summary and keywords — the minimum needed for anyone to find the dataset by searching for its subject.'
    },
    'FsF-F3-01M': {
        term: 'Data identifier inside the metadata',
        short: 'Does the record name the identifier of the data it describes?',
        long: 'A machine reading the record should be able to jump straight to the data file. Nearly every AuScope record fails this metric because our DOIs describe collections and services, not single downloadable files — which is why it is the most common failure on these pages and not, on its own, a sign of a bad record.'
    },
    'FsF-F4-01M': {
        term: 'Harvestable by search engines',
        short: 'Can a search engine or aggregator index the record?',
        long: 'The metadata is published somewhere machines can crawl or harvest it, so the dataset can be found by people who never visit the repository.'
    },
    'FsF-A1-01M': {
        term: 'Access conditions stated',
        short: 'Does the record say who may use the data, and how?',
        long: 'Whether the data is open, restricted or embargoed, and on what terms. Silence here forces a would-be user to ask a human.'
    },
    'FsF-A1-02MD': {
        term: 'Retrievable by identifier',
        short: 'Does following the identifier actually reach the data?',
        long: 'Resolving the DOI leads to the metadata and to a real route to the data, rather than to a dead page.'
    },
    'FsF-A1.1-01MD': {
        term: 'Standard access protocol',
        short: 'Is the data reachable by ordinary web standards?',
        long: 'Retrieval uses an open, free, universally implemented protocol such as HTTPS — not a bespoke channel or a bilateral arrangement.'
    },
    'FsF-A1.2-01MD': {
        term: 'Authenticated access supported',
        short: 'If the data is restricted, can the right people still get in?',
        long: 'The access protocol supports authentication and authorisation, so restricted data is still reachable by those entitled to it rather than simply unavailable.'
    },
    'FsF-I1-01M': {
        term: 'Machine-readable metadata format',
        short: 'Is the record in a language a machine can parse?',
        long: 'The metadata is expressed formally — JSON-LD, RDF, structured XML — rather than as prose a human has to read.'
    },
    'FsF-I2-01M': {
        term: 'Registered vocabularies',
        short: 'Do the keywords come from a published vocabulary?',
        long: 'Subjects and keywords are drawn from a registered controlled vocabulary, so "MT" means the same thing to every system reading it, rather than being free text.'
    },
    'FsF-I3-01M': {
        term: 'Qualified links to related things',
        short: 'Does the record link to related work, and say how it is related?',
        long: 'References to papers, instruments, software or other datasets, each tagged with the nature of the relationship (IsCitedBy, IsDerivedFrom, and so on) rather than a bare link.'
    },
    'FsF-R1-01M': {
        term: 'Content described',
        short: 'Does the record describe what is actually in the data?',
        long: 'Variables, coverage, resolution, units — enough for someone to judge whether the data suits their purpose before downloading it.'
    },
    'FsF-R1.1-01M': {
        term: 'Licence stated',
        short: 'Is there a reuse licence, in machine-readable form?',
        long: 'A named licence such as CC-BY-4.0. Without one, a careful user must assume they may not reuse the data at all.'
    },
    'FsF-R1.2-01M': {
        term: 'Provenance recorded',
        short: 'Does the record say where the data came from?',
        long: 'How the data came to exist: who collected or generated it, with what instrument or method, and from what sources.'
    },
    'FsF-R1.3-01M': {
        term: 'Community metadata standard',
        short: 'Does the record follow a standard the field recognises?',
        long: 'The metadata uses a disciplinary standard the relevant research community has agreed on, so their tools can read it without special handling.'
    },
    'FsF-R1.3-02D': {
        term: 'Community file format',
        short: 'Are the files in a format the field actually uses?',
        long: 'Data in formats the community works with — miniSEED, netCDF, GeoTIFF — rather than a proprietary or one-off format that needs specific software.'
    },

    // ---------- Instruments and deployments ----------
    'pidinst': {
        term: 'PIDInst',
        short: 'Persistent Identifier for Instruments.',
        long: 'A metadata standard and DOI type for physical instruments, so a magnetometer or a seismometer can be identified and cited as precisely as a paper. AuScope mints instrument DOIs under the 10.82388 prefix.',
        aliases: ['pid-inst', 'instrument-doi'],
        href: 'https://www.pidinst.org/'
    },
    'pidinst-score': {
        term: 'PIDInst score',
        short: 'Metadata completeness for an instrument record.',
        long: 'How much of the PIDInst schema an instrument record actually fills in — model, serial number, owner, manufacturer, dates — weighted by how load-bearing each field is. It measures the record, not the instrument.'
    },
    'recording-days': {
        term: 'Recording-days',
        short: 'One instrument recording for one day.',
        long: 'The sum, across every instrument and every deployment, of the days each instrument spent in the ground collecting data. Ten instruments out for thirty days each is 300 recording-days. It measures effort in the field, not the number of sites or instruments.',
        aliases: ['recording day', 'recording days', 'recording-day']
    },
    'unit-years': {
        term: 'Unit-years',
        short: 'One instrument in service for one year.',
        long: 'The same idea as recording-days at fleet scale: the total time instruments have been in service, summed across the fleet. Twelve instruments held for five years each is 60 unit-years. It expresses how hard the fleet has worked, independently of how many units there are.',
        aliases: ['unit year', 'unit years', 'unit-year']
    },
    'occupation': {
        term: 'Occupation',
        short: 'One instrument at one site for one continuous stretch.',
        long: 'A site visited twice, or worked by two instruments at once, counts as two occupations. Occupations are how deployments are counted; stations are how places are counted.'
    },
    'run': {
        term: 'Run',
        short: 'A single continuous recording by one instrument.',
        long: 'The atomic record in the AusMT station files: one instrument, one site, a start and an end. Runs are what recording-days are summed from.'
    },
    'deployment': {
        term: 'Deployment',
        short: 'One unit at one station for one acquisition epoch.',
        long: 'Channels are deduplicated, so a three-component sensor at one site for one epoch is one deployment, not three. The same unit moved to a second site is a second deployment.'
    },
    'deployment-days': {
        term: 'Deployment-days',
        short: 'One instrument deployed for one day.',
        long: 'Days summed per deployment epoch and capped at today, so an open-ended epoch cannot run into the future. The seismic and MT registers count the same quantity; the MT pages call it recording-days.',
        aliases: ['deployment day', 'deployment days', 'deployment-year', 'deployment-years']
    },
    'station-deployment': {
        term: 'Station-deployment',
        short: 'A unit-by-station pairing.',
        long: 'The count of unit x station epochs, not of places. One station worked by four instruments over a decade contributes four station-deployments and one station.',
        aliases: ['station-deployments', 'unit station epoch']
    },
    'mintable-unit': {
        term: 'Mintable unit',
        short: 'A physical device identifiable enough to receive a DOI.',
        long: 'A (model, serial) pair distinct enough to identify one physical device, so it could carry a PIDInst DOI once one is minted. Mintable is a statement about identity, not about ownership.',
        aliases: ['mintable', 'mintable units']
    },

    // ---------- Instrument attribution tiers (seismic register) ----------
    'attribution-tier': {
        term: 'Attribution tier',
        short: 'How firmly an instrument is established as AuScope kit.',
        long: 'The instrument registers grade ownership the same way the publication pages grade papers: only evidenced tiers are counted in headline figures, and the excluded tiers are still listed so the exclusion is visible rather than implied.',
        aliases: ['attribution tiers', 'tier']
    },
    'tier-anu-built': {
        term: 'ANU-built',
        short: 'Counted.',
        long: 'The model string names ANU as the builder (LPR-200, ANUSR, TerraSAWR), making ANU both manufacturer and owner.',
        aliases: ['confirmed-ANU-built', 'ANU-built']
    },
    'tier-auscope-experiment': {
        term: 'AuScope experiment',
        short: 'Counted.',
        long: 'Deployed in an experiment whose operator has confirmed the use of AuScope instruments.',
        aliases: ['confirmed-AuScope', 'AuScope experiment']
    },
    'tier-ansir-loan': {
        term: 'ANSIR loan',
        short: 'Counted.',
        long: 'The serial sits in a network whose ANSIR project record itemises that model as loaned kit.',
        aliases: ['confirmed-ANSIR-loan', 'ANSIR loan']
    },
    'tier-probable-ansir': {
        term: 'Probable ANSIR',
        short: 'Not counted.',
        long: 'In an ANSIR-supported project, but the model is not itemised on the loan record. Plausible, not evidenced, so it stays out of every headline figure.',
        aliases: ['probable-ANSIR', 'probable ANSIR']
    },
    'tier-unattributed': {
        term: 'Unattributed',
        short: 'Not counted.',
        long: 'No ANSIR or AuScope record and not ANU-built. Includes the GSWA-run WA Array and the AuSIS schools network.',
        aliases: ['unattributed']
    },

    'station': {
        term: 'Station',
        short: 'A place where data is recorded.',
        long: 'A site with a code and a position. One station can host many deployments over the years, so station counts and deployment counts are different measures and will not match.'
    },

    // ---------- The lenses ----------
    'lens': {
        term: 'Lens',
        short: "AuScope's own grouping of its programs.",
        long: "The Downward-Looking Telescope frames AuScope's work as six lenses onto the continent. Lenses are a program taxonomy applied to projects; most of the site's evidence is not yet mapped to one, so lens counts describe coverage of the taxonomy, not the whole evidence base."
    },
    // Counts deliberately absent from these definitions: the lens cards render
    // live figures from project-mapping.json right beside the tooltip, and the
    // hardcoded versions here had already drifted (FAIR read "no registered
    // datasets yet" on a card showing 11). A definition should define, not count.
    'lens-observational': {
        term: 'Observational Lens',
        short: 'Seeing the continent as it is now.',
        long: 'Programs that image and sound the Earth in the present — seismic, magnetotelluric and geodetic observation.'
    },
    'lens-temporal': {
        term: 'Temporal Lens',
        short: 'Reading the continent through time.',
        long: 'Programs concerned with age, composition and evolution — geochronology, geochemistry and the sample archives behind them.'
    },
    'lens-characterisation': {
        term: 'Characterisation Lens',
        short: 'Measuring what the rock actually is.',
        long: 'Programs that characterise material directly — drill-core scanning, mineralogy, spectral and physical property measurement.'
    },
    'lens-analysis': {
        term: 'Analysis Framework',
        short: 'Turning observation into model.',
        long: 'Simulation, analysis and modelling capability — the computational side of the telescope.'
    },
    'lens-fair': {
        term: 'FAIR Data Framework',
        short: 'The plumbing that makes the rest findable.',
        long: 'Research data systems and the virtual research environment — the infrastructure that publishes and connects everything else.'
    },
    'lens-community': {
        term: 'Community, Culture & Collaboration',
        short: 'People, outreach and partnership.',
        long: 'Outreach, engagement and international collaboration. (The mapping sheet spells this "Cuture"; the pages follow the sheet.)',
        aliases: ['Community, Cuture & Collaboration', 'lens-culture']
    },

    // ---------- Identifiers and sources ----------
    'doi': {
        term: 'DOI',
        short: 'Digital Object Identifier.',
        long: 'A permanent identifier for a published thing — a paper, a dataset, an instrument. Resolving it through doi.org should always reach the current home of that thing, even if the website behind it changes.'
    },
    'datacite': {
        term: 'DataCite',
        short: 'The registry behind research-data DOIs.',
        long: 'DataCite mints DOIs for datasets, software and instruments, and publishes the metadata attached to them. Most figures on the dataset pages are read live from the DataCite API.'
    },
    'openalex': {
        term: 'OpenAlex',
        short: 'An open catalogue of scholarly works.',
        long: 'The tracker uses OpenAlex for discovery, metadata and citation counts. It is open and free, which is why it is the primary source, but it is not exhaustive.'
    },
    'opencitations': {
        term: 'OpenCitations',
        short: 'An open index of citation links.',
        long: 'Used to find which works cite a given DOI, complementing the counts from OpenAlex.'
    },
    'crossref': {
        term: 'Crossref',
        short: 'The registry behind most journal-article DOIs.',
        long: 'Used here only to enrich metadata for DOIs already known. Its free-text search returns too many false positives to be trusted for discovery.'
    },
    'fdsn': {
        term: 'FDSN',
        short: 'International Federation of Digital Seismograph Networks.',
        long: 'The body that assigns seismic network codes and defines the web services those networks publish. AusPass station and network figures come from FDSN services.'
    },
    'geonetwork': {
        term: 'GeoNetwork',
        short: 'A catalogue server for spatial metadata.',
        long: "NCI publishes its collection records through GeoNetwork. Reading them means walking a tree of records one request at a time, which is why those pages take a while to fill."
    },
    'orcid': {
        term: 'ORCID',
        short: 'A persistent identifier for a researcher.',
        long: 'Distinguishes one researcher from every other person with a similar name, and travels with them between institutions.'
    },
    'ror': {
        term: 'ROR',
        short: 'Research Organization Registry.',
        long: 'A persistent identifier for an institution. AuScope’s ROR on a paper is the strongest machine-verifiable evidence that the paper is ours.'
    },
    'open-access': {
        term: 'Open access',
        short: 'Free to read without a subscription.',
        long: 'Anyone can read the paper without paying or belonging to a subscribing institution. Open-access status comes from OpenAlex.',
        aliases: ['oa']
    },
    'as-of': {
        term: 'As-of date',
        short: 'When this number was true.',
        long: 'Figures on this site are either read live or baked in when the page was last built. The as-of date says which, and when. A number pasted into a slide without its as-of date cannot be defended six months later.'
    }
};

// Lookup that tolerates how the site actually writes these things:
// case, spaces, the FsF- prefix on metric codes, and display strings.
var TRACKER_GLOSSARY_INDEX = null;

function buildGlossaryIndex() {
    TRACKER_GLOSSARY_INDEX = {};
    function put(k, entry) {
        if (k == null) return;
        var norm = String(k).toLowerCase().replace(/\s+/g, '-').replace(/[.,]$/, '');
        if (!TRACKER_GLOSSARY_INDEX[norm]) TRACKER_GLOSSARY_INDEX[norm] = entry;
    }
    for (var key in TRACKER_GLOSSARY) {
        if (!Object.prototype.hasOwnProperty.call(TRACKER_GLOSSARY, key)) continue;
        var entry = TRACKER_GLOSSARY[key];
        entry.key = key;
        put(key, entry);
        put(entry.term, entry);
        // fair-trends strips the FsF- prefix before display; match both.
        if (key.indexOf('FsF-') === 0) put(key.slice(4), entry);
        if (entry.aliases) {
            for (var i = 0; i < entry.aliases.length; i++) put(entry.aliases[i], entry);
        }
    }
}

function trackerTerm(key) {
    if (!key) return null;
    if (!TRACKER_GLOSSARY_INDEX) buildGlossaryIndex();
    var norm = String(key).toLowerCase().replace(/\s+/g, '-').replace(/[.,]$/, '');
    return TRACKER_GLOSSARY_INDEX[norm]
        || TRACKER_GLOSSARY_INDEX['fsf-' + norm]
        || null;
}

// The short name the site should show for a bare F-UJI metric code —
// this is what fills fair-trends.html's empty .metric-name slot.
function fujiMetricName(id) {
    var e = trackerTerm(id);
    return e ? e.term : '';
}

// A tooltip-ready sentence. Falls back to the raw key so a missing
// entry degrades to "no gloss yet" rather than to a silent empty tip.
function termTip(key) {
    var e = trackerTerm(key);
    if (!e) return '';
    var parts = [e.term];
    if (e.short) parts.push('— ' + e.short);
    var head = parts.join(' ');
    return e.long ? head + ' ' + e.long : head;
}

// The documented short name from the spec. Kept as an alias because a
// few pages already use `term` as a local variable inside functions —
// harmless (they shadow, they never call), but trackerTerm is the name
// to reach for in new code.
var term = trackerTerm;

var trackerGlossSeq = 0;

// A real <button>: focusable, activatable by Enter and Space, and
// described to a screen reader by a visually-hidden sibling carrying
// the full definition. The old <span class="info-i"> was mouse-only,
// which meant every gloss on this site was invisible to keyboard and
// assistive-technology users.
function glossaryIcon(key, opts) {
    opts = opts || {};
    var e = trackerTerm(key);
    var tip = opts.tip || termTip(key);
    if (!tip) return '';
    var name = e ? e.term : String(key);
    var id = 'gloss-' + (++trackerGlossSeq);
    return '<span class="term-wrap">'
        + '<button type="button" class="info-i" data-term="' + escapeAttr(key) + '"'
        + ' data-tip="' + escapeAttr(tip) + '"'
        + ' aria-label="' + escapeAttr(name) + ' \u2014 definition"'
        + ' aria-describedby="' + id + '" aria-expanded="false">i</button>'
        + '<span class="sr-only" id="' + id + '">' + escapeHtml(tip) + '</span>'
        + '</span>';
}

// The jargon word itself, marked with a dotted underline and glossed.
// Use where the term is the content (a metric code in a table, a tier
// badge) rather than a label needing an [i] beside it.
function glossaryTerm(key, displayText, opts) {
    opts = opts || {};
    var e = trackerTerm(key);
    var tip = opts.tip || termTip(key);
    var text = displayText != null ? displayText : (e ? e.term : String(key));
    if (!tip) return escapeHtml(text);
    var id = 'gloss-' + (++trackerGlossSeq);
    return '<span class="term-wrap">'
        + '<button type="button" class="term' + (opts.className ? ' ' + opts.className : '') + '"'
        + ' data-term="' + escapeAttr(key) + '" data-tip="' + escapeAttr(tip) + '"'
        + ' aria-describedby="' + id + '" aria-expanded="false">' + escapeHtml(text) + '</button>'
        + '<span class="sr-only" id="' + id + '">' + escapeHtml(tip) + '</span>'
        + '</span>';
}

// A definition list of chosen terms — for the "How this page measures"
// section every page needs and publications.html does not have.
function renderGlossaryList(keys, opts) {
    opts = opts || {};
    var items = keys.map(function(k) {
        var e = trackerTerm(k);
        if (!e) return '';
        return '<div class="gloss-item"><dt>' + escapeHtml(e.term) + '</dt>'
            + '<dd>' + (e.short ? '<strong>' + escapeHtml(e.short) + '</strong> ' : '')
            + escapeHtml(e.long || '')
            + (e.href ? ' <a href="' + escapeAttr(e.href) + '" target="_blank" rel="noopener">Reference ↗</a>' : '')
            + '</dd></div>';
    }).join('');
    return '<dl class="gloss-list' + (opts.className ? ' ' + opts.className : '') + '">' + items + '</dl>';
}


// ============================================================
// 4. HONEST NUMBERS — renderStat and setFigure
// ============================================================
// The convention, in one place: a headline number carries its value,
// what it counts, how firmly it is known, when it was true, and a link
// to the rows behind it. A number that cannot carry those is not
// published as a number.

var TRACKER_GRADES = {
    measured:    { label: 'Measured',    glyph: '●', key: 'grade-measured' },
    snapshot:    { label: 'Snapshot',    glyph: '◷', key: 'grade-snapshot' },
    partial:     { label: 'Partial',     glyph: '◐', key: 'grade-partial' },
    estimate:    { label: 'Estimate',    glyph: '≈', key: 'grade-estimate' },
    unverified:  { label: 'Unverified',  glyph: '?', key: 'grade-unverified' },
    unavailable: { label: 'Unavailable', glyph: '—', key: 'grade-unavailable' }
};

function formatNumber(n, opts) {
    opts = opts || {};
    if (n == null || (typeof n === 'number' && !isFinite(n))) return null;
    var v = Number(n);
    if (isNaN(v)) return null;
    if (opts.format === 'percent') return Math.round(v) + '%';
    if (opts.format === 'raw') return String(n);
    if (typeof opts.format === 'function') return opts.format(v);
    var s = (opts.decimals != null)
        ? v.toFixed(opts.decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        : Math.round(v).toLocaleString('en-AU');
    return s + (opts.unit ? ' ' + opts.unit : '');
}

var TRACKER_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// "as of 30 Aug 2026". Finding 6 on the audit was a tense problem, not
// an arithmetic one: a build-time figure was labelled "streaming now".
// Every figure gets a date, and build-time figures say "as at", so the
// present tense never attaches to a frozen number.
function formatAsOf(value, opts) {
    opts = opts || {};
    if (!value) return '';
    var d = (value instanceof Date) ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value);
    var stamp = d.getDate() + ' ' + TRACKER_MONTHS[d.getMonth()] + ' ' + d.getFullYear();
    return (opts.prefix != null ? opts.prefix : 'as of ') + stamp;
}

// Resolve the ledger verdict for a figure. Returns
// { state: 'ok'|'partial'|'failed', reason }
function figureSourceState(opts) {
    opts = opts || {};
    var ledger = opts.source;
    if (!ledger || typeof ledger.get !== 'function') return { state: 'ok', reason: '' };
    var keys = opts.sourceKey;
    if (keys == null) return { state: 'ok', reason: '' };
    if (!Array.isArray(keys)) keys = [keys];
    var broken = [], degraded = [];
    keys.forEach(function(k) {
        if (ledger.broken(k)) broken.push(ledger.get(k));
        else if (ledger.degraded(k)) degraded.push(ledger.get(k));
    });
    if (broken.length) {
        return {
            state: 'failed',
            reason: broken.map(function(s) { return s.label + ' — ' + (s.reason || 'did not answer'); }).join('; ')
        };
    }
    if (degraded.length) {
        return {
            state: 'partial',
            reason: degraded.map(function(s) {
                return s.label + ' — ' + (s.done != null && s.total != null
                    ? s.done + ' of ' + s.total + ' records loaded'
                    : 'incomplete');
            }).join('; ')
        };
    }
    return { state: 'ok', reason: '' };
}

// THE RULE, in code. A failed source produces an em dash and a reason.
// It never produces 0, and it never produces a blank. Callers that pass
// a real zero must say so with zeroIsReal:true, which is the only way a
// 0 reaches the page.
function trackerFigureHtml(value, opts) {
    opts = opts || {};
    var src = figureSourceState(opts);

    if (src.state === 'failed') return figureUnavailableHtml(src.reason);
    if (opts.unavailable) return figureUnavailableHtml(opts.unavailable);

    var text = formatNumber(value, opts);
    if (text == null) {
        return figureUnavailableHtml(opts.missingReason || 'not yet loaded');
    }
    // A zero is only printed when something vouches for it: either the
    // caller says so outright, or a wired ledger reports the source that
    // produced it healthy. An unvouched 0 is exactly the shape of the
    // nci-mt defect — "Total citations 0" during a DataCite outage — so
    // it renders as missing data instead.
    var vouched = opts.zeroIsReal === true
        || (opts.source && opts.sourceKey && src.state === 'ok');
    if (Number(value) === 0 && !vouched) {
        return figureUnavailableHtml(opts.missingReason
            || 'nothing confirmed this zero — no source vouched for it');
    }

    if (src.state === 'partial') {
        var tip = 'Incomplete: ' + src.reason + '. Read this as a floor, not a total.';
        return '<span class="fig-partial" data-tip="' + escapeAttr(tip) + '" tabindex="0"'
            + ' role="img" aria-label="' + escapeAttr(text + ' — incomplete. ' + src.reason) + '">'
            + '<span aria-hidden="true">' + escapeHtml(text)
            + '<span class="fig-partial-mark">†</span></span></span>';
    }
    return '<span class="fig-value">' + escapeHtml(text) + '</span>';
}

function figureUnavailableHtml(reason) {
    var full = 'No number available. ' + (reason || 'the source behind this figure did not answer')
        + '. This is missing data, not a zero.';
    return '<span class="fig-unavailable" data-tip="' + escapeAttr(full) + '" tabindex="0"'
        + ' role="img" aria-label="' + escapeAttr(full) + '">'
        + '<span aria-hidden="true">—</span></span>';
}

// Write a figure into an element, obeying the same rule.
//
// If a ledger is wired, the element re-paints whenever that ledger
// changes. This matters more than it looks: a page typically paints its
// tiles the moment its first feed lands and only learns that DataCite
// died several seconds later. Without the re-paint, the tile keeps the
// number it drew while everything still looked fine — which is exactly
// how a stale figure outlives the outage that invalidated it.
function setFigure(el, value, opts) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return;
    el.innerHTML = trackerFigureHtml(value, opts);
    bindLedgerRepaint(el, opts, function() {
        el.innerHTML = trackerFigureHtml(value, opts);
    });
}

function bindLedgerRepaint(el, opts, repaint) {
    el._trackerRepaint = repaint;                 // always the latest painter
    if (!opts || !opts.source || typeof opts.source.onChange !== 'function') return;
    if (el._trackerBound) return;                 // one listener per element, ever
    el._trackerBound = true;
    opts.source.onChange(function() {
        if (el._trackerRepaint) el._trackerRepaint();
    });
}

// ---------- renderStat ----------
// spec = {
//   value, label,
//   grade      'measured' | 'snapshot' | 'partial' | 'estimate'
//              | 'unverified' | 'unavailable'
//   asOf       ISO string or Date — required in spirit; its absence is
//              rendered visibly rather than silently omitted
//   href       where the rows behind the number live
//   note       the sentence that has to travel with the number
//   term       glossary key for the [i] beside the label
//   source/sourceKey   ledger wiring, so an outage cannot become a 0
//   unit, format, decimals, zeroIsReal   passed to formatNumber
//   cite       true adds a "Copy with caveat" button
// }
function renderStat(spec) {
    spec = spec || {};
    var srcState = figureSourceState(spec);
    var grade = spec.grade || 'measured';
    if (srcState.state === 'failed' || spec.unavailable) grade = 'unavailable';
    else if (srcState.state === 'partial' && grade === 'measured') grade = 'partial';
    var g = TRACKER_GRADES[grade] || TRACKER_GRADES.measured;

    var valueHtml = trackerFigureHtml(spec.value, spec);
    var inner = spec.href
        ? '<a class="stat-link" href="' + escapeAttr(spec.href) + '">' + valueHtml
          + '<span class="sr-only"> — see the records behind this number</span></a>'
        : valueHtml;

    var stamp;
    if (grade === 'unavailable') {
        stamp = srcState.reason || spec.unavailable || 'source did not answer';
    } else if (spec.asOf) {
        stamp = formatAsOf(spec.asOf, { prefix: spec.asOfPrefix });
    } else {
        // Deliberately loud. An undated number is the one that ends up in
        // a slide deck a year later.
        stamp = 'date not stamped';
    }

    var gradeTip = termTip(g.key);
    var gradeId = 'gloss-' + (++trackerGlossSeq);

    var html = '<div class="stat honest grade-' + grade + '">'
        + '<div class="label">' + escapeHtml(spec.label || '')
        + (spec.term ? glossaryIcon(spec.term) : '')
        + '</div>'
        + '<div class="value">' + inner + '</div>'
        + '<div class="grade-row">'
        + '<button type="button" class="grade-chip g-' + grade + '"'
        + ' data-tip="' + escapeAttr(gradeTip) + '" aria-describedby="' + gradeId + '" aria-expanded="false">'
        + '<span class="grade-glyph" aria-hidden="true">' + g.glyph + '</span>'
        + escapeHtml(g.label) + '</button>'
        + '<span class="sr-only" id="' + gradeId + '">' + escapeHtml(gradeTip) + '</span>'
        + '<span class="grade-sep" aria-hidden="true">·</span>'
        + '<span class="as-of' + (spec.asOf || grade === 'unavailable' ? '' : ' undated') + '">'
        + escapeHtml(stamp) + '</span>'
        + '</div>'
        + (spec.note ? '<div class="stat-note">' + escapeHtml(spec.note) + '</div>' : '')
        + (spec.cite ? '<button type="button" class="stat-cite" data-stat-cite="'
            + escapeAttr(statCitation(spec, g, stamp))
            + '">Copy with caveat</button>' : '')
        + '</div>';
    return html;
}

// renderStat returns a string, so it is a snapshot: build a row of tiles
// with it and they will not notice a source dying afterwards. Use
// renderStatInto for anything wired to a ledger — it re-paints on every
// ledger change, so a tile that was drawn as "4 · measured" becomes
// "— · unavailable" the moment its source fails.
function renderStatInto(el, spec) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return;
    el.innerHTML = renderStat(spec);
    bindLedgerRepaint(el, spec, function() { el.innerHTML = renderStat(spec); });
}

// A whole row of tiles, all live against the same ledger.
// specs = [ statSpec, … ]
function renderStatRow(el, specs) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return;
    function paint() {
        el.innerHTML = specs.map(function(s) { return renderStat(s); }).join('');
    }
    paint();
    var withSource = null;
    for (var i = 0; i < specs.length && !withSource; i++) {
        if (specs[i] && specs[i].source) withSource = specs[i];
    }
    if (withSource) bindLedgerRepaint(el, withSource, paint);
}

// The board-pack answer: when somebody copies a number off this site
// into a slide, the grade, the date, the caveat and the source link go
// with it. One click, one paste, caveat included.
function statCitation(spec, g, stamp) {
    var val = formatNumber(spec.value, spec);
    var bits = [];
    bits.push((val == null ? 'No figure available' : val) + ' ' + (spec.label || '').toLowerCase());
    bits.push('(' + g.label.toLowerCase() + ', ' + stamp + ')');
    var line = bits.join(' ') + '.';
    // `caveat` is the copy-only version: a tile can drop its visible note
    // (because the sentence above it already says the same thing) without
    // the exclusion falling out of the text someone pastes into a deck.
    var carried = spec.caveat || spec.note;
    if (carried) line += ' ' + carried;
    line += ' Source: AuScope Impact Tracker';
    if (spec.href) {
        try { line += ' — ' + new URL(spec.href, window.location.href).href; }
        catch (e) { line += ' — ' + spec.href; }
    }
    return line;
}

document.addEventListener('click', function(e) {
    var btn = e.target.closest ? e.target.closest('[data-stat-cite]') : null;
    if (!btn) return;
    copyToClipboard(btn.getAttribute('data-stat-cite') || '');
    showToast('Copied, caveat included.');
});


// ============================================================
// 5. ACCESSIBILITY
// ============================================================
// Three defects the audit found, fixed here rather than in 14 pages:
//   a) every gloss was mouse-only — [data-tip] fired on :hover alone
//   b) every sortable column was mouse-only — bare <th>, no aria-sort
//   c) no skip link on pages with several hundred focusable elements
// All three are wired from the chassis, so no page needs to change to
// get them.

// ---------- (a) tooltips reachable by keyboard and touch ----------
// CSS handles :hover and :focus-visible. This adds click-to-pin (touch
// has no hover), Escape to dismiss, and flips the tooltip to the left
// when it would otherwise run off the right edge on a narrow screen.
(function() {
    function closeAll(except) {
        var open = document.querySelectorAll('.tip-open');
        for (var i = 0; i < open.length; i++) {
            if (open[i] === except) continue;
            open[i].classList.remove('tip-open');
            if (open[i].hasAttribute('aria-expanded')) open[i].setAttribute('aria-expanded', 'false');
        }
    }

    function placeTip(elm) {
        if (!elm || !elm.getBoundingClientRect) return;
        var r = elm.getBoundingClientRect();
        var room = window.innerWidth - r.left;
        elm.classList.toggle('tip-left', room < 300);
    }

    document.addEventListener('click', function(e) {
        var t = e.target.closest ? e.target.closest('[data-tip]') : null;
        if (!t) { closeAll(null); return; }
        // Only pin on the dedicated affordances; pinning every badge that
        // happens to carry a tip would fight the pages' own row clicks.
        if (!t.classList.contains('info-i') && !t.classList.contains('term')
            && !t.classList.contains('grade-chip')) { closeAll(null); return; }
        e.preventDefault();
        e.stopPropagation();
        var wasOpen = t.classList.contains('tip-open');
        closeAll(t);
        placeTip(t);
        t.classList.toggle('tip-open', !wasOpen);
        if (t.hasAttribute('aria-expanded')) t.setAttribute('aria-expanded', String(!wasOpen));
    }, true);

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') closeAll(null);
    });

    document.addEventListener('focusin', function(e) {
        var t = e.target.closest ? e.target.closest('[data-tip]') : null;
        if (t) placeTip(t);
    });

    document.addEventListener('mouseover', function(e) {
        var t = e.target.closest ? e.target.closest('[data-tip]') : null;
        if (t) placeTip(t);
    });
})();


// ---------- (b) sortable headers that work from the keyboard ----------
// The pages bind their click handlers to the <th> itself and read the
// arrow span inside it. So rather than replacing anything, we move the
// th's existing contents into a real <button>: the button is focusable
// and fires a click on Enter and Space, that click bubbles to the th,
// and every existing page handler runs unchanged.
//
// aria-sort is then mirrored from whatever the page already does to the
// header (the .sorted class and the ▲/▼ arrow), so screen readers are
// told the sort state without any page having to announce it.

function enhanceSortableHeaders(root) {
    var scope = root || document;
    var ths = scope.querySelectorAll ? scope.querySelectorAll('th.sortable') : [];
    for (var i = 0; i < ths.length; i++) enhanceOneHeader(ths[i]);
    return ths.length;
}

function enhanceOneHeader(th) {
    if (!th || th.getAttribute('data-th-enhanced')) return;
    th.setAttribute('data-th-enhanced', '1');
    if (!th.hasAttribute('aria-sort')) th.setAttribute('aria-sort', 'none');

    // Some pages already made the th itself keyboard-operable
    // (role=button + tabindex). Nesting a button inside would create a
    // second tab stop for the same control, so leave those alone.
    var alreadyOperable = th.getAttribute('role') === 'button' || th.hasAttribute('tabindex');
    var hasControl = th.querySelector('button, a, input, select');

    if (!alreadyOperable && !hasControl) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'th-sort';
        while (th.firstChild) btn.appendChild(th.firstChild);
        th.appendChild(btn);
    }
    mirrorAriaSort(th);
    observeHeader(th);
}

function mirrorAriaSort(th) {
    var arrow = th.querySelector('.arrow');
    // Without an arrow there is nothing to read the direction from, and
    // the page may be managing aria-sort itself. Don't guess.
    if (!arrow) return;
    var sorted = th.classList.contains('sorted');
    var glyph = (arrow.textContent || '').trim();
    var value;
    if (glyph.indexOf('▼') >= 0) value = 'descending';       // ▼
    else if (glyph.indexOf('▲') >= 0) value = 'ascending';   // ▲
    else if (!sorted) value = 'none';
    // Sorted, but the arrow gives no direction: dataset-registry.html
    // marks .sorted and sets aria-sort itself without ever writing an
    // arrow glyph. Writing a guess here would overwrite the page's own
    // correct value with a vaguer one, so leave it alone.
    else return;
    if (th.getAttribute('aria-sort') !== value) th.setAttribute('aria-sort', value);
}

function observeHeader(th) {
    if (typeof MutationObserver === 'undefined') return;
    if (th._sortObserver) return;
    var obs = new MutationObserver(function() { mirrorAriaSort(th); });
    obs.observe(th, { attributes: true, attributeFilter: ['class'], subtree: true, characterData: true, childList: true });
    th._sortObserver = obs;
}

// For pages that build a <thead> after load, or that want to set the
// state explicitly rather than have it inferred from the arrow.
function setSortState(scopeOrTable, key, dir) {
    var scope = typeof scopeOrTable === 'string'
        ? document.querySelector(scopeOrTable) : (scopeOrTable || document);
    if (!scope) return;
    var ths = scope.querySelectorAll('th.sortable');
    for (var i = 0; i < ths.length; i++) {
        var isActive = ths[i].getAttribute('data-sort') === key;
        ths[i].setAttribute('aria-sort', isActive
            ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
    }
}


// ---------- (c) skip link ----------
// nci-mt.html carries close to 500 focusable elements. Without a skip
// link, reaching the table by keyboard means tabbing through the header,
// the site tabs, the controls and the fleet panel every single time.
function injectSkipLink() {
    if (document.querySelector('.skip-link')) return;
    if (document.body.getAttribute('data-site-tab') === null) return;  // widgets and map embeds opt out
    var target = document.querySelector('main, #main, .table-wrap, .wrap');
    if (!target) return;
    if (!target.id) target.id = 'tracker-main';
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    var a = document.createElement('a');
    a.className = 'skip-link';
    a.href = '#' + target.id;
    a.textContent = 'Skip to main content';
    document.body.insertBefore(a, document.body.firstChild);
}


// ---------- chassis a11y boot ----------
(function() {
    function boot() {
        try { injectSkipLink(); } catch (e) {}
        try { enhanceSortableHeaders(document); } catch (e) {}
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
