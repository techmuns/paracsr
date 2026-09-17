/* ui.js — shared helpers: formatting, palette, ECharts base, DOM & icons. */

/* ------------------------------------------------------------- palette */
// Validated categorical order (dataviz check: all pass; never cycle a 9th hue).
export const CATEGORICAL = ["#7c3aed","#06b6d4","#ec4899","#f59e0b","#10b981","#3b82f6","#14b8a6","#f43f5e","#6366f1","#0ea5e9"];
export const COLORS = {
  gov:"#6366f1", pri:"#06b6d4",        // Government (indigo) vs Private (cyan) — CVD ΔE 18.5
  govSoft:"rgba(99,102,241,.85)", priSoft:"rgba(6,182,212,.85)",
  heYes:"#10b981", heNo:"#cbd5e1",     // Health/Education Yes = green (always)
  more:"#10b981", less:"#f59e0b", met:"#94a3b8", // 2% rule (green/amber CVD-safe ΔE 8.9)
  ink1:"#0f172a", ink2:"#475569", ink3:"#64748b", ink4:"#94a3b8",
};
export const FONT = "Inter, system-ui, sans-serif";
export const MONO = "'JetBrains Mono', ui-monospace, monospace";

/* --------------------------------------------------------- formatting */
// Indian digit grouping (…12,34,567).
function group(n, dp) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
// ₹ crore, sensible precision: whole for big, 1dp for small, "—" for null.
export function fmtCr(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const dp = Math.abs(n) >= 100 || n === 0 ? 0 : Math.abs(n) >= 10 ? 1 : 2;
  return "₹" + group(n, dp) + " cr";
}
export function fmtCrShort(n) { // for axis labels: "₹1,316" (unit in title)
  if (n == null || Number.isNaN(n)) return "—";
  return "₹" + group(Math.round(n), 0);
}
export function fmtNum(n, dp = 0) { return group(n, dp); }
export function fmtPct(n, dp = 1) { return n == null || Number.isNaN(n) ? "—" : group(n, dp) + "%"; }

/* --------------------------------------------------------- ECharts base */
export const TOOLTIP = {
  trigger: "item", backgroundColor: "rgba(15,23,42,0.92)", borderWidth: 0,
  textStyle: { color: "#fff", fontSize: 12, fontFamily: FONT },
  extraCssText: "border-radius:10px;padding:8px 12px;box-shadow:0 8px 24px rgba(2,6,23,.28)",
};
export const AXIS_LABEL = { color: COLORS.ink3, fontFamily: FONT, fontSize: 11 };
// muted, minimal axis (no heavy gridlines).
export function valueAxis(extra = {}) {
  return {
    type: "value", splitLine: { lineStyle: { color: "rgba(15,23,42,.06)" } },
    axisLine: { show: false }, axisTick: { show: false },
    axisLabel: { ...AXIS_LABEL, formatter: (v) => fmtCrShort(v) }, ...extra,
  };
}
export function catAxis(data, extra = {}) {
  return {
    type: "category", data, axisTick: { show: false },
    axisLine: { lineStyle: { color: "rgba(15,23,42,.12)" } },
    axisLabel: { ...AXIS_LABEL }, ...extra,
  };
}
export const LEGEND = {
  bottom: 0, icon: "roundRect", itemWidth: 11, itemHeight: 11, itemGap: 16,
  textStyle: { color: COLORS.ink2, fontFamily: FONT, fontSize: 12 },
};
export const EMPHASIS_PIE = { scale: true, scaleSize: 7, itemStyle: { shadowBlur: 16, shadowColor: "rgba(2,6,23,0.20)" } };

/* --------------------------------------------------------- DOM & icons */
export function el(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((c) => c != null && n.append(c.nodeType ? c : document.createTextNode(String(c))));
  return n;
}
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

export function icons() { try { if (window.lucide) window.lucide.createIcons(); } catch {} }

export function emptyNote(container, msg, icon = "inbox") {
  container.innerHTML = "";
  container.append(el("div", { class: "empty-note" }, [
    el("i", { "data-lucide": icon }), el("div", { text: msg }),
  ]));
  icons();
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
