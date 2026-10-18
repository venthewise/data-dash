---
name: data-dash
description: >-
  Build a data dashboard, KPI report or chart page from CSV, Excel, Parquet,
  JSON, SQLite/DuckDB, HTTP APIs, Google Sheets or connector data: SQL in DuckDB,
  one self-contained offline HTML file (Apache ECharts), every number clickable
  to its query, rows, freshness and CSV, PNG/PDF export, refreshable on a
  schedule. Not for slide decks, motion/video charts, or live BI tools.
license: MIT (see LICENSE). Bundled Apache ECharts is Apache-2.0, Inter font is OFL-1.1 (see assets/LICENSES.md)
compatibility: Requires Python 3.10+ with duckdb and pyyaml; playwright + Chromium for check/export; optional openpyxl (xlsx) and tzdata (Windows, display_tz). Network only for URL sources on first refresh.
metadata:
  author: Paolo Libertad (github.com/venthewise)
  version: "1.1.0"
---
# Data Dash: traceable, self-contained dashboards

A YAML spec declares sources, SQL datasets, filters and widgets. `refresh` runs every query in DuckDB, `build` writes ONE HTML file with the data, ECharts, font and CSS inlined, `check` audits it, `export` makes PNG/PDF. Works from `file://` with no network.

Inspired by Anthropic's Claude Dashboards; an independent project, not affiliated with Anthropic.

## When to use / not use

