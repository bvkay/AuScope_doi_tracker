import json, re, collections, csv, os
# Paths resolve relative to this script so the folder is self-contained.
# Paths: the scripts live in src/seismic/, their data in data/seismic/.
# SEISMIC_DATA_DIR overrides (used by CI and for dry runs).
_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.environ.get('SEISMIC_DATA_DIR') or os.path.join(_REPO, 'data', 'seismic')
os.makedirs(DATA, exist_ok=True)
H=DATA
OUTDIR=DATA
rows=[json.loads(l) for l in open(os.path.join(H,'deployments.jsonl'))]
links=json.load(open(os.path.join(H,'ansir_network_links.json')))
# Network funding evidence (src/seismic/network_funding.py). EVIDENCE ONLY —
# it is attached to units for context and NEVER consulted when assigning a
# tier: "AuScope funded this experiment" is a claim about deployment support,
# not about who owned the instrument. See METHODOLOGY.md.
FUNDING={}
try:
    _fj=json.load(open(os.path.join(H,'network_funding.json')))
    for _r in _fj.get('records',[]):
        FUNDING.setdefault(_r['network'],[]).append(_r)
except Exception as _e:
    print('network funding evidence unavailable (%s) - continuing without it' % _e)

def funding_for(deps):
    """Funding records whose network epoch overlaps a deployment of this unit.
    Matched per epoch, never per bare code: 1H is EAL2 (2010) and Mundi Mundi
    (2024) and they were funded differently."""
    out={}
    for (net,_sta,st,en) in deps:
        for r in FUNDING.get(net,[]):
            rs,re_=r.get('epoch_start') or '', r.get('epoch_end') or '9999-12-31'
            if st and rs and not (st <= re_ and (en or '9999-12-31') >= rs): continue
            k=(net,r.get('epoch_start'),r.get('source'))
            out[k]={'net':net,'epoch':r.get('epoch_start'),'funders':r.get('funders',[]),
                    'source':r.get('source'),'experiment':r.get('description')}
    return sorted(out.values(), key=lambda x:(x['net'],x['epoch'] or ''))
# Network codes are reused across unrelated experiments (1G is GAWLER 2008,
# Banda Arc 2019 and Lake George 2020; 1H is EAL2 2010 and Mundi Mundi 2024),
# so the roster cannot be a bare code: it is the code AND the epoch of the
# experiment the operator confirmed. AUSCOPE_EPOCHS declares, per code, the
# net_start of each epoch that IS the AuScope experiment, and a deployment
# only counts if its station epoch overlaps one of them — the same test
# funding_for() applies. Before this, 41 units deployed in 2008-2010 carried
# the basis 'AuScope experiment: LAKE GEORGE' for an experiment run in 2020.
_ND=json.load(open(os.path.join(H,'networks_digest.json')))
NET_EPOCHS=collections.defaultdict(list)   # code -> [(net_start, net_end)]
for _e in _ND:
    if _e.get('net_start'):
        NET_EPOCHS[_e['network']].append((_e['net_start'][:10], (_e.get('net_end') or '9999-12-31')[:10]))
AUSCOPE_EPOCHS={
 'ZJ':['2025-11-19'], 'M8':['2024-01-09'], '2B':['2023-02-23','2026-05-20'], '4K':['2024-09-24'],
 '1H':['2024-06-17'], '2E':['2023-09-05'], 'X5':['2023-04-25'], '4B':['2023-03-26'],
 '1G':['2020-12-10'], '7A':['2024-07-02'], '4Z':['2021-12-16'], '6Y':['2022-10-06'],
 '3X':['2022-06-14'], '6D':['2022-04-02'], '2X':['2022-02-09'], '6K':['2020-10-14'],
 '5G':['2018-10-16'], '3G':['2018-04-21'], '5J':['2017-04-23'], 'Y7':['2025-10-09'],
 '9B':['2020-08-31'], '9M':['2023-11-21'], '8A':['2024-08-30'], 'YB':['2026-03-11'],
}
def auscope_epoch(net, st, en):
    """True if a station epoch [st, en] overlaps a declared AuScope epoch of
    this network. A deployment with no start date cannot be tested and is
    accepted on the bare code, as funding_for() does; it is counted so the
    run log shows how much rests on that fallback."""
    if net not in AUSCOPE_EPOCHS: return False
    if not st:
        _UNTESTED[net]+=1; return True
    en=en or '9999-12-31'
    for (rs,re_) in NET_EPOCHS.get(net,[]):
        if rs[:10] in AUSCOPE_EPOCHS[net] and st<=re_ and en>=rs: return True
    return False
