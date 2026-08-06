# NVCL Scan-Length Methodology (merged-v1.2)

Counting rules for every NVCL figure published by this repository
(`data/nvcl-stats.json`, `docs/nvcl-data.json`, the dashboard and the NVCL
page). Implemented by `src/nvcl/harvest.js`, with the TSG enrichment cache
built by `src/nvcl/tsg-enrich.js`. This document is the citable reference: if
a number appears in a report, this is how it was made.

## Evidence precedence (the one rule that governs everything)

**Depth.** API-published interval **>** TSG-measured interval **>**
drilled-length estimate.

**Date.** TSG header scan date **>** node API date (which is an *ingest*
date).

Tiers are never blended. Each figure is published with its provenance, and a
lower tier is used only where every higher tier is silent.

## Headline metrics

| Metric | One-line definition |
|---|---|
| **Unique core scanned** (`unique_scanned_km`) | Kilometres of distinct borehole depth covered by at least one HyLogger scan — the union of each borehole's scan intervals, overlaps merged, then summed nationally. |
| **Total scan work** (`total_scan_km`) | Kilometres the instruments actually logged — the plain sum of every dataset's scan interval, so re-scanning the same core counts each time. |

Unique answers *"how much of Australia's core has been scanned?"* Total
answers *"how much scanning have the instruments done?"* Unique can never
exceed total. The legacy field `total_scanned_km` is retained as an alias of
`unique_scanned_km` for page compatibility (see `total_scanned_km_note` in
the output).

## The atom: per-dataset scan intervals

The unit of measure is the **scan interval `(depth_start_m, depth_end_m)` of
one dataset**, parsed from the `DepthRange` element of each borehole's
`getDatasetCollection` response on its state node. Nothing else is ever
counted as scanned length — not borehole length, not drilled depth, not
metadata claims.

An interval is **valid** when:

1. both `start` and `end` are present and numeric, and
2. `end > start`, and
3. `(end − start) ≤ 1.5 × boreholeLength_m` when the drilled length is known
   (the **garbage clamp** — see below).

## The union rule

Per borehole, `unique_scanned_m` is the length of the union of its valid
intervals: sort by start, merge overlapping or touching intervals, sum the
survivors. Two scans of the same 100 m of core contribute 100 m unique and
200 m total.

## The no-substitution rule and the unrecorded bucket

A dataset whose interval is missing or invalid contributes **zero metres**
and increments `interval_unrecorded` (per node and nationally). Borehole
length is **never** substituted for a missing scan interval. The unrecorded
count is published beside the kilometre figures so the size of the
"we cannot say" bucket is always visible — an honest zero plus a disclosed
gap, rather than a guessed number.

## The garbage clamp

An interval longer than 1.5× the drilled borehole length (when the WFS
reports one) is physically impossible and treated as metadata garbage: it is
excluded from both metrics and counted in `interval_clamped` (a disclosed
subset of `interval_unrecorded`). The 1.5 factor tolerates legitimate
inclined-hole and re-surveyed-length cases while rejecting order-of-magnitude
entry errors.

## Rescans

Re-scanning is real instrument work and is deliberately visible: it widens
the gap between total and unique. `rescan_stats` reports how many boreholes
carry more than one interval-bearing dataset and the maximum per borehole.
Rescans are never collapsed away (that would understate instrument service)
and never inflate unique coverage (the union absorbs them). `rescan_stats`
counts API-interval datasets only; multiple TSG archives on one borehole are
unioned into a single measurement rather than reported as a rescan, because
a daughter-hole archive is not the same event as a re-scan of the same core.

## Node failures and the 80% write guard

Each of the 8 public nodes is harvested independently; a down node yields
state status `unreachable` and never aborts the run. Its figures are then
*absent, not zero* — which is exactly why outputs are only written when the
run is healthy:

- at least **5 of 8 nodes** answered their WFS, **and**
- boreholes-with-data is at least **80% of the previous snapshot's count**.

Otherwise the harvester exits non-zero and the previous snapshot stays in
place. A half-blind harvest must never replace a good national figure with a
smaller one that would read as decline. (`NVCL_FORCE=1` exists for deliberate
rebaselining only.)

Victoria is a special case: it registers NVCL-flagged boreholes on its WFS
but operates no HyLogger node and no NVCLDataServices (confirmed 404), so it
is reported as `non_participating` with its registered-borehole count and
contributes no scan figures.

## Provenance

Every figure is reproducible by querying the same public services cited in
the output's `endpoints` block:

1. WFS `GetFeature` on `gsmlp:BoreholeView` with `nvclCollection='true'`
   (paged; NT's GeoServer ignores that CQL filter, so NT is paged unfiltered
   and filtered client-side) — borehole identity, location, drilled length;
2. `NVCLDataServices/getDatasetCollection.html?holeidentifier={id}` —
   datasets, `DepthRange`, created dates, and the embedded TSG metadata
   (instrument name, scan/drill dates) plus TIR markers (`tirq` element or
   `TIR` in a log name);
