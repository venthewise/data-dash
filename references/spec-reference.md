# data-dash spec reference

One YAML file. Paths are relative to the spec's folder. Top-level keys: `dashboard`, `sources`, `datasets`, `filters`, `sections` (or a flat `widgets` list).

## dashboard

| Key | Default | Meaning |
|---|---|---|
| `title` | `Dashboard` | page title (no digits; see `allow_terms`) |
| `subtitle` | – | the question the dashboard answers |
| `theme` | `light` | `light` or `dark` |
| `colors` | – | override theme tokens: `accent`, `ink`, `muted`, `bg`, `card`, `border`, `faint`, `up`, `down`, `series: [...]` (checked for contrast) |
| `layout` | `{sections: stacked}` | `{sections: tabs}` renders sections as tabs |
| `locale` | `en-US` | number/date formatting (`en-GB`, `de-DE`, ...) |
| `display_tz` | – | IANA zone (`Europe/London`, `America/New_York`, `UTC`) for displayed header/footer/drawer times (data through, refreshed, fetched/pulled), labelled `Europe/London (UTC+1)`. Converted at build with Python `zoneinfo`; invalid names fail the build (Windows: `pip install tzdata`). Without it: data through in UTC (`… UTC`, date-only `… (UTC day)`), refreshed in its written offset (`… UTC+1`). Display only; date-only data through, buckets and completeness stay UTC |
| `font` | `inter` | `inter` (embedded subset, 31 KB) or `system` |
| `allow_terms` | `[]` | defined terms that contain digits and are not reported numbers, e.g. `["M5+", "Q4 plan", "COVID-19"]` |
| `footnote` | – | method notes shown in the footer |
| `output` | `index.html` | default build path |
| `embed_limit` | `50000` | max rows per dataset (refresh fails above it) |
| `animation` | `false` | ECharts animation (off keeps exports deterministic) |

## sources