_UNTESTED=collections.Counter()
AUSCOPE_NETS={'ZJ':'SAMWISE','M8':'MATE','2B':'DASH/SISSLE','4K':'FISSLE','1H':'MUNDI MUNDI',
              '2E':'WETA','X5':'AHNA','4B':'SNAKEY','1G':'LAKE GEORGE','7A':'QSTNQ','4Z':'ALiRT','6Y':'SOSA','3X':'CURNAMONA CUBE','6D':'WESTERN GAWLER ADI','2X':'VULCAN ADI','6K':'AusArray SA','5G':'LAKE EYRE BASIN','3G':'MARLA','5J':'ASR','Y7':'OKSN','9B':'MT STROMLO','9M':'EYRE PENINSULA','8A':'BMNTE','YB':'YB'}
# Station-level AuScope funding. Attribution is normally network-level, but
# funding does not always arrive at network granularity: AuSIS (S1) is a
# GSWA-era schools network that is NOT an AuScope experiment, yet two of its
# sites were established with AuScope funding in June 2026. Without this the
# instruments at those sites fall to 'unattributed' — the network roster has
# no way to say "these stations, not that network".
assert set(AUSCOPE_EPOCHS)==set(AUSCOPE_NETS), 'roster and epoch table disagree'
for _c,_starts in AUSCOPE_EPOCHS.items():
    _have={rs for rs,_ in NET_EPOCHS.get(_c,[])}
    assert set(_starts)<=_have, f'{_c}: declared AuScope epoch {_starts} not in digest {sorted(_have)}'
