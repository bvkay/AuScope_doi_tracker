# AusPASS → ANU / AuScope seismic instruments: PIDINST candidates

**Generated 31 Aug 2026.** Channel-level StationXML harvested for all 83 AusPASS
network codes (89 network-epochs, 15,606 channel-epoch rows), joined to the ANSIR
Project Database, the operator-confirmed AuScope experiment roster, and the live
AuScope PIDINST registry.

## Headline

**2,752 mintable instrument units. 1,305 confirmed AuScope/ANU.**

Counts below are the CURRENT output of `build_candidates.py`, after the serial
spelling merges and the station-level AuScope exception documented later in
this file. They are regenerated with the data, so if this table disagrees with
`data/seismic/PIDINST_candidates_final.json`, the JSON is right and this table
is stale — say so rather than quoting it.

| tier | units | basis |
|---|---:|---|
| `confirmed-ANU-built` | 446 | Model string names ANU as builder (LPR-200, ANUSR, TerraSAWR) — ANU is manufacturer *and* owner |
| `confirmed-AuScope` | 646 | Deployed in an experiment confirmed by the operator to use AuScope instruments, or at an AuScope-funded site |
| `confirmed-ANSIR-loan` | 213 | Serial in a network whose ANSIR project record itemises that model as loaned kit |
| `probable-ANSIR` | 197 | In an ANSIR-supported project, model not itemised on the loan record — **excluded from headlines** |
| `unattributed` | 1,250 | No ANSIR/AuScope record, not ANU-built — incl. GSWA WA Array, AuSIS — **excluded from headlines** |

Earlier revisions of this document quoted 2,830 / 1,309 (456 / 601 / 252 /
1,324). Those predate the 78 serial-variant merges (one physical device was
being counted twice under two spellings) and the two AuSIS site exceptions.

## Files

| file | what it is |
|---|---|
| `PIDINST_candidates_final.csv` / `.json` | 2,830 candidate units, one row per physical device |
| `build_candidates.py` | regenerates both outputs from `source/`; **edit `AUSCOPE_NETS` to extend the roster and re-run** |
| `source/deployments.jsonl` | 15,606 parsed channel-epoch rows (the working dataset) |
| `source/xml/*.xml` | raw harvested StationXML, 83 networks |
| `source/harvest.py`, `source/parse.py` | re-harvest from AusPASS and re-parse |
| `source/ansir_network_links.json` | 22 AusPASS networks matched to ANSIR projects + loaned-kit lists |
| `source/networks_digest.json` | 89 network-epochs: dates, description, DOI, citation comments |
| `source/models_digest.json` | 112 raw equipment Model strings with unit counts |
| `source/instruments.json` | earlier per-(role,model,serial) aggregate, kept for reference |

Self-contained: `python3 build_candidates.py` from this folder regenerates everything.

## AuScope experiment roster (operator-confirmed, 24 networks, epoch-keyed)

`1G` LAKE GEORGE (2020 epoch only) · `1H` MUNDI MUNDI (2024 epoch only) · `2B` DASH + SISSLE ·
`2E` WETA · `2X` VULCAN ADI · `3G` MARLA · `3X` CURNAMONA CUBE · `4B` SNAKEY · `4K` FISSLE ·
`4Z` ALiRT · `5G` LAKE EYRE BASIN · `5J` ASR · `6D` WESTERN GAWLER ADI · `6K` AusArray SA ·
`6Y` SOSA · `7A` QSTNQ · `8A` BMNTE · `9B` MT STROMLO · `9M` EYRE PENINSULA · `M8` MATE ·
`X5` AHNA · `Y7` OKSN · `YB` Rugby 2026 · `ZJ` SAMWISE

**The roster is code + epoch, not code.** FDSN codes are reused: `1G` is GAWLER (2008),
Banda Arc (2019) and Lake George (2020); `1H` is EAL2 (2010) and Mundi Mundi (2024). A
deployment counts only if its station epoch overlaps the declared AuScope epoch of that code
(`AUSCOPE_EPOCHS` in `build_candidates.py`, checked against `networks_digest.json` at load —
the build refuses to run if a declared epoch is not in the digest). Keying on the bare code
had confirmed 35 units for 2008–2010 deployments under the labels of 2020/2024 experiments.

