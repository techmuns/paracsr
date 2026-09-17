/* explorer.js — the Company Explorer table (sortable), plus PDF/Excel/CSV export. */

import { el, $, icons, fmtCr, fmtNum, fmtPct, esc } from "./ui.js";
import { isNum, requiredOf } from "./data.js";

// align: 'left' text · 'right' numbers · 'center' badges/pills. Header alignment
// matches the cell so nothing looks like it's "dancing". num → monospaced figures.
const COLS = [
  { key: "rank",    label: "#",             num: true,  align: "center", get: (r) => r.rank ?? Infinity, cell: (r) => `<span class="rank-cell">${r.rank ?? "—"}</span>` },
  { key: "name",    label: "Company",       num: false, align: "left",   get: (r) => (r.name || "").toLowerCase(),
    cell: (r) => `<div class="co-name">${esc(r.name)}</div><div class="co-tick">${esc(r.ticker)} · ${esc(r.exchange || "")}</div>` },
  { key: "sector",  label: "Sector",        num: false, align: "left",   get: (r) => (r.sector || "").toLowerCase(), cell: (r) => `<span class="sector-cell">${esc(r.sector || "—")}</span>` },
  { key: "type",    label: "Type",          num: false, align: "center", get: (r) => (r.is_psu ? 0 : 1),
    cell: (r) => r.is_psu ? `<span class="chip gov"><span class="swatch"></span>Government</span>` : `<span class="chip pri"><span class="swatch"></span>Private</span>` },
  { key: "pat",     label: "Profit ₹cr",    num: true,  align: "right",  get: (r) => (isNum(r.pat_cr) ? r.pat_cr : -1), cell: (r) => fmtNum(r.pat_cr) },
  { key: "spent",   label: "CSR Spent ₹cr", num: true,  align: "right",  get: (r) => (isNum(r.csr_spent_cr) ? r.csr_spent_cr : -1),
    cell: (r) => isNum(r.csr_spent_cr)
      ? `${fmtNum(r.csr_spent_cr, r.csr_spent_cr >= 100 ? 0 : 2)}${r.confidence === "low" ? amberDot() : ""}`
      : `<span class="muted">Not disclosed</span>` },
  { key: "fy",      label: "Year",          num: false, align: "center", get: (r) => (r.fy_used === "FY26" ? 0 : r.fy_used === "FY25" ? 1 : 2),
    cell: (r) => r.fy_used === "FY26" ? `<span class="badge fy26">FY26</span>` : r.fy_used === "FY25" ? `<span class="badge fy25">FY25</span>` : `<span class="muted">—</span>` },
  { key: "pct",     label: "% of Profit",   num: true,  align: "right",  get: (r) => pctOf(r) ?? -1,
    cell: (r) => { const v = pctOf(r); return v == null ? `<span class="muted">—</span>` : fmtPct(v, 2); } },
  { key: "he",      label: "Health/Edu",    num: false, align: "center", get: (r) => (r.health_or_education === true ? 0 : 1),
    cell: (r) => r.health_or_education === true
      ? `<span class="badge yes"><i data-lucide="check"></i>Yes</span>`
      : `<span class="badge no">—</span>` },
  { key: "example", label: "Example",       num: false, align: "left",   get: (r) => ((r.examples || [])[0] || "").toLowerCase(), cell: (r) => exampleCell(r) },
  { key: "src",     label: "Source",        num: false, align: "center", get: (r) => 0,
    cell: (r) => r.source && r.source.annual_report_url
      ? `<a href="${esc(r.source.annual_report_url)}" target="_blank" rel="noopener" title="Open the annual report"><i data-lucide="file-text"></i><span>AR${r.source.page ? " p." + r.source.page : ""}</span></a>`
      : `<span class="muted">—</span>` },
];

const pctOf = (r) => (isNum(r.csr_spent_cr) && isNum(r.pat_cr) && r.pat_cr > 0 ? (r.csr_spent_cr / r.pat_cr) * 100 : null);
const amberDot = () => `<span class="amber-dot" title="Lower-confidence extraction"></span>`;