Mapping `id -> source`. `id` must be a SQL identifier; it becomes a DuckDB table you query by name. Common keys: `type`, `path` or `url`, `title`, `licence`, `options` (passed to DuckDB's reader). URLs are downloaded with Python into `.cache/` on refresh (`refresh --offline` reuses them; the cache is gitignored, so the first refresh needs network). `${ENV_VAR}` inside `url`, `headers`, `params` is read at refresh time; headers/params are never embedded in the HTML.

| type | Keys | Notes |
|---|---|---|
| `csv` | `path`/`url`, `options` | `read_csv(auto_detect=true, ...)`; e.g. `options: {delim: ";", header: true, dateformat: "%d/%m/%Y"}` |
| `gsheet` | `url` (published CSV link) or `sheet_id` + `gid` | uses `.../export?format=csv&gid=` (sheet must be published or link-viewable) |
| `parquet` | `path`/`url` | `read_parquet` |
| `json` | `path`/`url`, optional `records`, `fields` | plain JSON/NDJSON via `read_json_auto`; with `records`/`fields`, mapped like `api` |
| `api` | `url`, `params`, `headers`, `records`, `fields`, `paginate` | HTTP JSON. `records`: path to the list (`$.data.items[*]`, `$[*]`); `fields`: `{column: path}` per record (`$.author.login`, `$.tags[0]`, `$['odd key']`). `paginate: {param: page, start: 1, max_pages: 5}` stops on an empty page |
| `xlsx` | `path`/`url`, `sheet`, `skip_rows` | needs `openpyxl`; first non-skipped row is the header |
| `sqlite` | `path`, `table` or `query` | read-only |
| `duckdb` | `path`, optional `table`/`query` | attached read-only as `<id>_db`; with `table`, also exposed as `<id>` |
| `snapshot` | `path` | agent-written connector pull: `{pulled_at, pulled_from, query, rows: [{...}]}` or `{columns: [...], rows: [[...]]}`; `pulled_at` shows in the drawer |

## datasets

List. Each becomes `data/<id>.json` and is embedded in the page if a widget uses it (or `embed: true`).

| Key | Meaning |
|---|---|
| `id` | identifier used by widgets and filters |
| `title`, `description` | shown in the Sources drawer and footer |
| `query` (or `sql`) | DuckDB SQL over source tables. Return row-level or lightly aggregated rows; the page aggregates per widget and filter |
| `formula` + `from` (+ `where`, `as`) | shorthand for a one-row metric: `select <formula> as value from <from>` |
| `source` | shorthand for `select * from <source>` |
| `date_column` | the dataset's main date/timestamp column (filters, KPI windows, time buckets) |
| `data_through` | `{column: c}` = max(c) of the result (preferred); `"2026-09-30"` = explicit (for static files, state the real coverage end); `{sql: "select max(d) from src"}`. Never today |
| `data_from` | coverage start, e.g. the API's `starttime`. Default: min(date_column). Deltas whose prior window starts before it show "No comparison" |
| `embed_limit` | per-dataset row cap |

Column types are inferred from DuckDB: number, date (`YYYY-MM-DD`), datetime (ISO, UTC, `Z` if tz-aware), string, bool. A date-only `data_through` covers that whole day.

## filters

| Key | Meaning |
|---|---|
| `id`, `label` | identity and label |
| `type` | `date_range` or `category` |
| `field` | column to filter (date filters default to each dataset's `date_column`) |
| `fields` | per-dataset override `{dataset_id: column}` |
| `datasets` | restrict to these datasets (default: every dataset that has the field) |
| `presets` | date presets relative to data through: `[{label: All}, {label: Last 12 months, months: 12}, {label: Last 90 days, days: 90}]` |
| `values`, `default`, `all_label` | category chip order, preselected values, label of the "All" chip |

## sections and widgets

`sections: [{title, description, widgets: [...]}]`. Common widget keys:

| Key | Meaning |
|---|---|
| `type` | `kpi`, `line`, `area`, `bar`, `stacked_bar`, `pie`, `donut`, `scatter`, `table`, `heatmap` |
| `id` | optional (auto `w1`, `w2`, ...) |
| `title`, `subtitle` | text (no digits unless in `allow_terms`) |
| `dataset` | dataset id |
| `format` | `number` / `currency` / `percent` / `date`, or `{type, decimals, currency: EUR, compact: true, input: 100}` (`input: 100` when percents are stored 0-100) |
| `units` | shown next to values / as the value-axis name (`earthquakes`, `km`, `orders`) |
| `where` | widget-level row filter: `[{field, op, value}]`, ops `= != > >= < <= in not_null` |
| `span`, `span_tablet`, `span_mobile` | grid columns out of 12 (defaults: KPI 3/6/12, chart 6/12/12, table 12) |
| `height` | chart height px (default 300) |
| `period` | `false` hides the generated period caption |

Measures: `y: {field, agg, label}` (or `y: field` + `agg`), list for several measures; `value: {field, agg}` for KPI/heatmap. `agg`: `count` (default without field), `sum` (default with field), `avg`, `min`, `max`, `median`, `distinct`, `first`, `last`.

| Type | Keys |
|---|---|
| `kpi` | `value`, `window: {days\|weeks\|months\|years: n}` ending at data through (or at the date filter's end), `delta: pct\|abs\|none`, `good: up\|down\|neutral`, `detail_field` (row of the max/min), `date` (override date column) |
| `line` / `area` | `x` (date column), `grain: hour\|day\|week\|month\|quarter\|year`, `y`, `series` (split column), `series_order`, `max_series` (default 6, rest = Other), `colors`, `color_map`, `y_scale` (don't force zero), `partial: false` (disables flagging; check FAILs) |
| `bar` / `stacked_bar` | time x as above, or categorical `x`: `orientation: horizontal` (ranked), `limit` (default 10 horizontal / 12 vertical), `sort: value\|label`, `x_plural` (for "Top 10 of 150 regions"), `labels: false` |
| `pie` / `donut` | `x` (category), `value`/`y`, `limit` (max 6 slices, rest = Other). Use for 2-5 parts of a whole only |
| `scatter` | `x`, `y` numeric columns, `x_format`, `x_units`, `x_label`, `y_label`, `series`, `label_field` (tooltip title), `y_inverse`, `symbol_size`, `opacity` |
| `heatmap` | `x` (date with `grain`, or category with `x_limit`), `y` category, `y_limit` (top N by count), `value` |
| `table` | `columns: [{field, label, format, units, unitless, wrap, hide_mobile}]`, `sort: {field, dir}`, `limit` (default 50). Headers sort on click |

## Output files

- `data/<id>.json`: `{id, title, description, query, columns:[{name,type}], rows:[[...]], row_count, refreshed_at, data_through, data_through_rule, data_from, data_from_rule, date_column, sources:[{id,title,type,location,licence,fetched_at|file_modified|pulled_at,rows}]}`. With `display_tz`, the embedded copy also carries `display: {data_through, refreshed_at, sources}` (converted ISO strings, display only)
- `index.html`: everything inlined; `window.dashReady`, `window.dashReport` (widget values, partial flags), `window.dashShowAll()`, `window.dashOpenSource(id)`, `window.dashCsv(id)` for automation.
