/* data.js — load, normalize, filter, and aggregate. Everything is computed from
   csr.json at runtime; nothing about the 25/200 count is hardcoded. */

export const state = {
  records: [],
  meta: { total: 200, done: 0, updated_at: null },
  filters: { type: "all", sector: "__all", search: "" },
};

async function getJSON(url) {
  // Cache-bust so a CDN/edge-cached older copy never shows a stale count after a refresh.
  const bust = (url.includes("?") ? "&" : "?") + "v=" + Date.now();
  const res = await fetch(url + bust, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

export async function loadData() {
  const [csr, meta] = await Promise.all([
    getJSON("data/csr.json"),
    getJSON("data/metadata.json").catch(() => ({ total: 200, done: 0, updated_at: null })),
  ]);
  state.records = Object.values(csr.companies || {}).map((r) => ({ ...r }));
  state.meta = {
    total: meta.total ?? 200,
    done: meta.done ?? state.records.length,
    updated_at: meta.updated_at || csr.updated_at || null,
  };
  return state;
}

/* ------------------------------------------------------------- helpers */
export const isNum = (v) => typeof v === "number" && !Number.isNaN(v);
export const typeOf = (r) => (r.is_psu ? "gov" : "private");
// "required by law (2%)": prefer the explicit 2% figure, else the stated obligation.
export const requiredOf = (r) => (isNum(r.csr_required_2pct_cr) ? r.csr_required_2pct_cr : isNum(r.csr_obligation_cr) ? r.csr_obligation_cr : null);

export function distinctSectors(records = state.records) {
  return [...new Set(records.map((r) => r.sector).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

// How many records came from the FY26 report vs the FY25 fallback.
export function fyBreakdown(records = state.records) {
  const b = { FY26: 0, FY25: 0, unknown: 0 };
  records.forEach((r) => { b[r.fy_used === "FY26" ? "FY26" : r.fy_used === "FY25" ? "FY25" : "unknown"]++; });
  return b;
}

/* ----------------------------------------------------- filter pipeline */
// Charts respect Type + Sector. The table & examples gallery also apply search.
export function getFiltered({ search = false } = {}) {
  const { type, sector, search: q } = state.filters;
  let list = state.records;
  if (type !== "all") list = list.filter((r) => typeOf(r) === type);
  if (sector !== "__all") list = list.filter((r) => r.sector === sector);
  if (search && q.trim()) {
    const s = q.trim().toLowerCase();
    list = list.filter((r) => (r.name || "").toLowerCase().includes(s) || (r.ticker || "").toLowerCase().includes(s));
  }
  return list;
}

/* --------------------------------------------------------- aggregations */
export const withSpend = (list) => list.filter((r) => isNum(r.csr_spent_cr));
export const totalSpend = (list) => withSpend(list).reduce((a, r) => a + r.csr_spent_cr, 0);
export const heYes = (list) => list.filter((r) => r.health_or_education === true);

export function coverage(list) {
  return { disclosed: withSpend(list).length, total: list.length };
}

export function splitByType(list) {
  return { gov: list.filter((r) => r.is_psu), pri: list.filter((r) => !r.is_psu) };
}

export function groupStats(list) {
  const mk = (arr) => {
    const spend = withSpend(arr);
    const sumSpend = spend.reduce((a, r) => a + r.csr_spent_cr, 0);
    const sumPat = spend.reduce((a, r) => a + (isNum(r.pat_cr) ? r.pat_cr : 0), 0);
    const intens = spend.filter((r) => isNum(r.pat_cr) && r.pat_cr > 0).map((r) => (r.csr_spent_cr / r.pat_cr) * 100);
    return {
      count: arr.length,
      disclosed: spend.length,
      totalSpend: sumSpend,
      avgSpend: spend.length ? sumSpend / spend.length : 0,
      intensity: sumPat > 0 ? (sumSpend / sumPat) * 100 : 0,               // aggregate CSR as % of profit
      avgIntensity: intens.length ? intens.reduce((a, b) => a + b, 0) / intens.length : 0,
      hePct: arr.length ? (heYes(arr).length / arr.length) * 100 : 0,
      heYes: heYes(arr).length,
    };
  };
  const { gov, pri } = splitByType(list);
  return { gov: mk(gov), pri: mk(pri) };
}

export function topSpenders(list, n = 15) {
  return withSpend(list).sort((a, b) => b.csr_spent_cr - a.csr_spent_cr).slice(0, n);
}

export function bySector(list, n = 8) {
  const m = new Map();
  withSpend(list).forEach((r) => {
    const s = r.sector || "Unclassified";
    m.set(s, (m.get(s) || 0) + r.csr_spent_cr);
  });
  return [...m.entries()].map(([sector, total]) => ({ sector, total })).sort((a, b) => b.total - a.total).slice(0, n);
}

export function healthSplit(list) {
  const yes = heYes(list).length;
  return { yes, no: list.length - yes, total: list.length, pct: list.length ? (yes / list.length) * 100 : 0 };
}

export function heByType(list) {
  const { gov, pri } = splitByType(list);
  const c = (a) => ({ yes: heYes(a).length, no: a.length - heYes(a).length });
  return { gov: c(gov), pri: c(pri) };
}

export function heBySector(list, n = 8) {
  const sectors = bySector(list, 999).map((x) => x.sector); // order by spend
  const rows = sectors.map((s) => {
    const arr = list.filter((r) => (r.sector || "Unclassified") === s);
    return { sector: s, yes: heYes(arr).length, no: arr.length - heYes(arr).length };
  });
  return rows.slice(0, n);
}

export function ruleData(list) {
  return withSpend(list)
    .map((r) => ({ ...r, required: requiredOf(r) }))
    .filter((r) => isNum(r.required))
    .map((r) => ({
      name: r.name, ticker: r.ticker, is_psu: r.is_psu,
      spent: r.csr_spent_cr, required: r.required, gap: r.csr_spent_cr - r.required,
    }))
    .sort((a, b) => a.gap - b.gap);
}
