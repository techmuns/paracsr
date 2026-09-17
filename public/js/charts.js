/* charts.js — ECharts renders. Every chart: mounts only when its tab is visible,
   guards on `echarts`, shows a friendly empty-state when there's no data or the
   CDN is blocked, and shares one tooltip/legend/axis style. */

import {
  CATEGORICAL, COLORS, FONT, MONO, TOOLTIP, LEGEND, AXIS_LABEL, valueAxis, catAxis,
  EMPHASIS_PIE, emptyNote, fmtCr, fmtCrShort, fmtPct, fmtNum, esc,
} from "./ui.js";
import { splitByType, groupStats, topSpenders, bySector, healthSplit, heByType, heBySector, ruleData, withSpend, totalSpend, isNum, typeOf } from "./data.js";

const charts = new Map();
const has = () => typeof window.echarts !== "undefined";

function mount(id) {
  const dom = document.getElementById(id);
  if (!dom) return null;
  if (!has()) { emptyNote(dom, "Chart library unavailable here — the full data is in the Company Explorer tab.", "bar-chart-3"); return null; }
  let c = charts.get(id);
  if (!c || c.isDisposed?.()) { c = window.echarts.init(dom, null, { renderer: "canvas" }); charts.set(id, c); }
  return c;
}
function empty(id, msg, icon) { const d = document.getElementById(id); if (d) emptyNote(d, msg, icon); const c = charts.get(id); if (c) { c.dispose(); charts.delete(id); } }
export function resizeAll() { charts.forEach((c) => { try { c.resize(); } catch {} }); }

const grad = (a, b) => ({ type: "linear", x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: a }, { offset: 1, color: b }] });
// signed ₹ crore, e.g. +₹169 · −₹42 · ₹0 (Indian digit grouping)
const signCr = (v) => (v > 0 ? "+₹" : v < 0 ? "−₹" : "₹") + fmtNum(Math.abs(Math.round(v)));
const typeChip = (isPsu) => (isPsu ? "Government" : "Private");
const heMark = (r) => (r.health_or_education === true ? "✓ Health/Education" : "—");
const shortName = (n) => (n || "").replace(/\s+(Limited|Ltd\.?|Corporation|Company|of India)\b.*/i, "").trim() || n;

/* -------------------------------------------------- ① Top 15 spenders */
export function renderTop(list) {
  const data = topSpenders(list, 15);
  if (!data.length) return empty("chart-top", "No disclosed CSR spend for this filter yet.", "bar-chart-3");
  const c = mount("chart-top"); if (!c) return;
  const rows = data.slice().reverse(); // ECharts plots first category at the bottom
  c.setOption({
    grid: { left: 8, right: 64, top: 12, bottom: 8, containLabel: true },
    tooltip: {
      ...TOOLTIP,
      formatter: (p) => {
        const r = rows[p.dataIndex];
        return `<b>${esc(r.name)}</b><br/>CSR Spent: <b>${fmtCr(r.csr_spent_cr)}</b><br/>Profit: ${fmtCr(r.pat_cr)}<br/>${typeChip(r.is_psu)} · ${heMark(r)}`;
      },
    },
    xAxis: valueAxis(),
    yAxis: catAxis(rows.map((r) => shortName(r.name)), { axisLabel: { ...AXIS_LABEL, fontSize: 11, width: 130, overflow: "truncate" } }),
    series: [{
      name: "CSR Spent", type: "bar", barWidth: "62%",
      itemStyle: { color: grad(COLORS.gov, COLORS.pri), borderRadius: [0, 6, 6, 0] },
      emphasis: { itemStyle: { color: grad("#7c3aed", "#0ea5e9") } },
      label: { show: true, position: "right", formatter: (p) => fmtCrShort(p.value), color: COLORS.ink2, fontFamily: MONO, fontSize: 11 },
      data: rows.map((r) => r.csr_spent_cr),
    }],
  }, true);
}

/* -------------------------------------------------- ① Gov vs Private donut */
export function renderGovPriDonut(list) {
  const { gov, pri } = splitByType(list);
  const g = totalSpend(gov), p = totalSpend(pri), tot = g + p;
  if (tot <= 0) return empty("chart-govpri", "No disclosed CSR spend for this filter yet.", "pie-chart");
  const c = mount("chart-govpri"); if (!c) return;
  c.setOption({
    tooltip: { ...TOOLTIP, formatter: (x) => `${x.marker} <b>${x.name}</b><br/>${fmtCr(x.value)} · ${fmtPct(x.percent)}` },
    legend: { ...LEGEND, data: ["Government (PSU)", "Private"] },
    title: { text: fmtCrShort(tot), subtext: "total ₹ cr", left: "center", top: "38%",
      textStyle: { fontFamily: "Space Grotesk", fontSize: 22, color: COLORS.ink1, fontWeight: 700 },
      subtextStyle: { fontFamily: FONT, fontSize: 11, color: COLORS.ink3 } },
    series: [{
      type: "pie", radius: ["54%", "78%"], center: ["50%", "46%"], avoidLabelOverlap: true,
      itemStyle: { borderColor: "#fff", borderWidth: 3, borderRadius: 6 },
      label: { show: false }, emphasis: EMPHASIS_PIE,
      data: [
        { name: "Government (PSU)", value: +g.toFixed(2), itemStyle: { color: COLORS.gov } },
        { name: "Private", value: +p.toFixed(2), itemStyle: { color: COLORS.pri } },
      ],
    }],
  }, true);
}

