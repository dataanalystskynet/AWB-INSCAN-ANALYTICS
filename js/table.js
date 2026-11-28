/* =====================================================================
   table.js — reusable DataTable: search, column sort, pagination,
   rows-per-page, CSV / Excel export. Only the visible page is rendered
   to the DOM, so tables stay fast with thousands of rows.
   ===================================================================== */
(function (global) {
  'use strict';
  const { esc, fmtNum, debounce } = U;

  class DataTable {
    /**
     * @param {HTMLElement} mount
     * @param {{
     *   columns: {key:string,label:string,align?:'r',sortable?:boolean,render?:Function,exportValue?:Function,cls?:string}[],
     *   defaultSort: {key:string, dir:'asc'|'desc'},
     *   pageSizes?: number[], pageSize?: number,
     *   searchKeys?: string[], exportName?: string, searchPlaceholder?: string
     * }} opts
     */
    constructor(mount, opts) {
      this.mount = mount;
      this.opts = Object.assign({ pageSizes: [10, 25, 50, 100], pageSize: 10, exportName: 'export' }, opts);
      this.rows = [];
      this.view = [];
      this.page = 1;
      this.pageSize = this.opts.pageSize;
      this.sort = Object.assign({}, this.opts.defaultSort);
      this.query = '';
      this.open = new Set();      // grouped mode: keys of expanded parent rows
      this.build();
    }

    build() {
      const o = this.opts;
      this.mount.innerHTML = `
        <div class="dt-toolbar">
          <div class="search-box"><svg><use href="#i-search"/></svg><input type="search" placeholder="${esc(o.searchPlaceholder || 'Search in this table')}" aria-label="Search table"></div>
          <label class="hint">Rows <select aria-label="Rows per page">${o.pageSizes.map((n) => `<option value="${n}" ${n === this.pageSize ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <span class="spacer"></span>
          <button type="button" class="btn btn-sm" data-x="csv">Export CSV</button>
          <button type="button" class="btn btn-sm" data-x="xlsx">Export Excel</button>
        </div>
        <div class="dt-wrap"><table class="dt"><thead><tr>${o.columns.map((c) => `
          <th class="${c.align === 'r' ? 'r ' : ''}${c.sortable !== false ? 'sortable' : ''}" data-k="${c.key}" scope="col" ${c.sortable !== false ? 'tabindex="0"' : ''}>${esc(c.label)}${c.sortable !== false ? '<span class="arrow">▼</span>' : ''}</th>`).join('')}
        </tr></thead><tbody></tbody></table></div>
        <div class="dt-foot"><span class="dt-info"></span><div class="pager"></div></div>`;
      this.tbody = this.mount.querySelector('tbody');
      this.info = this.mount.querySelector('.dt-info');
      this.pager = this.mount.querySelector('.pager');

      const search = this.mount.querySelector('.dt-toolbar input');
      search.addEventListener('input', debounce(() => { this.query = search.value.trim().toLowerCase(); this.page = 1; this.compute(); this.render(); }, 180));
      this.mount.querySelector('.dt-toolbar select').addEventListener('change', (e) => { this.pageSize = +e.target.value; this.page = 1; this.render(); });
      this.mount.querySelector('[data-x="csv"]').addEventListener('click', () => Exporter.exportCSV(this.exportRows(), this.exportColumns(), this.opts.exportName));
      this.mount.querySelector('[data-x="xlsx"]').addEventListener('click', () => Exporter.exportExcel(this.exportRows(), this.exportColumns(), this.opts.exportName));

      const onSort = (th) => {
        const k = th.dataset.k;
        if (this.sort.key === k) this.sort.dir = this.sort.dir === 'desc' ? 'asc' : 'desc';
        else this.sort = { key: k, dir: 'desc' };
        this.page = 1; this.compute(); this.render();
      };
      this.mount.querySelectorAll('th.sortable').forEach((th) => {
        th.addEventListener('click', () => onSort(th));
        th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(th); } });
      });
      // grouped mode: click a parent row to expand / collapse its children
      this.tbody.addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-gk]');
        if (!tr) return;
        const k = tr.dataset.gk;
        if (this.open.has(k)) this.open.delete(k); else this.open.add(k);
        this.render();
      });
      this.pager.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-p]');
        if (!b || b.disabled) return;
        this.page = +b.dataset.p; this.render();
      });
    }

    /** Grouped mode: expand / collapse every parent row. */
    expandAll(on) { this.open = on ? new Set(this.rows.map((r) => String(r._gk))) : new Set(); this.render(); }

    /** Export: in grouped mode every parent is followed by all its children. */
    exportRows() { return this.opts.grouped ? this.view.flatMap((r) => [r].concat(r._kids || [])) : this.view; }

    exportColumns() {
      return this.opts.columns.map((c) => ({ label: c.label, value: c.exportValue || ((r) => r[c.key]) }));
    }

    /** Replace the data (keeps the current sort, resets to page 1). */
    setRows(rows) { this.rows = rows; this.page = 1; this.compute(); this.render(); }

    compute() {
      let v = this.rows;
      const keys = this.opts.searchKeys || this.opts.columns.map((c) => c.key);
      const q = this.query;
      const hit = (r) => keys.some((k) => String(r[k] ?? '').toLowerCase().includes(q));
      const { key, dir } = this.sort;
      const m = dir === 'asc' ? 1 : -1;
      const cmp = (a, b) => {
        const x = a[key]; const y = b[key];
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * m || (a._rank || 0) - (b._rank || 0);
        return String(x ?? '').localeCompare(String(y ?? '')) * m || (a._rank || 0) - (b._rank || 0);
      };
      if (this.opts.grouped) {
        // parents match on themselves or on any child; matching children open their parent
        this.autoOpen = new Set();
        v = v.map((r) => {
          const all = r._children || [];
          if (!q || hit(r)) return Object.assign(r, { _kids: all.slice().sort(cmp) });
          const kids = all.filter(hit);
          if (!kids.length) return null;
          this.autoOpen.add(String(r._gk));
          return Object.assign(r, { _kids: kids.sort(cmp) });
        }).filter(Boolean);
      } else if (q) v = v.filter(hit);
      this.view = v.slice().sort(cmp);
    }

    render() {
      const total = this.view.length;
      const pages = Math.max(1, Math.ceil(total / this.pageSize));
      if (this.page > pages) this.page = pages;
      const start = (this.page - 1) * this.pageSize;
      const slice = this.view.slice(start, start + this.pageSize);
      const cols = this.opts.columns;

      const tr = (r, attrs = '') => `<tr${attrs}>${cols.map((c) => `<td class="${c.align === 'r' ? 'r ' : ''}${c.cls || ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`;
      const rowsHtml = !this.opts.grouped ? slice.map((r) => tr(r)).join('') : slice.map((r) => {
        const k = String(r._gk);
        const open = this.open.has(k) || (this.autoOpen && this.autoOpen.has(k));
        r._open = open;
        return tr(r, ` class="dt-parent${open ? ' open' : ''}" data-gk="${esc(k)}" title="Click to ${open ? 'collapse' : 'expand'}"`)
          + (open ? (r._kids || []).map((c) => tr(c, ' class="dt-child"')).join('') : '');
      }).join('');
      this.tbody.innerHTML = slice.length ? rowsHtml
        : `<tr><td class="dt-empty" colspan="${cols.length}">No rows found.</td></tr>`;

      this.mount.querySelectorAll('th.sortable').forEach((th) => {
        const on = th.dataset.k === this.sort.key;
        th.classList.toggle('sorted', on);
        th.setAttribute('aria-sort', on ? (this.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
        th.querySelector('.arrow').textContent = on && this.sort.dir === 'asc' ? '▲' : '▼';
      });

      this.info.textContent = total ? `Showing ${fmtNum(start + 1, 0)}–${fmtNum(Math.min(start + this.pageSize, total), 0)} of ${fmtNum(total, 0)}` : '0 rows';

      // compact pager: first, prev, window, next, last
      const btn = (p, label, on = false, dis = false) => `<button type="button" data-p="${p}" ${on ? 'class="on" aria-current="page"' : ''} ${dis ? 'disabled' : ''}>${label}</button>`;
      let html = btn(this.page - 1, '‹', false, this.page === 1);
      const win = 2;
      const from = Math.max(1, this.page - win); const to = Math.min(pages, this.page + win);
      if (from > 1) html += btn(1, '1') + (from > 2 ? '<button type="button" disabled>…</button>' : '');
      for (let p = from; p <= to; p++) html += btn(p, p, p === this.page);
      if (to < pages) html += (to < pages - 1 ? '<button type="button" disabled>…</button>' : '') + btn(pages, pages);
      html += btn(this.page + 1, '›', false, this.page === pages);
      this.pager.innerHTML = html;
    }
  }

  global.DataTable = DataTable;
})(window);
