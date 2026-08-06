# NVCL Scan-Length Methodology (merged-v1)

Counting rules for every NVCL figure published by this repository
(`data/nvcl-stats.json`, `docs/nvcl-data.json`, the dashboard and the NVCL
page). Implemented by `src/nvcl/harvest.js`. This document is the citable
reference: if a number appears in a report, this is how it was made.

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
and never inflate unique coverage (the union absorbs them).

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
   `TIR` in a log name).

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