/* -------------------------------------------------- ① CSR by sector */
export function renderSector(list) {
  const data = bySector(list, 8);
  if (!data.length) return empty("chart-sector", "No sector spend to show for this filter yet.", "layers");
  const c = mount("chart-sector"); if (!c) return;
  const rows = data.slice().reverse();
  c.setOption({
    grid: { left: 8, right: 60, top: 12, bottom: 8, containLabel: true },
    tooltip: { ...TOOLTIP, formatter: (p) => `<b>${esc(rows[p.dataIndex].sector)}</b><br/>CSR Spent: <b>${fmtCr(rows[p.dataIndex].total)}</b>` },
    xAxis: valueAxis(),
    yAxis: catAxis(rows.map((r) => r.sector), { axisLabel: { ...AXIS_LABEL, width: 120, overflow: "truncate" } }),
    series: [{
      name: "CSR Spent", type: "bar", barWidth: "60%",
      itemStyle: { color: grad("#ec4899", "#f59e0b"), borderRadius: [0, 6, 6, 0] },
      emphasis: { itemStyle: { color: grad("#f43f5e", "#fbbf24") } },
      label: { show: true, position: "right", formatter: (p) => fmtCrShort(p.value), color: COLORS.ink2, fontFamily: MONO, fontSize: 11 },
      data: rows.map((r) => r.total),
    }],
  }, true);
}

/* -------------------------------------------------- ② grouped bar */
export function renderGrouped(list, mode = "amount") {
  const s = groupStats(list);
  const c = mount("chart-grouped"); if (!c) return;
  const isPct = mode === "pct";
  const cats = isPct ? ["CSR as % of profit", "Avg intensity / company"] : ["Total CSR", "Avg per company"];
  const govVals = isPct ? [s.gov.intensity, s.gov.avgIntensity] : [s.gov.totalSpend, s.gov.avgSpend];
  const priVals = isPct ? [s.pri.intensity, s.pri.avgIntensity] : [s.pri.totalSpend, s.pri.avgSpend];
  const fmt = (v) => (isPct ? fmtPct(v, 2) : fmtCrShort(v));
  c.setOption({
    grid: { left: 6, right: 16, top: 28, bottom: 44, containLabel: true },
    legend: { ...LEGEND, data: ["Government (PSU)", "Private"] },
    tooltip: { ...TOOLTIP, trigger: "axis", axisPointer: { type: "shadow" },
      formatter: (ps) => ps.map((p) => `${p.marker} ${p.seriesName}: <b>${fmt(p.value)}</b>`).join("<br/>") },
    xAxis: catAxis(cats),
    yAxis: valueAxis({ axisLabel: { ...AXIS_LABEL, formatter: (v) => (isPct ? v + "%" : fmtCrShort(v)) } }),
    series: [
      { name: "Government (PSU)", type: "bar", barWidth: 26, itemStyle: { color: COLORS.gov, borderRadius: [6, 6, 0, 0] },
        label: { show: true, position: "top", formatter: (p) => fmt(p.value), color: COLORS.ink2, fontFamily: MONO, fontSize: 10 }, data: govVals.map((v) => +v.toFixed(2)) },
      { name: "Private", type: "bar", barWidth: 26, itemStyle: { color: COLORS.pri, borderRadius: [6, 6, 0, 0] },
        label: { show: true, position: "top", formatter: (p) => fmt(p.value), color: COLORS.ink2, fontFamily: MONO, fontSize: 10 }, data: priVals.map((v) => +v.toFixed(2)) },
    ],
  }, true);
}

