(function () {
  'use strict';

  var root = document.getElementById('app');

  var SVG_NS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------------------------------------
  // Data access
  // ---------------------------------------------------------------------------------------------
  function extractData(result) {
    if (!result || !Array.isArray(result.data)) {
      throw new Error('The query returned an unexpected response (no data array).');
    }
    return result.data;
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined && text !== null) { n.textContent = text; }
    return n;
  }

  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  function clear(n) { while (n.firstChild) { n.removeChild(n.firstChild); } }

  var nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  var nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  var nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function compact(n) {
    var a = Math.abs(n);
    if (a >= 1e9) { return nf1.format(n / 1e9) + 'B'; }
    if (a >= 1e6) { return nf1.format(n / 1e6) + 'M'; }
    if (a >= 1e3) { return nf1.format(n / 1e3) + 'K'; }
    return nf0.format(n);
  }

  function money(n) { return (n < 0 ? '-$' : '$') + compact(Math.abs(n)); }
  function pct(n) { return (n >= 0 ? '+' : '') + nf1.format(n * 100) + '%'; }
  function int(n) { return nf0.format(n); }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function parseDate(v) {
    // Dates arrive as 'YYYY-MM-DD...' - parse as UTC so labels never shift by timezone.
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    if (m) { return Date.UTC(+m[1], +m[2] - 1, +m[3]); }
    var t = new Date(v).getTime();
    return isNaN(t) ? 0 : t;
  }

  function fmtDate(t) {
    var d = new Date(t);
    return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  }

  function fmtShort(t) {
    var d = new Date(t);
    return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
  }

  function isoDate(t) {
    var d = new Date(t);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }

  function toBool(v) { return v === true || v === 'true' || v === 'True' || v === 1; }
  function num(v) { return typeof v === 'number' ? v : Number(v); }

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------
  var RAW = [];        // base rows: { t, store, deptName, type, hol, sales, size }
  var WEEKS = [];      // sorted unique week timestamps
  var STORES = [];     // sorted unique store ids (filter options)
  var DEPTS = [];      // sorted unique department names (filter options)
  var STATE = {
    type: 'All',       // 'All' | 'A' | 'B' | 'C'
    dateFrom: '',      // 'YYYY-MM-DD' or '' (no lower bound)
    dateTo: '',        // 'YYYY-MM-DD' or '' (no upper bound)
    store: 'All',      // 'All' | store id
    dept: 'All',       // 'All' | department name
    metric: 'sales',   // KPI card highlighted / metric shown in the trend chart
    trendMode: 'total', // 'total' (one neutral line + area) | 'type' (one line per store type)
    // Each bottom panel drills inside itself; a drill level is null (top) or a selected key.
    typeSel: null,     // Sales by store type  -> departments of that type
    deptSel: null,     // Departments          -> stores of that department (click filters the stores panel)
    storeSel: null,    // Stores               -> best weeks of that store
    theme: 'light'
  };

  // Fixed color per store type, used everywhere (bars, store type panel, trend lines).
  var TYPE_COLORS = { A: '#2563eb', B: '#0d9488', C: '#f97316' };
  var TYPE_ORDER = ['A', 'B', 'C'];
  // Deep indigo for the "Total" trend line: an executive tone, distinct from the store-type colors
  // (blue / teal / orange) and from every KPI card accent (blue, violet, cyan, green, orange).
  // Lighter in dark theme so the line keeps its contrast (see --total-color in styles.css).
  var TOTAL_COLOR = 'var(--total-color)';
  function typeColor(t) { return TYPE_COLORS[t] || '#64748b'; }

  // Every KPI card exists, but only metrics that make sense as a weekly series get a trend tab.
  var METRICS = [
    { id: 'sales', label: 'Total Sales', short: 'Total Sales', fmt: money, color: '#2563eb', tab: true },
    { id: 'avgsw', label: 'Avg Sales per Store-Week', short: 'Avg / Store-Week', fmt: money, color: '#7c3aed', tab: false },
    { id: 'sqft', label: 'Sales per Sq Ft', short: 'Sales / Sq Ft', fmt: function (n) { return '$' + nf2.format(n); }, color: '#0891b2', tab: true },
    // Active Stores and Active Departments share one grid cell as two compact half-width cards.
    { id: 'stores', label: 'Active Stores', short: 'Active Stores', fmt: int, color: '#16a34a', tab: false, compact: true },
    { id: 'depts', label: 'Active Departments', short: 'Active Depts', fmt: int, color: '#0891b2', tab: false, compact: true },
    { id: 'lift', label: 'Holiday Lift %', short: 'Holiday Lift %', fmt: pct, color: '#ea580c', tab: false }
  ];

  function metricById(id) {
    for (var i = 0; i < METRICS.length; i++) { if (METRICS[i].id === id) { return METRICS[i]; } }
    return METRICS[0];
  }

  // ---------------------------------------------------------------------------------------------
  // Filtering & aggregation
  // ---------------------------------------------------------------------------------------------
  // Rows that pass every global filter (date range, store type, store, department).
  function filtered() {
    var from = STATE.dateFrom ? parseDate(STATE.dateFrom) : -Infinity;
    var to = STATE.dateTo ? parseDate(STATE.dateTo) : Infinity;
    return RAW.filter(function (r) {
      if (r.t < from || r.t > to) { return false; }
      if (STATE.type !== 'All' && r.type !== STATE.type) { return false; }
      if (STATE.store !== 'All' && r.store !== STATE.store) { return false; }
      if (STATE.dept !== 'All' && r.deptName !== STATE.dept) { return false; }
      return true;
    });
  }

  // Compute every KPI over a set of rows. Average = per store-week everywhere (one definition).
  function kpis(rows) {
    var sales = 0, hs = 0, ns = 0, sizeSum = 0;
    var storeSet = {}, deptSet = {}, storeWeek = {}, weekSet = {}, holSW = {}, nonSW = {};
    rows.forEach(function (r) {
      var sw = r.store + '|' + r.t;
      sales += r.sales;
      storeSet[r.store] = true;
      deptSet[r.deptName] = true;
      storeWeek[sw] = true;
      weekSet[r.t] = true;
      if (!storeSet[r.store + '#size']) { storeSet[r.store + '#size'] = true; sizeSum += r.size; }
      if (r.hol) { hs += r.sales; holSW[sw] = true; } else { ns += r.sales; nonSW[sw] = true; }
    });
    var nStores = Object.keys(storeSet).filter(function (k) { return k.indexOf('#size') < 0; }).length;
    var nSW = Object.keys(storeWeek).length;
    var nWeeks = Object.keys(weekSet).length;
    var nH = Object.keys(holSW).length, nN = Object.keys(nonSW).length;
    // Floor space = sum of the sizes of the distinct stores in the selection (each store counted once).
    var hAvg = nH ? hs / nH : 0, nAvg = nN ? ns / nN : 0;
    return {
      sales: sales,
      avgsw: nSW ? sales / nSW : 0,
      // Sales per sq ft = sales / total floor space of the stores selected. Over the whole period this is
      // the period (YTD) figure; inside the weekly trend it is that week's sales per sq ft.
      sqft: sizeSum ? sales / sizeSum : 0,
      stores: nStores,
      depts: Object.keys(deptSet).length,
      // Holiday lift = avg sales per store-week in holiday weeks vs non-holiday weeks.
      lift: nH && nN && nAvg ? (hAvg - nAvg) / nAvg : 0,
      holAvg: hAvg, nonAvg: nAvg, nH: nH, nN: nN
    };
  }

  function weeklySeries(rows) {
    var byWeek = {};
    rows.forEach(function (r) { (byWeek[r.t] = byWeek[r.t] || []).push(r); });
    // Holiday lift is not defined for a single week, so use the cumulative lift of the period up to
    // that week; the other metrics are exact per-week values.
    var weeks = Object.keys(byWeek).map(Number).sort(function (a, b) { return a - b; });
    var acc = [];
    return weeks.map(function (t) {
      var k = kpis(byWeek[t]);
      acc = acc.concat(byWeek[t]);
      var kc = kpis(acc);
      return {
        t: t,
        hol: byWeek[t].some(function (r) { return r.hol; }),
        sales: k.sales, avgsw: k.avgsw, sqft: k.sqft, stores: k.stores, depts: k.depts, lift: kc.lift
      };
    });
  }

  function groupSum(rows, keyFn) {
    var m = {};
    rows.forEach(function (r) {
      var k = keyFn(r);
      m[k] = (m[k] || 0) + r.sales;
    });
    return Object.keys(m).map(function (k) { return { key: k, v: m[k] }; })
      .sort(function (a, b) { return b.v - a.v; });
  }

  // ---------------------------------------------------------------------------------------------
  // Rendering: pieces
  // ---------------------------------------------------------------------------------------------
  var refs = {};

  function pills(container, options, current, onPick) {
    clear(container);
    options.forEach(function (o) {
      var b = el('button', 'pill' + (o.value === current ? ' active' : ''), o.label);
      b.type = 'button';
      b.addEventListener('click', function () { onPick(o.value); });
      container.appendChild(b);
    });
  }

  function sparkline(series, key, color) {
    var W = 160, H = 36, pad = 2;
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'spark', preserveAspectRatio: 'none' });
    if (series.length < 2) { return svg; }
    var vals = series.map(function (s) { return s[key]; });
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    var rng = mx - mn || 1;
    var pts = vals.map(function (v, i) {
      return [pad + (W - 2 * pad) * i / (vals.length - 1), pad + (H - 2 * pad) * (1 - (v - mn) / rng)];
    });
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    svg.appendChild(svgEl('path', { d: d, fill: 'none', stroke: color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
    return svg;
  }

  function renderHeader(rows) {
    var ts = rows.map(function (r) { return r.t; });
    var lo = ts.length ? Math.min.apply(null, ts) : null;
    var hi = ts.length ? Math.max.apply(null, ts) : null;
    var active = [];
    if (STATE.type !== 'All') { active.push('Type ' + STATE.type); }
    if (STATE.dateFrom || STATE.dateTo) { active.push((STATE.dateFrom || '…') + ' → ' + (STATE.dateTo || '…')); }
    if (STATE.store !== 'All') { active.push('Store ' + STATE.store); }
    if (STATE.dept !== 'All') { active.push(STATE.dept); }
    var stores = {};
    rows.forEach(function (r) { stores[r.store] = true; });
    var range = lo === null ? 'No data' : fmtDate(lo) + ' – ' + fmtDate(hi);
    refs.subtitle.textContent = range + '  ·  ' + (active.length ? active.join(', ') : 'No filters') +
      '  ·  ' + int(Object.keys(stores).length) + ' stores';
  }

  function renderKpiCards(rows, series) {
    clear(refs.kpis);
    var k = kpis(rows);
    var pair = null;   // wrapper that holds the two compact cards in a single grid cell
    METRICS.forEach(function (m) {
      var card = el('button', 'card kpi' + (m.compact ? ' compact' : '') + (STATE.metric === m.id ? ' selected' : ''));
      card.type = 'button';
      card.style.setProperty('--accent', m.color);
      card.appendChild(el('div', 'kpi-label', m.label));
      card.appendChild(el('div', 'kpi-value', m.fmt(k[m.id])));
      if (!m.compact) { card.appendChild(sparkline(series, m.id, m.color)); }
      card.addEventListener('click', function () {
        STATE.metric = m.id;
        renderAll();
      });
      if (m.compact) {
        if (!pair) { pair = el('div', 'kpi-pair'); refs.kpis.appendChild(pair); }
        pair.appendChild(card);
      } else {
        refs.kpis.appendChild(card);
      }
    });
  }

  function renderTrend(series, rows) {
    var m = metricById(STATE.metric);
    // A metric without a trend tab (e.g. a compact card) falls back to Total Sales in the chart.
    if (!m.tab) { m = metricById('sales'); }
    clear(refs.tabs);
    METRICS.forEach(function (x) {
      if (!x.tab) { return; }
      var b = el('button', 'tab' + (x.id === m.id ? ' active' : ''), x.short);
      b.type = 'button';
      b.addEventListener('click', function () { STATE.metric = x.id; renderAll(); });
      refs.tabs.appendChild(b);
    });
    refs.trendTitle.textContent = m.label + ' by week';

    // Segmented selector: Total | By type (only meaningful while the store-type filter is All).
    clear(refs.mode);
    [{ value: 'total', label: 'Total' }, { value: 'type', label: 'By type' }].forEach(function (o) {
      var on = STATE.type === 'All' ? STATE.trendMode === o.value : false;
      var b = el('button', 'tab' + (on ? ' active' : ''), o.label);
      b.type = 'button';
      b.disabled = STATE.type !== 'All';
      b.addEventListener('click', function () { STATE.trendMode = o.value; renderAll(); });
      refs.mode.appendChild(b);
    });

    clear(refs.chart);
    if (!series.length) {
      refs.chart.appendChild(el('div', 'empty', 'No data for the current filters.'));
      return;
    }
    // Total (default): one dark neutral line with the sum of every store type and a shaded area.
    // By type: one line per store type in its fixed color. A specific type filter always shows its own single line.
    var lines;
    var totalMode = STATE.type === 'All' && STATE.trendMode === 'total';
    if (totalMode) {
      lines = [{ type: null, color: TOTAL_COLOR, pts: series }];
    } else if (STATE.type === 'All') {
      lines = TYPE_ORDER.map(function (t) {
        var tr = rows.filter(function (r) { return r.type === t; });
        return tr.length ? { type: t, color: typeColor(t), pts: weeklySeries(tr) } : null;
      }).filter(Boolean);
    } else {
      lines = [{ type: STATE.type, color: typeColor(STATE.type), pts: series }];
    }
    var byT = {};
    series.forEach(function (s) { byT[s.t] = s; });
    // The chart fills its box: measure it so SVG text stays the same size as the page text.
    var box = refs.chart.getBoundingClientRect();
    var W = Math.max(400, Math.round(box.width)), H = Math.max(140, Math.round(box.height));
    var mg = { t: 12, r: 16, b: 28, l: 64 };
    var iw = W - mg.l - mg.r, ih = H - mg.t - mg.b;
    var vals = [];
    lines.forEach(function (ln) { ln.pts.forEach(function (s) { vals.push(s[m.id]); }); });
    var mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals);
    var lo = Math.min(0, mn), hi = mx === lo ? lo + 1 : mx;
    var span = hi - lo;
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, class: 'trend', role: 'img',
      'aria-label': m.label + ' by week' });
    var i;
    for (i = 0; i <= 4; i++) {
      var y = mg.t + ih - ih * i / 4;
      svg.appendChild(svgEl('line', { x1: mg.l, x2: W - mg.r, y1: y, y2: y, class: 'gridline' }));
      var tl = svgEl('text', { x: mg.l - 8, y: y + 5, class: 'axis', 'text-anchor': 'end' });
      tl.textContent = m.fmt(lo + span * i / 4);
      svg.appendChild(tl);
    }
    // Shared week axis (all weeks that survive the filters), so every line lines up.
    var weeks = series.map(function (s) { return s.t; });
    var idxOf = {};
    weeks.forEach(function (t, idx) { idxOf[t] = idx; });
    var step = weeks.length > 1 ? iw / (weeks.length - 1) : 0;
    var X = function (idx) { return weeks.length > 1 ? mg.l + step * idx : mg.l + iw / 2; };
    var Y = function (v) { return mg.t + ih - ih * (v - lo) / span; };

    // Holiday week markers (vertical bands behind the data).
    series.forEach(function (s, idx) {
      if (s.hol) {
        var bw = Math.max(8, step * 0.8);
        svg.appendChild(svgEl('rect', { x: X(idx) - bw / 2, y: mg.t, width: bw, height: ih, class: 'holiday' }));
      }
    });

    // X axis labels (about 10 evenly spaced).
    var every = Math.max(1, Math.ceil(weeks.length / 10));
    series.forEach(function (s, idx) {
      if (idx % every === 0) {
        var t = svgEl('text', { x: X(idx), y: H - 8, class: 'axis', 'text-anchor': 'middle' });
        t.textContent = fmtShort(s.t);
        svg.appendChild(t);
      }
    });

    var tip = refs.tip;
    var single = lines.length === 1;
    lines.forEach(function (ln) {
      var pts = ln.pts.map(function (s) { return [X(idxOf[s.t]), Y(s[m.id])]; });
      var d = pts.map(function (p, idx) { return (idx ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
      if (single && pts.length) {
        var base = Y(Math.max(lo, 0));
        var area = d + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + base + ' L' + pts[0][0].toFixed(1) + ' ' + base + ' Z';
        svg.appendChild(svgEl('path', { d: area, fill: ln.color, opacity: 0.14 }));
      }
      svg.appendChild(svgEl('path', { d: d, fill: 'none', stroke: ln.color, 'stroke-width': 2.6,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      // Points + hover.
      ln.pts.forEach(function (s, idx) {
        var c = svgEl('circle', { cx: pts[idx][0], cy: pts[idx][1], r: s.hol ? 5 : 3.2, fill: s.hol ? '#f59e0b' : ln.color,
          class: 'pt' });
        var hit = svgEl('circle', { cx: pts[idx][0], cy: pts[idx][1], r: 10, fill: 'transparent' });
        var show = function (ev) {
          clear(tip);
          tip.appendChild(el('div', 'tip-date', fmtDate(s.t) + (s.hol ? '  ·  Holiday week' : '')));
          tip.appendChild(el('div', 'tip-val', m.fmt(s[m.id])));
          tip.appendChild(el('div', 'tip-sub', m.label + (ln.type && STATE.type === 'All' ? '  ·  Type ' + ln.type : (totalMode ? '  ·  All types' : ''))));
          var b = refs.chart.getBoundingClientRect();
          tip.style.display = 'block';
          var left = ev.clientX - b.left + 14;
          if (left + 210 > b.width) { left = ev.clientX - b.left - 220; }
          tip.style.left = Math.max(4, left) + 'px';
          tip.style.top = Math.max(4, ev.clientY - b.top - 70) + 'px';
        };
        hit.addEventListener('mousemove', show);
        hit.addEventListener('mouseenter', show);
        hit.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
        svg.appendChild(c);
        svg.appendChild(hit);
      });
    });
    refs.chart.appendChild(svg);
    refs.chart.appendChild(tip);
    tip.style.display = 'none';

    // Legend: type colors (when split) + holiday swatch.
    clear(refs.legend);
    if (totalMode) {
      var tItem = el('span', 'legend-item');
      var tDot = el('span', 'legend-dot'); tDot.style.background = TOTAL_COLOR;
      tItem.appendChild(tDot); tItem.appendChild(el('span', null, 'Total (all store types)'));
      refs.legend.appendChild(tItem);
    } else if (lines.length > 1 || STATE.type !== 'All') {
      lines.forEach(function (ln) {
        var item = el('span', 'legend-item');
        var dot = el('span', 'legend-dot'); dot.style.background = ln.color;
        item.appendChild(dot); item.appendChild(el('span', null, 'Type ' + ln.type));
        refs.legend.appendChild(item);
      });
    }
    var hol = el('span', 'legend-item');
    hol.appendChild(el('span', 'swatch')); hol.appendChild(el('span', null, 'Holiday week'));
    refs.legend.appendChild(hol);
  }

  // A bottom panel is a header (title + breadcrumb), a subtitle and a body that holds the bars.
  function panelShell(container, title, crumbs) {
    clear(container);
    var head = el('div', 'panel-head');
    head.appendChild(el('div', 'panel-title', title));
    container.appendChild(head);
    var nav = el('nav', 'crumbs');
    crumbs.forEach(function (c, i) {
      var last = i === crumbs.length - 1;
      var b = el('button', 'crumb' + (last ? ' current' : ''), c.label);
      b.type = 'button';
      if (!last) { b.addEventListener('click', c.onClick); }
      nav.appendChild(b);
      if (!last) { nav.appendChild(el('span', 'sep', '›')); }
    });
    container.appendChild(nav);
    var body = el('div', 'panel-body');
    container.appendChild(body);
    return body;
  }

  // `color` is a single color or a function(item) -> color (used for the fixed store-type palette).
  function bars(body, items, color, onPick, selectedKey, fmtVal) {
    if (!items.length) { body.appendChild(el('div', 'empty', 'No data.')); return; }
    var max = Math.max.apply(null, items.map(function (x) { return x.v; })) || 1;
    var list = el('div', 'bars');
    items.forEach(function (it) {
      var row = el(onPick ? 'button' : 'div', 'bar-row' + (selectedKey === it.key ? ' selected' : '') + (onPick ? ' clickable' : ''));
      if (onPick) { row.type = 'button'; row.addEventListener('click', function () { onPick(it.key); }); }
      var lbl = el('div', 'bar-label', it.label || it.key);
      lbl.title = it.label || it.key;
      row.appendChild(lbl);
      var track = el('div', 'bar-track');
      var fill = el('div', 'bar-fill');
      fill.style.width = (100 * it.v / max) + '%';
      fill.style.background = typeof color === 'function' ? color(it) : color;
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('div', 'bar-value', (fmtVal || money)(it.v)));
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  // Store -> type lookup so store bars can use the fixed type color.
  function storeTypeMap(rows) {
    var m = {};
    rows.forEach(function (r) { m[r.store] = r.type; });
    return m;
  }

  // Per store type: store count, share of sales, share of floor space and sales per sq ft.
  // Store size repeats on every row, so floor space counts each store once (not once per row).
  function typeStats(rows) {
    var byType = {}, totSales = 0, totSpace = 0;
    rows.forEach(function (r) {
      var g = byType[r.type] || (byType[r.type] = { type: r.type, sales: 0, stores: {}, space: 0 });
      g.sales += r.sales;
      if (!g.stores[r.store]) { g.stores[r.store] = true; g.space += r.size; }
    });
    var list = TYPE_ORDER.concat(Object.keys(byType).filter(function (t) { return TYPE_ORDER.indexOf(t) < 0; }))
      .filter(function (t) { return byType[t]; })
      .map(function (t) { return byType[t]; });
    list.forEach(function (g) { totSales += g.sales; totSpace += g.space; });
    return list.map(function (g) {
      return {
        type: g.type,
        stores: Object.keys(g.stores).length,
        salesPct: totSales ? g.sales / totSales : 0,
        spacePct: totSpace ? g.space / totSpace : 0,
        perSqFt: g.space ? g.sales / g.space : 0
      };
    });
  }

  function typeTable(body, rows) {
    var stats = typeStats(rows);
    if (!stats.length) { return; }
    var best = stats.reduce(function (a, b) { return b.perSqFt > a.perSqFt ? b : a; });
    var wrap = el('div', 'type-mini');
    var table = el('table', 'tbl');
    var thead = el('thead'); var hr = el('tr');
    ['Type', 'Stores', '% sales', '% space', 'Sales / sq ft'].forEach(function (h, i) {
      hr.appendChild(el('th', i ? 'r' : null, h));
    });
    thead.appendChild(hr); table.appendChild(thead);
    var tb = el('tbody');
    stats.forEach(function (s) {
      var top = stats.length > 1 && s.type === best.type;
      var tr = el('tr', top ? 'top' : null);
      var tt = el('td'); tt.appendChild(el('span', 'type-dot')); tt.lastChild.style.background = typeColor(s.type);
      tt.appendChild(document.createTextNode(' ' + s.type));
      tr.appendChild(tt);
      tr.appendChild(el('td', 'r', int(s.stores)));
      tr.appendChild(el('td', 'r', nf1.format(s.salesPct * 100) + '%'));
      tr.appendChild(el('td', 'r', nf1.format(s.spacePct * 100) + '%'));
      tr.appendChild(el('td', 'r', '$' + nf2.format(s.perSqFt) + (top ? ' ★' : '')));
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    wrap.appendChild(table);
    if (stats.length > 1) {
      wrap.appendChild(el('div', 'type-note', 'Type ' + best.type + ' has the highest sales per sq ft'));
    }
    body.appendChild(wrap);
  }

  // Panel: Sales by store type. Click a type -> its departments, inside the same panel.
  function renderTypePanel(rows) {
    var crumbs = [{ label: 'All store types', onClick: function () { STATE.typeSel = null; renderAll(); } }];
    if (STATE.typeSel) { crumbs.push({ label: 'Type ' + STATE.typeSel }); }
    var body = panelShell(refs.p1, 'Sales by store type', crumbs);
    if (!STATE.typeSel) {
      var types = groupSum(rows, function (r) { return r.type; }).map(function (x) {
        return { key: x.key, label: 'Type ' + x.key, v: x.v };
      });
      bars(body, types, function (it) { return typeColor(it.key); }, function (k) { STATE.typeSel = k; renderAll(); }, null);
      typeTable(body, rows);
    } else {
      var depts = groupSum(rows.filter(function (r) { return r.type === STATE.typeSel; }),
        function (r) { return r.deptName; }).slice(0, 15).map(function (x) {
        return { key: x.key, label: x.key, v: x.v };
      });
      bars(body, depts, typeColor(STATE.typeSel), null, null);
    }
  }

  // Panel: Departments (all 15, scrolls inside the panel). Clicking one filters the stores panel.
  function renderDeptPanel(rows) {
    var crumbs = [{ label: 'All departments', onClick: function () { STATE.deptSel = null; STATE.storeSel = null; renderAll(); } }];
    if (STATE.deptSel) { crumbs.push({ label: STATE.deptSel }); }
    var body = panelShell(refs.p2, 'Departments', crumbs);
    var depts = groupSum(rows, function (r) { return r.deptName; }).slice(0, 15).map(function (x) {
      return { key: x.key, label: x.key, v: x.v };
    });
    // Toggle: clicking the selected department again clears the selection.
    bars(body, depts, '#16a34a', function (k) {
      STATE.deptSel = STATE.deptSel === k ? null : k;
      STATE.storeSel = null;
      renderAll();
    }, STATE.deptSel);
  }

  // Panel: Stores (all 45, scrolls inside the panel), filtered by the selected department.
  // Click a store -> its best weeks as a table, inside the same panel.
  function renderStorePanel(rows) {
    var title = 'Stores';
    var crumbs = [{ label: STATE.deptSel ? 'All stores · ' + STATE.deptSel : 'All stores', onClick: function () { STATE.storeSel = null; renderAll(); } }];
    if (STATE.storeSel) { crumbs.push({ label: 'Store ' + STATE.storeSel }); }
    var body = panelShell(refs.p3, title, crumbs);
    var scoped = STATE.deptSel ? rows.filter(function (r) { return r.deptName === STATE.deptSel; }) : rows;
    if (!STATE.storeSel) {
      var tmap = storeTypeMap(rows);
      var stores = groupSum(scoped, function (r) { return r.store; }).slice(0, 45).map(function (x) {
        return { key: x.key, label: 'Store ' + x.key, v: x.v, type: tmap[x.key] };
      });
      bars(body, stores, function (it) { return typeColor(it.type); }, function (k) { STATE.storeSel = k; renderAll(); }, null);
    } else {
      var byWeek = {};
      scoped.filter(function (r) { return r.store === STATE.storeSel; }).forEach(function (r) {
        var w = byWeek[r.t] || (byWeek[r.t] = { t: r.t, v: 0, hol: false });
        w.v += r.sales; w.hol = w.hol || r.hol;
      });
      var best = Object.keys(byWeek).map(function (k) { return byWeek[k]; })
        .sort(function (a, b) { return b.v - a.v; }).slice(0, 6);
      var table = el('table', 'tbl');
      var thead = el('thead'); var hr = el('tr');
      ['#', 'Date', 'Sales', 'Holiday'].forEach(function (h, i) {
        hr.appendChild(el('th', i === 2 ? 'r' : null, h));
      });
      thead.appendChild(hr); table.appendChild(thead);
      var tb = el('tbody');
      best.forEach(function (w, i) {
        var tr = el('tr');
        tr.appendChild(el('td', 'muted', String(i + 1)));
        tr.appendChild(el('td', null, fmtDate(w.t)));
        tr.appendChild(el('td', 'r', '$' + nf0.format(w.v)));
        var td = el('td'); td.appendChild(el('span', 'badge' + (w.hol ? ' yes' : ''), w.hol ? 'Yes' : 'No'));
        tr.appendChild(td);
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      body.appendChild(table);
    }
  }

  // Panel: Holiday vs non-holiday. Bars = average sales per store-week in holiday vs non-holiday weeks,
  // plus the Holiday Lift box and a note with the store-week count of each group. Same definitions as the
  // Holiday Lift % KPI (kpis()), so it follows every filter and the Reset button through renderAll().
  function renderHolidayPanel(rows) {
    var body = panelShell(refs.p4, 'Holiday vs non-holiday', [{ label: 'Avg sales per store-week' }]);
    var k = kpis(rows);
    bars(body, [
      { key: 'hol', label: 'Holiday weeks', v: k.holAvg },
      { key: 'non', label: 'Non-holiday weeks', v: k.nonAvg }
    ], 'var(--lift-color)', null, null, money);
    var lift = el('div', 'lift');
    lift.appendChild(el('div', 'lift-label', 'Holiday Lift'));
    lift.appendChild(el('div', 'lift-value', k.nH && k.nN ? pct(k.lift) : 'n/a'));
    lift.appendChild(el('div', 'lift-note',
      int(k.nH) + ' holiday store-weeks vs ' + int(k.nN) + ' non-holiday store-weeks'));
    body.appendChild(lift);
  }

  // Searchable dropdown (combobox): a button that opens a panel with a search box and a scrolling list.
  var openDrop = null;
  function closeDrop() {
    if (openDrop) { openDrop.classList.remove('open'); openDrop = null; }
  }

  function dropdown(container, opts) {
    // opts: { options:[{value,label}], current, allLabel, searchable, onPick }
    clear(container);
    container.classList.add('dd');
    var curLabel = opts.allLabel;
    opts.options.forEach(function (o) { if (o.value === opts.current) { curLabel = o.label; } });
    var btn = el('button', 'dd-btn' + (opts.current !== 'All' ? ' active' : ''));
    btn.type = 'button';
    btn.appendChild(el('span', 'dd-text', curLabel));
    btn.appendChild(el('span', 'dd-caret', '▾'));
    var menu = el('div', 'dd-menu');
    var input = null;
    var list = el('div', 'dd-list');
    if (opts.searchable) {
      input = el('input', 'dd-search');
      input.type = 'search';
      input.placeholder = 'Search…';
      input.autocomplete = 'off';
      menu.appendChild(input);
    }
    menu.appendChild(list);
    function fill(q) {
      clear(list);
      var items = [{ value: 'All', label: opts.allLabel }].concat(opts.options);
      var n = 0;
      items.forEach(function (o) {
        if (q && o.value !== 'All' && o.label.toLowerCase().indexOf(q) < 0) { return; }
        n++;
        var it = el('button', 'dd-item' + (o.value === opts.current ? ' selected' : ''), o.label);
        it.type = 'button';
        it.addEventListener('click', function (ev) {
          ev.stopPropagation();
          closeDrop();
          opts.onPick(o.value);
        });
        list.appendChild(it);
      });
      if (!n) { list.appendChild(el('div', 'dd-none', 'No matches')); }
    }
    fill('');
    if (input) { input.addEventListener('input', function () { fill(input.value.trim().toLowerCase()); }); }
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var wasOpen = container.classList.contains('open');
      closeDrop();
      if (!wasOpen) {
        container.classList.add('open');
        openDrop = container;
        if (input) { input.value = ''; fill(''); setTimeout(function () { input.focus(); }, 0); }
      }
    });
    menu.addEventListener('click', function (ev) { ev.stopPropagation(); });
    container.appendChild(btn);
    container.appendChild(menu);
  }

  // True when any filter, trend view or panel selection differs from the initial state.
  function hasActiveFilters() {
    return STATE.type !== 'All' || !!STATE.dateFrom || !!STATE.dateTo ||
      STATE.store !== 'All' || STATE.dept !== 'All' || STATE.trendMode !== 'total' ||
      !!STATE.typeSel || !!STATE.deptSel || !!STATE.storeSel;
  }

  // Back to the initial state: every filter on All / full date range, Total trend, panels at top level.
  function resetFilters() {
    STATE.type = 'All';
    STATE.dateFrom = '';
    STATE.dateTo = '';
    STATE.store = 'All';
    STATE.dept = 'All';
    STATE.trendMode = 'total';
    STATE.typeSel = null;
    STATE.deptSel = null;
    STATE.storeSel = null;
    closeDrop();
    renderAll();
  }

  function renderFilters() {
    var dirty = hasActiveFilters();
    refs.reset.disabled = !dirty;
    refs.reset.classList.toggle('active', dirty);
    pills(refs.fType, [
      { value: 'All', label: 'All' }, { value: 'A', label: 'A' }, { value: 'B', label: 'B' }, { value: 'C', label: 'C' }
    ], STATE.type, function (v) { STATE.type = v; STATE.typeSel = null; renderAll(); });

    // Date range (native date inputs, bounded to the data).
    if (document.activeElement !== refs.dFrom) { refs.dFrom.value = STATE.dateFrom; }
    if (document.activeElement !== refs.dTo) { refs.dTo.value = STATE.dateTo; }

    // Store / department dropdowns. Options come from the full dataset so they never shrink
    // to the current selection; a selection that no longer exists simply shows no rows.
    dropdown(refs.fStore, {
      options: STORES.map(function (s) { return { value: s, label: 'Store ' + s }; }),
      current: STATE.store, allLabel: 'All stores', searchable: true,
      onPick: function (v) { STATE.store = v; STATE.storeSel = null; renderAll(); }
    });
    dropdown(refs.fDept, {
      options: DEPTS.map(function (d) { return { value: d, label: d }; }),
      current: STATE.dept, allLabel: 'All departments', searchable: false,
      onPick: function (v) { STATE.dept = v; STATE.deptSel = null; STATE.storeSel = null; renderAll(); }
    });
  }

  function applyTheme() {
    root.setAttribute('data-theme', STATE.theme);
    document.body.setAttribute('data-theme', STATE.theme);
    refs.themeBtn.textContent = STATE.theme === 'dark' ? '☀ Light' : '☾ Dark';
  }

  function renderAll() {
    var rows = filtered();
    var series = weeklySeries(rows);
    renderHeader(rows);
    renderFilters();
    renderKpiCards(rows, series);
    renderTrend(series, rows);
    renderTypePanel(rows);
    renderDeptPanel(rows);
    renderStorePanel(rows);
    renderHolidayPanel(rows);
  }

  function buildShell() {
    clear(root);
    var header = el('header', 'header');
    var left = el('div', 'head-left');
    left.appendChild(el('h1', null, 'Walmart Sales Explorer'));
    refs.subtitle = el('div', 'subtitle', 'Loading…');
    left.appendChild(refs.subtitle);
    var right = el('div', 'head-right');
    refs.themeBtn = el('button', 'theme-btn', '☾ Dark');
    refs.themeBtn.type = 'button';
    refs.themeBtn.addEventListener('click', function () {
      STATE.theme = STATE.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
    });
    right.appendChild(refs.themeBtn);
    right.appendChild(el('div', 'credit', 'Created by Camila Leal'));
    header.appendChild(left); header.appendChild(right);
    root.appendChild(header);

    // Row 2: all filters on a single line.
    var filters = el('section', 'filters');
    [['Store type', 'fType']].forEach(function (f) {
      var g = el('div', 'fgroup');
      g.appendChild(el('div', 'flabel', f[0]));
      refs[f[1]] = el('div', 'pills');
      g.appendChild(refs[f[1]]);
      filters.appendChild(g);
    });
    // Date range: two native date inputs.
    var gd = el('div', 'fgroup');
    gd.appendChild(el('div', 'flabel', 'Dates'));
    var dr = el('div', 'daterange');
    refs.dFrom = el('input', 'date-in'); refs.dFrom.type = 'date';
    refs.dFrom.min = isoDate(WEEKS[0]); refs.dFrom.max = isoDate(WEEKS[WEEKS.length - 1]);
    refs.dTo = el('input', 'date-in'); refs.dTo.type = 'date';
    refs.dTo.min = refs.dFrom.min; refs.dTo.max = refs.dFrom.max;
    refs.dFrom.addEventListener('change', function () { STATE.dateFrom = refs.dFrom.value; STATE.storeSel = null; renderAll(); });
    refs.dTo.addEventListener('change', function () { STATE.dateTo = refs.dTo.value; STATE.storeSel = null; renderAll(); });
    dr.appendChild(refs.dFrom); dr.appendChild(el('span', 'dash', '–')); dr.appendChild(refs.dTo);
    gd.appendChild(dr);
    filters.appendChild(gd);
    // Store (searchable) and department dropdowns.
    var gs = el('div', 'fgroup');
    gs.appendChild(el('div', 'flabel', 'Store'));
    refs.fStore = el('div');
    gs.appendChild(refs.fStore);
    filters.appendChild(gs);
    var gp = el('div', 'fgroup');
    gp.appendChild(el('div', 'flabel', 'Dept'));
    refs.fDept = el('div');
    gp.appendChild(refs.fDept);
    filters.appendChild(gp);
    // Reset button: pushed to the right end of the filter row; styled on its own (not as a .pill).
    refs.reset = el('button', 'reset-btn', 'Reset filters');
    refs.reset.type = 'button';
    refs.reset.addEventListener('click', resetFilters);
    filters.appendChild(refs.reset);
    root.appendChild(filters);
    document.addEventListener('click', closeDrop);

    // Row 3: KPI cards in one row (Active Stores + Active Departments share one cell).
    refs.kpis = el('section', 'kpis');
    root.appendChild(refs.kpis);

    // Row 4: trend (2/3) + sales by store type (1/3).
    var row4 = el('section', 'row4');
    var trend = el('div', 'card trend-card');
    var th = el('div', 'trend-head');
    refs.trendTitle = el('div', 'panel-title', '');
    refs.mode = el('div', 'tabs mode-tabs');
    refs.tabs = el('div', 'tabs');
    var thr = el('div', 'trend-ctrls');
    thr.appendChild(refs.mode); thr.appendChild(refs.tabs);
    th.appendChild(refs.trendTitle); th.appendChild(thr);
    trend.appendChild(th);
    refs.chart = el('div', 'chart-wrap');
    refs.tip = el('div', 'tooltip');
    trend.appendChild(refs.chart);
    refs.legend = el('div', 'legend');
    trend.appendChild(refs.legend);
    row4.appendChild(trend);
    refs.p1 = el('div', 'card panel');
    row4.appendChild(refs.p1);
    root.appendChild(row4);

    // Row 5: three panels side by side.
    var row5 = el('section', 'row5');
    refs.p2 = el('div', 'card panel');
    refs.p3 = el('div', 'card panel');
    refs.p4 = el('div', 'card panel');
    row5.appendChild(refs.p2); row5.appendChild(refs.p3); row5.appendChild(refs.p4);
    root.appendChild(row5);
    applyTheme();
  }

  function renderError(msg) {
    clear(root);
    root.appendChild(el('p', 'error', 'Data unavailable: ' + msg));
  }

  // ---------------------------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------------------------
  function boot() {
    if (!root) { return; }
    root.textContent = 'Loading…';
    // Standalone version: loads a static snapshot of walmart_sales_2012 instead of querying Tableau.
    fetch('data.json').then(function (res) {
      if (!res.ok) { throw new Error('data.json could not be loaded (' + res.status + ')'); }
      return res.json();
    }).then(function (j) {
      var result = { data: j.rows.map(function (r) {
        var st = j.stores[String(r[1])];
        return { fecha: j.dates[r[0]], tienda: r[1], dept: j.depts[r[2]], tipo: st[0], hol: r[3] === 1, size: st[1], sales: r[4] };
      }) };
      var data = extractData(result);
      if (!data.length) {
        clear(root);
        root.appendChild(el('p', 'empty', 'The data source returned no rows.'));
        return;
      }
      var weekSet = {};
      RAW = data.map(function (r) {
        var t = parseDate(r.fecha);
        weekSet[t] = true;
        return {
          t: t,
          store: String(r.tienda),
          deptName: String(r.dept),
          type: String(r.tipo),
          hol: toBool(r.hol),
          size: num(r.size),
          sales: num(r.sales)
        };
      });
      WEEKS = Object.keys(weekSet).map(Number).sort(function (a, b) { return a - b; });
      var sSet = {}, dSet = {};
      RAW.forEach(function (r) { sSet[r.store] = true; dSet[r.deptName] = true; });
      STORES = Object.keys(sSet).sort(function (a, b) { return Number(a) - Number(b) || (a < b ? -1 : 1); });
      DEPTS = Object.keys(dSet).sort();
      buildShell();
      renderAll();
      // Re-render once on resize so the trend chart always fills its box exactly.
      var timer = null;
      window.addEventListener('resize', function () {
        clearTimeout(timer);
        timer = setTimeout(renderAll, 120);
      });
    }).catch(function (err) {
      renderError((err && err.message) || String(err));
    });
  }

  boot();
})();