Use for: KPI pages, recurring reports, "chart this CSV/table/API", dashboards over connector pulls (mail, CRM, analytics, repos), anything that must show where each number came from and be refreshable.
Not for: live per-viewer BI (use the warehouse's own tool), slide decks, animated chart videos (use a motion skill), one-off single charts in chat (just draw it).

## Data honesty (non-negotiable)

- Never invent, estimate or "fill in" numbers. Every value comes from a source through a dataset query.
- Example or synthetic data says so in the dashboard subtitle and source title (`EXAMPLE DATA`).
- `data_through` comes from the data (`{column: ...}` max) or an explicit declaration. Never today's date. A static file is not live because someone opened it today.
- Incomplete periods are flagged, not hidden or extrapolated.
- If a source fails, stop and report it; do not ship stale or partial numbers silently.

## Workflow

1. **Question.** Write the one question the dashboard answers (put it in `subtitle`). Name the audience and the decision.
2. **Data inventory.** List sources, owners, licence, grain, date column, coverage start, refresh cadence, known gaps. Pull connector data into a `snapshot` file (pattern below).
3. **Spec.** `dash.py init <dir>` for a scaffold, or write `spec.yaml` (see `references/spec-reference.md`). 3-4 KPIs on top, one time series, one ranking, one detail table is the default shape. Embed row-level or lightly aggregated rows (the page re-aggregates for filters).
4. **Refresh.** `dash.py refresh spec.yaml` and read the printed row counts and `data_through` values. Sanity-check one KPI in SQL yourself.
5. **Build.** `dash.py build spec.yaml`.
6. **Check.** `dash.py check spec.yaml`, fix every FAIL.
7. **Export.** `dash.py export index.html` (desktop 1440, mobile 390 @2x, A4 landscape PDF).
8. **Scored review loop** (below) on the two PNGs. Iterate until every axis is 8+.
9. **Deliver.** The HTML (works offline, attach it), the PNG/PDF, the spec + `data/` folder, and a one-line note of data_through and any caveats.

`dash.py all spec.yaml --outdir out/` runs refresh, build, check and export in one go.

## Scored review loop

Read `desktop.png` and `mobile.png` (crop to full resolution; don't judge a downscaled full page). Score 1-10:

| Axis | 8+ means |
|---|---|
| Answers the question | the top row answers the subtitle's question without scrolling |
| Accuracy / traceability | numbers match an independent SQL check; every widget opens its source; periods compared are equal length |
| Clarity | each chart has one message; titles say what, captions say when; no unexplained comparisons |
| Layout | aligned grid, sensible spans, no orphans, mobile is a single readable column |
| Readability | labels legible at phone size, no truncation that hides meaning, units on every value |
| Design restraint | one accent, no gradients/glow/3D, pies only for 2-5 part-of-whole, no chart junk |
| Freshness transparency | data through + refreshed visible; incomplete periods marked |

Write the scores and the single biggest fix, fix it, re-run `build`/`check`/`export`, re-score. Do at least one fix pass. Optional: a separate read-only reviewer scores and lists fixes, never edits.

## Commands

`D=scripts/dash.py`, resolved relative to this SKILL.md's folder (the skill directory), wherever the skill is installed (`python3 $D <cmd> -h` for flags; `python` on Windows).

**Run `refresh` (or `all`) first.** `build` reads `data/<id>.json`, which only `refresh` writes; URL sources are downloaded into `.cache/` on the first refresh (needs network). The cache is gitignored and not shipped, so `refresh --offline` only works after one online refresh. Both bundled examples use local snapshot files and need no network. Missing data or cache stops with a message saying which command to run.

| Command | What it does |
|---|---|
| `init <dir>` | scaffold `spec.yaml` + `sample/orders.csv` (seeded synthetic EXAMPLE data, mid-month end so partial flagging shows) |
| `refresh <spec> [--offline]` | load sources into DuckDB (URLs cached in `.cache/`), run each dataset query, write `data/<id>.json`: columns + types, rows, `refreshed_at` (ISO with offset), `data_through` + rule, `data_from`, row_count, query, source metadata. `--offline` reuses cached downloads |
| `build <spec> [--out f.html]` | one self-contained HTML: data, ECharts 6.1 (SVG renderer), Inter subset, CSS inlined |
| `check <spec\|html> [--no-browser]` | checklist below; exit 1 on any FAIL |
| `export <html> [--png --mobile --pdf] [--active-only]` | waits for `window.dashReady` (set after every chart's `finished` event), full-page PNG at 1440 and 390 (@2x), A4 landscape PDF. All tabs stacked unless `--active-only` |
| `all <spec> [--outdir d] [--offline] [--no-export]` | refresh, build, check, export |

`check` covers: widget datasets and fields exist; no digits in spec text (titles, subtitles, labels) except `dashboard.allow_terms`; no `new Date()`/`Date.now()` in the app code; `data_through` present and not "today"; units on every KPI/chart/numeric column (or %/currency format, or `unitless: true`); time charts flag partial periods; WCAG AA contrast for theme text pairs (4.5:1) and series/widget colours (3:1); HTML size; and in Chromium at 1440 and 390 with the network blocked: no overlapping widgets, no clipped text or sideways page scroll, chart labels inside their SVG, every visible digit inside data (`.dv`), generated (`.gen`) or chart elements, the source drawer opens and fits, the CSV downloads with the full row count, 0 console errors, 0 network requests.

## What the page does

- Header: title, question, **Data through** (earliest across datasets) and **Refreshed**, each with an explicit zone label. Default: data through in UTC (`18 Oct 2026, 08:00 UTC`; a date-only value reads `17 Oct 2026 (UTC day)`), refreshed in the offset it was written with (e.g. `16:16 UTC+1`). Set `dashboard.display_tz: Europe/London` (any IANA name) to show header, footer and drawer times in that zone, labelled `Europe/London (UTC+1)`; the build converts with Python `zoneinfo` (no pytz). Display only: `data_through` itself, completeness and time buckets stay UTC, and it is never set from today's date. Footer: per-dataset data through, refresh time, rows, source + licence.
- Every KPI and chart carries `data-src`. Click a KPI, a chart mark, or "Source" to open the drawer: dataset title and description, sources (URL, licence, fetched/pulled time), the DuckDB SQL, refreshed, data through (with rule), data from, row count (and filtered count), first 20 rows, **Download CSV** (all rows) and **Download filtered CSV** (Blob, offline).
- KPIs: aggregate over a window ending at data through (`window: {months: 12}`) with delta vs the preceding equal window (`delta: pct|abs`, `good: up|down|neutral`). If the prior window starts before `data_from`, it says "No comparison" instead of comparing against missing data. `detail_field` names the max/min row (and notes ties).
- Time charts bucket client-side (`grain`); an incomplete last (or first) bucket is hatched (bars, heatmap columns) or dashed (lines) with a generated note: "Oct 2026 is incomplete (data through 18 Oct 2026, 08:00 UTC)". Completeness uses data_through only.
- Each chart shows its generated period ("1 Oct 2024 – 18 Oct 2026") so KPIs and charts over different windows can't be confused.
- Filters (date range with presets relative to data through; categorical chips) re-aggregate every widget whose dataset has the field. Series colours stay fixed per category (`series_order`/`color_map`).
- Tabs (`layout: {sections: tabs}`) or stacked sections; responsive 12-col grid (desktop / ≤960px / ≤640px).

## Connector data: the snapshot pattern

For data only reachable through an agent connector (mail, chat, CRM, analytics, issue trackers, social), pull it with the connector tool, then write a snapshot file and reference it as a source:

```json
{"pulled_at": "2026-10-18T09:00:00+00:00", "pulled_from": "<connector name>", "query": "<what was pulled, filters, date range>",
 "rows": [{"date": "2026-10-01", "channel": "email", "count": 12}]}
```
```yaml
sources:
  inbox: {type: snapshot, path: snapshots/inbox.json, title: Inbox volume (connector pull)}
```
Rules: rows must be exactly what the connector returned (aggregate in SQL, not by hand); always set `pulled_at`; overwrite the file on each pull; keep personal data out unless the user asked for it, and remember the HTML embeds every row.

## Scheduled refresh (routine)

A routine (cron / scheduled agent task) runs: pull snapshots (if any) → `dash.py all spec.yaml --outdir out/` → if check fails, report the failures instead of delivering → otherwise deliver `desktop.png` + `dashboard.pdf` (and the HTML) to the agreed channel with "data through X, refreshed Y". Routines must not change the spec or the queries.

## Publishing

The HTML contains every embedded row. Publishing to static hosting (GitHub Pages, Netlify, S3, etc.) makes that data public: do it ONLY with the user's explicit approval for that dashboard and destination, after confirming the rows contain nothing private. Default delivery is a file attachment.

## Known limits vs Claude Dashboards

- No live per-viewer queries: data is a snapshot as of `refresh`; viewers see the same numbers and need no account.
- No in-chat live artifact or "ask about this number"; edits happen by changing the spec and rebuilding.
- No comment threads or sharing permissions.
- Embedded data is capped by `embed_limit` (default 50,000 rows); aggregate in SQL for bigger sources.
- Better: you own the code and data; PNG, PDF and per-source CSV export; any SQL source DuckDB can read; offline file; completeness from data, not the clock; reusable components and an automated audit.

## Setup (one time)

```bash
pip install duckdb pyyaml            # core
pip install openpyxl                 # only for xlsx sources
pip install playwright && python3 -m playwright install chromium   # check + export
```
On Debian/Ubuntu system Python add `--break-system-packages` (or use a venv). ECharts and the Inter subset are vendored in `assets/` (see `assets/LICENSES.md`); nothing is fetched at build time. `jinja2` is not needed.

## Worked examples

### Real data: USGS earthquakes

`examples/usgs-earthquakes/spec.yaml`: global M5+ earthquakes from the USGS ComCat FDSN event service, `https://earthquake.usgs.gov/fdsnws/event/1/query?format=csv&starttime=2024-10-01&minmagnitude=5&eventtype=earthquake&orderby=time-asc` (no key). Licence: public domain, U.S. Government work (USGS copyright policy). The bundled snapshot ends mid-month, so its last month is flagged incomplete (as the live feed's current month would be). 4 windowed KPIs with deltas, monthly stacked bar by magnitude band, ranked regions, sortable table, monthly-max line, depth/magnitude scatter, region × month heatmap, date + magnitude filters, two tabs.

```bash
python3 $D all examples/usgs-earthquakes/spec.yaml --outdir out/   # offline: bundled snapshot
```
Ships `snapshots/usgs-m5.json` (trimmed snapshot: 4,110 M5+ earthquakes, 1 Oct 2024 to 18 Oct 2026 08:00 UTC; columns id, time, mag, depth, place; public domain), so it builds offline on first run and October 2026 shows as incomplete. For live data, swap the `usgs` source for the `type: csv` URL source shown in the spec's header comment and run with network; the same query works on both.

### Connector snapshot: AI agent usage (EXAMPLE DATA)

`examples/usage-snapshot/`: the snapshot pattern end to end. `snapshots/usage.json` is a frozen, connector-shaped pull (`pulled_at`, `pulled_from`, `query`, `rows`) of **fake, seeded numbers**, clearly labelled EXAMPLE DATA in the file, title, subtitle, source and footnote: daily requests, input/output tokens and cost by product, agent and model (no real usage). Tokens, requests and cost KPIs over the last 30 days with deltas, weekly tokens by product, cost by model, requests per agent per day, an agent × week heatmap, a cost table; `display_tz: Europe/London`. Builds fully offline:

```bash
python3 $D all examples/usage-snapshot/spec.yaml --outdir out/
```
To make it real: replace the snapshot with an actual connector pull (same keys, rows exactly as returned), drop the EXAMPLE labels, re-run.

## Common issues

| Problem | Fix |
|---|---|
| `check`: hardcoded number in text | move it into data, or add a defined term (e.g. `M5+`) to `dashboard.allow_terms` |
| `check`: units missing | `units:` on the widget/column, a `percent`/`currency` format, or `unitless: true` on a table column |
| Timestamp columns shifted | store UTC; tz-aware columns are converted to UTC and written with `Z`; naive ones are treated as UTC |
| `data_through` warning | add `data_through: {column: <date col>}` or an explicit date for static files |
| Page heavy / slow | aggregate in SQL to the grain the widgets need; ~1.1 MB of every file is ECharts |
| Chart blank in export | widget field typo (see `check`), or no dated rows in range |
| `build`: `data/<id>.json missing` | run `refresh` (or `all`) first |
| `--offline: no cached download` | run one `refresh` without `--offline` (network) to fill `.cache/` |
| URL source fails | `refresh --offline` reuses the last cached download; secrets go in `${ENV_VAR}` inside `headers`/`params`, never in the spec text |

## Files

- `scripts/dash.py`: CLI (init, refresh, build, check, export, all)
- `assets/app.js`, `app.css`, `template.html`: page runtime and design system; `echarts.min.js`, `inter-var-latin.woff2`, licences
- `references/spec-reference.md`: every spec key; `references/design-rules.md`: chart and layout rules
- `examples/usgs-earthquakes/`: real-data example (spec + bundled `snapshots/usgs-m5.json`; `data/` and `.cache/` are generated and gitignored)
- `examples/usage-snapshot/`: connector-snapshot example with fake EXAMPLE numbers (offline)