// Example cell — one line, truncated, with a "+N" chip and an expand hint. The
// whole cell is clickable (wired in renderExplorer) to read the full text.
function exampleCell(r) {
  const ex = (r.examples || []).filter(Boolean);
  if (!ex.length) return `<span class="muted">—</span>`;
  const more = ex.length > 1 ? `<span class="ex-more">+${ex.length - 1}</span>` : "";
  return `<span class="ex-wrap"><span class="ex-text">${esc(ex[0])}</span>${more}<i data-lucide="maximize-2" class="ex-ico"></i></span>`;
}

/* A small modal to read a company's full Health/Education examples on click. */
let modalEl = null;
function ensureModal() {
  if (modalEl) return modalEl;
  modalEl = el("div", { class: "ex-modal", hidden: "" });
  modalEl.innerHTML = `<div class="ex-dialog" role="dialog" aria-modal="true" aria-label="CSR project examples">
      <button class="ex-close" aria-label="Close">&times;</button>
      <div class="ex-co"></div>
      <div class="ex-sub"></div>
      <ul class="ex-list"></ul>
      <a class="ex-srclink" target="_blank" rel="noopener"><i data-lucide="file-text"></i><span>Open the annual report</span></a>
    </div>`;
  document.body.append(modalEl);
  const close = () => { modalEl.hidden = true; };
  modalEl.addEventListener("click", (e) => { if (e.target === modalEl) close(); });
  modalEl.querySelector(".ex-close").addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modalEl.hidden) close(); });
  return modalEl;
}
function openExampleModal(r) {
  const m = ensureModal();
  m.querySelector(".ex-co").textContent = r.name;
  m.querySelector(".ex-sub").textContent = [r.sector, r.fy_used, "Healthcare / Education projects"].filter(Boolean).join("  ·  ");
  const ul = m.querySelector(".ex-list"); ul.innerHTML = "";
  (r.examples || []).filter(Boolean).forEach((e) => ul.append(el("li", { text: e })));
  const link = m.querySelector(".ex-srclink");
  if (r.source && r.source.annual_report_url) { link.href = r.source.annual_report_url; link.style.display = ""; }
  else link.style.display = "none";
  m.hidden = false;
  icons();
}

let sort = { key: "spent", dir: -1 };
let current = [];

export function renderExplorer(list) {
  current = list;
  const wrap = $("#explorer-wrap");
  if (!wrap) return;
  const rows = list.slice().sort(cmp);
  const table = el("table", { class: "explorer" });

  const thead = el("thead");
  const tr = el("tr");
  COLS.forEach((c) => {
    const active = sort.key === c.key;
    const th = el("th", { class: `a-${c.align}${c.num ? " num" : ""}${active ? " sorted" : ""}`, ...(active ? { "aria-sort": sort.dir === 1 ? "ascending" : "descending" } : {}) });
    // Only the active column carries an arrow — the rest stay clean (a faint hint appears on hover).
    const arrow = active ? (sort.dir === 1 ? "arrow-up" : "arrow-down") : "chevrons-up-down";
    th.innerHTML = `<span class="th-in">${esc(c.label)}<i data-lucide="${arrow}" class="sort-ico"></i></span>`;
    th.addEventListener("click", () => {
      if (sort.key === c.key) sort.dir *= -1; else sort = { key: c.key, dir: c.num ? -1 : 1 };
      renderExplorer(current);
    });
    tr.append(th);
  });
  thead.append(tr); table.append(thead);

  const tb = el("tbody");
  if (!rows.length) {
    tb.append(el("tr", {}, el("td", { colspan: COLS.length, style: "padding:28px;text-align:center;color:var(--text-3)" }, "No companies match these filters.")));
  } else {
    rows.forEach((r) => {
      const trr = el("tr");
      COLS.forEach((c) => {
        const td = el("td", { class: `a-${c.align}${c.num ? " num" : ""}${c.key === "example" ? " example" : ""}${c.key === "src" ? " src" : ""}` });
        td.innerHTML = c.cell(r);
        if (c.key === "example" && (r.examples || []).filter(Boolean).length) {
          td.classList.add("clickable");
          td.addEventListener("click", () => openExampleModal(r));
        }
        trr.append(td);
      });
      tb.append(trr);
    });
  }
  table.append(tb);
  wrap.innerHTML = "";
  wrap.append(table);
  icons();
}