## Where else these instruments were used

The CSV splits deployment history into `networks_auscope` (on the roster) and
`networks_other` (not on it), with `n_networks_other` as a count.

**894 of the 1,309 confirmed units were also deployed in networks that are NOT on the
roster.** Those networks host confirmed AuScope kit but have no confirmation of their own —
they are the strongest candidates for extending the roster:

| network | confirmed AuScope units hosted | |
|---|---:|---|
| 8J SQEAL | 225 | 4J AQ3 124 · 1Q AQT 112 · 2P SWAN 83 |
| 9M Eyre Peninsula | 155 | 1K ALFREX 71 · 1F Curnamona 65 · 7P TIGGER 64 |
| 7S/7U/7T/7R/7L SEAL+EVA | ~270 combined | 4N CWAS 55 · 6T NTSPA 53 · 4H EAL1 44 |

Separately, the largest networks where **nothing** is known about the kit:
WG WA Array 513 · S1 AuSIS 148 · 7P 64 · 6F BILBY 55 · 1P BASS 49 · OZ 39.

## Attribution is per instrument, never per network

329+ confirmed AuScope units were deployed inside experiments led by **other**
institutions — Adelaide (205), VUW (121), Macquarie (55), Otago (42), GSSA (35),
GSWA (28), QUT (18), UTAS (7). 29 of 89 networks mix AuScope and non-AuScope kit.
Neither the network nor the PI's affiliation establishes who owns an instrument:
QSTNQ (QUT) and SOSA (Otago) both ran AuScope kit.

Conversely, network DOI creators describe **who ran the experiment**, not who owned
the hardware — do not use DataCite affiliation as an ownership signal.

## Cleaning applied before minting

- junk serials excluded — `999`, `9999`, `SP`, `0000`, `123`, `1234`, `-`, `unknown`, single digits
- phantom `(built-in)` dataloggers dropped: an integrated node is ONE device
  (`integrated_node` = true, 393 confirmed units)
- **100 of 100 truncated SmartSolo serials resolved** to their full 9-digit DTCC
  form (short last-4 form used by networks 1G, 4Z, 9B). Four passes: model family
  by sensitivity, then temporal exclusion (a node cannot be in two networks at
  once), then serial-block prior (all 164 already-resolved short serials in those
  networks fall in the `45300` block, unanimously), then block-adjacency
  reconstruction for the final 2 (`2549`, `1698`) — both fall inside the observed
  block range 453001632–453002839 and are bracketed by resolved neighbours
  (2545←2549→2560, 1688←1698), so they are written as `453002549` / `453001698`
  and flagged `serial_reconstructed = true` so the inference stays auditable.
- **All SmartSolo spellings collapsed onto the three real DTCC products** —
  16HR-3C, 16HR-1C and BD3C-5 — keyed on sensitivity (76.6 vs 209.4 V/m/s), so
  9B's model-number-free `5hz 76.6 V/m/s` folds into 16HR-3C. Together with the
  serial resolution this removed **176 phantom duplicate units**; SmartSolo now
  resolves to 424 physical nodes (313 × 16HR-3C, 102 × BD3C-5, 9 × 16HR-1C) with
  zero serials split across models.
- model strings normalised (112 raw → ~74 canonical); raw variants kept in
  `raw_model_variants`
