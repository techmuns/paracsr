/* app.js — loader, shell, global filters, tab routing. Renders the active tab
   from the current filters; recomputes everything from csr.json at runtime. */

import { $, $$, el, icons, fmtCr, fmtCrShort, fmtNum, fmtPct, esc, COLORS } from "./ui.js";
import {
  state, loadData, getFiltered, distinctSectors, coverage, totalSpend, splitByType,
  groupStats, healthSplit, ruleData, withSpend, heYes, isNum, typeOf,
} from "./data.js";
import * as charts from "./charts.js";
import { renderExplorer, exportExcel, exportPDF } from "./explorer.js";

const ui = { tab: "big", govpriMode: "amount", heMode: "type", ruleType: "all" };

/* ---------------------------------------------------------------- boot */
init();
async function init() {
  try {
    await loadData();
  } catch (e) {
    console.error(e);
    showFatal("Couldn't load the data files. If you opened this as a local file, serve the folder over http (or view the deployed site).");
    return;
  }
  populateSectors();
  updateChrome();
  wireFilters(); wireTabs(); wireToggles(); wireExports();
  restoreTab();
  renderActive();
  icons();
  const loader = $("#loader"); if (loader) loader.classList.add("hidden");
  let t; window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(charts.resizeAll, 150); });
}

function showFatal(msg) {
  const loader = $("#loader");
  if (loader) { loader.innerHTML = ""; loader.append(el("div", { style: "max-width:420px;text-align:center;color:var(--text-2);font-size:14px;padding:24px;line-height:1.5" }, [el("div", { style: "font-size:26px;margin-bottom:8px" }, "⚠️"), msg])); }
}

/* -------------------------------------------------------------- chrome */
function populateSectors() {
  const sel = $("#sector-select");
  distinctSectors().forEach((s) => sel.append(el("option", { value: s }, s)));
}

function updateChrome() {
  const { done, total, updated_at } = state.meta;
  $("#live-count").textContent = `${fmtNum(done)} of ${fmtNum(total)} companies`;
  const f = getFiltered();
  $("#filter-count").textContent = `Showing ${f.length} of ${state.records.length} loaded`;
  if (updated_at) {
    const d = new Date(updated_at);
    if (!isNaN(d)) $("#footer-text").textContent = `Data from company FY26 annual reports (Section 135 CSR disclosures) · verified against Screener · updated ${d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`;
  }
}

/* --------------------------------------------------------------- wiring */
function wireFilters() {
  $$("#type-toggle button").forEach((b) => b.addEventListener("click", () => {
    $$("#type-toggle button").forEach((x) => x.setAttribute("aria-selected", "false"));
    b.setAttribute("aria-selected", "true");
    state.filters.type = b.dataset.type; onFilterChange();
  }));
  $("#sector-select").addEventListener("change", (e) => { state.filters.sector = e.target.value; onFilterChange(); });
  let t; $("#search-input").addEventListener("input", (e) => {
    clearTimeout(t); t = setTimeout(() => { state.filters.search = e.target.value; if (ui.tab === "explorer" || ui.tab === "health") renderActive(); }, 160);
  });
}

function onFilterChange() { updateChrome(); renderActive(); }

