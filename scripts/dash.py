#!/usr/bin/env python3
"""data-dash: spec-driven, self-contained HTML dashboards (DuckDB + Apache ECharts).

  init    <dir>                         scaffold spec.yaml + EXAMPLE data
  refresh <spec>                        run every dataset query in DuckDB -> data/<id>.json
  build   <spec> [--out index.html]     one self-contained offline HTML file
  check   <spec|html> [--no-browser]    review checklist; exit 1 on any FAIL
  export  <html> [--png d.png --mobile m.png --pdf out.pdf]
  all     <spec> [--outdir DIR]         refresh + build + check + export

Rules baked in: data_through comes from the data (max of a declared column) or an
explicit declaration, never from today's date; every number on the page traces to a
dataset; units are labelled; incomplete last periods are flagged.
"""
from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import decimal
import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

VERSION = "1.1.0"
SKILL_DIR = Path(__file__).resolve().parent.parent
ASSETS = SKILL_DIR / "assets"
ECHARTS = ASSETS / "echarts.min.js"
FONT = ASSETS / "inter-var-latin.woff2"
UA = "data-dash/%s (+https://echarts.apache.org)" % VERSION

THEMES = {
    "light": {
        "bg": "#F6F6F3", "card": "#FFFFFF", "ink": "#15171C", "muted": "#596070",
        "faint": "#ECECE7", "faintStrong": "#C9CBD1", "border": "#E0E0D9",
        "accent": "#2251C9", "up": "#17703F", "down": "#B42318",
        "hatch": "rgba(255,255,255,0.7)", "heatLow": "#EEF2FC", "scheme": "light",
        "series": ["#2251C9", "#C2521A", "#17803F", "#8E3B9E", "#5F6B7A", "#9A7400"],
    },
    "dark": {
        "bg": "#0E1013", "card": "#16191E", "ink": "#E9EBEE", "muted": "#A3ABB7",
        "faint": "#23272E", "faintStrong": "#4A505A", "border": "#2B3038",
        "accent": "#7EA6FF", "up": "#5BC08A", "down": "#FF8A80",
        "hatch": "rgba(0,0,0,0.55)", "heatLow": "#1C2230", "scheme": "dark",
        "series": ["#7EA6FF", "#F0A060", "#5BC08A", "#D19AE6", "#A8B3C2", "#E3C35A"],
    },
}
FONT_STACK_SYSTEM = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

WIDGET_TYPES = {"kpi", "line", "area", "bar", "stacked_bar", "pie", "donut", "scatter", "table", "heatmap"}
TIME_GRAINS = {"hour", "day", "week", "month", "quarter", "year"}


# ----------------------------------------------------------------- utils
def die(msg: str, code: int = 2):
    print("data-dash: " + msg, file=sys.stderr)
    sys.exit(code)


def now_iso() -> str:
    return dt.datetime.now().astimezone().replace(microsecond=0).isoformat()


def need(mod: str, hint: str):
    try:
        return __import__(mod)
    except ImportError:
        die(f"missing Python package '{mod}'. Install: {hint}")


def load_yaml(path: Path) -> dict:
    yaml = need("yaml", "pip install pyyaml")
    with open(path, encoding="utf-8") as fh:
        spec = yaml.safe_load(fh) or {}
    if not isinstance(spec, dict):
        die(f"{path}: spec must be a mapping")
    spec.setdefault("dashboard", {})
    spec.setdefault("sources", {})
    spec.setdefault("datasets", [])
    spec.setdefault("filters", [])
    if "sections" not in spec:
        spec["sections"] = [{"title": None, "widgets": spec.get("widgets", [])}]
    if isinstance(spec["sources"], list):
        spec["sources"] = {s["id"]: s for s in spec["sources"]}
    return spec


ENV_RE = re.compile(r"\$\{([A-Z0-9_]+)\}")


def expand_env(v):
    """${VAR} in URLs/headers/params is read from the environment at refresh time (never stored)."""
    if isinstance(v, str):
        def rep(m):
            if m.group(1) not in os.environ:
                die(f"environment variable {m.group(1)} is not set")
            return os.environ[m.group(1)]
        return ENV_RE.sub(rep, v)
    if isinstance(v, dict):
        return {k: expand_env(x) for k, x in v.items()}
    if isinstance(v, list):
        return [expand_env(x) for x in v]
    return v


def qident(s: str) -> str:
    return '"' + s.replace('"', '""') + '"'


def qlit(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(qlit(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ", ".join(f"{qlit(str(k))}: {qlit(x)}" for k, x in v.items()) + "}"
    return "'" + str(v).replace("'", "''") + "'"


# ----------------------------------------------------------------- JSONPath-ish
_TOK = re.compile(r"\.([A-Za-z_][\w\-]*)|\[(\d+|\*)\]|\['([^']+)'\]|\[\"([^\"]+)\"\]")


def jpath(obj, path: str | None):
    """Minimal JSONPath: $.a.b, $.a[0].b, $.a[*].b, $['odd key']. Returns a list when [*] is used."""
    if path in (None, "", "$"):
        return obj
    p = path.strip()
    if p.startswith("$"):
        p = p[1:]
    elif not p.startswith((".", "[")):
        p = "." + p
    cur = [obj]
    multi = False
    pos = 0
    while pos < len(p):
        m = _TOK.match(p, pos)
        if not m:
            die(f"unsupported path syntax: {path!r} at {p[pos:]!r}")
        pos = m.end()
        key = m.group(1) or m.group(3) or m.group(4)
        nxt = []
        for c in cur:
            if key is not None:
                if isinstance(c, dict) and key in c:
                    nxt.append(c[key])
                elif isinstance(c, list):  # implicit map over lists
                    nxt.extend(x.get(key) for x in c if isinstance(x, dict))
                    multi = True
                else:
                    nxt.append(None)
            elif m.group(2) == "*":
                multi = True
                if isinstance(c, list):
                    nxt.extend(c)
                elif isinstance(c, dict):
                    nxt.extend(c.values())
            else:
                i = int(m.group(2))
                nxt.append(c[i] if isinstance(c, list) and i < len(c) else None)
        cur = nxt
    return cur if multi else (cur[0] if cur else None)


# ----------------------------------------------------------------- sources
class Ctx:
    def __init__(self, spec_path: Path, offline: bool = False):
        self.base = spec_path.parent
        self.cache = self.base / ".cache"
        self.offline = offline


def fetch(ctx: Ctx, url: str, headers=None, params=None, suffix=".bin") -> tuple[Path, dict]:
    url = expand_env(url)
    if params:
        params = expand_env(params)
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    ctx.cache.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(url.encode()).hexdigest()[:16]
    dest = ctx.cache / (key + suffix)
    meta_p = ctx.cache / (key + ".meta.json")
    if ctx.offline:
        if not dest.exists():
            die(f"--offline: no cached download of {redact(url)} in {ctx.cache}/. The cache is not shipped with "
                f"examples; run `dash.py refresh <spec>` (or `all <spec>`) once WITHOUT --offline (needs network) "
                f"to download it, then --offline works.")
        return dest, json.loads(meta_p.read_text())
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(expand_env(headers) or {})})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            data = r.read()
            info = {"status": r.status, "content_type": r.headers.get("Content-Type"),
                    "last_modified": r.headers.get("Last-Modified"), "link": r.headers.get("Link")}
    except Exception as e:  # noqa: BLE001
        die(f"download failed for {redact(url)}: {e}")
    dest.write_bytes(data)
    meta = {"fetched_at": now_iso(), "bytes": len(data), **info}
    meta_p.write_text(json.dumps(meta))
    return dest, meta


def redact(url: str) -> str:
    return re.sub(r"(?i)((?:token|key|secret|password|sig|auth)[^=]*=)[^&]+", r"\1***", url)


def records_to_table(con, name: str, records: list[dict], ctx: Ctx):
    if not records:
        die(f"source '{name}': 0 records")
    ctx.cache.mkdir(parents=True, exist_ok=True)
    p = ctx.cache / f"_{name}.ndjson"
    with open(p, "w", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r, default=str) + "\n")
    con.execute(f"create or replace table {qident(name)} as select * from read_json_auto({qlit(str(p))}, format='newline_delimited', sample_size=-1)")


