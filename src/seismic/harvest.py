"""Harvest AusPASS StationXML (channel level) for every network."""
import os, re, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

# Paths: the scripts live in src/seismic/, their data in data/seismic/.
# SEISMIC_DATA_DIR overrides (used by CI and for dry runs).
_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.environ.get('SEISMIC_DATA_DIR') or os.path.join(_REPO, 'data', 'seismic')
os.makedirs(DATA, exist_ok=True)
OUT = os.path.join(DATA, 'xml')
os.makedirs(OUT, exist_ok=True)
BASE = "https://auspass.edu.au/fdsnws/station/1/query"

def fetch(url, timeout=300):
    req = urllib.request.Request(url, headers={'User-Agent': 'AuScope-PIDINST-audit/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as f:
        return f.read()

nets_xml = fetch(f"{BASE}?level=network&format=xml").decode('utf-8', 'replace')
codes = sorted(set(re.findall(r'<Network code="([^"]+)"', nets_xml)))
print(f"{len(codes)} distinct network codes", flush=True)

def grab(code):
    path = os.path.join(OUT, f"{code}.xml")
    if os.path.exists(path) and os.path.getsize(path) > 200:
        return (code, os.path.getsize(path), 'cached')
    for attempt in range(3):
        try:
            data = fetch(f"{BASE}?net={code}&level=channel&format=xml")
            with open(path, 'wb') as f:
                f.write(data)
            return (code, len(data), 'ok')
        except Exception as e:
            if attempt == 2:
                return (code, 0, f'FAIL {type(e).__name__}: {e}')
            time.sleep(3 * (attempt + 1))

with ThreadPoolExecutor(5) as ex:
    results = list(ex.map(grab, codes))

ok = [r for r in results if r[2] in ('ok', 'cached')]
bad = [r for r in results if r not in ok]
print(f"fetched {len(ok)}/{len(codes)}; total {sum(r[1] for r in ok)/1e6:.1f} MB")
for r in bad:
    print("  FAILED:", r)