function cmp(a, b) {
  const c = COLS.find((x) => x.key === sort.key);
  let va = c.get(a), vb = c.get(b);
  if (typeof va === "string") return va.localeCompare(vb) * sort.dir;
  return (va - vb) * sort.dir;
}

/* ------------------------------------------------------------- exports */
// The CLIENT's original template first (headers verbatim), then 4 provenance
// columns. t: "num" → real number in the .xlsx; "money" → number OR "Not disclosed".
const round2 = (n) => Math.round(n * 100) / 100;
// a = column alignment: text left · numbers right · short categories centre.
// The header takes the same alignment as its cells, so nothing looks misaligned.
const CLIENT_COLS = [
  { h: "Company Name",         t: "text",  a: "left",   v: (r) => `${r.name} (${r.exchange || ""}:${r.ticker})` },
  { h: "PAT (FY26)",           t: "num",   a: "right",  v: (r) => (isNum(r.pat_cr) ? round2(r.pat_cr) : null) },
  { h: "Type of Institution",  t: "text",  a: "center", v: (r) => (r.is_psu ? "PSU" : "Non-PSU") },
  { h: "CSR spend (INR cr)",   t: "money", a: "right",  v: (r) => (isNum(r.csr_spent_cr) ? round2(r.csr_spent_cr) : "Not disclosed") },
  { h: "Spends on Health/Education?", t: "text", a: "center", v: (r) => (r.health_or_education === true ? "Yes" : r.health_or_education === false ? "No" : "N/A") },
  { h: "Example projects",     t: "text",  a: "left",   v: (r) => ((r.examples || []).length ? r.examples.join("; ") : "—") },
  // provenance the client can trust the source with
  { h: "Data Year",            t: "text",  a: "center", v: (r) => r.fy_used || "" },
  { h: "Confidence",           t: "text",  a: "center", v: (r) => r.confidence || "" },
  { h: "Required by law (2%, INR cr)", t: "num", a: "right", v: (r) => { const x = requiredOf(r); return isNum(x) ? round2(x) : null; } },
  { h: "Source",               t: "link",  a: "left",   v: (r) => (r.source && r.source.annual_report_url) || "" },
];
const COL_WIDTH = {
  "Company Name": 46, "PAT (FY26)": 14, "Type of Institution": 17, "CSR spend (INR cr)": 16,
  "Spends on Health/Education?": 22, "Example projects": 62, "Data Year": 11, "Confidence": 13,
  "Required by law (2%, INR cr)": 20, "Source": 22,
};