/* -------------------------------------------------- ② / ③ health-edu by type */
export function renderHeFocus(list, id = "chart-hefocus") {
  const h = heByType(list);
  const c = mount(id); if (!c) return;
  c.setOption({
    grid: { left: 6, right: 16, top: 28, bottom: 44, containLabel: true },
    legend: { ...LEGEND, data: ["Yes", "No / not disclosed"] },
    tooltip: { ...TOOLTIP, trigger: "axis", axisPointer: { type: "shadow" },
      formatter: (ps) => `<b>${ps[0].axisValue}</b><br/>` + ps.map((p) => `${p.marker} ${p.seriesName}: <b>${fmtNum(p.value)}</b>`).join("<br/>") },
    xAxis: catAxis(["Government", "Private"]),
    yAxis: valueAxis({ axisLabel: { ...AXIS_LABEL, formatter: (v) => fmtNum(v) }, minInterval: 1 }),
    series: [
      { name: "Yes", type: "bar", stack: "he", barWidth: 46, itemStyle: { color: COLORS.heYes, borderRadius: [6, 6, 0, 0] },
        label: { show: true, formatter: (p) => (p.value ? p.value : ""), color: "#fff", fontFamily: MONO, fontSize: 11 },
        data: [h.gov.yes, h.pri.yes] },
      { name: "No / not disclosed", type: "bar", stack: "he", barWidth: 46, itemStyle: { color: COLORS.heNo, borderRadius: [6, 6, 0, 0] },
        label: { show: true, formatter: (p) => (p.value ? p.value : ""), color: COLORS.ink2, fontFamily: MONO, fontSize: 11 },
        data: [h.gov.no, h.pri.no] },
    ],
  }, true);
}

/* -------------------------------------------------- ③ Yes/No donut */
export function renderHeDonut(list) {
  const s = healthSplit(list);
  if (!s.total) return empty("chart-he-donut", "No companies for this filter yet.", "pie-chart");
  const c = mount("chart-he-donut"); if (!c) return;
  c.setOption({
    tooltip: { ...TOOLTIP, formatter: (x) => `${x.marker} <b>${x.name}</b><br/>${fmtNum(x.value)} companies · ${fmtPct(x.percent)}` },
    legend: { ...LEGEND, data: ["Spends on Health/Education", "No / not disclosed"] },
    title: { text: fmtPct(s.pct, 0), subtext: "spend on Health/Edu", left: "center", top: "36%",
      textStyle: { fontFamily: "Space Grotesk", fontSize: 26, color: COLORS.heYes, fontWeight: 700 },
      subtextStyle: { fontFamily: FONT, fontSize: 11, color: COLORS.ink3 } },
    series: [{
      type: "pie", radius: ["55%", "80%"], center: ["50%", "44%"],
      itemStyle: { borderColor: "#fff", borderWidth: 3, borderRadius: 6 }, label: { show: false }, emphasis: EMPHASIS_PIE,
      data: [
        { name: "Spends on Health/Education", value: s.yes, itemStyle: { color: COLORS.heYes } },
        { name: "No / not disclosed", value: s.no, itemStyle: { color: COLORS.heNo } },
      ],
    }],
  }, true);
}

/* -------------------------------------------------- ③ stacked breakdown */
export function renderHeStack(list, mode = "type") {
  const c = mount("chart-he-stack"); if (!c) return;
  let cats, yesArr, noArr;
  if (mode === "sector") {
    const rows = heBySector(list, 8);
    if (!rows.length) return empty("chart-he-stack", "No data for this filter yet.", "bar-chart-4");
    cats = rows.map((r) => r.sector); yesArr = rows.map((r) => r.yes); noArr = rows.map((r) => r.no);
  } else {
    const h = heByType(list);
    cats = ["Government", "Private"]; yesArr = [h.gov.yes, h.pri.yes]; noArr = [h.gov.no, h.pri.no];
  }
  const horizontal = mode === "sector";
  const catAx = catAxis(horizontal ? cats.slice().reverse() : cats, horizontal ? { axisLabel: { ...AXIS_LABEL, width: 116, overflow: "truncate" } } : {});
  const valAx = valueAxis({ axisLabel: { ...AXIS_LABEL, formatter: (v) => fmtNum(v) }, minInterval: 1 });
  if (horizontal) { yesArr = yesArr.slice().reverse(); noArr = noArr.slice().reverse(); }
  c.setOption({
    grid: { left: 6, right: 16, top: 28, bottom: 44, containLabel: true },
    legend: { ...LEGEND, data: ["Yes", "No / not disclosed"] },
    tooltip: { ...TOOLTIP, trigger: "axis", axisPointer: { type: "shadow" },
      formatter: (ps) => `<b>${ps[0].axisValue}</b><br/>` + ps.map((p) => `${p.marker} ${p.seriesName}: <b>${fmtNum(p.value)}</b>`).join("<br/>") },
    xAxis: horizontal ? valAx : catAx,
    yAxis: horizontal ? catAx : valAx,
    series: [
      { name: "Yes", type: "bar", stack: "he", barWidth: horizontal ? "56%" : 46, itemStyle: { color: COLORS.heYes, borderRadius: horizontal ? [0, 0, 0, 0] : [0, 0, 0, 0] }, data: yesArr,
        label: { show: true, formatter: (p) => (p.value ? p.value : ""), color: "#fff", fontFamily: MONO, fontSize: 10 } },
      { name: "No / not disclosed", type: "bar", stack: "he", barWidth: horizontal ? "56%" : 46, itemStyle: { color: COLORS.heNo }, data: noArr,
        label: { show: true, formatter: (p) => (p.value ? p.value : ""), color: COLORS.ink2, fontFamily: MONO, fontSize: 10 } },
    ],
  }, true);
}

