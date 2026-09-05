"""Capture funding evidence for AusPASS network epochs. EVIDENCE ONLY.

Two sources say who funded an EXPERIMENT:
  1. FDSN metadata already harvested into networks_digest.json (description +
     comments) — epoch-precise, covers all 89 network-epochs.
  2. The AusPASS network pages (https://auspass.edu.au/networks/<slug>.html),
     which carry an explicit "Funding sources" field. Only ~12 experiments
     have a page, so this source is partial.

This is DELIBERATELY not wired into attribution. "AuScope funded this
experiment" is a claim about DEPLOYMENT SUPPORT; the AUSCOPE_NETS roster in
build_candidates.py asserts something different and stronger — that the
experiment used AuScope INSTRUMENTS. An AuScope-funded campaign can run ANU or
ARC-purchased kit. Folding the two together would restate hundreds of units'
provenance on evidence that never mentioned instruments, so the funding
evidence is captured here, carried on each unit as `network_funding`, and left
for a deliberate decision about the tier model.

Network codes are REUSED across epochs (1H is EAL2 in 2010 and Mundi Mundi in
2024), so page evidence is resolved to specific epochs by matching the
experiment name in the digest description — never to the bare code.

Usage: python3 src/seismic/network_funding.py     (pages cached after first run)
"""
import os, re, json, html, time, urllib.request

_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.environ.get('SEISMIC_DATA_DIR') or os.path.join(_REPO, 'data', 'seismic')
PAGES = os.path.join(DATA, 'auspass_pages')
OUT = os.path.join(DATA, 'network_funding.json')
BASE = 'https://auspass.edu.au/networks/'

# page slug -> regex matching the experiment name in the FDSN description.
# Explicit rather than fuzzy: a wrong match would attach one experiment's
# funding to another's instruments.
PAGE_EXPERIMENTS = {
    'aqt':            r'^AQT\b',
    'ausis':          r'AUSiS|Seismometers in Schools',
    'bass':           r'^BASS\b',
    'bilby':          r'^BILBY\b',
    'capral':         r'^CAPRAL\b',
    'curnamona':      r'^CURNAMONA$',          # the 2009 experiment, NOT Curnamona Cube (3X)
    'eal':            r'^EAL[123]\b',
    'kimba':          r'^KIMBA9[78]\b',
    'macquarieridge': r'Macquarie Ridge',
    'skippy':         r'^SKIPPY\b',
    'soc':            r'^SOC\b',
    'wacraton':       r'West Australian Cratons',
}
FUNDERS = [('AuScope', r'auscope'), ('ANSIR', r'\bansir\b'), ('NCRIS', r'\bncris\b'),
           ('ARC', r'\barc\b|australian research council'), ('ANU', r'\banu\b|research school of earth sciences')]


def fetch_page(slug):
    path = os.path.join(PAGES, slug + '.html')
    if os.path.exists(path) and os.path.getsize(path) > 500:
        return open(path, encoding='utf-8', errors='replace').read()
    req = urllib.request.Request(BASE + slug + '.html', headers={'User-Agent': 'AuScope-impact-tracker/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=30) as f:
            body = f.read().decode('utf-8', 'replace')
    except Exception as e:
        print('  ' + slug + ': fetch failed (' + str(e) + ')')
        return None
    os.makedirs(PAGES, exist_ok=True)
    open(path, 'w', encoding='utf-8').write(body)
    time.sleep(0.7)
    return body


def plain(t):
    t = re.sub(r'<script.*?</script>|<style.*?</style>', '', t, flags=re.S)
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', t)))


def funders_in(text):
    return [name for name, pat in FUNDERS if re.search(pat, text or '', re.I)]


def run():
    digest = json.load(open(os.path.join(DATA, 'networks_digest.json')))
    epochs = digest if isinstance(digest, list) else list(digest.values())
    records = []

    # ── source 1: FDSN metadata, epoch-precise ──
    for n in epochs:
        blob = ' '.join(str(n.get(k) or '') for k in ('description', 'comments'))
        f = funders_in(blob)
        if not f:
            continue
        snip = re.search(r'.{0,80}(auscope|ansir|ncris).{0,120}', blob, re.I)
        records.append({
            'network': n.get('network'), 'epoch_start': (n.get('net_start') or '')[:10],
            'epoch_end': (n.get('net_end') or '')[:10] or None,
            'description': n.get('description'), 'funders': f,
            'source': 'fdsn-metadata', 'evidence': (snip.group(0).strip()[:220] if snip else None),
        })

    # ── source 2: AusPASS network pages, resolved to epochs by experiment name ──
    print('AusPASS network pages:')
    for slug, pat in sorted(PAGE_EXPERIMENTS.items()):
        body = fetch_page(slug)
        if not body:
            continue
        txt = plain(body)
        m = re.search(r'Funding sources\s*:?\s*([^.]{0,160}?)\s*(?:Access data|Read more|$)', txt, re.I)
        raw = m.group(1).strip() if m else None
        f = funders_in(raw or '')
        matched = [n for n in epochs if re.search(pat, n.get('description') or '', re.I)]
        print('  ' + slug.ljust(16) + (raw or '(no funding field)')[:44].ljust(46)
              + '-> ' + (', '.join(sorted({str(n.get('network')) + ' ' + (n.get('net_start') or '')[:4] for n in matched})) or 'NO EPOCH MATCH'))
        if not raw or not matched:
            continue
        for n in matched:
            records.append({
                'network': n.get('network'), 'epoch_start': (n.get('net_start') or '')[:10],
                'epoch_end': (n.get('net_end') or '')[:10] or None,
                'description': n.get('description'), 'funders': f,
                'source': 'auspass-page', 'evidence': raw[:220],
                'url': BASE + slug + '.html',
            })

    out = {
        'metadata': {
            'type': 'network-funding-evidence',
            'note': 'Funding of the EXPERIMENT. Not evidence of instrument ownership; '
                    'deliberately not wired into attribution tiers.',
            'sources': ['fdsn-metadata (all 89 network-epochs)',
                        'auspass-page (only ~12 experiments have a page)'],
            'epochs_with_evidence': len({(r['network'], r['epoch_start']) for r in records}),
            'auscope_epochs': len({(r['network'], r['epoch_start']) for r in records if 'AuScope' in r['funders']}),
        },
        'records': sorted(records, key=lambda r: (str(r['network']), str(r['epoch_start']))),
    }
    json.dump(out, open(OUT, 'w'), indent=1)
    print('\n' + str(len(records)) + ' evidence records over '
          + str(out['metadata']['epochs_with_evidence']) + ' network-epochs ('
          + str(out['metadata']['auscope_epochs']) + ' naming AuScope) -> ' + OUT)


run()
