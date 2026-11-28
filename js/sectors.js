/* =====================================================================
   sectors.js — Destination code → Sector mapping (pivot grouping).
   Edit SECTORS below to change which country codes belong to a sector.
   Any code not listed falls into "OTHERS".
   ===================================================================== */
(function (global) {
  'use strict';

  // Order here = order of sectors when weights are equal. Codes are matched upper-case.
  const SECTORS = {
    AUS: ['AU'],
    MYS: ['MY'],
    UK:  ['UK', 'GB'],                         // data uses GB for United Kingdom
    CAN: ['CA', 'YVR', 'YUL', 'YYZ'],          // data uses CA; airport codes kept too
    EUR: ['DE', 'AT', 'BE', 'LU', 'NL', 'CZ', 'DK', 'LI', 'FR', 'MC', 'PL', 'IT', 'HU', 'SK', 'SL', 'SI',
          'PT', 'ES', 'FI', 'IE', 'SE', 'EE', 'HR', 'LT', 'LV', 'RO', 'BG', 'IS', 'GR'],
    NZ:  ['NZ'],
    SIN: ['SG', 'TH', 'KH', 'TW', 'ID', 'BN', 'PH', 'VN', 'MO', 'KR', 'JP'],
    DXB: ['AE', 'QA', 'BH', 'KW', 'OM', 'IQ', 'JO', 'ZA', 'LB'],
    USA: ['US'],
    HK:  ['HK'],
    SA:  ['SA'],
  };
  const OTHERS = 'OTHERS';

  const lookup = new Map();
  Object.keys(SECTORS).forEach((s) => SECTORS[s].forEach((c) => { if (!lookup.has(c)) lookup.set(c, s); }));

  function of(code) {
    const c = String(code == null ? '' : code).trim().toUpperCase();
    return lookup.get(c) || OTHERS;
  }

  /** Group destination rows [[code,{kg,count}]] into sectors.
      Returns [{ sector, kg, count, children: [[code,{kg,count}]] }] sorted by kg desc. */
  function group(destRows) {
    const m = new Map();
    for (const [code, o] of destRows) {
      const s = of(code);
      let g = m.get(s); if (!g) m.set(s, (g = { sector: s, kg: 0, count: 0, children: [] }));
      g.kg += o.kg; g.count += o.count; g.children.push([code, o]);
    }
    const out = Array.from(m.values());
    out.forEach((g) => g.children.sort((a, b) => b[1].kg - a[1].kg));
    out.sort((a, b) => (a.sector === OTHERS) - (b.sector === OTHERS) || b.kg - a.kg);
    return out;
  }

  global.Sectors = { SECTORS, OTHERS, of, group };
})(window);
