"""Parse harvested StationXML into deployment + instrument records."""
import os, re, json, glob
import xml.etree.ElementTree as ET

# Paths: the scripts live in src/seismic/, their data in data/seismic/.
# SEISMIC_DATA_DIR overrides (used by CI and for dry runs).
_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.environ.get('SEISMIC_DATA_DIR') or os.path.join(_REPO, 'data', 'seismic')
os.makedirs(DATA, exist_ok=True)
HERE = DATA
NS = {'s': 'http://www.fdsn.org/xml/station/1'}

def txt(el, path):
    if el is None: return None
    f = el.find(path, NS)
    return f.text.strip() if f is not None and f.text else None

def equip(el, tag):
    e = el.find(f's:{tag}', NS)
    if e is None: return {}
    return {k: txt(e, f's:{k}') for k in
            ('Type','Description','Manufacturer','Vendor','Model','SerialNumber',
             'InstallationDate','RemovalDate','CalibrationDate')}

deployments = []   # one row per channel epoch
networks = {}

for path in sorted(glob.glob(os.path.join(HERE, 'xml', '*.xml'))):
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as e:
        print(f"PARSE FAIL {os.path.basename(path)}: {e}"); continue
    for net in root.findall('s:Network', NS):
        ncode = net.get('code')
        comments = [c.text.strip() for c in net.findall('s:Comment/s:Value', NS) if c.text]
        doi = None
        for c in comments:
            m = re.search(r'10\.\d{4,9}/[^\s,;]+', c)
            if m: doi = m.group(0).rstrip('.')
        key = (ncode, net.get('startDate'))
        networks.setdefault(key, {
            'network': ncode,
            'net_start': net.get('startDate'),
            'net_end': net.get('endDate'),
            'description': txt(net, 's:Description'),
            'doi': doi,
            'comments': comments,
            'operator': txt(net, 's:Operator/s:Agency'),
            'restricted': net.get('restrictedStatus'),
        })
        for sta in net.findall('s:Station', NS):
            scode = sta.get('code')
            site = txt(sta, 's:Site/s:Name')
            country = txt(sta, 's:Site/s:Country')
            lat, lon, elev = txt(sta,'s:Latitude'), txt(sta,'s:Longitude'), txt(sta,'s:Elevation')
            for ch in sta.findall('s:Channel', NS):
                sen, dl = equip(ch, 'Sensor'), equip(ch, 'DataLogger')
                deployments.append({
                    'network': ncode, 'net_desc': networks[key]['description'], 'net_doi': doi,
                    'station': scode, 'site': site, 'country': country,
                    'lat': lat, 'lon': lon, 'elev': elev,
                    'channel': ch.get('code'), 'loc': ch.get('locationCode'),
                    'ch_start': ch.get('startDate'), 'ch_end': ch.get('endDate'),
                    'sta_start': sta.get('startDate'), 'sta_end': sta.get('endDate'),
                    'sample_rate': txt(ch, 's:SampleRate'),
                    'sensor': sen, 'datalogger': dl,
                })

with open(os.path.join(HERE,'deployments.jsonl'),'w') as f:
    for d in deployments: f.write(json.dumps(d)+'\n')
with open(os.path.join(HERE,'networks.json'),'w') as f:
    json.dump(list(networks.values()), f, indent=1)

print(f"networks (code+epoch): {len(networks)}")
print(f"channel-epoch rows   : {len(deployments)}")
sser = {d['sensor'].get('SerialNumber') for d in deployments if d['sensor'].get('SerialNumber')}
dser = {d['datalogger'].get('SerialNumber') for d in deployments if d['datalogger'].get('SerialNumber')}
print(f"unique sensor serials     : {len(sser)}")
print(f"unique datalogger serials : {len(dser)}")
print(f"rows with NO sensor serial: {sum(1 for d in deployments if not d['sensor'].get('SerialNumber'))}")
smod = {d['sensor'].get('Model') for d in deployments if d['sensor'].get('Model')}
print(f"unique sensor models      : {len(smod)}")
print(f"Manufacturer populated    : {sum(1 for d in deployments if d['sensor'].get('Manufacturer'))}")