3. `https://thredds.nci.org.au/thredds/catalog/rs07/{STATE}/catalog.xml` and
   the matching `fileServer` URLs — the AuScope NVCL TSG mirror on NCI,
   collection DOI **10.25914/bztg-rg43**, cited wherever a TSG-sourced figure
   appears. State subpaths are case-sensitive: `SA`, `Tas`, `WA`, `NT`,
   `Qld`, `Vic` (NSW has no mirror there).

No private databases, no manual numbers. `as_of` in every output records the
harvest date; `data/nvcl-history.jsonl` keeps one line per run so trends are
reconstructable from git history alone.

Instrument names are canonicalised (trim, collapse whitespace,
`Hylogger3-2` / `HyLogger 3.2` → `HyLogger 3-2`); unparseable or absent names
land in an explicit `Unknown` bucket rather than being dropped.

## Differences from the two retired methods

**Conservative scraper** (`AuScope_Outreach/scripts/scrape_nvcl.py`): took
only the *first* dataset's interval per borehole and zero on anything
missing. Retired because it silently discarded every additional dataset —
understating both coverage (extra depth ranges) and instrument work
(rescans), and making dataset counts and scan kilometres inconsistent with
each other.

**Deep pipeline** (`NVCL_Metadata/2026_Update` `build_fact_table.py`): used
`scanned_length_m = depth_range` with a **fallback to borehole length** when
the depth range was missing, and summed across datasets without a union.
Retired because the fallback fabricated scan metres from drilling metadata
(a borehole can be drilled 1,000 m and scanned 50 m), and the straight sum
multiplied rescanned core into the headline coverage figure. merged-v1 keeps
its per-dataset atom but removes the substitution (unrecorded bucket instead)
and separates coverage (union) from work (sum).

## TSG enrichment tier (added merged-v1.2)

### What it is

Every TSG archive produced by the NVCL is mirrored by AuScope on NCI THREDDS
as the collection **`10.25914/bztg-rg43`** — that DOI is the citation for
every figure this tier contributes. Where a node's API is silent, the TSG
file itself is not: its header records the depth interval the instrument
scanned, the date it scanned it, the HyLogger unit used, and the TSG UUID.

`src/nvcl/tsg-enrich.js` reads those headers and caches them in
`data/nvcl/tsg-cache.jsonl`, one line per archive, keyed by `state` +
`zipName`. That file is committed: it is the durable asset, and it is what
makes the weekly run cheap.

### Technique — HTTP range requests

The archives run from 30 MB to nearly 2 GB. None is ever downloaded. Per
archive:

1. `HEAD` → size and `Accept-Ranges`;
2. `Range:` the last 64 KB → the ZIP End Of Central Directory record;
3. `Range:` the central directory → the entry table (~2 KB);
4. `Range:` the `.tsg` entry alone → ~200 KB compressed, inflated in memory
   (`zlib.inflateRawSync`; stored entries are handled too).

Roughly **0.1%** of each archive is transferred. Verified: NT
`1113660_ECD10.zip` is 295 MB and 253 KB was read. The base `_tsg.tsg` entry
is preferred over the `_tsg_tir.tsg` companion; the entry actually read is
recorded in `tsgEntryName`.

### The depth field

The interval comes from the `[coordinates]` block, whose lines are written
`<index>:<name>;<min>;<max>;…` (the index prefix is present in some files,
absent in others):

```
80:Depth (m);24.003340;103.486778;2;-1;0;…
92:TIDL Depth Backup;24.003338;103.486778;…
```

`Depth (m)` is primary; `TIDL Depth Backup` is the secondary source for the
same pair. The name is anchored so the decoys in that same block never match
— `Interactive Depth Logging` (±16,777,216) and the per-mineral
`… PFIT depth` scalars are not scan intervals.

**Sanity clamp.** A parsed interval is accepted only if `to > from`,
`from ≥ 0`, `to ≤ 20,000 m` and `to − from ≤ 5,000 m`; otherwise the row is
recorded with error `implausible depth` and the borehole stays in the
estimation tier. The harvester then applies the *same* 1.5 × drilled-length
garbage clamp it applies to API intervals — one rule for all sources.

Some archives carry no depth line at all. Those rows are kept with their date
and error `no depth field`: the borehole gains a real scan date but stays in
the estimation tier for kilometres. The `dates_from_tsg` / `tsg_measured_km`
split makes that visible.

### How a TSG interval is counted

A TSG interval is a **measurement**, not an estimate — it is the instrument's
own record. It is included in `unique_scanned_km` and reported separately as
`tsg_measured_km` / `tsg_measured_boreholes` per state and nationally, with
`tsg_source: "NCI THREDDS TSG (10.25914/bztg-rg43)"`. It is used **only**
when the node publishes no interval for that borehole. Where several archives
map to one borehole (WA daughter holes: `12CADD001.zip` plus
`12CADD001_wedge.zip`), their intervals are unioned — the conservative
choice, since a wedge overlaps its parent.