AUSCOPE_STATIONS={
 ('S1','AUOKV'):'AuSIS Oak Valley Anangu School (AuScope-funded site, 2026)',
 ('S1','AUYLT'):'AuSIS Yalata Anangu School (AuScope-funded site, 2026)',
}
ANU_BUILT=re.compile(r'\bANU\b|ANUSR|TerraSAWR|LPR-200',re.I)
BUILTIN=re.compile(r'\(built-in\)',re.I)
# A shared sensor/datalogger serial only means ONE device if the sensor is genuinely an
# integrated sensor+digitiser product. Passive seismometers (Lennartz LE-3Dlite, Trillium,
# CMG-40T ...) have no digitiser, so a shared serial there is a metadata authoring error —
# network 1G copies its ANU Generation 1 recorder serial into the Lennartz sensor field on
# all 105 rows, which previously deleted all 35 of those recorders from the output.
INTEGRATED=re.compile(r'smartsolo|dt-?solo|igu-|cmg-?6td|certimus|certis|meridian|posthole.*compact.*digiti',re.I)
JUNK=re.compile(r'^(0+|9+|n/?a|none|null|unknown|tbd|x+|sp|bb|gp|-+|\?+|\d|123|1234)$',re.I)
SHORT2FULL={}
RECONSTRUCTED=set()
def _build_short_map():
    """Resolve SmartSolo serials truncated to their last 4 digits (networks 1G, 4Z, 9B).

    Three passes, strongest evidence first:
      1. family match  - candidate full serials must share the model family, keyed on
                         sensitivity (16HR-3C = 76.6 V/m/s, BD3C-5 = 209.4 V/m/s), so the
                         '5hz 76.6 V/m/s' spelling used only by 9B folds into 16HR-3C.
      2. temporal      - a physical node cannot be in two networks at once; drop candidates
                         whose deployment epochs overlap the short serial's.
      3. serial block  - nodes are purchased and deployed in lots. Every one of the 164
                         already-resolved short serials in 1G/4Z/9B falls in the 45300 block,
                         so remaining ties resolve to that block.
    Serials with no matching full serial anywhere are left short and unmerged.
    """
    def fam(m):
        k=(m or '').lower()
        if '209.4' in k or 'bd3c' in k: return 'BD3C-5'
        if '16hr-1c' in k.replace(' ',''): return '16HR-1C'
        if '76.6' in k or '16hr' in k.replace(' ','') or '5hz' in k.replace(' ',''): return '16HR-3C'
        return 'unknown'
    SS=re.compile(r'smartsolo|dt-?solo',re.I)
    short=collections.defaultdict(lambda:{'fams':set(),'epochs':[],'nets':set()})
    full=collections.defaultdict(lambda:{'fams':set(),'epochs':[]})
    for d in rows:
        for role in ('sensor','datalogger'):
            e=d[role]; m=e.get('Model') or ''
            if not SS.search(m): continue
            sn=(e.get('SerialNumber') or '').strip().lstrip('#')
            if not sn.isdigit(): continue
            tgt = short if len(sn)<=4 else (full if len(sn)>=8 else None)
            if tgt is None: continue
            r=tgt[sn]; r['fams'].add(fam(m))
            if 'nets' in r: r['nets'].add(d['network'])
            if d['sta_start']: r['epochs'].append((d['sta_start'][:10],(d['sta_end'] or '2099-01-01')[:10],d['network']))
    def clash(a,b):
        for s1,e1,n1 in a:
            for s2,e2,n2 in b:
                if n1!=n2 and s1<e2 and s2<e1: return True
        return False
    pending={}
    for sn,r in short.items():
        tail=sn.zfill(4)
        c=[f for f,fr in full.items() if f.endswith(tail) and (r['fams'] & fr['fams'] or not r['fams'])]
        if not c: continue
        if len(c)==1: SHORT2FULL[sn]=c[0]; continue
        keep=[x for x in c if not clash(r['epochs'], full[x]['epochs'])]
        if len(keep)==1: SHORT2FULL[sn]=keep[0]
        elif keep: pending[sn]=(keep, r['nets'])
    if pending:
        prior=collections.defaultdict(collections.Counter)
        for sn,f in SHORT2FULL.items():
            for n in short[sn]['nets']: prior[n][f[:5]]+=1
        for sn,(cands,nets) in pending.items():
            p=collections.Counter()
            for n in nets: p.update(prior.get(n,{}))
            if not p: continue
            best=p.most_common(1)[0][0]
            pick=[x for x in cands if x[:5]==best]
            if len(pick)==1: SHORT2FULL[sn]=pick[0]
    # Final pass: a short serial with NO full-serial candidate anywhere, but which falls
    # inside the observed range of its network's dominant serial block and is bracketed by
    # resolved neighbours, is reconstructed as <block><tail>. Flagged in serial_reconstructed.
    dom=collections.Counter(f[:5] for f in SHORT2FULL.values())
    if dom:
        blk=dom.most_common(1)[0][0]
        known=sorted(int(f) for f in SHORT2FULL.values() if f.startswith(blk))
        lo,hi=(known[0],known[-1]) if known else (None,None)
        for sn,r in short.items():
            if sn in SHORT2FULL: continue
            cand=int(blk+sn.zfill(4))
            if lo is not None and lo<=cand<=hi:
                SHORT2FULL[sn]=str(cand); RECONSTRUCTED.add(str(cand))

def nser(sn):
    sn=(sn or '').strip().lstrip('#')
    sn = sn[:-2] if re.fullmatch(r'\d+\.0',sn) else sn
    return SHORT2FULL.get(sn, sn)
MFR=[(r'smartsolo|dtcc|dt-?solo|igu-','DTCC (SmartSolo)'),(r'lennartz|le-?3d','Lennartz Electronic'),
 (r'nanometrics|trillium|centaur|orion|taurus|meridian','Nanometrics'),
 (r'guralp|cmg-|minimus|certimus|certis','Guralp Systems'),(r'sercel|l-4c|l-4a|l-28','Sercel'),
 (r'silicon.?audio|silicone audio','Silicon Audio'),(r'\banu|anusr|terrasawr|lpr-200','Australian National University'),
 (r'willmore|sensonics','Sensonics (Willmore)'),(r'reftek|ref ?tek|wrangler|colt','REF TEK / Trimble'),
 (r'kinemetrics|episensor','Kinemetrics'),(r'gaiacode|theta','GaiaCode'),
 (r'streckeisen|sts-?[12]','Streckeisen'),(r'src |gecko','Seismology Research Centre'),
 (r'silixa|idas','Silixa (DAS)'),(r'earth ?data','Earth Data')]