- **serial spelling variants merged, temporally guarded** — the same device is
  written differently by different networks: `047` in 1K/8J/9X but `47` in 6Y,
  `A-012` vs `A012`, `0457` vs `457`. `nser()` cannot see this (it normalises
  each serial in isolation), so 79 pairs of records were one physical
  instrument counted twice — 54 involving a confirmed unit and **34 carrying
  two different attribution verdicts for the same device**, because evidence
  was split across the two spellings. Variants are now merged on
  (manufacturer, canonical model, punctuation- and zero-padding-insensitive
  serial), but **only where the deployment epochs do not overlap** — a
  physical device cannot be in two places at once, the same test that resolved
  the truncated SmartSolo serials. 77 pairs merged; the surviving spelling is
  the one with more deployments (ties → the longer, zero-padded form) and the
  absorbed spellings are listed in `serial_merged`. **2 pairs were kept
  separate**: GaiaCode Theta `TT-1122`/`TT1122` and `TT-1124`/`TT1124` overlap
  in time and so are genuinely two devices each — they carry
  `serial_variant_conflict = true`. A regex-only rule would have wrongly
  merged them. Net effect: 2,830 → 2,752 units, confirmed 1,335 → 1,302, with
  no deployment lost (3,850 → 3,877 station-deployments, consolidated onto
  fewer devices).
- float-formatted serials normalised (`5171.0` → `5171`)

## Dates — read before populating any date field

`coverage_pidinst` is the ONLY defensible date field, as `date_type = Coverage`.

Do **not** derive Commissioned or DeCommissioned. StationXML start/end dates are
data-acquisition epochs; `InstallationDate`, `RemovalDate` and `CalibrationDate`
are null on all 15,606 rows. A back-test showed 18.6–21.3% of units that looked
decommissioned at a historical cutoff were later redeployed (longest dormancy
20.3 years). Units still in service (`still_deployed` = true) take the open-ended
form `YYYY-MM-DD/`, never a closed range.

## Report back to AusPASS

- SmartSolo serials truncated to last-4 in networks 1G, 4Z, 9B (98 of 100
  recoverable from other networks' full serials, but the archive should hold the
  full form)
- five spellings of the same node family across the archive; 9B's
  `DTCC SmartSolo 5hz 76.6 V/m/s` carries no model number at all
- 8 network DOIs live in the `<Identifier>` element rather than comment text;
  ~22 more exist at DataCite but are absent from AusPASS StationXML entirely
- `<Identifier>` DOI values are inconsistently formatted (`//doi.org/…`,
  `https://doi.org/…`, bare DOI, one literal `TBA`)
- the `fdsnws-availability` service is deployed but returns HTTP 204 for every
  query — the index appears unpopulated

## Registry cross-references

- `6D` Western Gawler (DOI `10.7914/6j8j-9f06`) is **not linked** to platform
  `10.82388/ssw0j868` — worth adding as a `Collects` related identifier
- `2X` Vulcan is confirmed and already linked to `10.82388/bt6orvhn`, but that
  record's spatial polygon is ~8.6 km off the actual station grid (8 of 100
  stations fall inside it)
- `3X` Curnamona Cube (`10.7914/6q5b-va48`) has no registry counterpart — a
  genuinely missing campaign, not a duplicate of the 2017 Curnamona platform

## Open questions

- **WG WA Array (~276 units)** — GSWA-funded and managed; presumed out of scope
- **S1 AuSIS (~151 units)** — ANU-operated but permanently sited in schools;
  arguably a separate collection with different deployment semantics
- granularity for integrated instruments (CMG-6TD, Certimus, Meridian, SmartSolo):
  one DOI for the box with the digitiser serial as an alternate identifier
- `manufacturer_identifier`: only 5 of 18 manufacturers have a ROR; the rest need
  URL identifiers. The IRIS/EarthScope Nominal Response Library is a more durable
  namespace for `model_identifier` than vendor product pages
- GCMD has no concept for a seismic datalogger or for ground velocity;
  `measured_variable` resolves against `sciencekeywords`, not `MeasurementName`

## Instrument class

Every unit carries `instrument_class`, assigned by an ordered rule table over
the canonical model string in `build_candidates.py`:

| class | what it is |
|---|---|
| `datalogger` | standalone digitisers/recorders (LPR-200, ANUSR, TerraSAWR, Centaur, Taurus, Orion, Pegasus, PR6-24, RefTek, Minimus, CMG-6TD, GECKO) |
| `broadband` | seismometers ~20 s and longer (Trillium family, STS-2/2.5/6A, CMG-3ESP/40T/6T, Certis/Certimus, Meridian Compact Posthole, Silicon Audio, COLT) |
| `short-period` | ~1–4.5 Hz seismometers (Lennartz LE-3Dlite MkII, Sercel L-4C/L-4A/L-28, Willmore) |
| `nodal-short-period` | integrated 5 Hz nodes (SmartSolo 16HR-3C, 16HR-1C) |
| `nodal-broadband` | integrated broadband nodes (SmartSolo BD3C-5) |
| `accelerometer`, `hydrophone` | strong motion; hydrophones |
| `unclassified` | **flagged, never guessed** |