function wireTabs() {
  $$("#tabbar .tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
}
function switchTab(name) {
  ui.tab = name;
  $$("#tabbar .tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
  try { localStorage.setItem("paracsr-tab", name); } catch {}
  renderActive();
  requestAnimationFrame(charts.resizeAll);
}
function restoreTab() {
  let saved; try { saved = localStorage.getItem("paracsr-tab"); } catch {}
  if (saved && $(`#tabbar .tab[data-tab="${saved}"]`)) switchTab(saved);
}

function wireToggles() {
  bindToggle("#govpri-toggle", (m) => { ui.govpriMode = m; if (ui.tab === "govpri") renderGovPri(); });
  bindToggle("#he-breakdown-toggle", (m) => { ui.heMode = m; if (ui.tab === "health") charts.renderHeStack(getFiltered(), ui.heMode); });
  bindToggle("#rule-toggle", (m) => { ui.ruleType = m; if (ui.tab === "rule") renderRule(); }, "type");
}
function bindToggle(sel, cb, attr = "mode") {
  const root = $(sel); if (!root) return;
  $$("button", root).forEach((b) => b.addEventListener("click", () => {
    $$("button", root).forEach((x) => x.setAttribute("aria-selected", "false"));
    b.setAttribute("aria-selected", "true"); cb(b.dataset[attr]);
  }));
}

function wireExports() {
  $("#btn-excel").addEventListener("click", exportExcel);
  $("#btn-pdf").addEventListener("click", () => { if (ui.tab !== "explorer") switchTab("explorer"); requestAnimationFrame(() => setTimeout(exportPDF, 60)); });
}

/* --------------------------------------------------------------- render */
function renderActive() {
  updateChrome();
  ({ big: renderBig, govpri: renderGovPri, health: renderHealth, rule: renderRule, explorer: renderExplorerTab }[ui.tab] || renderBig)();
  requestAnimationFrame(charts.resizeAll);
}

/* ① Big Picture */
function renderBig() {
  const list = getFiltered();
  renderTiles(list);
  charts.renderTop(list);
  charts.renderGovPriDonut(list);
  charts.renderSector(list);
}
function renderTiles(list) {
  const cov = coverage(list);
  const tot = totalSpend(list);
  const { gov, pri } = splitByType(list);
  const hs = healthSplit(list);
  const govN = gov.length, priN = pri.length, tt = Math.max(1, govN + priN);
  const host = $("#stat-tiles");
  host.innerHTML = "";
  host.append(
    tile("violet", "heart-handshake", `<span class="num">₹${fmtNum(Math.round(tot))}<small> cr</small></span>`, "Total CSR Spending"),
    tile("blue", "building-2", `<span class="num">${fmtNum(cov.disclosed)}<small> of ${fmtNum(cov.total)}</small></span>`, "with disclosed CSR spend"),
    tile("indigo", "landmark",
      `<div class="splitbar"><span style="width:${(govN / tt) * 100}%;background:var(--gov)"></span><span style="width:${(priN / tt) * 100}%;background:var(--pri)"></span></div>
       <div class="split-legend"><span class="k"><span class="swatch" style="background:var(--gov)"></span>${govN} Government</span><span class="k"><span class="swatch" style="background:var(--pri)"></span>${priN} Private</span></div>`,
      "Government vs Private", true),
    tile("green", "stethoscope", `<span class="num">${fmtPct(hs.pct, 0)}</span>`, "focus on Health / Education"),
  );
  icons();
}
function tile(color, icon, bodyHtml, label, isSplit = false) {
  return el("div", { class: "card hoverable tile" }, [
    el("div", { class: "tile-top" }, [
      el("div", { class: "tile-icon " + color, html: `<i data-lucide="${icon}"></i>` }),
    ]),
    el("div", { html: bodyHtml, style: isSplit ? "display:flex;flex-direction:column;gap:8px;margin-top:2px" : "" }),
    el("div", { class: "lbl", text: label }),
  ]);
}

/* ② Government vs Private */
function renderGovPri() {
  const list = getFiltered();
  const s = groupStats(list);
  const host = $("#cmp-cards"); host.innerHTML = "";
  host.append(cmpCard("gov", "Government (PSU)", "landmark", s.gov), cmpCard("pri", "Private", "briefcase", s.pri));
  icons();
  charts.renderGrouped(list, ui.govpriMode);
  charts.renderHeFocus(list, "chart-hefocus");
}
function cmpCard(kind, title, icon, m) {
  const metric = (num, lbl) => `<div class="metric"><div class="m-num">${num}</div><div class="m-lbl">${lbl}</div></div>`;
  return el("div", { class: `card hoverable cmp-card ${kind}` }, [
    el("div", { class: "cmp-head", html: `<div class="badge-ico"><i data-lucide="${icon}"></i></div><div><h3>${title}</h3><div class="n">${m.count} companies · ${m.disclosed} with disclosed spend</div></div>` }),
    el("div", { class: "cmp-metrics", html:
      metric(`₹${fmtNum(Math.round(m.totalSpend))}<small> cr</small>`, "Total CSR spending") +
      metric(`₹${fmtNum(Math.round(m.avgSpend))}<small> cr</small>`, "Average per company") +
      metric(`${fmtPct(m.hePct, 0)}`, "Fund Health / Education") +
      metric(`${fmtPct(m.intensity, 2)}`, "CSR as % of profit") }),
  ]);
}

/* ③ Healthcare & Education */
function renderHealth() {
  const list = getFiltered();
  charts.renderHeDonut(list);
  charts.renderHeStack(list, ui.heMode);
  renderGallery(getFiltered({ search: true }));
}
function renderGallery(list) {
  const host = $("#ex-gallery");
  const withEx = list.filter((r) => (r.examples || []).length > 0);
  $("#ex-count").textContent = `${withEx.length} companies`;
  host.innerHTML = "";
  if (!withEx.length) { host.append(el("div", { class: "empty-note", html: `<i data-lucide="search-x"></i><div>No matching companies with described projects.</div>` })); icons(); return; }
  const grid = el("div", { class: "ex-grid" });
  withEx.forEach((r) => {
    const exs = (r.examples || []).slice(0, 2);
    const isHealth = /hospital|health|medical|clinic|\btb\b|nutrition|drinking water|mobile medical/i.test(exs.join(" ") + " " + (r.sector || ""));
    const ico = isHealth ? "heart-pulse" : "graduation-cap";
    grid.append(el("div", { class: "ex-card", html:
      `<div class="ex-top"><div class="ex-ico ${isHealth ? "health" : "edu"}"><i data-lucide="${ico}"></i></div>
        <div><div class="ex-name">${esc(r.name)}</div><div class="ex-tick">${esc(r.ticker)}</div></div>
        <span style="margin-left:auto" class="chip ${r.is_psu ? "gov" : "pri"}"><span class="swatch"></span>${r.is_psu ? "Gov" : "Private"}</span></div>
       <ul>${exs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` }));
  });
  host.append(grid);
  icons();
}

/* ④ Meeting the 2% rule */
function renderRule() {
  let list = getFiltered();
  if (ui.ruleType !== "all") list = list.filter((r) => typeOf(r) === ui.ruleType);
  const rows = ruleData(list);
  const more = rows.filter((r) => r.gap > 0.5).length;
  const short = rows.filter((r) => r.gap < -0.5).length;
  const met = rows.length - more - short;
  const chip = (cls, swatch, label, n) => `<span class="chip summary">${swatch ? `<span class="swatch" style="background:${swatch}"></span>` : ""}<b>${n}</b> ${label}</span>`;
  $("#rule-chips").innerHTML =
    chip("", COLORS.more, "spent more than required", more) +
    chip("", COLORS.met, "met the 2% mark", met) +
    chip("", COLORS.less, "spent less this year", short);
  charts.renderRule(list);
}

/* ⑤ Company Explorer */
function renderExplorerTab() { renderExplorer(getFiltered({ search: true })); }