def mfr(m,d=''):
    b=f"{m or ''} {d or ''}".lower()
    for p,n in MFR:
        if re.search(p,b): return n
    return 'UNRESOLVED'
CANON=[(re.compile(r'^dtcc[/ ]?smartsolo',re.I),'DTCC SmartSolo'),
 (re.compile(r'dt-?solo',re.I),'SmartSolo'),
 (re.compile(r'^(lennartz )?le-?3d ?lite ?mk ?ii$',re.I),'Lennartz LE-3Dlite MkII'),
 (re.compile(r'silicone audio',re.I),'Silicon Audio'),
 (re.compile(r'^anu terrasawr.*',re.I),'ANU TerraSAWR'),
 (re.compile(r'^anu lpr-200.*',re.I),'ANU LPR-200'),
 (re.compile(r'^(anusr|anu v3|anu generation|anu seismic recorder).*',re.I),'ANU Seismic Recorder (ANUSR)'),
 (re.compile(r'^nanometrics trillium (compact ?post ?hole|120s ?posthole|compact 120s posthole).*',re.I),'Nanometrics Trillium Compact PostHole 120s'),
 (re.compile(r'^nanometrics trillium ?compact ?120s?$',re.I),'Nanometrics Trillium Compact 120s'),
 (re.compile(r'^guralp minimus$',re.I),'Guralp MINIMUS')]
def canon_smartsolo(m):
    """All SmartSolo spellings -> the actual product model.

    DTCC ship three variants here, distinguished by sensitivity, not by the
    free-text name: 16HR-3C and 16HR-1C are 76.6 V/m/s 5 Hz geophone nodes,
    BD3C-5 is 209.4 V/m/s. Network 9B writes '5hz 76.6 V/m/s' with no model
    number at all; by sensitivity that is a 16HR-3C.
    """
    k=(m or '').lower(); flat=k.replace(' ','').replace('-','')
    if '209.4' in k or 'bd3c' in flat: return 'DTCC SmartSolo BD3C-5'
    if '16hr1c' in flat: return 'DTCC SmartSolo 16HR-1C'
    return 'DTCC SmartSolo 16HR-3C'

def canon(m):
    if not m: return None
    if re.search(r'smartsolo|dt-?solo', m, re.I): return canon_smartsolo(m)
    k=re.sub(r'\s*\([^)]*[Vv]/?m/?s[^)]*\)','',m); k=re.sub(r'\s+',' ',k).strip()
    for rx,rep in CANON: k=rx.sub(rep,k)
    k=re.sub(r'^(Nanometrics )+','Nanometrics ',k)
    return re.sub(r'\b(SmartSolo)( \1)+\b','SmartSolo',k)
KITMAP=[(r'IGU-16HR','smartsolo16hr'),(r'IGU-BD','smartsolobd'),(r'LPR-?200','lpr200'),
 (r'TerraSAWR','terrasawr'),(r'LE-?3D ?Lite|3D-Lite|Lennart','le3dlite'),(r'Trillium','trillium'),
 (r'CMG-6T','cmg6t'),(r'CMG-3ESP','cmg3esp'),(r'Silixa|iDAS','idas'),(r'Centaur','centaur')]
def kit_match(net,model):
    L=links.get(net)
    if not L: return False
    kit=L.get('kit') or ''; m=(model or '').lower().replace(' ','').replace('-','')
    for pat,tok in KITMAP:
        if re.search(pat,kit,re.I) and tok in m: return True
    return False

_build_short_map()
print(f"short->full node serial merges: {len(SHORT2FULL)}")
print("roster deployments accepted without a station date (untestable): %s" % dict(_UNTESTED))

U=collections.defaultdict(lambda:{'built':False,'kit':set(),'ansir':set(),'auscope':set(),
  'nets':set(),'stations':set(),'starts':[],'ends':[],'open':False,'models':set(),'ctry':set(),
  'roles':set(),'integrated':False,'dois':set(),'deps':{},'sites':set()})