def map_records(recs, fields: dict | None):
    if not isinstance(recs, list):
        recs = [recs]
    if not fields:
        return [r if isinstance(r, dict) else {"value": r} for r in recs]
    return [{k: jpath(r, v) for k, v in fields.items()} for r in recs]


def load_source(con, sid: str, src: dict, ctx: Ctx) -> dict:
    t = src.get("type") or guess_type(src)
    loc = src.get("url") or src.get("path")
    meta = {"id": sid, "title": src.get("title", sid), "type": t, "licence": src.get("licence") or src.get("license"),
            "location": redact(loc) if loc and str(loc).startswith("http") else loc}
    if src.get("attribution"):
        meta["attribution"] = src["attribution"]

    def local(suffix):
        if src.get("url"):
            p, fm = fetch(ctx, src["url"], src.get("headers"), src.get("params"), suffix)
            meta.update({"fetched_at": fm["fetched_at"], "bytes": fm["bytes"]})
            return p
        p = (ctx.base / src["path"]).resolve()
        if not p.exists():
            die(f"source '{sid}': file not found: {p}")
        meta["file_modified"] = dt.datetime.fromtimestamp(p.stat().st_mtime).astimezone().replace(microsecond=0).isoformat()
        return p

    opts = src.get("options") or {}
    optsql = "".join(f", {k}={qlit(v)}" for k, v in opts.items())
    if t in ("csv", "gsheet"):
        if t == "gsheet" and not src.get("url"):
            sheet, gid = src["sheet_id"], src.get("gid", 0)
            src = {**src, "url": f"https://docs.google.com/spreadsheets/d/{sheet}/export?format=csv&gid={gid}"}
            meta["location"] = src["url"]
        p = local(".csv")
        con.execute(f"create or replace table {qident(sid)} as select * from read_csv({qlit(str(p))}, auto_detect=true{optsql})")
    elif t == "parquet":
        p = local(".parquet")
        con.execute(f"create or replace table {qident(sid)} as select * from read_parquet({qlit(str(p))}{optsql})")
    elif t in ("json", "api"):
        p = local(".json")
        if t == "json" and not src.get("records") and not src.get("fields"):
            con.execute(f"create or replace table {qident(sid)} as select * from read_json_auto({qlit(str(p))}{optsql})")
        else:
            pages = [json.loads(p.read_text(encoding="utf-8"))]
            pg = src.get("paginate")
            if pg and src.get("url"):  # page-number pagination: {param: page, start: 1, max_pages: 5}
                start = int(pg.get("start", 1))
                for i in range(start + 1, start + int(pg.get("max_pages", 5))):
                    prm = {**(src.get("params") or {}), pg.get("param", "page"): i}
                    q, _ = fetch(ctx, src["url"], src.get("headers"), prm, ".json")
                    body = json.loads(q.read_text(encoding="utf-8"))
                    if not jpath(body, src.get("records")):
                        break
                    pages.append(body)
                meta["pages"] = len(pages)
            recs = []
            for body in pages:
                r = jpath(body, src.get("records"))
                recs.extend(r if isinstance(r, list) else [r])
            records_to_table(con, sid, map_records(recs, src.get("fields")), ctx)
    elif t == "xlsx":
        openpyxl = need("openpyxl", "pip install openpyxl")
        p = local(".xlsx")
        wb = openpyxl.load_workbook(p, read_only=True, data_only=True)
        ws = wb[src["sheet"]] if src.get("sheet") else wb.worksheets[0]
        it = ws.iter_rows(values_only=True)
        for _ in range(int(src.get("skip_rows", 0))):
            next(it)
        hdr = [str(h) if h is not None else f"col{i}" for i, h in enumerate(next(it))]
        recs = []
        for row in it:
            if row is None or all(v is None for v in row):
                continue
            recs.append({h: (v.isoformat() if isinstance(v, (dt.date, dt.datetime)) else v) for h, v in zip(hdr, row)})
        records_to_table(con, sid, recs, ctx)
    elif t == "sqlite":
        p = local(".sqlite")
        sq = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
        sq.row_factory = sqlite3.Row
        q = src.get("query") or f"select * from {qident(src['table'])}"
        recs = [dict(r) for r in sq.execute(q).fetchall()]
        sq.close()
        records_to_table(con, sid, recs, ctx)
        meta["query"] = q
    elif t == "duckdb":
        p = local(".duckdb")
        alias = f"{sid}_db"
        con.execute(f"attach {qlit(str(p))} as {qident(alias)} (read_only)")
        if src.get("table") or src.get("query"):
            q = src.get("query") or f"select * from {qident(alias)}.{qident(src['table'])}"
            con.execute(f"create or replace view {qident(sid)} as {q}")
        meta["note"] = f"attached as {alias}"
    elif t == "snapshot":
        p = local(".json")
        snap = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(snap, list):
            snap = {"rows": snap}
        rows = snap.get("rows") or []
        if snap.get("columns") and rows and isinstance(rows[0], list):
            rows = [dict(zip(snap["columns"], r)) for r in rows]
        records_to_table(con, sid, rows, ctx)
        for k in ("pulled_at", "pulled_from", "pulled_by", "query"):
            if snap.get(k):
                meta[k] = snap[k]
        if not snap.get("pulled_at"):
            print(f"  WARN snapshot '{sid}' has no pulled_at; freshness of the pull is unknown", file=sys.stderr)
    else:
        die(f"source '{sid}': unknown type {t!r}")
    n = con.execute(f"select count(*) from {qident(sid)}").fetchone()[0] if t != "duckdb" or src.get("table") or src.get("query") else None
    meta["rows"] = n
    return meta