/* -------------------------------------------------- ④ diverging 2% rule
   The biggest over- and under-spenders (≤30 bars). Diverging green/amber around a
   neutral zero line, x-axis titled in ₹ crore, the top few each side directly
   labelled and everything on hover. Chips over the FULL set are computed in app.js. */
export function renderRule(list) {
  const all = ruleData(list); // sorted by gap ascending
  if (!all.length) return empty("chart-rule", "No companies with both a spend and a 2% figure for this filter yet.", "scale");
  const c = mount("chart-rule"); if (!c) return;
  const narrow = (typeof window !== "undefined" && window.innerWidth < 720);
  const perSide = narrow ? 8 : 15;
  const under = all.filter((d) => d.gap < 0).slice(0, perSide);   // most-negative first
  const over = all.filter((d) => d.gap > 0).slice(-perSide);      // most-positive last
  const sel = [...under, ...over].sort((a, b) => a.gap - b.gap);  // plot ascending: under at bottom, over at top
  // Direct-label the top few each side (the rest read on hover) — keeps it uncluttered.
  const topOver = over.map((d) => d.gap).sort((a, b) => b - a)[Math.min(3, Math.max(0, over.length - 1))] ?? Infinity;
  const topUnder = under.map((d) => Math.abs(d.gap)).sort((a, b) => b - a)[Math.min(3, Math.max(0, under.length - 1))] ?? Infinity;
  const cats = sel.map((d) => shortName(d.name));
  const pos = sel.map((d) => (d.gap > 0 ? +d.gap.toFixed(2) : null));
  const neg = sel.map((d) => (d.gap < 0 ? +d.gap.toFixed(2) : null));
  c.setOption({
    grid: { left: 8, right: 70, top: narrow ? 64 : 40, bottom: 48, containLabel: true },
    legend: { ...LEGEND, top: 0, bottom: "auto", data: ["Spent more than required", "Spent less than required"] },
    tooltip: { ...TOOLTIP, trigger: "axis", axisPointer: { type: "shadow" },
      formatter: (ps) => { const d = sel[ps[0].dataIndex]; return `<b>${esc(d.name)}</b><br/>CSR spent: <b>${fmtCr(d.spent)}</b><br/>Required by law (2%): ${fmtCr(d.required)}<br/>Difference: <b>${(d.gap >= 0 ? "+" : "−") + fmtCr(Math.abs(d.gap))}</b>`; } },
    xAxis: valueAxis({
      name: "Spent minus required by law  (₹ crore)", nameLocation: "middle", nameGap: 30,
      nameTextStyle: { color: COLORS.ink2, fontFamily: FONT, fontSize: 12, fontWeight: 600 },
      axisLabel: { ...AXIS_LABEL, formatter: (v) => signCr(v) },
    }),
    yAxis: catAxis(cats, { axisLabel: { ...AXIS_LABEL, interval: 0, fontSize: 10, width: 116, overflow: "truncate" }, axisLine: { show: false } }),
    series: [
      { name: "Spent more than required", type: "bar", stack: "gap", barCategoryGap: "42%",
        itemStyle: { color: grad("#34d399", "#059669"), borderRadius: [0, 5, 5, 0] }, data: pos,
        emphasis: { itemStyle: { color: grad("#10b981", "#047857") } },
        label: { show: true, position: "right", color: "#047857", fontFamily: MONO, fontSize: 10, fontWeight: 600, formatter: (p) => (p.value != null && p.value >= topOver ? signCr(p.value) : "") } },
      { name: "Spent less than required", type: "bar", stack: "gap", barCategoryGap: "42%",
        itemStyle: { color: grad("#f59e0b", "#d97706"), borderRadius: [5, 0, 0, 5] }, data: neg,
        emphasis: { itemStyle: { color: grad("#f59e0b", "#b45309") } },
        label: { show: true, position: "left", color: "#b45309", fontFamily: MONO, fontSize: 10, fontWeight: 600, formatter: (p) => (p.value != null && Math.abs(p.value) >= topUnder ? signCr(p.value) : "") },
        markLine: { silent: true, symbol: "none",
          label: { show: true, position: "end", formatter: "← meets the 2% line →", color: COLORS.ink3, fontSize: 10.5, fontFamily: FONT, fontWeight: 600 },
          lineStyle: { color: "rgba(15,23,42,.35)", type: "dashed", width: 1.5 }, data: [{ xAxis: 0 }] } },
    ],
  }, true);
}
