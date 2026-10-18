/* data-dash runtime (independent implementation).
   Rules: every rendered number comes from embedded dataset rows (.dv) or is generated
   from spec parameters/metadata (.gen); spec text is marked .st. Period completeness is
   decided ONLY from each dataset's data_through, never from the viewer's clock. */
(function () {
  'use strict';
  var P = JSON.parse(document.getElementById('dash-data').textContent);
  var D = P.dashboard || {};
  var T = P.theme;
  var LOC = D.locale || 'en-US';
  var DAY = 86400000;
  var FONT = getComputedStyle(document.documentElement).getPropertyValue('--font') || 'sans-serif';
  window.dashReady = false;
  var report = window.dashReport = { widgets: [], warnings: [], renderTimeouts: 0, version: P.generator };

  // ---------------- time helpers (all UTC) ----------------
  function isDateOnly(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function parseTime(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return v;
    var s = String(v);
    if (isDateOnly(s)) return Date.parse(s + 'T00:00:00Z');
    if (/^\d{4}-\d{2}$/.test(s)) return Date.parse(s + '-01T00:00:00Z');
    var hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(s);
    return Date.parse(hasTz ? s : s.replace(' ', 'T') + 'Z');
  }
  function parts(ms) { var d = new Date(ms); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), dow: d.getUTCDay() }; }
  function bucketStart(ms, g) {
    var p = parts(ms);
    switch (g) {
      case 'year': return Date.UTC(p.y, 0, 1);
      case 'quarter': return Date.UTC(p.y, p.m - (p.m % 3), 1);
      case 'month': return Date.UTC(p.y, p.m, 1);
      case 'week': return Date.UTC(p.y, p.m, p.d - ((p.dow + 6) % 7));
      case 'hour': return Date.UTC(p.y, p.m, p.d, p.h);
      default: return Date.UTC(p.y, p.m, p.d);
    }
  }
  function nextBucket(ms, g) {
    var p = parts(ms);
    switch (g) {
      case 'year': return Date.UTC(p.y + 1, 0, 1);
      case 'quarter': return Date.UTC(p.y, p.m + 3, 1);
      case 'month': return Date.UTC(p.y, p.m + 1, 1);
      case 'week': return ms + 7 * DAY;
      case 'hour': return ms + 3600000;
      default: return Date.UTC(p.y, p.m, p.d + 1);
    }
  }
  function addMonths(ms, n) {
    var d = new Date(ms), y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  }
  function shift(ms, w, sign) {
    if (w.months) return addMonths(ms, sign * w.months);
    if (w.years) return addMonths(ms, sign * 12 * w.years);
    if (w.weeks) return ms + sign * w.weeks * 7 * DAY;
    return ms + sign * (w.days || 0) * DAY;
  }
  function windowWords(w) {
    var n, u;
    if (w.months) { n = w.months; u = 'month'; } else if (w.years) { n = w.years; u = 'year'; }
    else if (w.weeks) { n = w.weeks; u = 'week'; } else { n = w.days; u = 'day'; }
    return n + ' ' + u + (n === 1 ? '' : 's');
  }
  var dtfCache = {};
  function dtf(key, opts) { if (!dtfCache[key]) dtfCache[key] = new Intl.DateTimeFormat(LOC, Object.assign({ timeZone: 'UTC' }, opts)); return dtfCache[key]; }
  function fmtDate(ms, g) {
    if (ms === null || ms === undefined || isNaN(ms)) return '\u2014';
    switch (g) {
      case 'year': return dtf('y', { year: 'numeric' }).format(ms);
      case 'quarter': return 'Q' + (Math.floor(parts(ms).m / 3) + 1) + ' ' + parts(ms).y;
      case 'month': return dtf('m', { month: 'short', year: 'numeric' }).format(ms);
      case 'datetime': return dtf('dt', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms) + ' UTC';
      default: return dtf('d', { day: 'numeric', month: 'short', year: 'numeric' }).format(ms);
    }
  }
  function fmtAxisDate(ms, g, i) {
    var p = parts(ms);
    if (g === 'month') { var mo = dtf('mo', { month: 'short' }).format(ms); return (p.m === 0 || i === 0) ? mo + '\n' + p.y : mo; }
    if (g === 'quarter') { var q = 'Q' + (Math.floor(p.m / 3) + 1); return (p.m < 3 || i === 0) ? q + '\n' + p.y : q; }
    if (g === 'year') return String(p.y);
    var dm = dtf('dm', { day: 'numeric', month: 'short' }).format(ms);
    return (i === 0 || (p.m === 0 && p.d <= 7)) ? dm + '\n' + p.y : dm;
  }
  // ISO string with offset -> wall time as written, e.g. "18 Oct 2026, 16:16 UTC+1"
  function fmtIsoLocal(s) {
    if (!s) return '\u2014';
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
    if (!m) return s;
    var wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    var off = m[6] || 'Z', lab = 'UTC';
    if (off !== 'Z') { var om = /([+-])(\d{2}):?(\d{2})/.exec(off); var hh = +om[2], mm = +om[3]; if (hh || mm) lab = 'UTC' + om[1] + hh + (mm ? ':' + om[3] : ''); }
    return dtf('d', { day: 'numeric', month: 'short', year: 'numeric' }).format(wall) + ', ' + m[4] + ':' + m[5] + ' ' + lab;
  }
  // Display zone: dashboard.display_tz (IANA). The build converts times with Python zoneinfo into
  // dataset.display.*; here we only print them, labelled "<zone> (UTC+h)". Without it, data-through
  // shows in UTC and refreshed/fetched times show in the offset they were written with.
  var DTZ = D.display_tz || null;
  function fmtShown(iso, shown) {
    if (DTZ && shown) return fmtIsoLocal(shown).replace(/ (UTC[+-]?[\d:]*)$/, ' ' + DTZ + ' ($1)');
    return fmtIsoLocal(iso);
  }

  // ---------------- number formatting ----------------
  var nfCache = {};
  function nf(opts) { var k = JSON.stringify(opts); if (!nfCache[k]) nfCache[k] = new Intl.NumberFormat(LOC, opts); return nfCache[k]; }
  function normFmt(f) { if (!f) return { type: 'number' }; if (typeof f === 'string') return { type: f }; return f; }
  function fmtNum(v, f, compact) {
    f = normFmt(f);
    if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return '\u2014';
    if (f.type === 'date') return fmtDate(v, f.grain || 'day');
    if (typeof v !== 'number') return String(v);
    var o = {};
    if (f.type === 'percent') { o.style = 'percent'; if (f.input === 100) v = v / 100; o.maximumFractionDigits = f.decimals !== undefined ? f.decimals : 1; }
    else if (f.type === 'currency') { o.style = 'currency'; o.currency = f.currency || 'USD'; o.maximumFractionDigits = f.decimals !== undefined ? f.decimals : 0; }
    else { o.maximumFractionDigits = f.decimals !== undefined ? f.decimals : (Math.abs(v) >= 100 ? 0 : 2); }
    if (f.decimals !== undefined) o.minimumFractionDigits = Math.min(f.decimals, o.maximumFractionDigits);
    if (compact || f.compact) { o.notation = 'compact'; o.maximumFractionDigits = Math.min(o.maximumFractionDigits, 1); o.minimumFractionDigits = 0; }
    return nf(o).format(v);
  }
  function unitsLabel(w, f) {
    f = normFmt(f);
    if (w.units) return w.units;
    if (f.type === 'percent') return '%';
    if (f.type === 'currency') return f.currency || 'USD';
    return '';
  }

  // ---------------- colour ----------------
  function hex(c) { c = c.replace('#', ''); if (c.length === 3) c = c.split('').map(function (x) { return x + x; }).join(''); return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]; }
  function mix(a, b, t) { var A = hex(a), B = hex(b); return 'rgb(' + A.map(function (x, i) { return Math.round(x + (B[i] - x) * t); }).join(',') + ')'; }

  // ---------------- datasets ----------------
  var DS = {};
  Object.keys(P.datasets).forEach(function (id) {
    var d = P.datasets[id];
    var cols = d.columns.map(function (c) { return c.name; });
    var types = {}; d.columns.forEach(function (c) { types[c.name] = c.type; });
    var tcols = cols.map(function (c) { return types[c] === 'date' || types[c] === 'datetime'; });
    var rows = d.rows.map(function (r, i) {
      var o = { _i: i };
      for (var j = 0; j < cols.length; j++) { var v = r[j]; if (v !== null && tcols[j]) v = parseTime(v); o[cols[j]] = v; }
      return o;
    });
    var dateCol = d.date_column || null;
    var through = parseTime(d.data_through);
    var throughEnd = through === null ? null : (isDateOnly(d.data_through) ? through + DAY : through + 1);
    var from = parseTime(d.data_from);
    if (from === null && dateCol) { rows.forEach(function (r) { var v = r[dateCol]; if (v !== null && (from === null || v < from)) from = v; }); }
    DS[id] = { id: id, meta: d, cols: cols, types: types, rows: rows, dateCol: dateCol, through: through, throughEnd: throughEnd, from: from };
  });
  function throughLabel(ds) {
    if (ds.through === null) return 'not declared';
    if (isDateOnly(ds.meta.data_through)) return fmtDate(ds.through, 'day') + ' (UTC day)';
    var shown = ds.meta.display && ds.meta.display.data_through;
    return DTZ && shown ? fmtShown(ds.meta.data_through, shown) : fmtDate(ds.through, 'datetime');
  }
  function refreshedLabel(ds) { return fmtShown(ds.meta.refreshed_at, ds.meta.display && ds.meta.display.refreshed_at); }

  // ---------------- filters ----------------
  var FILTERS = (P.filters || []).map(function (f) {
    var st = f.type === 'date_range' ? { from: null, to: null } : { set: new Set((f.default || []).map(String)) };
    return Object.assign({}, f, { state: st });
  });
  function fField(f, dsId) {
    if (f.type === 'date_range') return (f.fields && f.fields[dsId]) || f.field || DS[dsId].dateCol;
    return (f.fields && f.fields[dsId]) || f.field;
  }
  function fApplies(f, dsId) {
    if (f.datasets && f.datasets.indexOf(dsId) < 0) return false;
    var fld = fField(f, dsId);
    return !!fld && DS[dsId].cols.indexOf(fld) >= 0;
  }
  function dateBounds(dsId) {
    var ds = DS[dsId], from = ds.from, toEnd = ds.throughEnd;
    FILTERS.forEach(function (f) {
      if (f.type !== 'date_range' || !fApplies(f, dsId)) return;
      if (f.state.from !== null) from = from === null ? f.state.from : Math.max(from, f.state.from);
      if (f.state.to !== null) toEnd = toEnd === null ? f.state.to + DAY : Math.min(toEnd, f.state.to + DAY);
    });
    return { from: from, toEnd: toEnd };
  }
  function passWhere(r, where) {
    if (!where) return true;
    for (var i = 0; i < where.length; i++) {
      var c = where[i], v = r[c.field], x = c.value;
      switch (c.op || '=') {
        case '=': if (String(v) !== String(x)) return false; break;
        case '!=': if (String(v) === String(x)) return false; break;
        case '>': if (!(v > x)) return false; break;
        case '>=': if (!(v >= x)) return false; break;
        case '<': if (!(v < x)) return false; break;
        case '<=': if (!(v <= x)) return false; break;
        case 'in': if (x.map(String).indexOf(String(v)) < 0) return false; break;
        case 'not_null': if (v === null || v === undefined) return false; break;
      }
    }
    return true;
  }
  // rows of a dataset after category filters (+ date filters unless skipDate) + widget where
  function rowsFor(dsId, where, skipDate) {
    var ds = DS[dsId];
    var cats = FILTERS.filter(function (f) { return f.type !== 'date_range' && f.state.set.size && fApplies(f, dsId); });
    var dates = skipDate ? [] : FILTERS.filter(function (f) { return f.type === 'date_range' && (f.state.from !== null || f.state.to !== null) && fApplies(f, dsId); });
    return ds.rows.filter(function (r) {
      for (var i = 0; i < cats.length; i++) if (!cats[i].state.set.has(String(r[fField(cats[i], dsId)]))) return false;
      for (var k = 0; k < dates.length; k++) {
        var f = dates[k], v = r[fField(f, dsId)];
        if (v === null) return false;
        if (f.state.from !== null && v < f.state.from) return false;
        if (f.state.to !== null && v >= f.state.to + DAY) return false;
      }
      return passWhere(r, where);
    });
  }

  // ---------------- aggregation ----------------
  function agg(rows, field, how) {
    how = how || (field ? 'sum' : 'count');
    if (how === 'count') return field ? rows.reduce(function (a, r) { return a + (r[field] !== null && r[field] !== undefined ? 1 : 0); }, 0) : rows.length;
    if (how === 'distinct') { var s = new Set(); rows.forEach(function (r) { s.add(r[field]); }); return s.size; }
    if (how === 'first') return rows.length ? rows[0][field] : null;
    if (how === 'last') return rows.length ? rows[rows.length - 1][field] : null;
    var vals = []; rows.forEach(function (r) { var v = r[field]; if (typeof v === 'number' && !isNaN(v)) vals.push(v); });
    if (!vals.length) return how === 'sum' ? 0 : null;
    switch (how) {
      case 'sum': return vals.reduce(function (a, b) { return a + b; }, 0);
      case 'avg': return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
      case 'min': return Math.min.apply(null, vals);
      case 'max': return Math.max.apply(null, vals);
      case 'median': vals.sort(function (a, b) { return a - b; }); var m = vals.length >> 1; return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
    }
    return null;
  }
  function measures(w) {
    if (Array.isArray(w.y)) return w.y.map(function (m) { return typeof m === 'string' ? { field: m, agg: w.agg } : m; });
    if (w.y && typeof w.y === 'object') return [w.y];
    return [{ field: w.y || null, agg: w.agg || (w.y ? 'sum' : 'count'), label: w.y_label }];
  }

  // ---------------- DOM helpers ----------------
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; }
  function gen(tag, text, cls) { return el(tag, 'gen' + (cls ? ' ' + cls : ''), text); }

  // ---------------- chart lifecycle / readiness ----------------
  var charts = [];
  var pending = 0, readyToken = 0;
  function settle() {
    var tok = ++readyToken;
    requestAnimationFrame(function () { requestAnimationFrame(function () { if (tok === readyToken && pending === 0) window.dashReady = true; }); });
  }
  function track(chart) {
    pending++; window.dashReady = false;
    var done = false;
    function fin() { if (done) return; done = true; chart.off('finished', fin); pending--; if (pending === 0) settle(); }
    chart.on('finished', fin);
    setTimeout(function () { if (!done) { report.renderTimeouts++; console.warn('data-dash: chart did not report finished'); fin(); } }, 5000);
  }
  function setChart(host, option, dsId) {
    var c = host._chart;
    if (!c) {
      c = echarts.init(host, null, { renderer: 'svg' });
      host._chart = c; charts.push(c);
      c.on('click', function () { openDrawer(dsId); });
      if (window.ResizeObserver) {
        var raf = 0;
        new ResizeObserver(function () { cancelAnimationFrame(raf); raf = requestAnimationFrame(function () { if (host.offsetWidth) { track(c); c.resize(); } }); }).observe(host);
      }
    }
    track(c);
    c.setOption(option, true);
  }
  function compactAxis() { return window.innerWidth < 640; }

  function baseOption(w) {
    return {
      animation: !!D.animation,
      color: w.colors || T.series,
      textStyle: { fontFamily: FONT, color: T.muted, fontSize: 12 },
      aria: { enabled: true },
      grid: { left: 10, right: 12, top: 44, bottom: 4, containLabel: true },
      tooltip: {
        trigger: 'axis', confine: true, backgroundColor: T.card, borderColor: T.border, borderWidth: 1,
        textStyle: { color: T.ink, fontSize: 12, fontFamily: FONT }, extraCssText: 'box-shadow:none;border-radius:8px;',
        axisPointer: { type: 'line', lineStyle: { color: T.muted, width: 1, type: 'dashed' }, shadowStyle: { color: 'rgba(127,127,127,.08)' } }
      }
    };
  }
  function valueAxis(w, f, name, horizontal) {
    return {
      type: 'value', name: name, nameLocation: 'end', nameGap: horizontal ? 8 : 14,
      nameTextStyle: horizontal ? { color: T.muted, fontSize: 11.5, align: 'right', verticalAlign: 'top', padding: [22, 0, 0, 0] } : { color: T.muted, fontSize: 11.5, align: 'left', padding: [0, 0, 0, -2] },
      axisLabel: { color: T.muted, formatter: function (v) { return fmtNum(v, f, true); }, hideOverlap: true },
      splitLine: { lineStyle: { color: T.faint } }, axisLine: { show: false }, axisTick: { show: false },
      splitNumber: compactAxis() ? 3 : 5, scale: !!w.y_scale, inverse: !horizontal && !!w.y_inverse
    };
  }
  function catAxis(labels, fmtIdx) {
    return {
      type: 'category', data: labels, boundaryGap: true,
      axisLine: { lineStyle: { color: T.border } }, axisTick: { show: false },
      axisLabel: { color: T.muted, hideOverlap: true, interval: 'auto', formatter: fmtIdx, lineHeight: 15 }
    };
  }
  function legend(n) { return n > 1 ? { show: true, top: 0, right: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, itemGap: 12, textStyle: { color: T.muted, fontSize: 12 } } : { show: false }; }
  // stable colour per series key: series_order position (so filtering never repaints a category)
  function colorFor(w, key, i) {
    var pal = w.colors || T.series;
    if (w.color_map && key !== null && w.color_map[key]) return w.color_map[key];
    if (key === 'Other') return T.faintStrong;
    if (w.series_order && key !== null) { var k = w.series_order.indexOf(key); if (k >= 0) return pal[k % pal.length]; }
    return pal[i % pal.length];
  }
  var HATCH = { symbol: 'rect', symbolSize: 1, dashArrayX: [[1, 0]], dashArrayY: [2, 3], rotation: -Math.PI / 4, color: null };

  // ---------------- widgets ----------------
  function widgetShell(w, sec) {
    var art = el('article', 'w w-' + w.type);
    art.dataset.src = w.dataset; art.dataset.wid = w.id; art.dataset.type = w.type;
    var s = w.span || (w.type === 'kpi' ? 3 : w.type === 'table' ? 12 : 6);
    var t = w.span_tablet || (w.type === 'kpi' ? 6 : Math.min(12, s * 2 > 12 ? 12 : (s <= 4 ? 6 : 12)));
    var m = w.span_mobile || 12;
    art.style.setProperty('--s', s); art.style.setProperty('--t', t); art.style.setProperty('--m', m);
    var head = el('header', 'wh'); var tx = el('div');
    var h = el('h3', 'wt-title st', w.title); h.id = 'wt-' + w.id; tx.appendChild(h);
    if (w.subtitle) tx.appendChild(el('p', 'ws st', w.subtitle));
    if (w.type !== 'kpi' && DS[w.dataset] && DS[w.dataset].dateCol && w.period !== false) { w._period = el('p', 'ws period gen'); tx.appendChild(w._period); }
    head.appendChild(tx);
    var b = el('button', 'src-btn', 'Source'); b.type = 'button'; b.setAttribute('aria-label', 'Show source data for ' + w.title);
    b.addEventListener('click', function (e) { e.stopPropagation(); openDrawer(w.dataset); });
    head.appendChild(b); art.appendChild(head);
    var body = el('div', 'wb'); art.appendChild(body);
    if (w.type === 'kpi') { art.tabIndex = 0; art.setAttribute('role', 'button'); art.setAttribute('aria-describedby', h.id); art.addEventListener('click', function () { openDrawer(w.dataset); }); art.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(w.dataset); } }); }
    w._art = art; w._body = body; w._sec = sec;
    return art;
  }

  function renderKpi(w) {
    var ds = DS[w.dataset], body = w._body; body.innerHTML = '';
    var f = normFmt(w.format), field = w.value && w.value.field !== undefined ? w.value.field : w.field;
    var how = (w.value && w.value.agg) || w.agg || (field ? 'sum' : 'count');
    var dcol = w.date || ds.dateCol, rep = { id: w.id, type: 'kpi', dataset: w.dataset };
    var cur, prev = null, curLabel = null, prevAvail = false, prevWords = '';
    if (dcol) {
      var b = dateBounds(w.dataset), base = rowsFor(w.dataset, w.where, true);
      var end = b.toEnd, start = w.window ? shift(end, w.window, -1) : b.from;
      if (b.from !== null && start < b.from && !w.window) start = b.from;
      cur = base.filter(function (r) { var v = r[dcol]; return v !== null && v >= start && v < end; });
      var pStart = w.window ? shift(start, w.window, -1) : start - (end - start);
      prevAvail = ds.from !== null && pStart >= ds.from;
      prev = base.filter(function (r) { var v = r[dcol]; return v !== null && v >= pStart && v < start; });
      prevWords = w.window ? 'prior ' + windowWords(w.window) : 'prior period of equal length';
      var endIncl = isDateOnly(ds.meta.data_through) || (end - 1 - bucketStart(end - 1, 'day')) === DAY - 1 ? fmtDate(end - 1, 'day') : fmtDate(end - 1, 'datetime');
      curLabel = (w.window ? 'Last ' + windowWords(w.window) : fmtDate(start, 'day') + ' \u2013') + ' to ' + endIncl;
      rep.window = { start: start, end: end };
    } else { cur = rowsFor(w.dataset, w.where, false); }
    var val = agg(cur, field, how);
    var vrow = el('div', 'kpi-val');
    vrow.appendChild(el('span', 'kpi-num dv', fmtNum(val, f)));
    var u = unitsLabel(w, f); if (u && f.type !== 'percent' && f.type !== 'currency') vrow.appendChild(el('span', 'unit st', u));
    body.appendChild(vrow);
    rep.value = val;
    if (w.detail_field && (how === 'max' || how === 'min') && cur.length) {
      var best = null; cur.forEach(function (r) { if (typeof r[field] === 'number' && (best === null || (how === 'max' ? r[field] > best[field] : r[field] < best[field]))) best = r; });
      if (best) {
        var ties = cur.filter(function (r) { return r[field] === best[field]; }).length - 1;
        var dv = best[w.detail_field]; body.appendChild(el('div', 'kpi-detail dv', ds.types[w.detail_field] === 'datetime' || ds.types[w.detail_field] === 'date' ? fmtDate(dv, 'day') : String(dv)));
        if (ties > 0) body.lastChild.appendChild(gen('span', ' (+' + ties + ' tied)'));
      }
    }
    if (w.delta && w.delta !== 'none' && dcol) {
      var line = el('div', 'kpi-delta');
      if (!prevAvail) { line.appendChild(gen('span', 'No comparison: data starts ' + fmtDate(ds.from, 'day'))); }
      else {
        var pv = agg(prev, field, how), mode = w.delta === 'abs' ? 'abs' : 'pct', txt, diff;
        if (pv === null || val === null || (mode === 'pct' && pv === 0)) { line.appendChild(gen('span', 'No comparable prior value')); }
        else if (val === pv) { line.appendChild(el('span', 'd dv neutral', 'No change')); line.appendChild(gen('span', ' vs ' + prevWords + ' (' + fmtNum(pv, f) + ')')); rep.delta = { prev: pv, diff: 0, mode: mode }; }
        else {
          diff = mode === 'pct' ? (val - pv) / Math.abs(pv) : val - pv;
          var arrow = diff > 0 ? '\u25B2 ' : diff < 0 ? '\u25BC ' : '';
          txt = arrow + (diff > 0 ? '+' : diff < 0 ? '\u2212' : '') + (mode === 'pct' ? fmtNum(Math.abs(diff), { type: 'percent', decimals: 1 }) : fmtNum(Math.abs(diff), f));
          var good = w.good || 'neutral', cls = good === 'neutral' || diff === 0 ? 'neutral' : ((diff > 0) === (good === 'up') ? 'good' : 'bad');
          line.appendChild(el('span', 'd dv ' + cls, txt));
          line.appendChild(gen('span', ' vs ' + prevWords + ' (' + fmtNum(pv, f) + ')'));
          rep.delta = { prev: pv, diff: diff, mode: mode };
        }
      }
      body.appendChild(line);
    }
    if (curLabel) body.appendChild(gen('div', curLabel, 'kpi-window'));
    report.widgets.push(rep);
  }

  // time buckets for a date-x chart; returns { starts, labels, partialFirst, partialLast, through }
  function timeBuckets(w, ds) {
    var g = w.grain || 'month', b = dateBounds(w.dataset);
    if (b.from === null || b.toEnd === null) return null;
    var starts = [], s = bucketStart(b.from, g), last = bucketStart(b.toEnd - 1, g);
    while (s <= last && starts.length < 5000) { starts.push(s); s = nextBucket(s, g); }
    var partialLast = w.partial !== false && b.toEnd < nextBucket(last, g);
    var partialFirst = w.partial !== false && b.from > starts[0];
    return { g: g, starts: starts, partialFirst: partialFirst, partialLast: partialLast, from: b.from, toEnd: b.toEnd };
  }
  function bucketIndex(starts, g) { var m = new Map(); starts.forEach(function (s, i) { m.set(s, i); }); return function (ms) { return m.get(bucketStart(ms, g)); }; }
  function splitSeries(rows, field, limit, order, valueOf) {
    if (!field) return [null];
    var tot = new Map();
    rows.forEach(function (r) { var k = String(r[field]); tot.set(k, (tot.get(k) || 0) + (valueOf ? valueOf(r) : 1)); });
    var keys = Array.from(tot.keys());
    if (order) { keys.sort(function (a, b) { var ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.localeCompare(b); }); }
    else keys.sort(function (a, b) { return tot.get(b) - tot.get(a); });
    if (limit && keys.length > limit) { keys = keys.slice(0, limit - 1); keys.push('Other'); }
    return keys;
  }
  function partialNote(w, tb, kind) {
    var bits = [];
    if (tb.partialLast) bits.push(fmtDate(tb.starts[tb.starts.length - 1], tb.g) + ' is incomplete (data through ' + fmtDate(tb.toEnd - 1, isDateOnly(DS[w.dataset].meta.data_through) ? 'day' : 'datetime') + ')');
    if (tb.partialFirst) bits.push(fmtDate(tb.starts[0], tb.g) + ' starts ' + fmtDate(tb.from, 'day'));
    if (!bits.length) return null;
    var p = gen('p', null, 'note'); var mk = el('span', 'pmark' + (kind === 'line' ? ' line' : '')); mk.setAttribute('aria-hidden', 'true'); p.appendChild(mk);
    p.appendChild(document.createTextNode(bits.join('; ') + '; shown ' + (kind === 'line' ? 'dashed' : 'hatched') + '.'));
    return p;
  }

  function renderTimeChart(w) {
    var ds = DS[w.dataset], body = w._body; body.innerHTML = '';
    var host = el('div', 'chart'); host.style.height = (w.height || 300) + 'px'; body.appendChild(host);
    var tb = timeBuckets(w, ds);
    var rep = { id: w.id, type: w.type, dataset: w.dataset };
    if (!tb) { body.appendChild(gen('p', 'No dated rows in range.', 'note')); report.widgets.push(rep); return; }
    var rows = rowsFor(w.dataset, w.where, false), xf = w.x, f = normFmt(w.format), ms = measures(w);
    var idx = bucketIndex(tb.starts, tb.g), n = tb.starts.length;
    var keys = w.series ? splitSeries(rows, w.series, w.max_series || 6, w.series_order) : null;
    var groups = [];
    if (keys) {
      var km = new Map(); keys.forEach(function (k) { km.set(k, Array.from({ length: n }, function () { return []; })); });
      rows.forEach(function (r) { var i = idx(r[xf]); if (i === undefined) return; var k = String(r[w.series]); if (!km.has(k)) k = 'Other'; if (km.has(k)) km.get(k)[i].push(r); });
      keys.forEach(function (k) { groups.push({ name: k, m: ms[0], b: km.get(k) }); });
    } else {
      var bk = Array.from({ length: n }, function () { return []; });
      rows.forEach(function (r) { var i = idx(r[xf]); if (i !== undefined) bk[i].push(r); });
      ms.forEach(function (m) { groups.push({ name: m.label || w.title, m: m, b: bk }); });
    }
    var isBar = w.type === 'bar' || w.type === 'stacked_bar', stacked = w.type === 'stacked_bar' || (w.type === 'area' && w.stack !== false && groups.length > 1);
    var fillZero = function (m) { return (m.agg || 'count') === 'count' || m.agg === 'sum' || (!m.agg && !m.field); };
    var series = [], labels = tb.starts.map(String);
    groups.forEach(function (gr, gi) {
      var vals = gr.b.map(function (bucket) { var v = agg(bucket, gr.m.field, gr.m.agg); return (v === null && fillZero(gr.m)) ? 0 : v; });
      var color = colorFor(w, keys ? gr.name : null, gi);
      if (isBar) {
        var data = vals.map(function (v, i) {
          var part = (i === n - 1 && tb.partialLast) || (i === 0 && tb.partialFirst);
          return part ? { value: v, itemStyle: { decal: Object.assign({}, HATCH, { color: T.hatch }), opacity: 0.75 } } : v;
        });
        series.push({ name: gr.name, type: 'bar', data: data, stack: stacked ? 'a' : undefined, barMaxWidth: 38, barCategoryGap: '28%', itemStyle: { color: color, borderRadius: stacked ? 0 : [2, 2, 0, 0] }, emphasis: { focus: 'series' } });
      } else {
        var solid = vals.slice(), dashed = null;
        if (tb.partialLast && n >= 2) { solid[n - 1] = null; dashed = vals.map(function (v, i) { return i >= n - 2 ? v : null; }); }
        var dashedFirst = null;
        if (tb.partialFirst && n >= 2) { solid[0] = null; dashedFirst = vals.map(function (v, i) { return i <= 1 ? v : null; }); }
        var area = w.type === 'area' ? { opacity: stacked ? 0.85 : 0.14, color: color } : undefined;
        var common = { type: 'line', symbol: 'circle', symbolSize: 5, showSymbol: n <= 40, connectNulls: false, stack: stacked ? 'a' : undefined, lineStyle: { width: 2, color: color }, itemStyle: { color: color }, areaStyle: area, emphasis: { focus: 'series' } };
        series.push(Object.assign({}, common, { name: gr.name, data: solid }));
        [dashed, dashedFirst].forEach(function (dd) { if (dd) series.push(Object.assign({}, common, { name: gr.name, data: dd, lineStyle: { width: 2, color: color, type: [4, 4] }, areaStyle: area ? { opacity: area.opacity * 0.45, color: color } : undefined, tooltip: { show: false }, z: 1 })); });
      }
    });
    var opt = baseOption(w), u = unitsLabel(w, f);
    opt.legend = legend(groups.length);
    opt.xAxis = catAxis(labels, function (v, i) { return fmtAxisDate(Number(v), tb.g, i); });
    opt.yAxis = valueAxis(w, f, u);
    if (groups.length < 2) opt.grid.top = 30;
    opt.tooltip.formatter = function (ps) {
      if (!ps.length) return '';
      var i = ps[0].dataIndex, part = (i === n - 1 && tb.partialLast) || (i === 0 && tb.partialFirst);
      var seen = {}, out = '<div style="font-weight:600;margin-bottom:4px">' + fmtDate(tb.starts[i], tb.g) + (part ? ' <span style="font-weight:400;color:' + T.muted + '">(incomplete)</span>' : '') + '</div>';
      ps.forEach(function (p) { if (seen[p.seriesName]) return; var v = p.value && typeof p.value === 'object' ? p.value.value : p.value; if (v === null || v === undefined) return; seen[p.seriesName] = 1; out += '<div>' + p.marker + p.seriesName + ': <b>' + fmtNum(v, f) + '</b>' + (u ? ' ' + u : '') + '</div>'; });
      return out;
    };
    opt.series = series;
    setChart(host, opt, w.dataset);
    var note = partialNote(w, tb, isBar ? 'bar' : 'line'); if (note) body.appendChild(note);
    rep.buckets = n; rep.partial = { first: tb.partialFirst, last: tb.partialLast };
    report.widgets.push(rep);
  }

  function renderCategoryChart(w) {
    var ds = DS[w.dataset], body = w._body; body.innerHTML = '';
    var horiz = w.orientation === 'horizontal';
    var rows = rowsFor(w.dataset, w.where, false), f = normFmt(w.format), m = measures(w)[0], u = unitsLabel(w, f);
    var groupsMap = new Map();
    rows.forEach(function (r) { var k = r[w.x] === null || r[w.x] === undefined ? '(blank)' : String(r[w.x]); if (!groupsMap.has(k)) groupsMap.set(k, []); groupsMap.get(k).push(r); });
    var cats = Array.from(groupsMap.keys()).map(function (k) { return { k: k, v: agg(groupsMap.get(k), m.field, m.agg) }; });
    if (w.sort === 'label') cats.sort(function (a, b) { return a.k.localeCompare(b.k); }); else cats.sort(function (a, b) { return (b.v || 0) - (a.v || 0); });
    var total = cats.length, limit = w.limit || (horiz ? 10 : 12);
    cats = cats.slice(0, limit);
    var host = el('div', 'chart'); host.style.height = (w.height || (horiz ? Math.max(220, cats.length * 30 + 40) : 300)) + 'px'; body.appendChild(host);
    var keys = w.series && w.type === 'stacked_bar' ? splitSeries(rows, w.series, w.max_series || 6, w.series_order) : null;
    var opt = baseOption(w); opt.tooltip.trigger = 'axis'; opt.tooltip.axisPointer = { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,.08)' } };
    var series = [];
    if (keys) {
      keys.forEach(function (k, ki) {
        series.push({ name: k, type: 'bar', stack: 'a', barMaxWidth: 26, itemStyle: { color: colorFor(w, k, ki) },
          data: cats.map(function (c) { var rs = groupsMap.get(c.k).filter(function (r) { var s = String(r[w.series]); return k === 'Other' ? keys.indexOf(s) < 0 : s === k; }); return agg(rs, m.field, m.agg) || 0; }) });
      });
    } else {
      series.push({ name: m.label || w.title, type: 'bar', barMaxWidth: horiz ? 20 : 38, itemStyle: { color: (w.colors || T.series)[0], borderRadius: horiz ? [0, 2, 2, 0] : [2, 2, 0, 0] },
        label: { show: w.labels !== false, position: horiz ? 'right' : 'top', color: T.ink, fontSize: 11.5, formatter: function (p) { return fmtNum(p.value, f); } },
        data: cats.map(function (c) { return c.v; }) });
    }
    opt.legend = legend(series.length);
    var ca = catAxis(cats.map(function (c) { return c.k; }), function (v) { var mx = compactAxis() ? 16 : 26; return v.length > mx ? v.slice(0, mx - 1) + '\u2026' : v; });
    var va = valueAxis(w, f, u, horiz); if (horiz) va.splitNumber = 3;
    if (horiz) { ca.inverse = true; ca.axisLabel.interval = 0; opt.yAxis = ca; opt.xAxis = va; opt.grid.right = 40; opt.grid.top = series.length > 1 ? 30 : 4; opt.grid.bottom = 20; }
    else { opt.xAxis = ca; opt.yAxis = va; if (series.length < 2) opt.grid.top = 30; }
    opt.tooltip.formatter = function (ps) { var o = '<div style="font-weight:600;margin-bottom:4px">' + ps[0].name + '</div>'; ps.forEach(function (p) { o += '<div>' + p.marker + (series.length > 1 ? p.seriesName + ': ' : '') + '<b>' + fmtNum(p.value, f) + '</b>' + (u ? ' ' + u : '') + '</div>'; }); return o; };
    opt.series = series;
    setChart(host, opt, w.dataset);
    if (total > cats.length) body.appendChild(gen('p', 'Top ' + cats.length + ' of ' + fmtNum(total, { type: 'number', decimals: 0 }) + ' ' + (w.x_plural || 'categories') + '.', 'note'));
    report.widgets.push({ id: w.id, type: w.type, dataset: w.dataset, categories: total });
  }

  function renderPie(w) {
    var body = w._body; body.innerHTML = '';
    var host = el('div', 'chart'); host.style.height = (w.height || 280) + 'px'; body.appendChild(host);
    var rows = rowsFor(w.dataset, w.where, false), f = normFmt(w.format), m = measures(w)[0], u = unitsLabel(w, f);
    var mp = new Map(); rows.forEach(function (r) { var k = String(r[w.x]); if (!mp.has(k)) mp.set(k, []); mp.get(k).push(r); });
    var items = Array.from(mp.keys()).map(function (k) { return { name: k, value: agg(mp.get(k), m.field, m.agg) || 0 }; }).sort(function (a, b) { return b.value - a.value; });
    var lim = Math.min(w.limit || 5, 6);
    if (items.length > lim) { var rest = items.slice(lim - 1).reduce(function (a, b) { return a + b.value; }, 0); items = items.slice(0, lim - 1); items.push({ name: 'Other', value: rest, itemStyle: { color: T.faintStrong } }); }
    var opt = baseOption(w); opt.tooltip = Object.assign(opt.tooltip, { trigger: 'item', formatter: function (p) { return p.marker + p.name + ': <b>' + fmtNum(p.value, f) + '</b>' + (u ? ' ' + u : '') + ' (' + fmtNum(p.percent / 100, { type: 'percent', decimals: 1 }) + ')'; } });
    opt.legend = { show: true, bottom: 0, left: 'center', icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: T.muted } };
    opt.series = [{ type: 'pie', radius: w.type === 'donut' ? ['52%', '76%'] : [0, '76%'], center: ['50%', '45%'], avoidLabelOverlap: true, itemStyle: { borderColor: T.card, borderWidth: 2 }, label: { color: T.ink, formatter: function (p) { return fmtNum(p.percent / 100, { type: 'percent', decimals: 0 }); } }, data: items }];
    setChart(host, opt, w.dataset);
    report.widgets.push({ id: w.id, type: w.type, dataset: w.dataset, slices: items.length });
  }

  function renderScatter(w) {
    var body = w._body; body.innerHTML = '';
    var host = el('div', 'chart'); host.style.height = (w.height || 300) + 'px'; body.appendChild(host);
    var rows = rowsFor(w.dataset, w.where, false).filter(function (r) { return typeof r[w.x] === 'number' && typeof r[w.y] === 'number'; });
    var fx = normFmt(w.x_format), fy = normFmt(w.format), ux = w.x_units || unitsLabel({}, fx), uy = unitsLabel(w, fy);
    var keys = w.series ? splitSeries(rows, w.series, w.max_series || 6, w.series_order) : [null];
    var series = keys.map(function (k, ki) {
      var rs = k === null ? rows : rows.filter(function (r) { var s = String(r[w.series]); return k === 'Other' ? keys.indexOf(s) < 0 : s === k; });
      return { name: k === null ? w.title : k, type: 'scatter', symbolSize: w.symbol_size || 5, large: rs.length > 2000, itemStyle: { color: colorFor(w, k, ki), opacity: w.opacity || 0.4 },
        data: rs.map(function (r) { return [r[w.x], r[w.y], w.label_field ? r[w.label_field] : null]; }) };
    });
    var opt = baseOption(w);
    opt.legend = legend(series.length);
    var xa = valueAxis(w, fx, ux, true); xa.splitLine = { lineStyle: { color: T.faint } }; xa.scale = true; xa.nameLocation = 'middle'; xa.nameGap = 26; xa.nameTextStyle = { color: T.muted, fontSize: 11.5 };
    opt.xAxis = xa; opt.yAxis = valueAxis(w, fy, uy); opt.yAxis.scale = !!w.y_scale; if (w.y_inverse) { opt.yAxis.nameLocation = 'start'; } opt.grid.bottom = 26; opt.grid.right = 20;
    if (series.length < 2) opt.grid.top = 30;
    opt.tooltip = Object.assign(opt.tooltip, { trigger: 'item', formatter: function (p) { return (p.value[2] ? '<div style="font-weight:600;margin-bottom:4px">' + p.value[2] + '</div>' : '') + (w.x_label || w.x) + ': <b>' + fmtNum(p.value[0], fx) + '</b> ' + ux + '<br>' + (w.y_label || w.y) + ': <b>' + fmtNum(p.value[1], fy) + '</b> ' + uy; } });
    opt.series = series;
    setChart(host, opt, w.dataset);
    report.widgets.push({ id: w.id, type: w.type, dataset: w.dataset, points: rows.length });
  }

  function renderHeatmap(w) {
    var ds = DS[w.dataset], body = w._body; body.innerHTML = '';
    var rows = rowsFor(w.dataset, w.where, false), f = normFmt(w.format), u = unitsLabel(w, f);
    var m = w.value ? { field: w.value.field || null, agg: w.value.agg || (w.value.field ? 'sum' : 'count') } : { field: null, agg: 'count' };
    var isTime = ds.types[w.x] === 'date' || ds.types[w.x] === 'datetime', tb = null, xs, xi;
    if (isTime) { tb = timeBuckets(w, ds); if (!tb) { body.appendChild(gen('p', 'No dated rows in range.', 'note')); return; } xs = tb.starts; var bi = bucketIndex(tb.starts, tb.g); xi = function (r) { return bi(r[w.x]); }; }
    else { xs = splitSeries(rows, w.x, w.x_limit || 24, w.x_order); var xm = new Map(xs.map(function (k, i) { return [k, i]; })); xi = function (r) { return xm.get(String(r[w.x])); }; }
    var ys = splitSeries(rows, w.y, 0, w.y_order).slice(0, w.y_limit || 10);
    var ym = new Map(ys.map(function (k, i) { return [k, i]; }));
    var cells = new Map();
    rows.forEach(function (r) { var a = xi(r), b = ym.get(String(r[w.y])); if (a === undefined || b === undefined) return; var key = a + ',' + b; if (!cells.has(key)) cells.set(key, []); cells.get(key).push(r); });
    var data = [], mx = 0;
    for (var a = 0; a < xs.length; a++) for (var b2 = 0; b2 < ys.length; b2++) {
      var rs = cells.get(a + ',' + b2) || []; var v = agg(rs, m.field, m.agg); if (v === null) v = 0; mx = Math.max(mx, v);
      var partCol = tb && ((a === xs.length - 1 && tb.partialLast) || (a === 0 && tb.partialFirst));
      data.push(partCol ? { value: [a, b2, v], itemStyle: { decal: Object.assign({}, HATCH, { color: T.hatch }) } } : [a, b2, v]);
    }
    var host = el('div', 'chart'); host.style.height = (w.height || Math.max(240, ys.length * 28 + 90)) + 'px'; body.appendChild(host);
    var opt = baseOption(w);
    opt.grid = { left: 10, right: 12, top: 8, bottom: 52, containLabel: true };
    opt.tooltip = Object.assign(opt.tooltip, { trigger: 'item', formatter: function (p) { return '<div style="font-weight:600;margin-bottom:4px">' + ys[p.value[1]] + '</div>' + (isTime ? fmtDate(xs[p.value[0]], tb.g) : xs[p.value[0]]) + ': <b>' + fmtNum(p.value[2], f) + '</b>' + (u ? ' ' + u : ''); } });
    opt.xAxis = catAxis(xs.map(String), function (v, i) { return isTime ? fmtAxisDate(Number(v), tb.g, i) : v; }); opt.xAxis.splitArea = { show: false };
    var ya = catAxis(ys, function (v) { var mx2 = compactAxis() ? 14 : 24; return v.length > mx2 ? v.slice(0, mx2 - 1) + '\u2026' : v; }); ya.inverse = true; ya.axisLabel.interval = 0; ya.axisLine = { show: false }; opt.yAxis = ya;
    opt.visualMap = { min: 0, max: Math.max(1, mx), calculable: false, orient: 'horizontal', left: 0, bottom: 0, itemWidth: 10, itemHeight: 120, text: [fmtNum(Math.max(1, mx), f) + (u ? ' ' + u : ''), '0'], textGap: 6, textStyle: { color: T.muted, fontSize: 11 }, inRange: { color: [T.heatLow, T.accent] } };
    opt.series = [{ type: 'heatmap', data: data, itemStyle: { borderColor: T.card, borderWidth: 1.5 }, emphasis: { itemStyle: { borderColor: T.ink, borderWidth: 1 } } }];
    setChart(host, opt, w.dataset);
    if (tb) { var note = partialNote(w, tb, 'bar'); if (note) { note.lastChild.textContent = note.lastChild.textContent.replace('; shown hatched.', '; that column is hatched and not comparable.'); body.appendChild(note); } }
    report.widgets.push({ id: w.id, type: w.type, dataset: w.dataset, partial: tb ? { first: tb.partialFirst, last: tb.partialLast } : null });
  }

  function cellText(ds, c, v) {
    var t = ds.types[c.field];
    if (v === null || v === undefined) return '\u2014';
    if (t === 'date' || t === 'datetime') return fmtDate(v, (c.format && c.format.grain) || (t === 'datetime' && !(c.format && c.format.type === 'date') ? 'datetime' : 'day'));
    if (typeof v === 'number') return fmtNum(v, c.format);
    return String(v);
  }
  function renderTable(w) {
    var ds = DS[w.dataset], body = w._body; body.innerHTML = '';
    var cols = (w.columns || ds.cols.map(function (c) { return { field: c }; })).map(function (c) { return typeof c === 'string' ? { field: c } : c; });
    if (!w._sort) w._sort = w.sort ? { field: w.sort.field || w.sort, dir: w.sort.dir || 'desc' } : null;
    var rows = rowsFor(w.dataset, w.where, false).slice();
    if (w._sort) { var sf = w._sort.field, dir = w._sort.dir === 'asc' ? 1 : -1; rows.sort(function (a, b) { var x = a[sf], y = b[sf]; if (x === y) return 0; if (x === null || x === undefined) return 1; if (y === null || y === undefined) return -1; return (x < y ? -1 : 1) * dir; }); }
    var total = rows.length, lim = w.limit || 50; rows = rows.slice(0, lim);
    var wrap = el('div', 'tbl-wrap'), tbl = el('table'); tbl.setAttribute('aria-labelledby', 'wt-' + w.id);
    var thead = el('thead'), tr = el('tr');
    var mobile = window.innerWidth < 640;
    var vis = cols.filter(function (c) { return !(mobile && c.hide_mobile); });
    vis.forEach(function (c) {
      var numeric = ds.types[c.field] === 'number';
      var th = el('th', numeric ? 'num' : ''); th.scope = 'col';
      if (w._sort && w._sort.field === c.field) th.setAttribute('aria-sort', w._sort.dir === 'asc' ? 'ascending' : 'descending');
      var btn = el('button', 'th-btn'); btn.type = 'button';
      btn.appendChild(el('span', 'st', c.label || c.field));
      var u = c.units || unitsLabel({}, c.format); if (u && numeric && normFmt(c.format).type !== 'currency' && normFmt(c.format).type !== 'percent') btn.appendChild(el('span', 'unit st', u));
      btn.addEventListener('click', function () { w._sort = { field: c.field, dir: w._sort && w._sort.field === c.field && w._sort.dir === 'desc' ? 'asc' : 'desc' }; renderTable(w); });
      th.appendChild(btn); tr.appendChild(th);
    });
    thead.appendChild(tr); tbl.appendChild(thead);
    var tbody = el('tbody');
    rows.forEach(function (r) { var row = el('tr'); vis.forEach(function (c) { var numeric = ds.types[c.field] === 'number'; row.appendChild(el('td', 'dv' + (numeric ? ' num' : '') + (c.wrap ? ' wrap' : ''), cellText(ds, c, r[c.field]))); }); tbody.appendChild(row); });
    tbl.appendChild(tbody); wrap.appendChild(tbl); body.appendChild(wrap);
    var sortCol = w._sort ? (cols.filter(function (c) { return c.field === w._sort.field; })[0] || {}) : null;
    body.appendChild(gen('p', 'Showing ' + fmtNum(rows.length, { decimals: 0 }) + ' of ' + fmtNum(total, { decimals: 0 }) + ' rows' + (sortCol ? ', sorted by ' + (sortCol.label || sortCol.field) + (w._sort.dir === 'asc' ? ' (ascending)' : ' (descending)') : '') + '.', 'note'));
    report.widgets.push({ id: w.id, type: 'table', dataset: w.dataset, rows: total });
  }

  var RENDER = { kpi: renderKpi, line: renderTimeChart, area: renderTimeChart, bar: null, stacked_bar: null, pie: renderPie, donut: renderPie, scatter: renderScatter, table: renderTable, heatmap: renderHeatmap };
  function periodText(dsId) {
    var b = dateBounds(dsId), ds = DS[dsId];
    if (b.from === null || b.toEnd === null) return '';
    var endFmt = isDateOnly(ds.meta.data_through) || b.toEnd !== ds.throughEnd ? 'day' : 'datetime';
    return fmtDate(b.from, 'day') + ' \u2013 ' + fmtDate(b.toEnd - 1, endFmt);
  }
  function renderWidget(w) {
    var ds = DS[w.dataset];
    if (w._period) w._period.textContent = periodText(w.dataset);
    var timeX = w.x && ds && (ds.types[w.x] === 'date' || ds.types[w.x] === 'datetime');
    var fn = RENDER[w.type] || ((w.type === 'bar' || w.type === 'stacked_bar') ? (timeX ? renderTimeChart : renderCategoryChart) : null);
    if (!fn) { console.error('data-dash: unknown widget type ' + w.type); return; }
    try { fn(w); } catch (e) { console.error('data-dash: widget ' + w.id + ' failed: ' + e.message); }
  }

  // ---------------- page ----------------
  var SECTIONS = P.sections, activeTab = 0, showAll = false;
  var useTabs = (D.layout && D.layout.sections === 'tabs') && SECTIONS.length > 1;
  function visibleSections() { return SECTIONS.filter(function (s, i) { return showAll || !useTabs || i === activeTab; }); }
  function renderAll() {
    report.widgets = [];
    pending = 0; window.dashReady = false;
    visibleSections().forEach(function (s) { s.widgets.forEach(renderWidget); });
    if (pending === 0) settle();
  }
  function buildPage() {
    document.getElementById('dash-title').textContent = D.title || 'Dashboard';
    var sub = document.getElementById('dash-subtitle'); if (D.subtitle) { sub.textContent = D.subtitle; sub.classList.add('st'); } else sub.remove();
    // freshness (header): earliest data_through + latest refresh across used datasets
    var ids = Object.keys(DS), fr = document.getElementById('dash-fresh');
    var thr = ids.map(function (i) { return DS[i]; }).filter(function (d) { return d.through !== null; }).sort(function (a, b) { return a.through - b.through; });
    var refs = ids.map(function (i) { return DS[i]; }).filter(function (d) { return d.meta.refreshed_at; }).sort(function (a, b) { return parseTime(a.meta.refreshed_at) - parseTime(b.meta.refreshed_at); });
    fr.classList.add('gen');
    if (thr.length) { fr.appendChild(document.createTextNode('Data through ')); fr.appendChild(el('b', null, throughLabel(thr[0]))); }
    if (refs.length) { fr.appendChild(el('br')); fr.appendChild(document.createTextNode('Refreshed ')); fr.appendChild(el('b', null, refreshedLabel(refs[refs.length - 1]))); }
    buildFilters();
    var tabs = document.getElementById('tabs'), main = document.getElementById('sections');
    SECTIONS.forEach(function (s, i) {
      var sec = el('section', 'sec'); sec.id = 'sec-' + i; sec.dataset.sec = i;
      if (useTabs) { sec.setAttribute('role', 'tabpanel'); sec.setAttribute('aria-labelledby', 'tab-' + i); }
      if (s.title && !useTabs) sec.appendChild(el('h2', 'sec-title st', s.title));
      if (s.description) sec.appendChild(el('p', 'sec-desc st', s.description));
      var grid = el('div', 'grid'); s.widgets.forEach(function (w) { grid.appendChild(widgetShell(w, i)); }); sec.appendChild(grid);
      main.appendChild(sec);
      if (useTabs) {
        var t = el('button', 'tab st', s.title || ('Section')); t.id = 'tab-' + i; t.type = 'button'; t.setAttribute('role', 'tab'); t.setAttribute('aria-controls', 'sec-' + i);
        t.addEventListener('click', function () { activeTab = i; syncTabs(); renderAll(); });
        tabs.appendChild(t);
      }
    });
    if (useTabs) tabs.hidden = false;
    syncTabs();
    buildFooter();
  }
  function syncTabs() {
    SECTIONS.forEach(function (s, i) {
      var sec = document.getElementById('sec-' + i); var on = showAll || !useTabs || i === activeTab; sec.hidden = !on;
      if (useTabs) { var t = document.getElementById('tab-' + i); t.setAttribute('aria-selected', String(i === activeTab && !showAll)); t.tabIndex = i === activeTab ? 0 : -1; }
      if (showAll && useTabs && s.title && !sec.querySelector('.sec-title')) { var h = el('h2', 'sec-title st', s.title); sec.insertBefore(h, sec.firstChild); }
    });
  }
  function buildFilters() {
    var box = document.getElementById('filters');
    FILTERS.forEach(function (f) {
      var g = el('div', 'fgroup'); g.appendChild(el('span', 'flabel st', f.label || f.field || 'Date'));
      var row = el('div', 'frow');
      var targets = Object.keys(DS).filter(function (id) { return fApplies(f, id); });
      g.title = 'Applies to: ' + targets.map(function (id) { return DS[id].meta.title || id; }).join(', ');
      if (f.type === 'date_range') {
        var lo = null, hi = null; targets.forEach(function (id) { var d = DS[id]; if (d.from !== null && (lo === null || d.from < lo)) lo = d.from; if (d.throughEnd !== null && (hi === null || d.throughEnd > hi)) hi = d.throughEnd; });
        var iso = function (ms) { return ms === null ? '' : new Date(ms).toISOString().slice(0, 10); };
        var a = el('input'); a.type = 'date'; a.min = iso(lo); a.max = iso(hi - 1); a.value = iso(lo); a.setAttribute('aria-label', (f.label || 'Date') + ' from');
        var b = el('input'); b.type = 'date'; b.min = iso(lo); b.max = iso(hi - 1); b.value = iso(hi - 1); b.setAttribute('aria-label', (f.label || 'Date') + ' to');
        var upd = function () { f.state.from = a.value && a.value !== iso(lo) ? parseTime(a.value) : null; f.state.to = b.value && b.value !== iso(hi - 1) ? parseTime(b.value) : null; renderAll(); };
        a.addEventListener('change', upd); b.addEventListener('change', upd);
        row.appendChild(a); row.appendChild(el('span', 'dash', '\u2013')); row.appendChild(b);
        (f.presets || [{ label: 'All' }]).forEach(function (pr) {
          var btn = el('button', 'linkbtn st', pr.label); btn.type = 'button';
          btn.addEventListener('click', function () { if (!pr.months && !pr.days && !pr.weeks && !pr.years) { a.value = iso(lo); b.value = iso(hi - 1); } else { var s = Math.max(lo, shift(hi, pr, -1)); a.value = iso(s); b.value = iso(hi - 1); } upd(); });
          row.appendChild(btn);
        });
        f._inputs = [a, b];
      } else {
        var vals = new Set(); targets.forEach(function (id) { var fld = fField(f, id); DS[id].rows.forEach(function (r) { if (r[fld] !== null && r[fld] !== undefined) vals.add(String(r[fld])); }); });
        var list = f.values ? f.values.map(String) : Array.from(vals).sort();
        var all = el('button', 'chip st', f.all_label || 'All'); all.type = 'button';
        var chips = [];
        var sync = function () { all.setAttribute('aria-pressed', String(f.state.set.size === 0)); chips.forEach(function (c) { c.setAttribute('aria-pressed', String(f.state.set.has(c.dataset.v))); }); };
        all.addEventListener('click', function () { f.state.set.clear(); sync(); renderAll(); });
        row.appendChild(all);
        list.forEach(function (v) { var c = el('button', 'chip dv', v); c.type = 'button'; c.dataset.v = v; c.addEventListener('click', function () { if (f.state.set.has(v)) f.state.set.delete(v); else f.state.set.add(v); sync(); renderAll(); }); chips.push(c); row.appendChild(c); });
        sync();
      }
      g.appendChild(row); box.appendChild(g);
    });
  }
  function buildFooter() {
    var ft = document.getElementById('foot');
    Object.keys(DS).forEach(function (id) {
      var d = DS[id], p = gen('p');
      p.appendChild(el('b', null, d.meta.title || id));
      p.appendChild(document.createTextNode(': data through ' + throughLabel(d) + ' \u00b7 refreshed ' + refreshedLabel(d) + ' \u00b7 ' + fmtNum(d.meta.row_count, { decimals: 0 }) + ' rows'));
      var srcs = (d.meta.sources || []).map(function (s) { return (s.title || s.id) + (s.licence ? ' (' + s.licence + ')' : ''); });
      if (srcs.length) p.appendChild(document.createTextNode(' \u00b7 Source: ' + srcs.join('; ')));
      ft.appendChild(p);
    });
    if (D.footnote) ft.appendChild(el('p', 'st', D.footnote));
    ft.appendChild(gen('p', 'Built with data-dash \u00b7 charts: Apache ECharts (Apache-2.0) \u00b7 click any number or \u201cSource\u201d for its query and rows.'));
  }

  // ---------------- source drawer ----------------
  var lastFocus = null;
  function csvOf(ds, rowsIdx) {
    var raw = P.datasets[ds.id], cols = raw.columns.map(function (c) { return c.name; });
    var esc = function (v) { if (v === null || v === undefined) return ''; var s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var lines = [cols.map(esc).join(',')];
    (rowsIdx || raw.rows.map(function (_, i) { return i; })).forEach(function (i) { lines.push(raw.rows[i].map(esc).join(',')); });
    return lines.join('\r\n') + '\r\n';
  }
  function download(name, text) {
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function kv(dl, k, v) { dl.appendChild(el('dt', null, k)); var dd = el('dd'); if (v instanceof Node) dd.appendChild(v); else dd.textContent = v; dl.appendChild(dd); }
  function openDrawer(id) {
    var ds = DS[id]; if (!ds) return;
    var m = ds.meta, body = document.getElementById('drawer-body'); body.innerHTML = '';
    document.getElementById('drawer-title').textContent = m.title || id;
    if (m.description) body.appendChild(el('p', null, m.description));
    var filtered = rowsFor(id, null, false);
    var dl = el('dl', 'kv');
    kv(dl, 'Dataset', id);
    kv(dl, 'Refreshed', refreshedLabel(ds));
    kv(dl, 'Data through', throughLabel(ds) + (m.data_through_rule ? ' (' + m.data_through_rule + ')' : ''));
    if (ds.from !== null) kv(dl, 'Data from', fmtDate(ds.from, 'day') + (m.data_from_rule ? ' (' + m.data_from_rule + ')' : ''));
    kv(dl, 'Rows', fmtNum(m.row_count, { decimals: 0 }) + (filtered.length !== ds.rows.length ? ' (' + fmtNum(filtered.length, { decimals: 0 }) + ' match current filters)' : ''));
    body.appendChild(dl);
    if ((m.sources || []).length) {
      var sw = el('div'); sw.appendChild(el('h3', 'dh', 'Sources'));
      var ul = el('ul', 'srcl');
      m.sources.forEach(function (s) {
        var li = el('li'); li.appendChild(el('b', null, s.title || s.id));
        if (s.location) { li.appendChild(el('br')); if (/^https?:/.test(s.location)) { var a = el('a', null, s.location); a.href = s.location; a.target = '_blank'; a.rel = 'noopener'; li.appendChild(a); } else li.appendChild(document.createTextNode(s.location)); }
        var sd = (m.display && m.display.sources && m.display.sources[s.id]) || {};
        var meta = [s.type, s.licence ? 'licence: ' + s.licence : null, s.fetched_at ? 'fetched ' + fmtShown(s.fetched_at, sd.fetched_at) : null, s.pulled_at ? 'pulled ' + fmtShown(s.pulled_at, sd.pulled_at) : null].filter(Boolean).join(' \u00b7 ');
        li.appendChild(el('div', 'meta', meta)); ul.appendChild(li);
      });
      sw.appendChild(ul); body.appendChild(sw);
    }
    var qw = el('div'); qw.appendChild(el('h3', 'dh', 'Query (DuckDB SQL)')); qw.appendChild(el('pre', 'sql', m.query || '')); body.appendChild(qw);
    var pv = el('div'); pv.appendChild(el('h3', 'dh', 'First ' + Math.min(20, filtered.length) + ' rows' + (filtered.length !== ds.rows.length ? ' (filtered)' : '')));
    var wrap = el('div', 'tbl-wrap'), t = el('table'), thr = el('tr');
    ds.cols.forEach(function (c) { thr.appendChild(el('th', ds.types[c] === 'number' ? 'num' : '', c)); });
    var th = el('thead'); th.appendChild(thr); t.appendChild(th); var tb = el('tbody');
    filtered.slice(0, 20).forEach(function (r) { var tr = el('tr'); var raw = P.datasets[id].rows[r._i]; ds.cols.forEach(function (c, j) { tr.appendChild(el('td', ds.types[c] === 'number' ? 'num' : '', raw[j] === null ? '' : String(raw[j]))); }); tb.appendChild(tr); });
    t.appendChild(tb); wrap.appendChild(t); pv.appendChild(wrap); body.appendChild(pv);
    var btns = el('div', 'btns');
    var b1 = el('button', 'btn', 'Download CSV'); b1.type = 'button'; b1.id = 'dl-csv'; b1.addEventListener('click', function () { download(id + '.csv', csvOf(ds)); });
    btns.appendChild(b1);
    if (filtered.length !== ds.rows.length) { var b2 = el('button', 'btn secondary', 'Download filtered CSV'); b2.type = 'button'; b2.id = 'dl-csv-filtered'; b2.addEventListener('click', function () { download(id + '-filtered.csv', csvOf(ds, filtered.map(function (r) { return r._i; }))); }); btns.appendChild(b2); }
    body.appendChild(btns);
    lastFocus = document.activeElement;
    document.getElementById('drawer').hidden = false; document.getElementById('drawer-backdrop').hidden = false;
    document.getElementById('drawer-close').focus();
  }
  function closeDrawer() { document.getElementById('drawer').hidden = true; document.getElementById('drawer-backdrop').hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !document.getElementById('drawer').hidden) closeDrawer(); });

  // ---------------- public hooks (export / check) ----------------
  window.dashShowAll = function () { showAll = true; document.getElementById('tabs').hidden = true; syncTabs(); renderAll(); };
  window.dashOpenSource = openDrawer;
  window.dashCsv = function (id) { return csvOf(DS[id]); };
  var lastW = window.innerWidth;
  window.addEventListener('resize', function () { var cw = window.innerWidth; if ((cw < 640) !== (lastW < 640)) { lastW = cw; renderAll(); } lastW = cw; });

  // assign ids, then render
  var n = 0; SECTIONS.forEach(function (s) { s.widgets.forEach(function (w) { if (!w.id) w.id = 'w' + (++n); }); });
  buildPage();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(renderAll); else renderAll();
})();