def guess_type(src: dict) -> str:
    loc = (src.get("url") or src.get("path") or "").lower().split("?")[0]
    for ext, t in ((".csv", "csv"), (".tsv", "csv"), (".parquet", "parquet"), (".json", "json"), (".ndjson", "json"),
                   (".xlsx", "xlsx"), (".sqlite", "sqlite"), (".db", "sqlite"), (".duckdb", "duckdb")):
        if loc.endswith(ext):
            return t
    die(f"cannot infer source type for {loc!r}; set type:")


# ----------------------------------------------------------------- refresh
def col_kind(tp: str) -> str:
    tp = tp.upper()
    if tp == "DATE":
        return "date"
    if tp.startswith("TIMESTAMP") or tp == "DATETIME":
        return "datetime"
    if any(tp.startswith(x) for x in ("TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UBIGINT", "UINTEGER",
                                       "USMALLINT", "UTINYINT", "FLOAT", "DOUBLE", "DECIMAL", "REAL")):
        return "number"
    if tp == "BOOLEAN":
        return "bool"
    return "string"


def jsonable(v, kind: str):
    if v is None:
        return None
    if isinstance(v, float):
        return None if (math.isnan(v) or math.isinf(v)) else (round(v, 10) if abs(v) < 1e15 else v)
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, dt.datetime):
        if v.tzinfo is not None:
            v = v.astimezone(dt.timezone.utc).replace(tzinfo=None)
            return v.isoformat(timespec="seconds") + "Z"
        return v.isoformat(timespec="seconds")
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, (dt.time, dt.timedelta)):
        return str(v)
    if isinstance(v, (bytes, bytearray)):
        return base64.b64encode(v).decode()
    if isinstance(v, (list, dict)):
        return json.dumps(v, default=str)
    return v


def dataset_sql(ds: dict) -> str:
    if ds.get("query") or ds.get("sql"):
        return (ds.get("query") or ds.get("sql")).strip()
    if ds.get("formula"):
        frm = ds.get("from") or ds.get("source")
        if not frm:
            die(f"dataset '{ds['id']}': formula needs from:")
        where = f"\nwhere {ds['where']}" if ds.get("where") else ""
        return f"select {ds['formula']} as {qident(ds.get('as', 'value'))}\nfrom {qident(frm)}{where}"
    if ds.get("source"):
        return f"select * from {qident(ds['source'])}"
    die(f"dataset '{ds['id']}': needs query, formula or source")


def scalar(con, sql: str):
    rel = con.sql(sql)
    t = str(rel.types[0]).upper()
    if t in ("TIMESTAMP WITH TIME ZONE", "TIMESTAMPTZ"):
        v = con.sql(f"select timezone('UTC', {qident(rel.columns[0])}) from ({sql}) as _q").fetchone()[0]
        return None if v is None else v.isoformat(timespec="seconds") + "Z"
    return jsonable(rel.fetchone()[0], "")