// Always export in the client's order: PAT descending. Uses the passed set
// (the active filtered set) or the current table set, defaulting to all 200.
const exportRows = (rows) => (rows && rows.length != null ? rows : current).slice()
  .sort((a, b) => (isNum(b.pat_cr) ? b.pat_cr : -1) - (isNum(a.pat_cr) ? a.pat_cr : -1));

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportExcel(rows) {
  const data = exportRows(rows);
  if (typeof window.ExcelJS === "undefined") return exportCSV(data);
  try {
    const wb = new window.ExcelJS.Workbook();
    wb.creator = "Corporate Social Responsibility Tracker";
    const ws = wb.addWorksheet("CSR Tracker", {
      views: [{ showGridLines: false, state: "frozen", ySplit: 2 }],   // gridlines off + frozen title+header
      properties: { tabColor: { argb: "FF6366F1" } },
    });
    const nCols = CLIENT_COLS.length;
    const first = 3, last = 2 + data.length;                            // data rows (title=1, header=2)
    const colLetter = (i) => String.fromCharCode(64 + i);              // 1 -> A
    const wrapCols = new Set(["Company Name", "Example projects"]);
    const solid = (argb) => ({ type: "pattern", pattern: "solid", bgColor: { argb } }); // dxf fill (CF uses bgColor)

    CLIENT_COLS.forEach((c, i) => { ws.getColumn(i + 1).width = COL_WIDTH[c.h] || Math.max(13, c.h.length + 3); });

    // Title banner (row 1)
    ws.mergeCells(1, 1, 1, nCols);
    const title = ws.getCell(1, 1);
    title.value = "Corporate Social Responsibility Tracker   ·   FY26 · India's top 200 listed companies";
    title.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
    title.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4F46E5" } };
    ws.getRow(1).height = 30;

    // Header (row 2) — bold, brand fill, wrapped, filterable
    const hdr = ws.getRow(2);
    CLIENT_COLS.forEach((c, i) => {
      const cell = hdr.getCell(i + 1);
      cell.value = c.h;
      cell.font = { bold: true, size: 11, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6366F1" } };
      cell.alignment = { vertical: "middle", horizontal: c.a, wrapText: true };
      cell.border = { bottom: { style: "medium", color: { argb: "FF4338CA" } } };
    });
    hdr.height = 34;

    // Data rows — number formats, wrap only on the long-text columns, banded rows,
    // vertical-centred so short cells never float at the top of a tall wrapped row.
    data.forEach((r, ri) => {
      const row = ws.getRow(first + ri);
      CLIENT_COLS.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        const raw = c.v(r);
        if (c.t === "link") {
          // Source → a friendly "View annual report" with the URL embedded.
          if (raw) { cell.value = { text: "View annual report", hyperlink: raw, tooltip: raw }; cell.font = { size: 10, underline: true, color: { argb: "FF2563EB" } }; }
          else { cell.value = "—"; cell.font = { size: 10, color: { argb: "FF94A3B8" } }; }
        } else {
          cell.value = raw;
          if ((c.t === "num" || c.t === "money") && typeof raw === "number") cell.numFmt = "#,##0.00";
          cell.font = { size: 10, color: { argb: "FF0F172A" } };
        }
        cell.alignment = { vertical: "middle", horizontal: c.a, wrapText: wrapCols.has(c.h) };
      });
      if (ri % 2 === 1) row.eachCell({ includeEmpty: true }, (cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF6F7FB" } }; });
    });

    // Filter dropdowns on every column
    ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: nCols } };

    // ---- highlighting (restrained: a few meaningful accents, no data bars / no rainbow) ----
    let pr = 1;
    const rng = (i) => `${colLetter(i)}${first}:${colLetter(i)}${last}`;
    const eq = (col, value, style) => ({ ref: rng(col), rules: [{ type: "cellIs", operator: "equal", formulae: [`"${value}"`], priority: pr++, style }] });

    // CSR spend "Not disclosed" → a soft amber flag so gaps stand out.
    ws.addConditionalFormatting({ ref: rng(4), rules: [
      { type: "cellIs", operator: "equal", formulae: ['"Not disclosed"'], priority: pr++, style: { font: { italic: true, color: { argb: "FFB45309" } }, fill: solid("FFFEF7ED") } },
    ] });
    // Health/Education "Yes" → a soft green tint (the headline positive metric).
    ws.addConditionalFormatting(eq(5, "Yes", { font: { bold: true, color: { argb: "FF047857" } }, fill: solid("FFF0FDF4") }));
    // Confidence → coloured text only, no fill (keeps the sheet calm).
    ws.addConditionalFormatting(eq(8, "high",   { font: { color: { argb: "FF047857" } } }));
    ws.addConditionalFormatting(eq(8, "medium", { font: { color: { argb: "FFB45309" } } }));
    ws.addConditionalFormatting(eq(8, "low",    { font: { color: { argb: "FFB91C1C" } } }));

    const buf = await wb.xlsx.writeBuffer();
    download(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "csr-tracker.xlsx");
  } catch (e) { console.warn("Excel export failed, using CSV:", e); exportCSV(exportRows(rows)); }
}

function exportCSV(rows) {
  const data = exportRows(rows);
  const esc2 = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const lines = [CLIENT_COLS.map((c) => esc2(c.h)).join(",")];
  data.forEach((r) => lines.push(CLIENT_COLS.map((c) => esc2(c.v(r))).join(",")));
  download(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }), "csr-tracker.csv");
}