### Matching cache rows to boreholes

Archive names are not WFS identifiers. WA names an archive after the hole
(`05GJD001.zip`); NT prefixes the numeric feature id
(`1113660_ECD10.zip`). Each archive is therefore indexed under three
normalised keys — whole name, part before the first underscore, part after it
— with normalisation to uppercase alphanumerics only, so punctuation
differences never cost a match. A borehole is matched in fixed precedence:
exact on WFS id, exact on WFS name, then name-as-suffix, then id-as-suffix.
Rows that match nothing are **counted and logged**, never silently dropped:
see `tsg_cache.unmatched_rows` nationally and `tsg_cache_rows_unmatched` per
state.

### Incremental, budgeted, hands-off

Each run lists the state's THREDDS catalog, diffs it against the cache by
`state + zipName`, and fetches only what is missing. Settled outcomes
(including `no depth field`, `no_tsg_in_zip`, HTTP 404) are never re-read;
transport failures are retried automatically next run; `--retry-failed`
re-reads everything with an error. `--max-new=N` (default 400) caps the work
per run so the weekly GitHub Action stays inside its time budget, and the
remainder is reported and picked up the following week. Politeness: one state
at a time, concurrency 3, 0.3 s between archives, 2 retries with backoff, and
a circuit breaker that stops after 8 consecutive network failures.

## Scan dates vs ingest dates

A node's `createdDate` is the day a record was **loaded into its database**,
not the day the core was scanned. Measured on the 2026-08-06 harvest:

| Source of dates | SA busiest month | TAS busiest month |
|---|---|---|
| Node API (`createdDate`) | 2019-07 = **20%** of the state | 2020-10 = **30%** of the state (2025-02 = 15%, 2022-11 = 14%) |
| TSG headers | 2022-10 = 4% (no cluster) | 2010-02 = 4% (no cluster) |

A fifth of South Australia was not scanned in July 2019 — it was *ingested*
then. Under TSG dates the clusters vanish and the distribution is smooth,
which is what real scanning activity looks like. Publishing the API date as a
scan date corrupts the growth chart, `days_since_latest`, the freshness
badges, the published scan-date range and any annual-throughput figure
derived from them.

So every date carries a `dateSource`:

- **`tsg`** — the TSG header's own scan date. Three tiers inside the file,
  highest confidence first: `scan date =` in `[description]`, then
  `scan date:` in `[history]`, then `Created :`. Years outside 2000–2035 are
  rejected as typos and fall through to the next tier.
- **`api_scan`** — `ScanDate` embedded in the API's dataset description.
- **`api_created`** — `createdDate`. An ingest date. Last resort.

Counts are published per state and nationally as `dates_from_tsg` /
`dates_from_api` (with the `api_scan` / `api_created` breakdown), plus
`dates_from_tsg_pct`. Where a borehole has more datasets than archives, the
lists are paired chronologically and leftover datasets take the borehole's
latest TSG date rather than fall back to an ingest date that would invent a
scanning month.

### Bulk-upload detector

For each state, the share of dated records falling in its single busiest
month is computed and published as `date_cluster`. When that share exceeds
**15%** *and* more than half the state's dates are API-sourced, the state
entry gains `suspected_bulk_upload_month`, `suspected_bulk_upload_share_pct`
and an explanatory note, and the NVCL page replaces that state's freshness
badge with an *ingest date* marker. The threshold is deliberately low: 15% of
a state's records in one month is already implausible for a single
instrument, and the cost of a false flag is a caveat, while the cost of a
missed one is a fabricated scanning history. The flag clears automatically as
TSG enrichment covers the state.

## Estimation tier (added merged-v1.1, narrowed in v1.2)

Some nodes publish no scan intervals at all through `getDatasetCollection`
(at the time of writing: WA and NT). Their scanning is real; their APIs
simply omit depth ranges. For boreholes with **neither an API interval nor a
TSG one**:

- A borehole whose datasets are *all* interval-less is estimated **once**
  at its drilled length (`boreholeLength_m` from the WFS). Never per
  dataset — rescans must not inflate an estimate.
- Estimates are reported as `estimated_km` / `estimated_boreholes`,
  **separately** from `unique_scanned_km` (measured). The headline
  `combined_estimate_km = measured + estimated` always travels with the
  split. Blending them silently was the retired deep-pipeline method's
  flaw; disclosure is the difference between an estimate and a fabrication.
- When a node begins publishing intervals, or the TSG cache reaches that
  borehole, it leaves the estimation tier automatically — measured always
  wins over estimated. WA and NT rows on the page therefore move from
  `≈ … est.` to a measured figure state by state as the backfill proceeds,
  and read as `312 km · 140 km est.` while a state is part-way through.