for d in rows:
    ssn=nser(d['sensor'].get('SerialNumber')); dsn=nser(d['datalogger'].get('SerialNumber'))
    integrated=bool(ssn) and ssn==dsn
    for role in ('sensor','datalogger'):
        e=d[role]; sn=nser(e.get('SerialNumber'))
        if not sn or JUNK.match(sn): continue
        if role=='datalogger' and (integrated or BUILTIN.search(e.get('Model') or '')): continue
        u=U[(mfr(e.get('Model'),e.get('Description')), canon(e.get('Model')), sn)]
        u['roles'].add(role); u['integrated']=u['integrated'] or (role=='sensor' and integrated)
        u['nets'].add(d['network']); u['stations'].add(f"{d['network']}.{d['station']}")
        # station-epoch detail for the register page: channels repeat per
        # component, so key on the epoch and keep one row per occupancy.
        _k=(d['network'],d['station'],(d.get('sta_start') or '')[:10],(d.get('sta_end') or '')[:10])
        u['deps'][_k]={'net':d['network'],'station':d['station'],'site':d.get('site') or '',
          'start':_k[2] or None,'end':_k[3] or None,'role':role,
          'lat':float(d['lat']) if d.get('lat') not in (None,'') else None,
          'lon':float(d['lon']) if d.get('lon') not in (None,'') else None,
          'country':d.get('country') or None}
        if e.get('Model'): u['models'].add(e['Model'])
        if d['country']: u['ctry'].add(d['country'])
        if d['net_doi']: u['dois'].add(d['net_doi'])
        if d['sta_start']: u['starts'].append(d['sta_start'][:10])
        if d['sta_end']: u['ends'].append(d['sta_end'][:10])
        else: u['open']=True
        if ANU_BUILT.search(e.get('Model') or ''): u['built']=True
        if auscope_epoch(d['network'],(d.get('sta_start') or '')[:10],(d.get('sta_end') or '')[:10]): u['auscope'].add(d['network'])
        if (d['network'],d['station']) in AUSCOPE_STATIONS:
            u['sites'].add(AUSCOPE_STATIONS[(d['network'],d['station'])])
        if d['network'] in links:
            u['ansir'].add(d['network'])
            if kit_match(d['network'],e.get('Model')): u['kit'].add(d['network'])


# ── Instrument class ───────────────────────────────────────────────────────
# Ordered rules over the canonical model string. StationXML's own <Type> field
# is unusable for this: across the archive it variously holds a class code
# (BB/SP/GP/SM), the model string repeated, or the manufacturer name.
# Nodal instruments are integrated sensor+digitiser boxes and are counted as
# ONE device, so they are their own class rather than being split across
# sensor and datalogger. Anything unmatched is reported as 'unclassified' and
# listed on stderr — never guessed into a class.
CLASS_RULES = [
    # nodal (integrated node: one physical box, sensor + digitiser)
    ('nodal-broadband',  r'smartsolo.*bd3c|bd3c-5'),
    ('nodal-short-period', r'smartsolo|dt-?solo|16hr-'),
    # dataloggers / digitisers / recorders
    ('datalogger',       r'lpr-200|anusr|anu seismic recorder|terrasawr|centaur|orion|hrd-24|'
                         r'pegasus|taurus|pr6-24|earthdata|reftek|ref ?tek|wrangler|rt ?-?7\d|'
                         r'reftek130|q330|minimus|cmg[\s-]*6td|cd24|gecko|50hz logger'),
    # strong motion
    ('accelerometer',    r'titan|accelerometer|rt147'),
    # hydrophone
    ('hydrophone',       r'hydrophone|hti-'),
    # broadband seismometers (period >= ~20 s)
    ('broadband',        r'trillium|sts-?[26]|streckeisen|cmg[\s-]*3|cmg[\s-]*40t|cmg[\s-]*6t|certimus|'
                         r'certis|meridian|silicon ?audio|213p|colt\d|ks-54000'),
    # short-period seismometers (~1-4.5 Hz)
    ('short-period',     r'le-3d|lennartz|l-4c|l-4a|l-28|willmore|sensonics'),
]
def iclass(model, role, integrated):
    m = (model or '').lower()
    # Nodes first: an integrated node is one box and belongs to neither the
    # sensor nor the datalogger axis.
    for name, pat in CLASS_RULES[:2]:
        if re.search(pat, m): return name
    # ROLE beats the model string for the sensor/datalogger axis. It records
    # which StationXML element the serial came from, so it is direct evidence,
    # where the model string is ambiguous: 'Nanometrics Meridian' is the
    # digitiser while 'Nanometrics Meridian Compact Posthole 120s' is the
    # sensor, and a model regex cannot reliably tell them apart.
    if role == 'datalogger':
        return 'datalogger'
    for name, pat in CLASS_RULES[2:]:
        if name == 'datalogger': continue
        if re.search(pat, m): return name
    return 'unclassified'

