/* =====================================================================
   charts.js — Chart.js wrappers. Charts are created once and then
   updated in place (no destroy/re-create on every filter change).
   Colors are read from CSS tokens so both themes stay in sync.
   ===================================================================== */
(function (global) {
  'use strict';
  const { fmtNum, fmtKg, fmtPct, fmtCompact, cssVar, reducedMotion } = U;

  const instances = {};
  /** Stable entity → palette slot maps (color follows the entity, not its rank). */
  const slotMaps = { hub: new Map(), state: new Map() };
  let clickHandler = null;      // (kind, value) => void
  let animate = true;

  /* ---------- Theme ---------- */
  function theme() {
    return {
      fg: cssVar('--fg'), fg2: cssVar('--fg-2'), fg3: cssVar('--fg-3'),
      line: cssVar('--line'), lineStrong: cssVar('--line-strong'),
      accent: cssVar('--accent'), accent2: cssVar('--accent-2'), brand: cssVar('--brand'),
      surface: cssVar('--surface-solid'),
      series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar('--s' + i)),
      mono: cssVar('--font-mono') || 'monospace',
      body: cssVar('--font-body') || 'sans-serif',
    };
  }

  function applyDefaults() {
    if (!global.Chart) return;
    const t = theme();
    Chart.defaults.font.family = t.body;
    Chart.defaults.font.size = 12;
    Chart.defaults.color = t.fg2;
    Chart.defaults.borderColor = t.line;
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.responsive = true;
    register3d();
    const rm = reducedMotion();
    // 3D entrance: bars rise one after another, donuts spin and grow in
    Chart.defaults.animation.duration = rm ? 0 : 1100;
    Chart.defaults.animation.easing = 'easeOutQuart';
    Chart.defaults.animation.delay = (ctx) => (!rm && ctx.type === 'data' && ctx.mode === 'default' && !ctx.chart.$staggered ? Math.min(ctx.dataIndex * 45, 700) : 0);
    Chart.defaults.animation.onComplete = (ctx) => { if (ctx.chart) ctx.chart.$staggered = true; };
    if (Chart.overrides.doughnut) { Chart.overrides.doughnut.animation = Object.assign({}, Chart.overrides.doughnut.animation, { animateRotate: true, animateScale: true }); }
    Chart.defaults.layout.padding = { top: 14, right: 14, bottom: 6, left: 4 };
  }

  /** Assign palette slots from the FULL dataset ranking (called on each data load). */
  function setEntitySlots(kind, orderedValues) {
    const m = new Map();
    orderedValues.forEach((v, i) => m.set(v, i));
    slotMaps[kind] = m;
  }
  function colorFor(kind, value, t = theme()) {
    const i = slotMaps[kind].get(value);
    if (i === undefined || i > 7) return t.fg3;
    return t.series[i];
  }

  /* ---------- Colour ramps (value → colour) ---------- */
  const RAMPS = {
    cool: ['--c-teal', '--c-blue', '--c-violet', '--c-pink'],     // destinations, matrix
    warm: ['--c-amber', '--c-orange', '--c-red', '--c-pink'],      // customers
    band: ['--c-green', '--c-teal', '--c-blue', '--c-violet', '--c-pink', '--c-orange', '--c-red'], // weight ranges
  };
  function toRgb(col) {
    col = (col || '').trim();
    if (col.startsWith('#')) { let h = col.slice(1); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    const m = col.match(/\d+(\.\d+)?/g); return m ? m.slice(0, 3).map(Number) : [128, 128, 128];
  }
  /** t in [0,1] → colour along a named ramp; optional alpha */
  function ramp(t, name = 'cool', alpha = 1) {
    const stops = RAMPS[name].map((v) => toRgb(cssVar(v)));
    t = Math.max(0, Math.min(1, isFinite(t) ? t : 0));
    const x = t * (stops.length - 1); const i = Math.min(stops.length - 2, Math.floor(x)); const f = x - i;
    const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
    return alpha >= 1 ? `rgb(${c.join(',')})` : `rgba(${c.join(',')},${alpha})`;
  }
  const tooltip = (t, extra = {}) => Object.assign({
    backgroundColor: t.surface,
    borderColor: t.lineStrong,
    borderWidth: 1,
    titleColor: t.fg,
    bodyColor: t.fg2,
    footerColor: t.fg3,
    titleFont: { weight: '700', size: 13 },
    bodyFont: { family: t.mono, size: 12 },
    padding: 10,
    cornerRadius: 10,
    boxPadding: 4,
    usePointStyle: true,
  }, extra);

  const axisX = (t, extra = {}) => Object.assign({ grid: { display: false }, border: { color: t.lineStrong }, ticks: { color: t.fg2 } }, extra);
  const axisY = (t, extra = {}) => Object.assign({
    beginAtZero: true, grid: { color: t.line }, border: { display: false },
    ticks: { color: t.fg3, callback: (v) => fmtCompact(v) },
  }, extra);

  /* ---------- Small plugins ---------- */
  /** Draws a soft drop shadow under donut arcs for a lifted, 3D feel. */
  const depthPlugin = {
    id: 'depth',
    beforeDatasetsDraw(chart) { const c = chart.ctx; c.save(); c.shadowColor = 'rgba(0,0,0,0.35)'; c.shadowBlur = 16; c.shadowOffsetY = 7; },
    afterDatasetsDraw(chart) { chart.ctx.restore(); },
  };
  /* ================= 3D look (registered once for every chart) ================= */
  /** "rgb(a)/#hex" → [r,g,b,a] */
  function rgba(col) {
    col = String(col || '').trim();
    if (col.startsWith('#')) { const [r, g, b] = toRgb(col); return [r, g, b, 1]; }
    const m = col.match(/-?\d+(\.\d+)?/g);
    if (!m) return null;
    return [+m[0], +m[1], +m[2], m[3] !== undefined ? +m[3] : 1];
  }
  const shade = (c, k, aMul = 1) => `rgba(${c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(k >= 1 ? v + (255 - v) * (k - 1) : v * k)))).join(',')},${Math.min(1, c[3] * aMul)})`;
  const pick = (v, i) => (Array.isArray(v) ? v[i] : v);

  /** Bar geometry from a Chart.js bar element (vertical or horizontal). */
  function barBox(el, horiz) {
    const p = el.getProps(['x', 'y', 'base', 'width', 'height'], true);
    if (horiz) return { l: Math.min(p.base, p.x), r: Math.max(p.base, p.x), t: p.y - p.height / 2, b: p.y + p.height / 2, w: p.height };
    return { l: p.x - p.width / 2, r: p.x + p.width / 2, t: Math.min(p.y, p.base), b: Math.max(p.y, p.base), w: p.width };
  }

  /** Bars become 3D blocks: lighter top face + darker side face, glossy front. */
  const bar3dPlugin = {
    id: 'bar3d',
    beforeUpdate(chart) {
      // square tops so the 3D faces line up with the front of the bar
      chart.data.datasets.forEach((ds) => { if ((ds.type || chart.config.type) === 'bar') ds.borderRadius = 1; });
    },
    beforeDatasetsDraw(chart) {
      const ctx = chart.ctx; const horiz = chart.options.indexAxis === 'y';
      ctx.save();
      chart.data.datasets.forEach((ds, di) => {
        const meta = chart.getDatasetMeta(di);
        if (meta.type !== 'bar' || meta.hidden) return;
        meta.data.forEach((el, i) => {
          const c = rgba(pick(ds.backgroundColor, i)); if (!c) return;
          const bx = barBox(el, horiz);
          if (bx.r - bx.l < 1 || bx.b - bx.t < 1) return;
          const d = Math.max(3, Math.min(11, bx.w * 0.3));
          ctx.beginPath();                                  // top face
          ctx.moveTo(bx.l, bx.t); ctx.lineTo(bx.l + d, bx.t - d); ctx.lineTo(bx.r + d, bx.t - d); ctx.lineTo(bx.r, bx.t); ctx.closePath();
          ctx.fillStyle = shade(c, 1.35, 1.1); ctx.fill();
          ctx.beginPath();                                  // side face
          ctx.moveTo(bx.r, bx.t); ctx.lineTo(bx.r + d, bx.t - d); ctx.lineTo(bx.r + d, bx.b - d); ctx.lineTo(bx.r, bx.b); ctx.closePath();
          ctx.fillStyle = shade(c, 0.62, 1.15); ctx.fill();
        });
      });
      // soft floor shadow under the whole set of bars
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx; const horiz = chart.options.indexAxis === 'y';
      ctx.save();
      chart.data.datasets.forEach((ds, di) => {
        const meta = chart.getDatasetMeta(di);
        if (meta.type !== 'bar' || meta.hidden) return;
        meta.data.forEach((el) => {
          const bx = barBox(el, horiz);
          if (bx.r - bx.l < 2 || bx.b - bx.t < 2) return;
          // glossy light from the left/top, shade on the far edge = rounded, lit look
          const g = horiz ? ctx.createLinearGradient(0, bx.t, 0, bx.b) : ctx.createLinearGradient(bx.l, 0, bx.r, 0);
          g.addColorStop(0, 'rgba(255,255,255,0.30)'); g.addColorStop(0.35, 'rgba(255,255,255,0.06)');
          g.addColorStop(0.7, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.16)');
          ctx.fillStyle = g; ctx.fillRect(bx.l, bx.t, bx.r - bx.l, bx.b - bx.t);
        });
      });
      ctx.restore();
    },
  };

  /** Donuts get thickness: the ring is extruded downwards in a darker shade. */
  const pie3dPlugin = {
    id: 'pie3d',
    beforeDatasetsDraw(chart) {
      if (chart.config.type !== 'doughnut' && chart.config.type !== 'pie') return;
      const meta = chart.getDatasetMeta(0); if (!meta || !meta.data.length) return;
      const ds = chart.data.datasets[0]; const ctx = chart.ctx;
      const depth = Math.max(5, Math.min(16, (meta.data[0].outerRadius || 80) * 0.1));
      ctx.save();
      for (let k = depth; k >= 1; k--) {
        meta.data.forEach((el, i) => {
          if (!chart.getDataVisibility(i)) return;
          const c = rgba(pick(ds.backgroundColor, i)); if (!c) return;
          const p = el.getProps(['x', 'y', 'startAngle', 'endAngle', 'innerRadius', 'outerRadius'], true);
          if (p.endAngle - p.startAngle <= 0) return;
          ctx.beginPath();
          ctx.arc(p.x, p.y + k, p.outerRadius, p.startAngle, p.endAngle);
          ctx.arc(p.x, p.y + k, p.innerRadius, p.endAngle, p.startAngle, true);
          ctx.closePath();
          ctx.fillStyle = shade(c, k === depth ? 0.4 : 0.55 + 0.25 * (1 - k / depth));
          ctx.fill();
        });
      }
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      if (chart.config.type !== 'doughnut' && chart.config.type !== 'pie') return;
      const el = chart.getDatasetMeta(0).data[0]; if (!el) return;
      const p = el.getProps(['x', 'y', 'outerRadius'], true); const ctx = chart.ctx;
      // glass highlight across the top of the ring
      const g = ctx.createLinearGradient(0, p.y - p.outerRadius, 0, p.y + p.outerRadius);
      g.addColorStop(0, 'rgba(255,255,255,0.28)'); g.addColorStop(0.45, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,0.10)');
      ctx.save();
      chart.getDatasetMeta(0).data.forEach((a, i) => {
        if (!chart.getDataVisibility(i)) return;
        const q = a.getProps(['x', 'y', 'startAngle', 'endAngle', 'innerRadius', 'outerRadius'], true);
        ctx.beginPath(); ctx.arc(q.x, q.y, q.outerRadius, q.startAngle, q.endAngle); ctx.arc(q.x, q.y, q.innerRadius, q.endAngle, q.startAngle, true); ctx.closePath();
        ctx.fillStyle = g; ctx.fill();
      });
      ctx.restore();
    },
  };

  /** Lines float above the grid with a coloured glow + drop shadow. */
  const line3dPlugin = {
    id: 'line3d',
    beforeDatasetDraw(chart, args) {
      if (args.meta.type !== 'line') return;
      const c = rgba(pick(chart.data.datasets[args.index].borderColor, 0)) || [0, 0, 0, 1];
      const ctx = chart.ctx; ctx.save();
      ctx.shadowColor = shade(c, 0.7, 0.55); ctx.shadowBlur = 12; ctx.shadowOffsetY = 8;
    },
    afterDatasetDraw(chart, args) { if (args.meta.type === 'line') chart.ctx.restore(); },
  };

  let fxRegistered = false;
  function register3d() {
    if (fxRegistered || !global.Chart) return;
    Chart.register(bar3dPlugin, pie3dPlugin, line3dPlugin);
    fxRegistered = true;
  }

  /** Text in the hole of a donut: options.plugins.centerText = { title, value } */
  const centerTextPlugin = {
    id: 'centerText',
    afterDraw(chart, _args, opts) {
      if (!opts || !opts.value) return;
      const meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data || !meta.data[0]) return;
      const { x, y } = meta.data[0];
      const inner = meta.data[0].innerRadius || 60;
      const c = chart.ctx; const t = theme();
      c.save();
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = t.fg3;
      c.font = `700 ${Math.max(9, inner * 0.16)}px ${t.body}`;
      c.fillText(opts.title || '', x, y - inner * 0.28);
      c.fillStyle = t.fg;
      c.font = `700 ${Math.max(14, inner * 0.36)}px "Barlow Condensed", ${t.body}`;
      c.fillText(opts.value, x, y + inner * 0.06);
      if (opts.sub) { c.fillStyle = t.fg3; c.font = `600 ${Math.max(9, inner * 0.15)}px ${t.body}`; c.fillText(opts.sub, x, y + inner * 0.4); }
      c.restore();
    },
  };

  const DL = () => (global.ChartDataLabels ? [global.ChartDataLabels] : []);

  /** Create or update a chart in place. */
  /* ---------- Readable value labels on every chart ----------
     Dark, bold numbers with a light outline (white numbers + dark outline in the
     dark theme), lifted above the 3D top face of each bar. */
  function isDarkTheme() { const c = toRgb(cssVar('--fg')); return (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000 > 140; }
  const shortNum = (v) => { const a = Math.abs(v); return a >= 1e5 ? fmtCompact(v) : a >= 1000 ? (v / 1000).toFixed(a >= 1e4 ? 1 : 2).replace(/\.?0+$/, '') + 'k' : fmtNum(v, a % 1 ? 1 : 0); };
  function boostLabels(cfg) {
    const dl = cfg.options && cfg.options.plugins && cfg.options.plugins.datalabels;
    if (!dl || dl.display === false) return;
    const dark = isDarkTheme();
    const ink = dark ? '#ffffff' : '#0a0f1c';
    const halo = dark ? 'rgba(2,6,23,0.92)' : 'rgba(255,255,255,0.95)';
    const isBar = cfg.type === 'bar';
    const horiz = cfg.options.indexAxis === 'y';
    const baseFont = dl.font || {};
    dl.color = ink;
    dl.textStrokeColor = halo;
    dl.textStrokeWidth = 3;
    dl.clamp = true; dl.clip = false;
    dl.font = (c) => {
      const f = typeof baseFont === 'function' ? baseFont(c) : baseFont;
      return Object.assign({}, f, { weight: '800', size: Math.max(11, (f && f.size) || 11) + 1 });
    };
    if (isBar) {
      const baseOffset = typeof dl.offset === 'number' ? dl.offset : 2;
      // lift the number above the 3D top face (same depth formula as bar3dPlugin)
      dl.offset = (c) => {
        const el = c.chart.getDatasetMeta(c.datasetIndex).data[c.dataIndex];
        if (!el) return baseOffset + 6;
        const w = horiz ? el.height : el.width;
        return baseOffset + Math.max(3, Math.min(11, (w || 0) * 0.3)) + 4;
      };
      // many bars side by side: short numbers (7.98k) so they do not run into each other
      const n = (cfg.data.labels || []).length;
      if (!horiz && n > 14 && typeof dl.formatter === 'function') {
        const f0 = dl.formatter;
        dl.formatter = (v, c) => { const out = f0(v, c); return typeof v === 'number' && out && /\d/.test(String(out)) && /KG|,|\./.test(String(out)) && Math.abs(v) >= 1000 ? shortNum(v) : out; };
      }
    }
  }

  function upsert(id, build) {
    const canvas = document.getElementById(id);
    if (!canvas || !global.Chart) return null;
    const cfg = build();
    boostLabels(cfg);
    let ch = instances[id];
    if (ch && ch.config.type === cfg.type) {
      ch.data = cfg.data;
      ch.options = cfg.options;
      ch.update(animate ? undefined : 'none');
    } else {
      if (ch) ch.destroy();
      ch = new Chart(canvas, cfg);
      instances[id] = ch;
    }
    return ch;
  }

  function clickable(kind, labelsOrFn) {
    return {
      onClick: (_e, els, chart) => {
        if (!els.length || !clickHandler) return;
        const i = els[0].index;
        const v = typeof labelsOrFn === 'function' ? labelsOrFn(els[0], chart) : labelsOrFn[i];
        if (v !== undefined) clickHandler(kind, v);
      },
      onHover: (e, els) => { e.native && (e.native.target.style.cursor = els.length && clickHandler ? 'pointer' : 'default'); },
    };
  }

  /* =================== Individual charts =================== */

  /** Origin hub bar — rows: [[hub,{kg,count}]] sorted desc */
  function hubBar(rows) {
    upsert('chHubBar', () => {
      const t = theme();
      const labels = rows.map((r) => r[0]);
      return {
        type: 'bar',
        plugins: DL(),
        data: { labels, datasets: [{
          label: 'Chargeable Weight (KG)',
          data: rows.map((r) => r[1].kg),
          backgroundColor: labels.map((h) => colorFor('hub', h, t)),
          borderRadius: { topLeft: 6, topRight: 6 }, borderSkipped: 'bottom',
          maxBarThickness: 90, categoryPercentage: 0.7,
        }] },
        options: Object.assign({
          layout: { padding: { top: 32, right: 16 } },
          plugins: {
            legend: { display: false },
            tooltip: tooltip(t, { callbacks: {
              label: (c) => ` ${fmtKg(c.raw)}`,
              afterLabel: (c) => { const r = rows[c.dataIndex][1]; return ` ${fmtNum(r.count, 0)} AWBs · avg ${fmtKg(r.kg / r.count)}`; },
            } }),
            datalabels: { anchor: 'end', align: 'end', offset: 2, color: t.fg, font: { weight: '700', family: t.mono, size: 12 }, formatter: (v) => fmtKg(v) },
          },
          scales: { x: axisX(t, { ticks: { color: t.fg, font: { weight: '700', size: 13 } } }), y: axisY(t, { title: { display: true, text: 'Chargeable Weight KG', color: t.fg3 } }) },
        }, clickable('hub', labels)),
      };
    });
  }

  /** Hub donut with total in the centre */
  function hubDonut(rows, total) {
    upsert('chHubDonut', () => {
      const t = theme();
      const labels = rows.map((r) => r[0]);
      return {
        type: 'doughnut',
        plugins: [depthPlugin, centerTextPlugin, ...DL()],
        data: { labels, datasets: [{
          data: rows.map((r) => r[1].kg),
          backgroundColor: labels.map((h) => colorFor('hub', h, t)),
          borderColor: t.surface, borderWidth: 3, hoverOffset: 12, spacing: 2,
        }] },
        options: Object.assign({
          cutout: '64%',
          layout: { padding: { top: 10, left: 12, right: 12, bottom: 24 } },
          plugins: {
            legend: { position: 'bottom', labels: { color: t.fg2, usePointStyle: true, pointStyle: 'rectRounded', padding: 14,
              generateLabels: (ch) => ch.data.labels.map((l, i) => ({
                text: `${l}  ${fmtPct(total ? (ch.data.datasets[0].data[i] / total) * 100 : 0)}`,
                fillStyle: ch.data.datasets[0].backgroundColor[i], strokeStyle: 'transparent', fontColor: t.fg2,
                hidden: !ch.getDataVisibility(i), index: i,
              })) } },
            tooltip: tooltip(t, { callbacks: { label: (c) => ` ${fmtKg(c.raw)} · ${fmtPct(total ? (c.raw / total) * 100 : 0)}` } }),
            centerText: { title: 'TOTAL KG', value: fmtNum(total, 1), sub: `${rows.length} hub${rows.length === 1 ? '' : 's'}` },
            datalabels: {
              color: '#fff', font: { weight: '700', size: 12 },
              formatter: (v) => { const p = total ? (v / total) * 100 : 0; return p >= 6 ? fmtPct(p, 0) : ''; },
            },
          },
        }, clickable('hub', labels)),
      };
    });
  }

  /** Destination bar grouped by sector (pivot style).
      items: [{ kind:'sector'|'country', label, sector, kg, count, expanded, n }]
      onBarClick(item) — sector bars expand/collapse, country bars go to the normal click-filter. */
  function destBar(items, total, onBarClick) {
    const box = document.getElementById('destBox');
    if (box) box.style.minWidth = Math.max(0, items.length * 46 + 80) + 'px';
    upsert('chDestBar', () => {
      const t = theme();
      const sectors = items.filter((x) => x.kind === 'sector');
      const maxKg = sectors.reduce((m, x) => Math.max(m, x.kg), 0) || 1;
      const sectorColor = {};
      sectors.forEach((s) => { sectorColor[s.sector] = ramp(Math.sqrt(s.kg / maxKg), 'cool'); });
      const labels = items.map((x) => (x.kind === 'sector'
        ? [`${x.expanded ? '▾' : '▸'} ${x.label}`, `(${x.n})`]
        : [x.label, '']));
      return {
        type: 'bar',
        plugins: DL(),
        data: { labels, datasets: [{
          label: 'Chargeable Weight (KG)', data: items.map((x) => x.kg),
          backgroundColor: items.map((x) => (x.kind === 'sector' ? sectorColor[x.sector] : ramp(Math.sqrt(x.kg / maxKg), 'cool', 0.45))),
          borderColor: items.map((x) => (x.kind === 'sector' ? 'transparent' : sectorColor[x.sector])),
          borderWidth: items.map((x) => (x.kind === 'sector' ? 0 : 1.5)),
          hoverBackgroundColor: items.map(() => cssVar('--c-amber')),
          borderRadius: { topLeft: 5, topRight: 5 }, borderSkipped: 'bottom', maxBarThickness: 40, categoryPercentage: 0.82,
        }] },
        options: Object.assign({
          layout: { padding: { top: 32, right: 16 } },
          plugins: {
            legend: { display: false },
            tooltip: tooltip(t, { callbacks: {
              title: (c) => { const x = items[c[0].dataIndex]; return x.kind === 'sector' ? `Sector ${x.label} (${x.n} countr${x.n === 1 ? 'y' : 'ies'})` : `Destination ${x.label} · Sector ${x.sector}`; },
              label: (c) => { const x = items[c.dataIndex]; return [` AWB Count: ${fmtNum(x.count, 0)}`, ` Chargeable Wt: ${fmtKg(x.kg)}`, ` Average Wt: ${fmtKg(x.count ? x.kg / x.count : 0, 2)}`, ` Share: ${fmtPct(total ? (x.kg / total) * 100 : 0)}`]; },
              footer: (c) => { const x = items[c[0].dataIndex]; return x.kind === 'sector' ? (x.expanded ? 'Click to collapse' : 'Click to expand countries') : ''; },
            } }),
            datalabels: { anchor: 'end', align: 'end', offset: 1, color: (c) => (items[c.dataIndex].kind === 'sector' ? t.fg : t.fg3), font: (c) => ({ family: t.mono, size: items[c.dataIndex].kind === 'sector' ? 11 : 9.5, weight: items[c.dataIndex].kind === 'sector' ? '700' : '400' }), formatter: (v) => fmtCompact(v) },
          },
          scales: { x: axisX(t, { ticks: { color: (c) => { const x = items[c.index]; return x && x.kind === 'sector' ? t.fg : t.fg3; }, font: (c) => { const x = items[c.index]; return { weight: x && x.kind === 'sector' ? '700' : '500', size: x && x.kind === 'sector' ? 12 : 11 }; }, autoSkip: false, maxRotation: 0 } }), y: axisY(t) },
          onClick: (_e, els) => { if (els.length && onBarClick) onBarClick(items[els[0].index]); },
          onHover: (e, els) => { e.native && (e.native.target.style.cursor = els.length ? 'pointer' : 'default'); },
        }),
      };
    });
  }

  /** Customer horizontal bar — rows desc */
  function custBar(rows, total) {
    const box = document.getElementById('custBox');
    if (box) box.style.height = Math.max(220, rows.length * 28 + 50) + 'px';
    upsert('chCustBar', () => {
      const t = theme();
      const labels = rows.map((r) => r[0]);
      return {
        type: 'bar',
        plugins: DL(),
        data: { labels, datasets: [{
          label: 'Chargeable Weight (KG)', data: rows.map((r) => r[1].kg),
          backgroundColor: rows.map((r) => ramp(1 - Math.sqrt(r[1].kg / (rows[0] ? rows[0][1].kg : 1)), 'warm')),
          hoverBackgroundColor: rows.map(() => cssVar('--c-violet')),
          borderRadius: { topRight: 5, bottomRight: 5 }, borderSkipped: 'left', maxBarThickness: 26, categoryPercentage: 0.72, barPercentage: 0.9,
        }] },
        options: Object.assign({
          indexAxis: 'y',
          layout: { padding: { right: 72, top: 14 } },
          plugins: {
            legend: { display: false },
            tooltip: tooltip(t, { callbacks: {
              label: (c) => { const r = rows[c.dataIndex][1]; return [` ${fmtKg(r.kg)} · ${fmtPct(total ? (r.kg / total) * 100 : 0)}`, ` ${fmtNum(r.count, 0)} AWBs · avg ${fmtKg(r.kg / r.count, 2)}`]; },
            } }),
            datalabels: { anchor: 'end', align: 'end', offset: 4, color: t.fg2, font: { family: t.mono, size: 11 }, formatter: (v) => fmtKg(v) },
          },
          scales: {
            y: { grid: { display: false }, border: { color: t.lineStrong }, ticks: { color: t.fg, autoSkip: false, font: { size: 11.5 },
              callback(v) { const l = this.getLabelForValue(v); return l.length > 26 ? l.slice(0, 25) + '…' : l; } } },
            x: axisY(t, { position: 'top', title: { display: true, text: 'Chargeable Weight KG', color: t.fg3 } }),
          },
        }, clickable('customer', labels)),
      };
    });
  }

  /** Weight distribution buckets — [{label,count,kg}] ; metric 'count'|'kg' */
  function buckets(rows, metric) {
    upsert('chBucket', () => {
      const t = theme();
      const isKg = metric === 'kg';
      return {
        type: 'bar',
        plugins: DL(),
        data: { labels: rows.map((r) => r.label), datasets: [{
          label: isKg ? 'Total KG' : 'AWB Count', data: rows.map((r) => (isKg ? r.kg : r.count)),
          backgroundColor: rows.map((_r, i) => ramp(rows.length > 1 ? i / (rows.length - 1) : 0, 'band')),
          borderRadius: { topLeft: 6, topRight: 6 }, borderSkipped: 'bottom', maxBarThickness: 64,
        }] },
        options: {
          layout: { padding: { top: 32, right: 16 } },
          plugins: {
            legend: { display: false },
            tooltip: tooltip(t, { callbacks: { label: (c) => { const r = rows[c.dataIndex]; return [` AWB Count: ${fmtNum(r.count, 0)}`, ` Total Wt: ${fmtKg(r.kg)}`]; } } }),
            datalabels: { anchor: 'end', align: 'end', offset: 2, color: t.fg, font: { family: t.mono, weight: '600', size: 11.5 }, formatter: (v) => (v ? (isKg ? fmtCompact(v) : fmtNum(v, 0)) : '') },
          },
          scales: { x: axisX(t, { title: { display: true, text: 'Weight range', color: t.fg3 } }), y: axisY(t, { title: { display: true, text: isKg ? 'Total KG' : 'AWB Count', color: t.fg3 } }) },
        },
      };
    });
  }

  /** AWB state donut (count share) */
  function stateDonut(rows, totalCount) {
    const sorted = rows.slice().sort((a, b) => b[1].count - a[1].count);
    upsert('chStateDonut', () => {
      const t = theme();
      const labels = sorted.map((r) => r[0]);
      return {
        type: 'doughnut',
        plugins: [depthPlugin, centerTextPlugin],
        data: { labels, datasets: [{ data: sorted.map((r) => r[1].count), backgroundColor: labels.map((s) => colorFor('state', s, t)), borderColor: t.surface, borderWidth: 2, hoverOffset: 10, spacing: 1 }] },
        options: Object.assign({
          cutout: '62%', layout: { padding: { top: 8, left: 8, right: 8, bottom: 22 } },
          plugins: {
            legend: { position: 'bottom', labels: { color: t.fg2, usePointStyle: true, pointStyle: 'rectRounded', padding: 8, font: { size: 10.5 }, boxWidth: 8 } },
            tooltip: tooltip(t, { callbacks: { label: (c) => ` ${fmtNum(c.raw, 0)} AWBs · ${fmtPct(totalCount ? (c.raw / totalCount) * 100 : 0)}` } }),
            centerText: { title: 'AWBs', value: fmtNum(totalCount, 0) },
          },
        }, clickable('state', labels)),
      };
    });
  }

  /** AWB state bar (KG, desc) */
  function stateBar(rows, total) {
    upsert('chStateBar', () => {
      const t = theme();
      const labels = rows.map((r) => r[0]);
      return {
        type: 'bar',
        plugins: DL(),
        data: { labels, datasets: [{ label: 'Chargeable KG', data: rows.map((r) => r[1].kg), backgroundColor: labels.map((s) => colorFor('state', s, t)), borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: 'left', maxBarThickness: 22, categoryPercentage: 0.72, barPercentage: 0.9 }] },
        options: Object.assign({
          indexAxis: 'y', layout: { padding: { right: 60, top: 14 } },
          plugins: {
            legend: { display: false },
            tooltip: tooltip(t, { callbacks: { label: (c) => { const r = rows[c.dataIndex][1]; return [` ${fmtKg(r.kg)} · ${fmtPct(total ? (r.kg / total) * 100 : 0)}`, ` ${fmtNum(r.count, 0)} AWBs`]; } } }),
            datalabels: { anchor: 'end', align: 'end', offset: 3, color: t.fg2, font: { family: t.mono, size: 10.5 }, formatter: (v) => fmtCompact(v) },
          },
          scales: {
            y: { grid: { display: false }, border: { color: t.lineStrong }, ticks: { color: t.fg, font: { size: 10.5 }, autoSkip: false } },
            x: axisY(t, { ticks: { color: t.fg3, maxTicksLimit: 4, callback: (v) => fmtCompact(v) } }),
          },
        }, clickable('state', labels)),
      };
    });
  }

  /**
   * Inscan trend — days: [{iso,kg,count}] (every calendar day, zeros included);
   * type 'bar'|'line'; metric 'kg'|'count'; trend: fitted values per day (or null).
   */
  function trend(days, type, metric, trendLine) {
    upsert('chTrend', () => {
      const t = theme();
      const isKg = metric === 'kg';
      const blue = cssVar('--c-blue'); const amber = cssVar('--c-amber');
      const values = days.map((d) => (isKg ? d.kg : d.count));
      const fmtV = (v) => (isKg ? fmtKg(v) : `${fmtNum(v, 0)} AWBs`);
      const isLine = type === 'line';
      const main = {
        type: isLine ? 'line' : 'bar',
        label: isKg ? 'Chargeable Weight KG' : 'AWB Count',
        data: values,
        order: 2,
        backgroundColor: isLine
          ? (ctx) => { const a = ctx.chart.chartArea; if (!a) return 'transparent'; const g = ctx.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom); g.addColorStop(0, `rgba(${toRgb(blue).join(',')},0.35)`); g.addColorStop(1, `rgba(${toRgb(blue).join(',')},0.02)`); return g; }
          : values.map((v) => ramp(Math.sqrt(v / (Math.max(...values) || 1)), 'cool')),
        borderColor: blue,
        borderWidth: isLine ? 2.5 : 0,
        fill: isLine,
        tension: 0.3, cubicInterpolationMode: 'monotone',   // no dips below 0 between points
        pointRadius: isLine ? (days.length > 45 ? 0 : 3.5) : 0,
        pointHoverRadius: 6,
        pointBackgroundColor: blue,
        borderRadius: { topLeft: 5, topRight: 5 }, borderSkipped: 'bottom', maxBarThickness: 30, categoryPercentage: 0.62, barPercentage: 0.85,
      };
      const datasets = [main];
      if (trendLine) {
        datasets.push({
          type: 'line', label: 'Trend', data: trendLine, order: 1,
          borderColor: amber, borderWidth: 2, borderDash: [7, 5], pointRadius: 0, pointHoverRadius: 0, fill: false, tension: 0,
          datalabels: { display: false },
        });
      }
      return {
        type: isLine ? 'line' : 'bar',
        plugins: DL(),
        data: { labels: days.map((d) => U.fmtDateShort(d.iso)), datasets },
        options: {
          layout: { padding: { top: 32, right: 18 } },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: !!trendLine, position: 'top', align: 'end', labels: { color: t.fg2, usePointStyle: true, pointStyle: 'line', boxWidth: 24 } },
            tooltip: tooltip(t, { callbacks: {
              title: (c) => U.fmtDate(days[c[0].dataIndex].iso),
              label: (c) => (c.dataset.label === 'Trend' ? ` Trend: ${fmtV(c.raw)}` : ` ${fmtV(c.raw)}`),
              afterBody: (c) => { const d = days[c[0].dataIndex]; return isKg ? ` ${fmtNum(d.count, 0)} AWBs · avg ${fmtKg(d.count ? d.kg / d.count : 0, 2)}` : ` ${fmtKg(d.kg)}`; },
            } }),
            datalabels: {
              display: (c) => c.datasetIndex === 0 && days.length <= 31 && !!c.dataset.data[c.dataIndex],
              anchor: 'end', align: 'end', offset: 2, color: t.fg2, font: { family: t.mono, size: 10.5 },
              formatter: (v) => (isKg ? fmtCompact(v) : fmtNum(v, 0)),
            },
          },
          scales: {
            x: axisX(t, { ticks: { color: t.fg2, maxRotation: 0, autoSkip: true, autoSkipPadding: 10 } }),
            y: axisY(t, { title: { display: true, text: isKg ? 'Chargeable Weight KG' : 'AWB Count', color: t.fg3 } }),
          },
        },
      };
    });
  }

  global.Charts = {
    applyDefaults, setEntitySlots, colorFor, theme, ramp,
    hubBar, hubDonut, destBar, custBar, buckets, stateDonut, stateBar, trend,
    setClickHandler(fn) { clickHandler = fn; },
    /** Fire the shared click-to-filter handler (used by the sector chart for country bars). */
    emitClick(kind, v) { if (clickHandler) clickHandler(kind, v); return !!clickHandler; },
    setAnimate(v) { animate = v; },
    instances,
    /** Re-theme every chart (after light/dark switch) by re-running the last render. */
    destroyAll() { Object.keys(instances).forEach((k) => { instances[k].destroy(); delete instances[k]; }); },
  };
})(window);