Two rules matter:

- **Nodal instruments are their own classes**, not split across sensor and
  datalogger — an integrated node is one physical box (`integrated_node`).
- **Role beats the model string on the sensor/datalogger axis.** `role` records
  which StationXML element the serial came from, so it is direct evidence,
  where the model string is ambiguous: `Nanometrics Meridian` is the digitiser
  while `Nanometrics Meridian Compact Posthole 120s` is the sensor, and no
  model regex separates them reliably. Nodal detection runs first, then role,
  then the model rules for sensors.

StationXML's own `<Type>` field is **not** used: across this archive it
variously holds a class code (`BB`/`SP`/`GP`/`SM`), the model string repeated,
or the manufacturer name.

Currently unclassified: `(null)` (39 units with no model string), `GaiaCode
Theta` (49) and `IGG CAS` (10) — all in the unattributed pool, so no confirmed
unit is unclassified. Identify those two products and they classify.

## Station-level AuScope funding

Attribution is normally network-level, but **funding does not always arrive at
network granularity**. AuSIS (`S1`) is a schools network that is not an AuScope
experiment, yet two of its sites were established with AuScope funding in June
2026: `AUOKV` Oak Valley Anangu School and `AUYLT` Yalata Anangu School.

`AUSCOPE_STATIONS` maps `(network, station)` to a funding basis, and a match is
evidence of the same standing as an experiment on the roster. Without it the
instruments at those sites fall to `unattributed`: three of the four did, and
the fourth (Trillium Compact 120s #4872) counted as AuScope only by
coincidence — the same sensor had previously served in MARLA and AusArray SA.
Effect: confirmed 1,302 → 1,305, `S1` 1 → 4 confirmed of 149 hosted. The
per-unit `auscope_sites` field records which site did the confirming.

## Network funding evidence (captured, not promoted)

`src/seismic/network_funding.py` records who funded each **experiment**, from
two sources: the FDSN metadata already in `networks_digest.json` (epoch-precise,
all 89 network-epochs) and the AusPASS network pages, which carry an explicit
*Funding sources* field (only ~12 experiments have a page). Output:
`data/seismic/network_funding.json` — 20 records over 19 network-epochs, 8
naming AuScope.

**It is deliberately not wired into the attribution tiers.** "AuScope funded
this experiment" is a claim about **deployment support**; `AUSCOPE_NETS`
asserts something different and stronger — that the experiment used AuScope
**instruments**. An AuScope-funded campaign can run ANU- or ARC-purchased kit,
so folding the two together would restate hundreds of units' provenance on
evidence that never mentioned instruments. Each unit therefore carries
`network_funding` and `funding_names_auscope` as context, and the tier is
unchanged: **382 units were deployed in an experiment whose funding names
AuScope, 72 of them not currently confirmed** — that 72 is the decision pool if
a future tier model chooses to use this evidence.

Networks with AuScope-funded experiments that are **not** on the instrument
roster: `1Q` AQT, `1F` CURNAMONA (2009), `4H`/`1H`/`7L` EAL1-3, `3F` Macquarie
Ridge, `ZR` MINQ.

**Epoch matching is mandatory here.** Network codes are reused: `1H` is EAL2
(2010-05-10) *and* Mundi Mundi (2024). Page evidence is resolved to an epoch by
matching the experiment name in the FDSN description, and a unit only inherits
funding evidence where its own deployment window overlaps that epoch — never by
bare network code.

**Worth asking AusPASS:** populate *Funding sources* for the other 77
network-epochs. It is the cheapest route to defensible attribution across the
archive; today only 12 experiments have a page at all.