# ── Serial spelling variants: one device written two ways ──────────────────
# Network conventions differ — 1K/8J/9X write LPR-200 serial '047' where 6Y
# writes '47'; 'A-012' vs 'A012' likewise. nser() cannot catch this because it
# normalises each serial in isolation and never compares units to each other.
# Merge variants ONLY where the deployment epochs do not overlap: a physical
# device cannot be in two places at once. That is the same temporal-exclusion
# test that resolved the truncated SmartSolo serials, and it matters — the
# GaiaCode Theta pairs TT-1122/TT1122 and TT-1124/TT1124 DO overlap, so they
# are genuinely two devices and are deliberately left separate.
def _loose(sn):
    return re.sub(r'^0+(?=\d)', '', re.sub(r'[^A-Za-z0-9]', '', sn or '').upper())

def _epochs(u):
    return [(st, en or '2100-01-01') for (_n, _s, st, en) in u['deps'].keys() if st]

def _overlaps(a, b):
    return any(s1 < e2 and s2 < e1 for s1, e1 in a for s2, e2 in b)

_groups = collections.defaultdict(list)
for _k in list(U.keys()):
    _groups[(_k[0], _k[1], _loose(_k[2]))].append(_k)

MERGED_INTO = {}      # surviving key -> set of absorbed spellings
CONFLICTS = []        # (key, key) pairs that overlap in time: NOT the same device
for _gk, _keys in _groups.items():
    if len(_keys) < 2: continue
    # the spelling with the most deployments survives; ties go to the longer
    # (zero-padded) form, which is what the instrument plates usually carry
    _keys.sort(key=lambda k: (-len(U[k]['deps']), -len(k[2]), k[2]))
    _keep, _rest = _keys[0], _keys[1:]
    for _k in _rest:
        if _overlaps(_epochs(U[_keep]), _epochs(U[_k])):
            CONFLICTS.append((_keep, _k))
            continue
        _a, _b = U[_keep], U[_k]
        _a['built'] = _a['built'] or _b['built']
        _a['integrated'] = _a['integrated'] or _b['integrated']
        _a['open'] = _a['open'] or _b['open']
        for _f in ('kit', 'ansir', 'auscope', 'nets', 'stations', 'models', 'ctry', 'roles', 'dois', 'sites'):
            _a[_f] |= _b[_f]
        _a['starts'] += _b['starts']; _a['ends'] += _b['ends']
        _a['deps'].update(_b['deps'])
        MERGED_INTO.setdefault(_keep, set()).add(_k[2])
        del U[_k]
_conflict_keys = {k for pair in CONFLICTS for k in pair}
print(f"serial spelling merges: {len(MERGED_INTO)} units absorbed "
      f"{sum(len(v) for v in MERGED_INTO.values())} variant spellings; "
      f"{len(CONFLICTS)} variant pairs kept separate (overlapping epochs)")