def cmd_refresh(spec_path: Path, offline=False, quiet=False) -> list[dict]:
    duckdb = need("duckdb", "pip install duckdb")
    spec = load_yaml(spec_path)
    ctx = Ctx(spec_path, offline)
    con = duckdb.connect(":memory:")
    con.execute("SET TimeZone='UTC'")
    src_meta = {}
    for sid, src in spec["sources"].items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", sid):
            die(f"source id {sid!r} must be a SQL identifier")
        src_meta[sid] = load_source(con, sid, src, ctx)
        if not quiet:
            print(f"  source {sid:<18} {src_meta[sid]['type']:<8} rows={src_meta[sid].get('rows')}")
    out_dir = spec_path.parent / "data"
    out_dir.mkdir(exist_ok=True)
    refreshed = now_iso()
    results = []
    for ds in spec["datasets"]:
        did = ds.get("id") or die("every dataset needs id:")
        sql = dataset_sql(ds)
        try:
            rel = con.sql(sql)
            cols = list(rel.columns)
            tps = [str(t) for t in rel.types]
            kinds = [col_kind(t) for t in tps]
            tz = [t.upper() in ("TIMESTAMP WITH TIME ZONE", "TIMESTAMPTZ") for t in tps]
            if any(tz):  # normalise to naive UTC; written with a trailing Z
                proj = ", ".join((f"timezone('UTC', {qident(c)}) as {qident(c)}" if z else qident(c)) for c, z in zip(cols, tz))
                rel = con.sql(f"select {proj} from ({sql}) as _q")
            raw_rows = rel.fetchall()
        except Exception as e:  # noqa: BLE001
            die(f"dataset '{did}': query failed: {e}")
        rows = [[(jsonable(v, k) + "Z" if (z and v is not None) else jsonable(v, k)) for v, k, z in zip(r, kinds, tz)] for r in raw_rows]
        limit = int(ds.get("embed_limit", spec["dashboard"].get("embed_limit", 50000)))
        if len(rows) > limit:
            die(f"dataset '{did}': {len(rows)} rows > embed_limit {limit}. Aggregate in SQL (the page embeds every row).")
        # data_through: declared column max, explicit value, or SQL. NEVER today's date.
        dthr = ds.get("data_through")
        date_col = ds.get("date_column")
        through = frm = rule = from_rule = None
        if isinstance(dthr, dict) and dthr.get("column"):
            date_col = date_col or dthr["column"]
            c = dthr["column"]
            if c not in cols:
                die(f"dataset '{did}': data_through column {c!r} not in result columns {cols}")
            i = cols.index(c)
            vals = [r[i] for r in rows if r[i] is not None]
            through = max(vals) if vals else None
            rule = f"max({c})"
        elif isinstance(dthr, dict) and dthr.get("sql"):
            through = scalar(con, dthr["sql"])
            rule = "declared query"
        elif isinstance(dthr, (str, dt.date)):
            through = jsonable(dthr, "") if not isinstance(dthr, str) else dthr
            rule = "declared"
        elif date_col and date_col in cols:
            i = cols.index(date_col)
            vals = [r[i] for r in rows if r[i] is not None]
            through = max(vals) if vals else None
            rule = f"max({date_col})"
        if isinstance(through, str) and through.lower() in ("today", "now"):
            die(f"dataset '{did}': data_through may not be '{through}'; derive it from the data")
        dfrom = ds.get("data_from")
        if dfrom:
            frm = jsonable(dfrom, "") if not isinstance(dfrom, str) else dfrom
            from_rule = "declared"
        elif date_col and date_col in cols:
            i = cols.index(date_col)
            vals = [r[i] for r in rows if r[i] is not None]
            frm = min(vals) if vals else None
            from_rule = f"min({date_col})"
        used = [m for sid, m in src_meta.items() if re.search(r"\b" + re.escape(sid) + r"(_db)?\b", sql)]
        out = {
            "id": did, "title": ds.get("title", did), "description": ds.get("description", ""),
            "query": sql, "columns": [{"name": c, "type": k} for c, k in zip(cols, kinds)],
            "rows": rows, "row_count": len(rows), "refreshed_at": refreshed,
            "data_through": through, "data_through_rule": rule, "data_from": frm, "data_from_rule": from_rule,
            "date_column": date_col, "sources": used, "generator": f"data-dash {VERSION}",
        }
        if through is None:
            print(f"  WARN dataset '{did}': no data_through (declare data_through: {{column: ...}} or a date)", file=sys.stderr)
        (out_dir / f"{did}.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        results.append(out)
        if not quiet:
            print(f"  dataset {did:<17} rows={len(rows):<6} data_through={through} ({rule})")
    con.close()
    return results


# ----------------------------------------------------------------- build
def theme_for(spec) -> dict:
    d = spec["dashboard"]
    name = d.get("theme", "light")
    if name not in THEMES:
        die(f"theme must be one of {list(THEMES)}")
    t = json.loads(json.dumps(THEMES[name]))
    for k, v in (d.get("colors") or {}).items():
        t[k] = v
    return t


def strip_private(src: dict) -> dict:
    return {k: v for k, v in src.items() if k not in ("headers", "params")}


def tz_label(d: dt.datetime) -> str:
    off = d.utcoffset() or dt.timedelta(0)
    mins = int(off.total_seconds() // 60)
    if mins == 0:
        return "UTC"
    sign = "+" if mins > 0 else "-"
    h, m = divmod(abs(mins), 60)
    return f"UTC{sign}{h}" + (f":{m:02d}" if m else "")


def parse_iso(s):
    """ISO string -> aware datetime (naive and trailing Z are UTC). Date-only strings return None."""
    if not isinstance(s, str) or re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return None
    try:
        d = dt.datetime.fromisoformat(s.replace("Z", "+00:00").replace(" ", "T"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


def display_zone(spec: dict):
    """dashboard.display_tz (IANA name) -> ZoneInfo, validated with the stdlib (no pytz)."""
    name = spec["dashboard"].get("display_tz")
    if not name:
        return None
    try:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    except ImportError:
        die("display_tz needs Python 3.9+ (zoneinfo)")
    try:
        return ZoneInfo(str(name))
    except (ZoneInfoNotFoundError, ValueError):
        die(f"dashboard.display_tz {name!r} is not an IANA time zone (e.g. Europe/London, America/New_York, UTC). "
            "On Windows, `pip install tzdata`.")


def display_times(meta: dict, zone) -> dict:
    """Display-only copies of a dataset's times in the display zone. Never changes data_through itself."""
    out = {}
    def conv(s):
        d = parse_iso(s)
        return d.astimezone(zone).replace(microsecond=0).isoformat() if d else None
    for k in ("data_through", "refreshed_at"):
        v = conv(meta.get(k))
        if v:
            out[k] = v
    srcs = {}
    for s in meta.get("sources") or []:
        e = {k: conv(s.get(k)) for k in ("fetched_at", "pulled_at", "file_modified") if conv(s.get(k))}
        if e:
            srcs[s.get("id")] = e
    if srcs:
        out["sources"] = srcs
    return out


def payload_for(spec_path: Path, spec: dict) -> dict:
    data_dir = spec_path.parent / "data"
    used = set()
    for s in spec["sections"]:
        for w in s.get("widgets", []):
            if w.get("dataset"):
                used.add(w["dataset"])
    datasets = {}
    for ds in spec["datasets"]:
        if ds["id"] not in used and not ds.get("embed"):
            continue
        p = data_dir / f"{ds['id']}.json"
        if not p.exists():
            die(f"{p} missing: dataset '{ds['id']}' has not been refreshed. Run `dash.py refresh {spec_path}` "
                f"(or `dash.py all {spec_path}`) first; URL sources need network on the first refresh.")
        datasets[ds["id"]] = json.loads(p.read_text(encoding="utf-8"))
    zone = display_zone(spec)
    if zone is not None:
        for d in datasets.values():
            d["display"] = display_times(d, zone)
    missing = used - set(datasets)
    if missing:
        die(f"widgets reference unknown datasets: {sorted(missing)}")
    dash = dict(spec["dashboard"])
    dash.pop("embed_limit", None)
    return {
        "generator": f"data-dash {VERSION}", "built_at": now_iso(), "dashboard": dash,
        "theme": theme_for(spec), "filters": spec["filters"], "sections": spec["sections"],
        "datasets": datasets, "sources": {k: strip_private(v) for k, v in spec["sources"].items()},
    }


def font_css(spec) -> tuple[str, str]:
    choice = spec["dashboard"].get("font", "inter")
    if choice == "inter" and FONT.exists():
        b64 = base64.b64encode(FONT.read_bytes()).decode()
        face = ("@font-face{font-family:'Inter DD';font-style:normal;font-weight:400 700;font-display:block;"
                f"src:url(data:font/woff2;base64,{b64}) format('woff2');}}")
        return face, "'Inter DD', " + FONT_STACK_SYSTEM
    return "", FONT_STACK_SYSTEM


def echarts_version() -> str:
    head = ECHARTS.read_text(encoding="utf-8", errors="ignore")[-4000:]
    m = re.search(r'version\s*[:=]\s*"(\d+\.\d+\.\d+)"', ECHARTS.read_text(encoding="utf-8", errors="ignore"))
    return m.group(1) if m else "?"


def cmd_build(spec_path: Path, out: Path | None = None, quiet=False) -> Path:
    spec = load_yaml(spec_path)
    if not ECHARTS.exists():
        die(f"{ECHARTS} missing (see SKILL.md setup)")
    pl = payload_for(spec_path, spec)
    face, stack = font_css(spec)
    t = pl["theme"]
    tvars = "\n".join(f"  --{k}:{v};" for k, v in t.items() if isinstance(v, str)) + f"\n  --font:{stack};"
    data = json.dumps(pl, ensure_ascii=False, separators=(",", ":"), default=str)
    data = data.replace("<", "\\u003c").replace(">", "\\u003e").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    html = (ASSETS / "template.html").read_text(encoding="utf-8")
    lib = ECHARTS.read_text(encoding="utf-8").replace("</script", "<\\/script")
    import html as _h
    rep = {
        "{{LANG}}": spec["dashboard"].get("lang", "en"), "{{THEME}}": spec["dashboard"].get("theme", "light"),
        "{{VERSION}}": VERSION, "{{TITLE}}": _h.escape(spec["dashboard"].get("title", "Dashboard")),
        "{{FONT_FACE}}": face, "{{THEME_VARS}}": tvars, "{{CSS}}": (ASSETS / "app.css").read_text(encoding="utf-8"),
        "{{ECHARTS_VERSION}}": echarts_version(),
    }
    for k, v in rep.items():
        html = html.replace(k, v)
    # big blobs last so placeholders inside them are never touched
    html = html.replace("{{DATA}}", data, 1)
    app = (ASSETS / "app.js").read_text(encoding="utf-8")
    i = html.index("{{ECHARTS}}")
    html = html[:i] + lib + html[i + len("{{ECHARTS}}"):]
    i = html.index("{{APP}}")
    html = html[:i] + app + html[i + len("{{APP}}"):]
    out = out or (spec_path.parent / spec["dashboard"].get("output", "index.html"))
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    if not quiet:
        print(f"  built {out} ({out.stat().st_size/1024:.0f} KB)")
    return out


# ----------------------------------------------------------------- playwright helpers
CHROME_ARGS = ["--force-color-profile=srgb", "--font-render-hinting=none", "--disable-lcd-text", "--hide-scrollbars"]


def pw():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        die("pip install playwright && python3 -m playwright install chromium")
    return sync_playwright


def open_page(browser, html: Path, width: int, scale: float = 1, offline=True, height=900):
    ctx = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=scale, accept_downloads=True)
    page = ctx.new_page()
    errors, requests = [], []
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    if offline:
        def route(r):
            if r.request.url.startswith(("file:", "data:", "blob:")):
                return r.continue_()
            requests.append(r.request.url)
            return r.abort()
        page.route("**/*", route)
    page.goto(html.resolve().as_uri())
    page.wait_for_function("window.dashReady === true", timeout=30000)
    return ctx, page, errors, requests


def wait_ready(page):
    page.wait_for_timeout(50)
    page.wait_for_function("window.dashReady === true", timeout=30000)


def cmd_export(html: Path, png=None, mobile=None, pdf=None, active_only=False, quiet=False):
    html = Path(html)
    png = png or html.with_name("desktop.png")
    mobile = mobile or html.with_name("mobile.png")
    with pw()() as p:
        b = p.chromium.launch(args=CHROME_ARGS)
        for out, width, scale in ((png, 1440, 1), (mobile, 390, 2)):
            if not out:
                continue
            ctx, page, errs, _ = open_page(b, html, width, scale)
            if not active_only:
                page.evaluate("window.dashShowAll && window.dashShowAll()")
                wait_ready(page)
            page.screenshot(path=str(out), full_page=True)
            ctx.close()
            if not quiet:
                print(f"  png {out} ({width}px x{scale})")
            if errs:
                print("  WARN page errors: " + "; ".join(errs), file=sys.stderr)
        if pdf:
            # A4 landscape, 10 mm margins -> 277 mm printable = 1047 CSS px
            ctx, page, errs, _ = open_page(b, html, 1047, 1)
            if not active_only:
                page.evaluate("window.dashShowAll && window.dashShowAll()")
            wait_ready(page)
            page.emulate_media(media="print")
            wait_ready(page)
            page.pdf(path=str(pdf), format="A4", landscape=True, print_background=True,
                     margin={"top": "10mm", "bottom": "10mm", "left": "10mm", "right": "10mm"})
            ctx.close()
            if not quiet:
                print(f"  pdf {pdf}")
        b.close()


# ----------------------------------------------------------------- check
def rel_lum(hexc: str) -> float:
    h = hexc.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a: str, b: str) -> float:
    la, lb = sorted((rel_lum(a), rel_lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


DIGIT_RE = re.compile(r"\d")


def extract_payload(html_text: str) -> dict:
    m = re.search(r'<script type="application/json" id="dash-data">(.*?)</script>', html_text, re.S)
    if not m:
        die("not a data-dash HTML file (no dash-data block)")
    return json.loads(m.group(1))


def widget_fields(w: dict) -> list[str]:
    f = []
    for k in ("x", "series", "date", "detail_field", "label_field"):
        if isinstance(w.get(k), str):
            f.append(w[k])
    if w.get("type") in ("scatter", "heatmap") and isinstance(w.get("y"), str):
        f.append(w["y"])
    elif isinstance(w.get("y"), str):
        f.append(w["y"])
    elif isinstance(w.get("y"), dict) and w["y"].get("field"):
        f.append(w["y"]["field"])
    elif isinstance(w.get("y"), list):
        f += [m if isinstance(m, str) else m.get("field") for m in w["y"] if (isinstance(m, str) or m.get("field"))]
    if isinstance(w.get("value"), dict) and w["value"].get("field"):
        f.append(w["value"]["field"])
    if w.get("field"):
        f.append(w["field"])
    for c in w.get("columns") or []:
        f.append(c if isinstance(c, str) else c.get("field"))
    for c in w.get("where") or []:
        f.append(c.get("field"))
    s = w.get("sort")
    if isinstance(s, dict) and s.get("field"):
        f.append(s["field"])
    elif isinstance(s, str) and s not in ("label", "value"):
        f.append(s)
    return [x for x in f if x]


def static_checks(pl: dict, html_text: str, html_path: Path | None) -> list[tuple[str, str, str]]:
    R = []
    add = lambda st, name, msg="": R.append((st, name, msg))  # noqa: E731
    dsets = pl["datasets"]
    allow = set(pl["dashboard"].get("allow_terms") or [])
    widgets = [w for s in pl["sections"] for w in s.get("widgets", [])]

    # 1 datasets + fields
    bad = []
    for w in widgets:
        wid = w.get("id") or w.get("title")
        if w.get("type") not in WIDGET_TYPES:
            bad.append(f"{wid}: unknown type {w.get('type')!r}")
            continue
        d = dsets.get(w.get("dataset"))
        if not d:
            bad.append(f"{wid}: dataset {w.get('dataset')!r} missing")
            continue
        cols = {c["name"] for c in d["columns"]}
        for f in widget_fields(w):
            if f not in cols:
                bad.append(f"{wid}: field {f!r} not in {w['dataset']}")
        if w.get("grain") and w["grain"] not in TIME_GRAINS:
            bad.append(f"{wid}: grain {w['grain']!r}")
    for f in pl.get("filters", []):
        targets = [i for i, d in dsets.items() if (not f.get("datasets") or i in f["datasets"])
                   and ((f.get("fields") or {}).get(i) or f.get("field") or (d.get("date_column") if f.get("type") == "date_range" else None))
                   in {c["name"] for c in d["columns"]}]
        if not targets:
            bad.append(f"filter {f.get('id') or f.get('label')}: applies to no dataset")
    add("FAIL" if bad else "PASS", "datasets & fields exist", "; ".join(bad) or f"{len(widgets)} widgets, {len(dsets)} datasets")

    # 2 hardcoded numbers in spec text
    texts = []
    for s in pl["sections"]:
        texts += [("section", s.get("title")), ("section", s.get("description"))]
        for w in s.get("widgets", []):
            wid = w.get("id") or w.get("title")
            texts += [(wid, w.get("title")), (wid, w.get("subtitle")), (wid, w.get("note")), (wid, w.get("units")), (wid, w.get("y_label")), (wid, w.get("x_label"))]
            for c in w.get("columns") or []:
                if isinstance(c, dict):
                    texts += [(wid, c.get("label")), (wid, c.get("units"))]
            if isinstance(w.get("y"), list):
                texts += [(wid, m.get("label")) for m in w["y"] if isinstance(m, dict)]
    texts += [("dashboard", pl["dashboard"].get("title")), ("dashboard", pl["dashboard"].get("subtitle"))]
    hard = []
    for where, t in texts:
        if not t:
            continue
        s = str(t)
        for term in sorted(allow, key=len, reverse=True):
            s = s.replace(term, "")
        if DIGIT_RE.search(s):
            hard.append(f"{where}: {t!r}")
    add("FAIL" if hard else "PASS", "no hardcoded numbers in text",
        ("; ".join(hard) + "  (move numbers into data, or list defined terms in dashboard.allow_terms)") if hard else
        ("allow_terms: " + ", ".join(sorted(allow)) if allow else "spec text has no digits"))

    # 3 completeness logic never reads the clock
    m = re.search(r"/\*<data-dash-app>\*/(.*?)/\*</data-dash-app>\*/", html_text, re.S)
    app = m.group(1) if m else ""
    rest = re.sub(r'<script id="echarts-lib">.*?</script>', "", html_text, flags=re.S)
    rest = re.sub(r'<script type="application/json" id="dash-data">.*?</script>', "", rest, flags=re.S)
    clock = re.findall(r"new\s+Date\s*\(\s*\)|Date\.now\s*\(", app + rest)
    add("FAIL" if (clock or not app) else "PASS", "no clock in completeness logic",
        f"found {clock}" if clock else ("app block missing" if not app else "no new Date()/Date.now() outside the vendored chart library"))

    # 4 data_through
    nodt = [i for i, d in dsets.items() if not d.get("data_through")]
    today_rule = [i for i, d in dsets.items() if (d.get("data_through_rule") or "").lower() in ("today", "now")]
    add("FAIL" if (nodt or today_rule) else "PASS", "data_through present",
        ("missing: " + ", ".join(nodt)) if nodt else "; ".join(f"{i}: {d['data_through']} ({d.get('data_through_rule')})" for i, d in dsets.items()))

    # 5 units
    nou = []
    for w in widgets:
        t = w.get("type")
        fmt = w.get("format")
        ftype = fmt if isinstance(fmt, str) else (fmt or {}).get("type")
        has = bool(w.get("units")) or ftype in ("percent", "currency")
        if t in ("kpi", "line", "area", "bar", "stacked_bar", "heatmap", "pie", "donut") and not has:
            nou.append(w.get("id") or w.get("title"))
        if t == "scatter" and (not has or not (w.get("x_units") or (w.get("x_format") or {}) in ("percent", "currency"))):
            nou.append((w.get("id") or w.get("title")) + " (x/y)")
        if t == "table":
            d = dsets.get(w.get("dataset"), {"columns": []})
            types = {c["name"]: c["type"] for c in d["columns"]}
            for c in w.get("columns") or []:
                c = {"field": c} if isinstance(c, str) else c
                cf = c.get("format")
                ct = cf if isinstance(cf, str) else (cf or {}).get("type")
                if types.get(c["field"]) == "number" and not (c.get("units") or ct in ("percent", "currency") or c.get("unitless")):
                    nou.append(f"{w.get('id') or w.get('title')}.{c['field']}")
    add("FAIL" if nou else "PASS", "units labelled", ("missing units: " + ", ".join(nou)) if nou else "every value has units or a %/currency format")

    # 6 partial periods
    pp = []
    for w in widgets:
        if w.get("type") in ("line", "area", "bar", "stacked_bar", "heatmap"):
            d = dsets.get(w.get("dataset"))
            if not d:
                continue
            types = {c["name"]: c["type"] for c in d["columns"]}
            if types.get(w.get("x")) in ("date", "datetime"):
                if w.get("partial") is False:
                    pp.append(f"{w.get('id') or w.get('title')}: partial flagging disabled")
                elif not d.get("data_through"):
                    pp.append(f"{w.get('id') or w.get('title')}: no data_through to judge completeness")
    add("FAIL" if pp else "PASS", "partial periods handled", "; ".join(pp) or "time charts flag incomplete buckets from data_through")

    # 7 contrast
    t = pl["theme"]
    pairs = [("ink/card", t["ink"], t["card"], 4.5), ("ink/bg", t["ink"], t["bg"], 4.5), ("muted/card", t["muted"], t["card"], 4.5),
             ("muted/bg", t["muted"], t["bg"], 4.5), ("accent/card", t["accent"], t["card"], 4.5), ("up/card", t["up"], t["card"], 4.5),
             ("down/card", t["down"], t["card"], 4.5), ("card/ink (buttons)", t["card"], t["ink"], 4.5)]
    pairs += [(f"series{i}/card (graphic)", c, t["card"], 3.0) for i, c in enumerate(t["series"])]
    for w in widgets:
        for i, c in enumerate(w.get("colors") or []):
            if re.fullmatch(r"#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{3}", str(c)):
                pairs.append((f"{w.get('id') or w.get('title')}.colors[{i}]/card (graphic)", c, t["card"], 3.0))
    lows, worst = [], []
    for name, a, b, need_ in pairs:
        r = contrast(a, b)
        worst.append((r / need_, name, r))
        if r < need_:
            lows.append(f"{name} {r:.2f} < {need_}")
    worst.sort()
    add("FAIL" if lows else "PASS", "WCAG AA contrast", "; ".join(lows) if lows else f"lowest: {worst[0][1]} {worst[0][2]:.2f}:1 ({len(pairs)} pairs)")

    # 8 size
    size = len(html_text.encode("utf-8"))
    rows = sum(d["row_count"] for d in dsets.values())
    add("WARN" if size > 8_000_000 else "INFO", "HTML size", f"{size/1024:.0f} KB ({rows} embedded rows; ECharts ~{ECHARTS.stat().st_size//1024} KB)")

    # restraint
    pies = [w for w in widgets if w.get("type") in ("pie", "donut")]
    if len(pies) > 1:
        add("WARN", "restraint", f"{len(pies)} pie/donut charts; prefer bars")
    return R


RUNTIME_JS = r"""
(allow) => {
  const out = {overlaps: [], clipped: [], scrollers: [], strayNumbers: [], chartText: [], pageOverflow: 0, widgets: 0, charts: 0};
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const ws = [...document.querySelectorAll('.w')].filter(vis);
  out.widgets = ws.length;
  const boxes = ws.map(w => ({id: w.dataset.wid, r: w.getBoundingClientRect()}));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i].r, b = boxes[j].r;
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ox > 1 && oy > 1) out.overlaps.push(boxes[i].id + ' x ' + boxes[j].id);
  }
  const textEls = [...document.querySelectorAll('.w *, .top *, .filters *, .foot *')].filter(e => vis(e) && !e.closest('svg') && !e.closest('.chart') && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()));
  for (const e of textEls) {
    const cs = getComputedStyle(e);
    if (e.closest('.tbl-wrap')) continue;
    if (e.scrollWidth > e.clientWidth + 1 && cs.display !== 'inline') out.clipped.push((e.closest('.w') ? e.closest('.w').dataset.wid + ': ' : '') + e.tagName.toLowerCase() + '.' + e.className + ' "' + e.textContent.trim().slice(0, 40) + '"');
    const r = e.getBoundingClientRect(), w = e.closest('.w');
    if (w) { const wr = w.getBoundingClientRect(); if (r.right > wr.right + 1 || r.left < wr.left - 1) out.clipped.push(w.dataset.wid + ': text exceeds card "' + e.textContent.trim().slice(0, 40) + '"'); }
  }
  for (const t of document.querySelectorAll('.tbl-wrap')) if (vis(t) && t.scrollWidth > t.clientWidth + 1) out.scrollers.push(t.closest('.w').dataset.wid);
  out.pageOverflow = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
  // stray numbers: digits inside a widget not produced from data (.dv) or generated (.gen) or inside chart/table data
  const walker = document.createTreeWalker(document.getElementById('sections'), NodeFilter.SHOW_TEXT);
  let n; while ((n = walker.nextNode())) {
    let txt = n.textContent; for (const a of allow) txt = txt.split(a).join('');
    if (!/\d/.test(txt)) continue;
    const p = n.parentElement;
    if (!vis(p)) continue;
    if (p.closest('.dv, .gen, svg, .chart')) continue;
    out.strayNumbers.push((p.closest('.w') ? p.closest('.w').dataset.wid : '?') + ': "' + n.textContent.trim().slice(0, 40) + '"');
  }
  // chart text clipped by its svg
  for (const svg of document.querySelectorAll('.chart svg')) {
    if (!vis(svg)) continue; out.charts++;
    const sr = svg.getBoundingClientRect();
    for (const t of svg.querySelectorAll('text')) {
      const r = t.getBoundingClientRect(); if (!r.width) continue;
      if (r.left < sr.left - 1 || r.right > sr.right + 1 || r.top < sr.top - 1 || r.bottom > sr.bottom + 1) out.chartText.push(svg.closest('.w').dataset.wid + ': "' + t.textContent.slice(0, 30) + '"');
    }
  }
  return out;
}
"""


def runtime_checks(html: Path, allow_terms=()) -> list[tuple[str, str, str]]:
    R = []
    add = lambda st, name, msg="": R.append((st, name, msg))  # noqa: E731
    with pw()() as p:
        b = p.chromium.launch(args=CHROME_ARGS)
        all_errs, all_reqs = [], []
        for width in (1440, 390):
            try:
                ctx, page, errs, reqs = open_page(b, html, width, 1, offline=True)
            except Exception as e:  # noqa: BLE001
                add("FAIL", f"renders offline @{width}", f"dashReady never set: {e}")
                continue
            page.evaluate("window.dashShowAll && window.dashShowAll()")
            wait_ready(page)
            res = page.evaluate(RUNTIME_JS, list(allow_terms))
            rep = page.evaluate("window.dashReport")
            tag = f"@{width}"
            add("FAIL" if res["overlaps"] else "PASS", f"no overlapping widgets {tag}", "; ".join(res["overlaps"]) or f"{res['widgets']} widgets")
            clip = res["clipped"] + [f"page scrolls sideways by {res['pageOverflow']}px"] * (1 if res["pageOverflow"] else 0)
            add("FAIL" if clip else "PASS", f"no clipped text {tag}", "; ".join(clip[:6]) or (f"tables scroll horizontally by design: {', '.join(res['scrollers'])}" if res["scrollers"] else "ok"))
            add("FAIL" if res["chartText"] else "PASS", f"chart labels inside chart {tag}", "; ".join(res["chartText"][:6]) or f"{res['charts']} charts")
            add("FAIL" if res["strayNumbers"] else "PASS", f"every number traces to data {tag}", "; ".join(res["strayNumbers"][:6]) or "numbers only in .dv (data) / .gen (derived) / charts")
            if rep.get("renderTimeouts"):
                add("WARN", f"chart finished events {tag}", f"{rep['renderTimeouts']} charts timed out")
            if width == 1440:
                parts = [f"{w['id']}" for w in rep["widgets"] if (w.get("partial") or {}).get("last") or (w.get("partial") or {}).get("first")]
                add("INFO", "partial periods flagged", ", ".join(parts) if parts else "no incomplete buckets in current data")
                # drawer + CSV
                try:
                    first = page.locator("[data-src]").first
                    first.click()
                    page.wait_for_selector("#drawer:not([hidden])", timeout=3000)
                    sql = page.inner_text("#drawer .sql")
                    ov = page.evaluate("(() => { const b = document.getElementById('drawer-body'); const bad = [...b.querySelectorAll('p, dl, h3, .srcl, .btns, pre, .tbl-wrap')].filter(e => e.getBoundingClientRect().right > b.getBoundingClientRect().right + 1).length; return {sw: b.scrollWidth, cw: b.clientWidth, bad}; })()")
                    add("FAIL" if (ov["bad"] or ov["sw"] > ov["cw"] + 1) else "PASS", "source drawer fits", f"{ov['bad']} elements overflow the drawer" if ov["bad"] else "content within drawer width")
                    with page.expect_download(timeout=5000) as dl:
                        page.click("#dl-csv")
                    path = dl.value.path()
                    text = Path(path).read_text(encoding="utf-8-sig")
                    nrows = sum(1 for _ in csv.reader(text.splitlines())) - 1
                    did = first.get_attribute("data-src")
                    exp = page.evaluate(f"JSON.parse(document.getElementById('dash-data').textContent).datasets[{json.dumps(did)}].row_count")
                    ok = bool(sql.strip()) and nrows == exp
                    add("PASS" if ok else "FAIL", "source drawer + CSV download", f"{did}: SQL shown, CSV {nrows}/{exp} rows")
                except Exception as e:  # noqa: BLE001
                    add("FAIL", "source drawer + CSV download", str(e)[:200])
            all_errs += errs
            all_reqs += reqs
            ctx.close()
        add("FAIL" if all_errs else "PASS", "console errors = 0", "; ".join(all_errs[:5]) or "0 errors")
        add("FAIL" if all_reqs else "PASS", "works offline (no network requests)", "; ".join(all_reqs[:5]) or "0 external requests")
        b.close()
    return R


def cmd_check(target: Path, browser=True) -> int:
    target = Path(target)
    if target.suffix in (".yaml", ".yml"):
        spec = load_yaml(target)
        html = target.parent / spec["dashboard"].get("output", "index.html")
        if not html.exists():
            die(f"{html} not built yet: run build first")
    else:
        html = target
    text = html.read_text(encoding="utf-8")
    pl = extract_payload(text)
    res = static_checks(pl, text, html)
    if browser:
        res += runtime_checks(html, pl["dashboard"].get("allow_terms") or [])
    w = max(len(r[1]) for r in res)
    for st, name, msg in res:
        print(f"  {st:<4}  {name:<{w}}  {msg}")
    fails = sum(1 for r in res if r[0] == "FAIL")
    print(f"  {'FAILED' if fails else 'PASSED'}: {fails} fail, {sum(1 for r in res if r[0]=='WARN')} warn, {sum(1 for r in res if r[0]=='PASS')} pass")
    return 1 if fails else 0


# ----------------------------------------------------------------- init
SAMPLE_SPEC = """# data-dash spec. Docs: <skill>/references/spec-reference.md
dashboard:
  title: Example orders dashboard
  subtitle: EXAMPLE DATA (synthetic, generated by `dash.py init`). Replace with real sources before sharing.
  theme: light            # light | dark
  layout: {sections: tabs}
  locale: en-US

sources:
  orders:
    type: csv
    path: sample/orders.csv
    title: Example orders (synthetic)
    licence: example data, not real

datasets:
  - id: orders
    title: Orders (example)
    description: One row per order. Synthetic example data.
    query: |
      select order_date, region, product, units, revenue
      from orders
    date_column: order_date
    data_through: {column: order_date}

filters:
  - id: date
    type: date_range
    label: Order date
    presets: [{label: All}, {label: Last 3 months, months: 3}]
  - id: region
    type: category
    field: region
    label: Region

sections:
  - title: Overview
    widgets:
      - {type: kpi, title: Revenue, dataset: orders, value: {field: revenue, agg: sum}, format: {type: currency, currency: USD}, window: {months: 1}, delta: pct, good: up}
      - {type: kpi, title: Orders, dataset: orders, value: {agg: count}, units: orders, window: {months: 1}, delta: pct, good: up}
      - {type: kpi, title: Units sold, dataset: orders, value: {field: units, agg: sum}, units: units, window: {months: 1}, delta: pct, good: up}
      - {type: kpi, title: Average order value, dataset: orders, value: {field: revenue, agg: avg}, format: {type: currency, currency: USD, decimals: 2}, window: {months: 1}, delta: pct, good: up}
      - {type: stacked_bar, title: Revenue by month, subtitle: By region, dataset: orders, x: order_date, grain: month, y: {field: revenue, agg: sum}, series: region, format: {type: currency, currency: USD}, span: 8}
      - {type: bar, orientation: horizontal, title: Top products, subtitle: Revenue, dataset: orders, x: product, y: {field: revenue, agg: sum}, format: {type: currency, currency: USD}, limit: 8, x_plural: products, span: 4}
  - title: Detail
    widgets:
      - {type: line, title: Orders per week, dataset: orders, x: order_date, grain: week, y: {agg: count}, units: orders, span: 12}
      - type: table
        title: Largest orders
        dataset: orders
        sort: {field: revenue, dir: desc}
        limit: 15
        columns:
          - {field: order_date, label: Date}
          - {field: region, label: Region}
          - {field: product, label: Product}
          - {field: units, label: Units, units: units}
          - {field: revenue, label: Revenue, format: {type: currency, currency: USD, decimals: 2}}
"""


def cmd_init(d: Path):
    d.mkdir(parents=True, exist_ok=True)
    sp = d / "spec.yaml"
    if sp.exists():
        die(f"{sp} exists")
    (d / "sample").mkdir(exist_ok=True)
    # deterministic synthetic data (seeded LCG), clearly labelled as example
    seed = 7

    def rnd():
        nonlocal seed
        seed = (1103515245 * seed + 12345) % (2 ** 31)
        return seed / 2 ** 31
    regions = ["North", "South", "East", "West"]
    products = ["Atlas", "Beacon", "Cobalt", "Delta", "Ember", "Flint", "Garnet", "Harbor", "Iris", "Juniper"]
    day = dt.date(2025, 1, 1)
    end = dt.date(2025, 6, 18)  # mid-month end date
    with open(d / "sample" / "orders.csv", "w", newline="", encoding="utf-8") as fh:
        wr = csv.writer(fh)
        wr.writerow(["order_date", "region", "product", "units", "revenue"])
        while day <= end:
            for _ in range(int(6 + rnd() * 10)):
                u = 1 + int(rnd() * 6)
                p = products[int(rnd() ** 1.6 * len(products))]
                wr.writerow([day.isoformat(), regions[int(rnd() * 4)], p, u, round(u * (18 + rnd() * 40), 2)])
            day += dt.timedelta(days=1)
    sp.write_text(SAMPLE_SPEC, encoding="utf-8")
    (d / ".gitignore").write_text(".cache/\n", encoding="utf-8")
    print(f"  scaffolded {sp} + sample/orders.csv (EXAMPLE DATA, synthetic)")
    print(f"  next: python3 {Path(__file__).resolve()} all {sp}")


# ----------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(prog="dash.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("init", help="scaffold spec.yaml + example data")
    a.add_argument("dir", type=Path)
    a = sub.add_parser("refresh", help="run queries -> data/<id>.json")
    a.add_argument("spec", type=Path)
    a.add_argument("--offline", action="store_true", help="use cached URL downloads only")
    a = sub.add_parser("build", help="write one self-contained HTML file")
    a.add_argument("spec", type=Path)
    a.add_argument("--out", type=Path)
    a = sub.add_parser("check", help="review checklist (exit 1 on FAIL)")
    a.add_argument("target", type=Path)
    a.add_argument("--no-browser", action="store_true", help="static checks only")
    a = sub.add_parser("export", help="PNG (1440 + 390) and PDF")
    a.add_argument("html", type=Path)
    a.add_argument("--png", type=Path)
    a.add_argument("--mobile", type=Path)
    a.add_argument("--pdf", type=Path)
    a.add_argument("--active-only", action="store_true", help="only the active tab (default: all sections stacked)")
    a = sub.add_parser("all", help="refresh + build + check + export")
    a.add_argument("spec", type=Path)
    a.add_argument("--outdir", type=Path, help="where index.html / desktop.png / mobile.png / dashboard.pdf go (default: spec dir)")
    a.add_argument("--offline", action="store_true")
    a.add_argument("--no-export", action="store_true")
    args = ap.parse_args(argv)

    if args.cmd == "init":
        cmd_init(args.dir)
    elif args.cmd == "refresh":
        cmd_refresh(args.spec, args.offline)
    elif args.cmd == "build":
        cmd_build(args.spec, args.out)
    elif args.cmd == "check":
        sys.exit(cmd_check(args.target, not args.no_browser))
    elif args.cmd == "export":
        cmd_export(args.html, args.png, args.mobile, args.pdf or args.html.with_name("dashboard.pdf"), args.active_only)
    elif args.cmd == "all":
        od = args.outdir or args.spec.parent
        od.mkdir(parents=True, exist_ok=True)
        print("refresh"); cmd_refresh(args.spec, args.offline)
        print("build"); html = cmd_build(args.spec, od / "index.html")
        print("check"); rc = cmd_check(html)
        if not args.no_export:
            print("export"); cmd_export(html, od / "desktop.png", od / "mobile.png", od / "dashboard.pdf")
        sys.exit(rc)


if __name__ == "__main__":
    main()
