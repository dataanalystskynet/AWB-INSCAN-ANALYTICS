/* =====================================================================
   dashboard.js — calculations + rendering of KPIs, summary, matrix,
   charts and tables. All numbers come from the records
   passed in; nothing is hard-coded.
   ===================================================================== */
(function (global) {
  'use strict';
  const { fmtNum, fmtKg, fmtPct, fmtDate, esc, $, sortedEntries, animateNumber } = U;

  const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 200];

  /** View-level settings (chart toggles) — persisted per browser. */
  const view = Object.assign({
    bucketMetric: 'count',
    custTopN: '10',
    buckets: DEFAULT_BUCKETS.slice(),
  }, U.store.get('view', {}));
  const saveView = () => U.store.set('view', view);

  let custCustom = null;     // MultiSelect for the customer chart "Custom" mode
  let destHub = 'ALL';       // hub tab selected on the destination chart
  const destOpen = new Set(); // sectors expanded on the destination chart / pivot
  const mxOpen = new Set();   // sectors expanded on the hub × sector matrix
  let tables = {};
  let last = { records: [], agg: null };
  let aggCache = { ref: null, agg: null };

  /* ------------------------------------------------------------------
     calculateKPIs — one pass over the records builds every aggregation
     the dashboard needs. Cached by array identity.
     ------------------------------------------------------------------ */
  function calculateKPIs(records) {
    if (aggCache.ref === records) return aggCache.agg;
    const add = (map, k, wt) => { let o = map.get(k); if (!o) { o = { kg: 0, count: 0 }; map.set(k, o); } o.kg += wt; o.count++; return o; };
    const a = {
      count: records.length, total: 0, min: Infinity, max: -Infinity, maxRec: null, minRec: null,
      customers: new Map(), hubs: new Map(), dests: new Map(), states: new Map(),
      inscanDays: new Map(),
      matrix: new Map(), lanes: new Map(),
    };
    for (const r of records) {
      const w = r.wt;
      a.total += w;
      if (w > a.max) { a.max = w; a.maxRec = r; }
      if (w < a.min) { a.min = w; a.minRec = r; }
      add(a.customers, r.customer, w);
      add(a.hubs, r.hub, w);
      add(a.dests, r.dest, w);
      add(a.states, r.state, w);
      if (r.inscanDate) add(a.inscanDays, r.inscanDate, w);
      let mx = a.matrix.get(r.hub); if (!mx) a.matrix.set(r.hub, (mx = new Map()));
      mx.set(r.dest, (mx.get(r.dest) || 0) + w);
      add(a.lanes, r.hub + ' → ' + r.dest, w);
    }
    if (!records.length) { a.min = 0; a.max = 0; }
    a.avg = a.count ? a.total / a.count : 0;
    a.hubRows = sortedEntries(a.hubs);
    a.destRows = sortedEntries(a.dests);
    a.custRows = sortedEntries(a.customers);
    a.stateRows = sortedEntries(a.states);
    a.laneRows = sortedEntries(a.lanes);
    aggCache = { ref: records, agg: a };
    return a;
  }

  /* ------------------------------ KPIs ------------------------------ */
  const KPI_DEFS = [
    { id: 'total', label: 'Total Chargeable Weight', hero: true, tone: 'red', icon: 'i-kg' },
    { id: 'awbs', label: 'Total AWBs', tone: 'blue', icon: 'i-box' },
    { id: 'avg', label: 'Average Weight', tone: 'teal', icon: 'i-avg' },
    { id: 'max', label: 'Maximum Weight', tone: 'orange', icon: 'i-up' },
    { id: 'min', label: 'Minimum Weight', tone: 'green', icon: 'i-down' },
    { id: 'customers', label: 'Customers', tone: 'violet', icon: 'i-users' },
    { id: 'hubs', label: 'Origin Hubs', tone: 'pink', icon: 'i-hub' },
    { id: 'dests', label: 'Destinations', tone: 'cyan', icon: 'i-globe' },
    { id: 'states', label: 'AWB States', tone: 'amber', icon: 'i-flag' },
  ];

  function buildKpiCards() {
    const grid = $('#kpiGrid');
    grid.innerHTML = KPI_DEFS.map((k) => `
      <article class="kpi${k.hero ? ' hero' : ''}" data-kpi="${k.id}" style="--kc:var(--c-${k.tone})">
        ${k.hero ? '' : `<span class="kpi-icon"><svg><use href="#${k.icon}"/></svg></span>`}
        <div>
          ${k.hero ? '<div class="hero-top">' : ''}<div class="kpi-label"><i></i>${esc(k.label)}</div>${k.hero ? '<div class="hero-date"><span>Inscan Date</span><b data-inscan>—</b></div></div>' : ''}
          <div class="kpi-value" data-val>0</div>
          <div class="kpi-sub" data-sub></div>
        </div>
        ${k.hero ? '<div><div class="hero-split" data-split></div><div class="hero-legend" data-legend></div></div>' : ''}
      </article>`).join('');
    // subtle 3D tilt that follows the pointer
    if (!U.reducedMotion()) {
      grid.querySelectorAll('.kpi').forEach((card) => {
        card.addEventListener('pointermove', (e) => {
          const r = card.getBoundingClientRect();
          const px = (e.clientX - r.left) / r.width - 0.5; const py = (e.clientY - r.top) / r.height - 0.5;
          const amp = card.classList.contains('hero') ? 3 : 7;
          card.style.transform = `translateY(-4px) rotateX(${(-py * amp).toFixed(2)}deg) rotateY(${(px * amp).toFixed(2)}deg)`;
          card.style.setProperty('--mx', `${(px + 0.5) * 100}%`); card.style.setProperty('--my', `${(py + 0.5) * 100}%`);
        });
        card.addEventListener('pointerleave', () => { card.style.transform = ''; });
        card.addEventListener('pointerenter', () => {
          const el = card.querySelector('[data-val]'); const v = parseFloat(el.dataset.v || '0');
          el.dataset.v = 0; animateNumber(el, v, { decimals: +el.dataset.dec || 0, suffix: el.dataset.suffix || '', duration: 450 });
        });
      });
    }
  }

  function setKpi(id, value, { decimals = 0, unit = '', sub = '' } = {}) {
    const card = document.querySelector(`[data-kpi="${id}"]`);
    if (!card) return;
    const el = card.querySelector('[data-val]');
    const suffix = unit ? `<small>${unit}</small>` : '';
    el.dataset.dec = decimals; el.dataset.suffix = suffix;
    animateNumber(el, value, { decimals, suffix });
    card.querySelector('[data-sub]').innerHTML = sub;
  }

  function updateKPIs(a, all) {
    const pctOfAll = all && all.total ? (a.total / all.total) * 100 : 100;
    setKpi('total', a.total, { decimals: 1, unit: 'KG', sub: a.count === (all ? all.count : a.count) ? 'All records' : `${fmtPct(pctOfAll)} of the total ${fmtKg(all.total)}` });
    setKpi('awbs', a.count, { sub: all && a.count !== all.count ? `out of ${fmtNum(all.count, 0)} in total` : 'Shipments scanned' });
    setKpi('avg', a.avg, { decimals: 2, unit: 'KG', sub: 'For each AWB' });
    setKpi('max', a.max, { decimals: 1, unit: 'KG', sub: a.maxRec ? `AWB ${esc(a.maxRec.awb)}` : '' });
    setKpi('min', a.min, { decimals: 1, unit: 'KG', sub: a.minRec ? `AWB ${esc(a.minRec.awb)}` : '' });
    setKpi('customers', a.customers.size, { sub: a.custRows[0] ? `Top: ${esc(a.custRows[0][0])}` : '' });
    setKpi('hubs', a.hubs.size, { sub: a.hubRows.map((h) => h[0]).slice(0, 4).join(' · ') });
    setKpi('dests', a.dests.size, { sub: a.destRows[0] ? `Top: ${esc(a.destRows[0][0])}` : '' });
    setKpi('states', a.states.size, { sub: a.stateRows[0] ? `Most weight: ${esc(a.stateRows[0][0])}` : '' });

    // hero: inscan date (or first – last date) of the shown records, then split bar by hub
    const hero = document.querySelector('[data-kpi="total"]');
    const days = Array.from(a.inscanDays.keys()).sort();
    hero.querySelector('[data-inscan]').textContent = !days.length ? '—'
      : days.length === 1 ? fmtDate(days[0]) : `${fmtDate(days[0])} – ${fmtDate(days[days.length - 1])}`;
    const t = Charts.theme();
    hero.querySelector('[data-split]').innerHTML = a.hubRows.map(([h, o]) => `<span title="${esc(h)} ${fmtKg(o.kg)}" style="flex:${o.kg || 0.0001};background:${Charts.colorFor('hub', h, t)}"></span>`).join('');
    hero.querySelector('[data-legend]').innerHTML = a.hubRows.slice(0, 6).map(([h, o]) => `<span><i style="background:${Charts.colorFor('hub', h, t)}"></i>${esc(h)} <b>${fmtKg(o.kg)}</b></span>`).join('');

    $('#metaFilteredCount').textContent = fmtNum(a.count, 0);
    $('#metaFilteredKg').textContent = fmtKg(a.total);
  }

  /* -------------------------- Executive summary -------------------------- */
  function updateSummary(a) {
    if (!a.count) { $('#summaryList').innerHTML = ''; return; }
    const pct = (v) => fmtPct(a.total ? (v / a.total) * 100 : 0);
    const [hub, hubO] = a.hubRows[0];
    const [cust, custO] = a.custRows[0];
    const [dest, destO] = a.destRows[0];
    const [lane, laneO] = a.laneRows[0];
    const [stateTop, stateO] = a.stateRows.slice().sort((x, y) => y[1].count - x[1].count)[0];
    const top10 = a.custRows.slice(0, 10).reduce((s, r) => s + r[1].kg, 0);
    const heavy = (last.records || []).filter((r) => r.wt >= 100).length;
    const items = [
      ['Total', `Total weight is <b>${fmtKg(a.total)}</b> from <b>${fmtNum(a.count, 0)} AWBs</b>. Average weight is <b>${fmtKg(a.avg, 2)}</b> per AWB.`],
      ['Hub', `<b>${esc(hub)}</b> hub has the most weight: <b>${fmtKg(hubO.kg)}</b> (${pct(hubO.kg)}) from ${fmtNum(hubO.count, 0)} AWBs.`],
      ['Customer', `The top customer is <b>${esc(cust)}</b> with <b>${fmtKg(custO.kg)}</b> from ${fmtNum(custO.count, 0)} AWBs (${pct(custO.kg)}).`],
      ['Destination', `<b>${esc(dest)}</b> is the top destination with <b>${fmtKg(destO.kg)}</b> (${pct(destO.kg)}) from ${fmtNum(destO.count, 0)} AWBs.`],
      ['Sector', (() => { const g = Sectors.group(a.destRows)[0]; return g ? `<b>${esc(g.sector)}</b> is the top sector with <b>${fmtKg(g.kg)}</b> (${pct(g.kg)}) from ${fmtNum(g.count, 0)} AWBs across ${g.children.length} destination${g.children.length === 1 ? '' : 's'}.` : ''; })()],
      ['Heaviest', `The heaviest AWB is <b>${esc(a.maxRec.awb)}</b> with <b>${fmtKg(a.max)}</b>. Customer: ${esc(a.maxRec.customer)}. Route: ${esc(a.maxRec.hub)} to ${esc(a.maxRec.dest)}.`],
      ['Route', `The busiest route is <b>${esc(lane.replace(' → ', ' to '))}</b> with <b>${fmtKg(laneO.kg)}</b> (${pct(laneO.kg)}).`],
      ['Top ' + Math.min(10, a.custRows.length), `The top ${Math.min(10, a.custRows.length)} customers give <b>${pct(top10)}</b> of all weight. ${fmtNum(heavy, 0)} AWB${heavy === 1 ? ' is' : 's are'} 100 KG or more.`],
      ['State', `Most AWBs are in <b>${esc(stateTop)}</b> state: ${fmtNum(stateO.count, 0)} AWBs (${fmtPct((stateO.count / a.count) * 100)}).`],
    ];
    const tones = ['red', 'pink', 'violet', 'cyan', 'teal', 'orange', 'blue', 'green', 'amber'];
    $('#summaryList').innerHTML = items.map(([t, s], i) => `<li style="--tc:var(--c-${tones[i % tones.length]})"><span class="tag">${t}</span><span>${s}</span></li>`).join('');
  }

  /* ------------------------------ Matrix ------------------------------ */
  /* Columns are grouped by sector (pivot style). Click a sector header or
     sector box to expand its countries; click a country box to filter. */
  function updateMatrix(a) {
    const hubs = a.hubRows.map((r) => r[0]);
    const groups = Sectors.group(a.destRows);
    const hubSector = (h, g) => { const row = a.matrix.get(h); if (!row) return 0; let v = 0; g.children.forEach(([c]) => { v += row.get(c) || 0; }); return v; };
    // colour scale: biggest sector box
    let max = 0;
    hubs.forEach((h) => groups.forEach((g) => { const v = hubSector(h, g); if (v > max) max = v; }));
    const cols = [];
    groups.forEach((g) => {
      const open = mxOpen.has(g.sector);
      cols.push({ kind: 'sector', g, open });
      if (open) g.children.forEach(([code, o]) => cols.push({ kind: 'country', g, code, o }));
    });
    const cell = (v, title, attrs, child) => {
      if (!v) return `<td class="zero${child ? ' mx-child' : ''}" ${child ? '' : attrs}>·</td>`;
      const k = Math.sqrt(v / max);   // sqrt scale keeps small lanes visible
      const bg = Charts.ramp(k, 'cool', (child ? 0.18 : 0.28) + k * (child ? 0.6 : 0.72));
      const ink = k > 0.45 && !child ? '#ffffff' : 'var(--fg)';
      return `<td class="${child ? 'mx-child' : 'mx-sector'}" style="background:${bg};color:${ink}" ${attrs} title="${title}">${fmtNum(v, 1)}</td>`;
    };
    const tbl = $('#matrixTable');
    const head = `<thead><tr><th>Hub \\ Sector</th>${cols.map((c) => (c.kind === 'sector'
      ? `<th class="mx-sh${c.open ? ' open' : ''}" data-mx-sector="${esc(c.g.sector)}" title="${c.open ? 'Click to collapse' : 'Click to expand'} ${esc(c.g.sector)} (${c.g.children.length} countries)"><span class="pv-caret">${c.open ? '▾' : '▸'}</span>${esc(c.g.sector)}<small>${c.g.children.length}</small></th>`
      : `<th class="mx-ch">${esc(c.code)}</th>`)).join('')}<th class="tot">Total</th></tr></thead>`;
    const body = hubs.map((h) => {
      const row = a.matrix.get(h) || new Map();
      return `<tr><th scope="row">${esc(h)}</th>${cols.map((c) => (c.kind === 'sector'
        ? cell(hubSector(h, c.g), `${esc(h)} → ${esc(c.g.sector)}: ${fmtKg(hubSector(h, c.g))} · click to ${c.open ? 'collapse' : 'expand'}`, `data-mx-sector="${esc(c.g.sector)}"`, false)
        : cell(row.get(c.code) || 0, `${esc(h)} → ${esc(c.code)} (${esc(c.g.sector)}): ${fmtKg(row.get(c.code) || 0)}`, `data-hub="${esc(h)}" data-dest="${esc(c.code)}"`, true))).join('')}<td class="tot">${fmtNum(a.hubs.get(h).kg, 1)}</td></tr>`;
    }).join('');
    const foot = `<tr><th class="tot" scope="row">Total</th>${cols.map((c) => (c.kind === 'sector'
      ? `<td class="tot mx-sector-tot">${fmtNum(c.g.kg, 1)}</td>`
      : `<td class="tot mx-child">${fmtNum(c.o.kg, 1)}</td>`)).join('')}<td class="tot">${fmtNum(a.total, 1)}</td></tr>`;
    tbl.innerHTML = head + `<tbody>${body}${foot}</tbody>`;
    const mm = document.getElementById('matrixMax'); if (mm) mm.textContent = fmtKg(max);
  }

  /* ------------------------------ Charts ------------------------------ */
  function bucketize(records, edges) {
    const e = edges.slice().sort((x, y) => x - y);
    const labels = [];
    for (let i = 0; i <= e.length; i++) {
      const lo = i === 0 ? 0 : e[i - 1];
      labels.push(i === e.length ? `${fmtNum(lo, 1)}+ KG` : `${fmtNum(lo, 1)}–${fmtNum(e[i], 1)} KG`);
    }
    const out = labels.map((l) => ({ label: l, count: 0, kg: 0 }));
    for (const r of records) {
      let i = 0; while (i < e.length && r.wt > e[i]) i++;    // upper edge inclusive: 5 KG falls in 0–5
      out[i].count++; out[i].kg += r.wt;
    }
    return out;
  }

  function customerRows(a) {
    const n = view.custTopN;
    if (n === 'ALL') return a.custRows;
    if (n === 'CUSTOM') {
      const sel = custCustom ? custCustom.selected : new Set();
      return sel.size ? a.custRows.filter((r) => sel.has(r[0])) : a.custRows.slice(0, 10);
    }
    return a.custRows.slice(0, parseInt(n, 10));
  }

  /** Destination rows for the hub tab picked on the destination chart (ALL = every hub). */
  function destView(a, records) {
    if (destHub !== 'ALL' && !a.hubs.has(destHub)) destHub = 'ALL';
    if (destHub === 'ALL') return { rows: a.destRows, total: a.total, count: a.count };
    const m = new Map(); let total = 0; let count = 0;
    for (const r of records) {
      if (r.hub !== destHub) continue;
      let o = m.get(r.dest); if (!o) m.set(r.dest, (o = { kg: 0, count: 0 }));
      o.kg += r.wt; o.count++; total += r.wt; count++;
    }
    return { rows: sortedEntries(m), total, count };
  }

  function updateDestTabs(a) {
    const t = Charts.theme();
    const tab = (v, label, dot) => `<button type="button" role="tab" data-v="${esc(v)}" aria-selected="${destHub === v}" class="${destHub === v ? 'on' : ''}">${dot ? `<i style="background:${dot}"></i>` : ''}${esc(label)}</button>`;
    $('#destHubTabs').innerHTML = tab('ALL', 'All Hubs') + a.hubRows.map(([h]) => tab(h, h, Charts.colorFor('hub', h, t))).join('');
  }

  /* ---------------- Sector pivot (destination grouped by sector) ---------------- */
  function sectorItems(groups) {
    const items = [];
    for (const g of groups) {
      const open = destOpen.has(g.sector);
      items.push({ kind: 'sector', label: g.sector, sector: g.sector, kg: g.kg, count: g.count, expanded: open, n: g.children.length });
      if (open) g.children.forEach(([code, o]) => items.push({ kind: 'country', label: code, sector: g.sector, kg: o.kg, count: o.count }));
    }
    return items;
  }

  function onDestBarClick(item) {
    if (item.kind === 'sector') {
      if (destOpen.has(item.sector)) destOpen.delete(item.sector); else destOpen.add(item.sector);
      refreshSectorViews();
    } else if (!Charts.emitClick('dest', item.label)) {
      U.toast(`${item.label}: ${fmtKg(item.kg)} · ${fmtNum(item.count, 0)} AWBs (sector ${item.sector})`);
    }
  }

  function refreshSectorViews() {
    if (!last.agg) return;
    const d = destView(last.agg, last.records);
    const groups = Sectors.group(d.rows);
    Charts.destBar(sectorItems(groups), d.total, onDestBarClick);
    updatePivot(groups, d);
  }

  function updatePivot(groups, d) {
    const el = document.getElementById('destPivot'); if (!el) return;
    const max = groups.reduce((m, g) => Math.max(m, g.kg), 0);
    const pct = (v) => fmtPct(d.total ? (v / d.total) * 100 : 0, 2);
    const bar = (v) => `<span class="wt-bar"><i style="width:${max ? Math.max(2, (v / max) * 100) : 0}%"></i></span>`;
    let html = '<thead><tr><th>Sector / Destination</th><th class="r">Countries</th><th class="r">AWBs</th><th class="r">Total KG</th><th class="r">Avg KG</th><th class="r">% Share</th></tr></thead><tbody>';
    for (const g of groups) {
      const open = destOpen.has(g.sector);
      html += `<tr class="pv-sector${open ? ' open' : ''}" data-sector="${esc(g.sector)}"><th scope="row"><span class="pv-caret">${open ? '▾' : '▸'}</span>${esc(g.sector)}</th><td class="r num">${g.children.length}</td><td class="r num">${fmtNum(g.count, 0)}</td><td class="r"><div class="wt-cell"><span class="num">${fmtNum(g.kg, 2)}</span>${bar(g.kg)}</div></td><td class="r num">${fmtNum(g.count ? g.kg / g.count : 0, 2)}</td><td class="r num">${pct(g.kg)}</td></tr>`;
      if (open) for (const [code, o] of g.children) {
        html += `<tr class="pv-child" data-dest="${esc(code)}"><th scope="row">${esc(code)}</th><td class="r num">—</td><td class="r num">${fmtNum(o.count, 0)}</td><td class="r"><div class="wt-cell"><span class="num">${fmtNum(o.kg, 2)}</span>${bar(o.kg)}</div></td><td class="r num">${fmtNum(o.count ? o.kg / o.count : 0, 2)}</td><td class="r num">${pct(o.kg)}</td></tr>`;
      }
    }
    html += `<tr class="pv-total"><th scope="row">Grand Total</th><td class="r num">${d.rows.length}</td><td class="r num">${fmtNum(d.count, 0)}</td><td class="r num">${fmtNum(d.total, 2)}</td><td class="r num">${fmtNum(d.count ? d.total / d.count : 0, 2)}</td><td class="r num">100.00%</td></tr></tbody>`;
    el.innerHTML = html;
  }

  function updateCharts(a, records) {
    Charts.hubBar(a.hubRows);
    Charts.hubDonut(a.hubRows, a.total);
    const d = destView(a, records);
    updateDestTabs(a);
    const groups = Sectors.group(d.rows);
    Charts.destBar(sectorItems(groups), d.total, onDestBarClick);
    updatePivot(groups, d);
    Charts.custBar(customerRows(a), a.total);
    Charts.buckets(bucketize(records, view.buckets), view.bucketMetric);
    Charts.stateDonut(a.stateRows, a.count);
    Charts.stateBar(a.stateRows, a.total);

    $('#destStats').innerHTML = `<span>Sectors <b>${groups.length}</b></span><span>Destinations <b>${d.rows.length}</b></span><span>AWBs <b>${fmtNum(d.count, 0)}</b></span><span>Total <b>${fmtKg(d.total)}</b></span>${d.rows[0] ? `<span>Top <b>${esc(d.rows[0][0])}</b> ${fmtPct(d.total ? (d.rows[0][1].kg / d.total) * 100 : 0)}</span>` : ''}`;
  }

  /* ------------------------------ Tables ------------------------------ */
  const wtCell = (v, max) => `<div class="wt-cell"><span class="num">${fmtNum(v, 2)}</span><span class="wt-bar"><i style="width:${max ? Math.max(2, (v / max) * 100) : 0}%"></i></span></div>`;
  const rankCell = (n) => `<span class="rank${n <= 3 ? ' top r' + n : ''}">${n}</span>`;

  function buildTables() {
    tables.cust = new DataTable($('#tblCust'), {
      exportName: 'top_customers',
      searchPlaceholder: 'Search customers…',
      defaultSort: { key: 'kg', dir: 'desc' },
      searchKeys: ['name'],
      columns: [
        { key: '_rank', label: 'Rank', render: (r) => rankCell(r._rank) },
        { key: 'name', label: 'Customer Name', cls: 'wrap' },
        { key: 'count', label: 'AWB Count', align: 'r', render: (r) => `<span class="num">${fmtNum(r.count, 0)}</span>` },
        { key: 'kg', label: 'Chargeable Weight KG', align: 'r', render: (r) => wtCell(r.kg, tables.cust._max), exportValue: (r) => +r.kg.toFixed(2) },
        { key: 'avg', label: 'Avg Weight KG', align: 'r', render: (r) => `<span class="num">${fmtNum(r.avg, 2)}</span>`, exportValue: (r) => +r.avg.toFixed(2) },
        { key: 'pct', label: '% Contribution', align: 'r', render: (r) => `<span class="num">${fmtPct(r.pct, 2)}</span>`, exportValue: (r) => +r.pct.toFixed(2) },
      ],
    });
    tables.dest = new DataTable($('#tblDest'), {
      exportName: 'sector_destination_performance',
      searchPlaceholder: 'Search sector or destination…',
      defaultSort: { key: 'kg', dir: 'desc' },
      searchKeys: ['name', 'sector'],
      pageSize: 10,
      grouped: true,
      columns: [
        { key: '_rank', label: 'Rank', render: (r) => (r._child ? '' : rankCell(r._rank)), exportValue: (r) => (r._child ? '' : r._rank) },
        { key: 'sector', label: 'Sector', cls: 'mono', render: (r) => (r._child ? `<span class="dt-sub">${esc(r.sector)}</span>` : `<span class="dt-caret">${r._open ? '▾' : '▸'}</span><b>${esc(r.sector)}</b>`) },
        { key: 'name', label: 'Destination Code', cls: 'mono', render: (r) => (r._child ? `<span class="dt-indent">${esc(r.name)}</span>` : `<span class="dt-sub">${r.n} countr${r.n === 1 ? 'y' : 'ies'}</span>`), exportValue: (r) => (r._child ? r.name : `ALL (${r.n})`) },
        { key: 'count', label: 'Total AWBs', align: 'r', render: (r) => `<span class="num">${fmtNum(r.count, 0)}</span>` },
        { key: 'kg', label: 'Total KG', align: 'r', render: (r) => wtCell(r.kg, tables.dest._max), exportValue: (r) => +r.kg.toFixed(2) },
        { key: 'avg', label: 'Avg Weight KG', align: 'r', render: (r) => `<span class="num">${fmtNum(r.avg, 2)}</span>`, exportValue: (r) => +r.avg.toFixed(2) },
        { key: 'pct', label: '% Contribution', align: 'r', render: (r) => `<span class="num">${fmtPct(r.pct, 2)}</span>`, exportValue: (r) => +r.pct.toFixed(2) },
      ],
    });
    tables.awb = new DataTable($('#tblAwb'), {
      exportName: 'chargeable_weight_analysis',
      searchPlaceholder: 'Search AWB, customer, destination…',
      defaultSort: { key: 'wt', dir: 'desc' },
      pageSizes: [25, 50, 100, 250],
      pageSize: 25,
      searchKeys: ['awb', 'customer', 'dest', 'sector', 'hub', 'state'],
      columns: [
        { key: '_rank', label: 'Rank', render: (r) => rankCell(r._rank) },
        { key: 'awb', label: 'AWB Number', cls: 'mono', render: (r) => `${esc(r.awb)}${r.dup ? ' <span class="pill" title="This AWB number appears more than once">DUP</span>' : ''}` },
        { key: 'customer', label: 'Customer Name' },
        { key: 'eventDate', label: 'Event Date', cls: 'mono', render: (r) => fmtDate(r.eventDate), exportValue: (r) => fmtDate(r.eventDate) },
        { key: 'state', label: 'AWB State', render: (r) => { const c = Charts.colorFor('state', r.state); return `<span class="pill" style="border-color:${c};background:color-mix(in srgb, ${c} 18%, transparent)"><span class="dot" style="background:${c}"></span>${esc(r.state)}</span>`; } },
        { key: 'inscanDate', label: 'Inscan Date', cls: 'mono', render: (r) => fmtDate(r.inscanDate), exportValue: (r) => fmtDate(r.inscanDate) },
        { key: 'dest', label: 'Destination Code', cls: 'mono' },
        { key: 'sector', label: 'Sector', cls: 'mono', exportValue: (r) => Sectors.of(r.dest) },
        { key: 'hub', label: 'Origin Hub Code', cls: 'mono' },
        { key: 'wt', label: 'Chargeable Wt.(KG.)', align: 'r', render: (r) => wtCell(r.wt, tables.awb._max) },
      ],
    });
  }

  function aggRows(entries, total) {
    return entries.map(([name, o], i) => ({ _rank: i + 1, name, count: o.count, kg: o.kg, avg: o.count ? o.kg / o.count : 0, pct: total ? (o.kg / total) * 100 : 0 }));
  }

  function updateTables(a, records) {
    const cr = aggRows(a.custRows, a.total); tables.cust._max = cr[0] ? cr[0].kg : 0; tables.cust.setRows(cr);
    const d = destView(a, records);
    $('#destTblHint').textContent = destHub === 'ALL' ? '' : `Origin hub ${destHub} only`;
    const pc = (v) => (d.total ? (v / d.total) * 100 : 0);
    const dr = Sectors.group(d.rows).map((g, i) => ({
      _rank: i + 1, _gk: g.sector, sector: g.sector, name: g.sector, n: g.children.length,
      count: g.count, kg: g.kg, avg: g.count ? g.kg / g.count : 0, pct: pc(g.kg),
      _children: g.children.map(([code, o], j) => ({ _child: true, _rank: j + 1, sector: g.sector, name: code, count: o.count, kg: o.kg, avg: o.count ? o.kg / o.count : 0, pct: pc(o.kg) })),
    }));
    tables.dest._max = dr.reduce((mx, r) => Math.max(mx, r.kg), 0); tables.dest.setRows(dr);
    const ar = records.slice().sort((x, y) => y.wt - x.wt || x.awb.localeCompare(y.awb)).map((r, i) => Object.assign({}, r, { _rank: i + 1, sector: Sectors.of(r.dest) }));
    tables.awb._max = ar[0] ? ar[0].wt : 0;
    tables.awb.setRows(ar);
  }

  /* ------------------------------ Wiring ------------------------------ */
  function initViewControls(onChange) {
    document.querySelectorAll('.seg[data-target]').forEach((seg) => {
      const key = seg.dataset.target;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(view[key]) === b.dataset.v));
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        view[key] = b.dataset.v; saveView();
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        if (key === 'custTopN') $('#custCustomWrap').hidden = view.custTopN !== 'CUSTOM';
        onChange();
      });
    });
    $('#custCustomWrap').hidden = view.custTopN !== 'CUSTOM';
    // hub tabs on the destination chart: filter that chart and the destination table
    $('#destHubTabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]'); if (!b || !last.agg) return;
      destHub = b.dataset.v;
      updateCharts(last.agg, last.records); updateTables(last.agg, last.records);
    });
    // sector expand / collapse (chart buttons + pivot rows)
    $('#destExpandAll').addEventListener('click', () => {
      if (!last.agg) return;
      Sectors.group(destView(last.agg, last.records).rows).forEach((g) => destOpen.add(g.sector));
      refreshSectorViews(); tables.dest.expandAll(true);
    });
    $('#destCollapseAll').addEventListener('click', () => { destOpen.clear(); refreshSectorViews(); tables.dest.expandAll(false); });
    if ($('#destPivot')) $('#destPivot').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-sector]');
      if (tr) { const s = tr.dataset.sector; if (destOpen.has(s)) destOpen.delete(s); else destOpen.add(s); refreshSectorViews(); return; }
      const c = e.target.closest('tr[data-dest]');
      if (c) Charts.emitClick('dest', c.dataset.dest);
    });
    // matrix: sector header / sector box toggles its countries
    $('#matrixTable').addEventListener('click', (e) => {
      const el = e.target.closest('[data-mx-sector]'); if (!el || !last.agg) return;
      const k = el.dataset.mxSector; if (mxOpen.has(k)) mxOpen.delete(k); else mxOpen.add(k);
      updateMatrix(last.agg);
    });
    $('#mxExpandAll').addEventListener('click', () => { if (!last.agg) return; Sectors.group(last.agg.destRows).forEach((g) => mxOpen.add(g.sector)); updateMatrix(last.agg); });
    $('#mxCollapseAll').addEventListener('click', () => { mxOpen.clear(); if (last.agg) updateMatrix(last.agg); });
    custCustom = new MultiSelect($('#custCustom'), { onChange });
    const bi = $('#bucketInput');
    bi.value = view.buckets.join(',');
    const applyBuckets = () => {
      const edges = bi.value.split(/[,\s]+/).map(Number).filter((n) => isFinite(n) && n > 0);
      const uniq = Array.from(new Set(edges)).sort((x, y) => x - y);
      if (!uniq.length) { U.toast('Enter bucket edges as numbers, e.g. 5,10,25,50', 'err'); return; }
      view.buckets = uniq; bi.value = uniq.join(','); saveView(); onChange();
    };
    $('#btnBucketApply').addEventListener('click', applyBuckets);
    bi.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyBuckets(); });
  }

  /** Full render for a filtered record set. `all` = aggregation of the full file. */
  function render(records, all) {
    last.records = records;
    const a = calculateKPIs(records);
    last.agg = a;
    updateKPIs(a, all);
    const empty = records.length === 0;
    $('#emptyState').hidden = !empty;
    $('#analytics').hidden = empty;
    if (empty) return a;
    updateSummary(a);
    updateMatrix(a);
    updateCharts(a, records);
    updateTables(a, records);
    return a;
  }

  /** Customer option list for the chart's custom picker */
  function setCustomerOptions(options) { if (custCustom) custCustom.setOptions(options); }

  global.Dashboard = {
    view, calculateKPIs, buildKpiCards, buildTables, initViewControls, render,
    updateCharts: () => last.agg && updateCharts(last.agg, last.records),
    updateTables: () => last.agg && updateTables(last.agg, last.records),
    setCustomerOptions, bucketize, customerRows,
    get last() { return last; },
    get tables() { return tables; },
  };
})(window);
