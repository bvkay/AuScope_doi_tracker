# AuScope DOI Tracker

Citation, publication, and dataset tracker for [AuScope](https://www.auscope.org.au/) — Australia's national research infrastructure for the Earth and environmental sciences.

Automatically discovers and tracks journal publications referencing AuScope facilities, inventories datasets across AuScope platforms, and generates an embeddable impact dashboard.

## Live Dashboard

- **Full dashboard**: [bvkay.github.io/AuScope_doi_tracker](https://bvkay.github.io/AuScope_doi_tracker/)
- **Embeddable widget**: [bvkay.github.io/AuScope_doi_tracker/widget.html](https://bvkay.github.io/AuScope_doi_tracker/widget.html)

## How It Works

```
Google Sheet                              GitHub (this repo)
┌──────────────────────┐                 ┌─────────────────────────┐
│ Staff paste DOIs    ─┼─── pending ───► │ Process pending DOIs    │
│ into "DOIs to add"   │                 │ (metadata via Crossref  │
│                      │                 │  + OpenAlex)            │
│ MasterList ◄─────────┼─── sync ◄───── │                         │
│ (source of truth     │                 │ Weekly keyword search   │
│  for manual edits)   │                 │ (39 terms × 3 APIs)    │
└──────────────────────┘                 │                         │
                                         │ Dataset inventory       │
                                         │ (EarthBank, AusPass,    │
                                         │  NCI GeoNetwork)        │
                                         │                         │
                                         │ Maintenance             │
                                         │ (dedup + metadata fill) │
                                         │                         │
                                         │ Dashboard + Widget      │
                                         │ (GitHub Pages)          │
                                         └─────────────────────────┘
```

## What It Tracks

### Publications (39 search terms)

Searches across OpenAlex, Semantic Scholar, and Europe PMC for:

- **Primary**: AuScope
- **Instruments & facilities**: Hylogger CSIRO, SHRIMP II, Western Australia Argon Isotope Facility, Noble Gas Geochronology Laboratory, Geoscience Atom Probe, National Argon Map
- **VLBI stations**: AuScope VLBI, Yarragadee, Katherine, Mt Pleasant
- **Networks**: AusPass, AusLAMP, Australian Seismometers in Schools, Australian Geophysical Observing System
- **Software**: EarthByte, GPlates, Underworld2, G-Adopt, AusGeochem
- **Portals & databases**: National Virtual Core Library, AuScope Discovery Portal, AuScope Virtual Research Environment, AuScope Geochemistry Network
- **AuScope capabilities**: Geospatial/Geodesy, Earth Imaging/Sounding, Characterisation, Simulation/Analysis/Modelling, and more

### Datasets (4 platforms)

Inventories datasets from:

| Platform | Source | What |
|----------|--------|------|
| **EarthBank** | DataCite API | Geochemistry datasets |
| **AusPass** | FDSN Station + Networks API | Seismic networks |
| **NCI MT** | GeoNetwork API | Magnetotelluric survey data |
| **NCI DAS** | GeoNetwork API | Distributed Acoustic Sensing data |

### Impact Metrics

Extracted from OpenAlex per publication:
- **Researchers** — unique author names across all publications
- **Institutions** — unique research institutions from author affiliations
- **Countries** — unique countries from institution data

## Publication Sources

| Source | Role |
|--------|------|
| [OpenAlex](https://openalex.org/) | Primary discovery + metadata + citation counts + institution/country data |
| [Semantic Scholar](https://www.semanticscholar.org/) | Discovery (primary query only) |
| [Europe PMC](https://europepmc.org/) | Discovery (OA full-text) |
| [Crossref](https://www.crossref.org/) | Metadata enrichment only (not used for discovery — fuzzy search returns false positives) |
| [CORE](https://core.ac.uk/) | OA papers, theses (pending API key) |
| [Dimensions](https://app.dimensions.ai/) | Journals, conferences (pending API key) |

## Running Locally

```bash
# Search all queries and update data/publications.json
S2_API_KEY=your_key node src/search.js

# Update dataset inventory from EarthBank, AusPass, NCI
node src/dataset-inventory.js

# Process pending DOIs from Google Sheet
node src/process-pending.js

# Run maintenance (dedup + metadata fill)
node src/maintain.js

# Regenerate dashboard and widget
node src/dashboard.js
```

## GitHub Actions

The workflow runs automatically:
- **Weekly** (Sundays 2am UTC): full keyword search + dataset inventory + maintenance + dashboard rebuild
- **On push** to `data/pending.json` or `data/publications.json`: process pending DOIs + dashboard rebuild
- **Manual**: trigger via Actions tab with optional full search

## Configuration

Edit `config.json` to modify search queries, pagination depth, or minimum year filter (1997 — AuScope founding year).

API keys are stored as [repository secrets](../../settings/secrets/actions):
- `S2_API_KEY` — Semantic Scholar
- `CORE_API_KEY` — CORE (when available)
- `DIMENSIONS_API_KEY` — Dimensions (when available)

## Embedding the Widget

```html
<iframe src="https://bvkay.github.io/AuScope_doi_tracker/widget.html"
        style="width:100%;max-width:1100px;height:220px;border:none;"
        title="AuScope Impact at a Glance">
</iframe>
```

## Licence

Built for AuScope research impact reporting.