recs=[]
for (man,mod,sn),u in U.items():
    if u['built']: tier,basis='confirmed-ANU-built','ANU is the manufacturer'
    elif u['auscope'] or u['sites']:
        _ev=[]
        if u['auscope']: _ev.append("AuScope experiment: "+','.join(sorted(AUSCOPE_NETS[n] for n in u['auscope'])))
        if u['sites']: _ev.append(','.join(sorted(u['sites'])))
        tier,basis='confirmed-AuScope','; '.join(_ev)
    elif u['kit']: tier,basis='confirmed-ANSIR-loan','ANSIR loan record: '+','.join(sorted(u['kit']))
    elif u['ansir']: tier,basis='probable-ANSIR','ANSIR project '+','.join(sorted(u['ansir']))+', model not itemised'
    else: tier,basis='unattributed','no ANSIR/AuScope record, not ANU-built'
    first=min(u['starts']) if u['starts'] else None
    last=None if u['open'] else (max(u['ends']) if u['ends'] else None)
    recs.append({'attribution':tier,'basis':basis,'manufacturer':man,'model':mod,'serial':sn,
      'integrated_node':u['integrated'],'roles':'+'.join(sorted(u['roles'])),
      'instrument_class':iclass(mod,'+'.join(sorted(u['roles'])),u['integrated']),
      'n_networks':len(u['nets']),'networks':sorted(u['nets']),
      'networks_auscope':sorted(n for n in u['nets'] if n in AUSCOPE_NETS),
      'auscope_sites':sorted(u['sites']),
      'network_funding':funding_for(u['deps'].keys()),
      'funding_names_auscope':any('AuScope' in f['funders'] for f in funding_for(u['deps'].keys())),
      'networks_other':sorted(n for n in u['nets'] if n not in AUSCOPE_NETS),
      'n_networks_other':len([n for n in u['nets'] if n not in AUSCOPE_NETS]),
      'serial_reconstructed': sn in RECONSTRUCTED,
      'serial_merged': sorted(MERGED_INTO.get((man,mod,sn), [])),
      'serial_variant_conflict': (man,mod,sn) in _conflict_keys,
      'n_deployments':len(u['stations']),
      'coverage_start':first,'coverage_end':last,
      'coverage_pidinst':(f"{first}/{last}" if first and last else (f"{first}/" if first else '')),
      'still_deployed':u['open'],'countries':sorted(u['ctry']),'network_dois':sorted(u['dois']),
      'raw_model_variants':sorted(u['models'])})
o={'confirmed-ANU-built':0,'confirmed-AuScope':1,'confirmed-ANSIR-loan':2,'probable-ANSIR':3,'unattributed':4}
recs.sort(key=lambda r:(o[r['attribution']],r['manufacturer'],r['model'] or '',r['serial']))
json.dump(recs,open(os.path.join(OUTDIR,'PIDINST_candidates_final.json'),'w'),indent=1)
# Sidecar: unit -> station-epoch deployments, keyed by the SAME normalised
# (manufacturer|model|serial) identity used above, so downstream consumers
# never have to re-derive model canonicalisation or serial resolution.
deps={'|'.join((man,mod or '',sn)):sorted(u['deps'].values(),key=lambda x:(x['start'] or ''))
      for (man,mod,sn),u in U.items()}
json.dump(deps,open(os.path.join(OUTDIR,'unit_deployments.json'),'w'))
print(f"unit deployment sidecar: {sum(len(v) for v in deps.values())} station-epochs")
cols=['attribution','basis','instrument_class','auscope_sites','funding_names_auscope','manufacturer','model','serial','serial_reconstructed','serial_merged','serial_variant_conflict','integrated_node',
 'roles','n_networks','networks','networks_auscope','networks_other','n_networks_other','n_deployments','coverage_start','coverage_end','coverage_pidinst','still_deployed',
 'countries','network_dois','raw_model_variants']
with open(os.path.join(OUTDIR,'PIDINST_candidates_final.csv'),'w',newline='') as f:
    w=csv.writer(f); w.writerow(cols)
    for r in recs: w.writerow(['; '.join(map(str,r[c])) if isinstance(r[c],list) else r[c] for c in cols])
cl=collections.Counter(r['instrument_class'] for r in recs)
print('\ninstrument classes: ' + ', '.join(f'{k} {v}' for k,v in cl.most_common()))
_unc=sorted({r['model'] or '(null)' for r in recs if r['instrument_class']=='unclassified'})
if _unc: print('UNCLASSIFIED models (' + str(len(_unc)) + '): ' + '; '.join(_unc))
_fund=[r for r in recs if r['funding_names_auscope']]
print('network funding evidence: %d units deployed in an experiment whose funding names AuScope '
      '(%d of them NOT currently confirmed - evidence captured, tiers unchanged)'
      % (len(_fund), len([r for r in _fund if not r['attribution'].startswith('confirmed')])))
t=collections.Counter(r['attribution'] for r in recs)
print(f"REVISED DATASET — {len(recs)} mintable units")
for k in o: print(f"   {k:24} {t[k]:5}")
conf=sum(t[k] for k in ['confirmed-ANU-built','confirmed-AuScope','confirmed-ANSIR-loan'])
print(f"   {'CONFIRMED total':24} {conf:5}   (was 1,120 before your list)")
print()
print("units confirmed via your experiment list, by model:")
for m,c in collections.Counter(r['model'] for r in recs if r['attribution']=='confirmed-AuScope').most_common(10):
    print(f"   {c:5}  {m}")
