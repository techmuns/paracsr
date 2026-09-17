/* explorer.js — the Company Explorer table (sortable), plus PDF/Excel/CSV export. */

import { el, $, icons, fmtCr, fmtNum, fmtPct, esc } from "./ui.js";
import { isNum, requiredOf } from "./data.js";

const COLS = [
  { key: "rank",    label: "#",             num: true,  get: (r) => r.rank ?? Infinity, cell: (r) => `<span class="rank-cell">${r.rank ?? "—"}</span>` },
  { key: "name",    label: "Company",       num: false, get: (r) => (r.name || "").toLowerCase(),
    cell: (r) => `<div class="co-name">${esc(r.name)}</div><div class="co-tick">${esc(r.ticker)} · ${esc(r.exchange || "")}</div>` },
  { key: "sector",  label: "Sector",        num: false, get: (r) => (r.sector || "").toLowerCase(), cell: (r) => esc(r.sector || "—") },
  { key: "type",    label: "Type",          num: false, get: (r) => (r.is_psu ? 0 : 1),
    cell: (r) => r.is_psu ? `<span class="chip gov"><span class="swatch"></span>Government</span>` : `<span class="chip pri"><span class="swatch"></span>Private</span>` },
  { key: "pat",     label: "Profit ₹cr",    num: true,  get: (r) => (isNum(r.pat_cr) ? r.pat_cr : -1), cell: (r) => fmtNum(r.pat_cr) },
  { key: "spent",   label: "CSR Spent ₹cr", num: true,  get: (r) => (isNum(r.csr_spent_cr) ? r.csr_spent_cr : -1),
    cell: (r) => isNum(r.csr_spent_cr)
      ? `${fmtNum(r.csr_spent_cr, r.csr_spent_cr >= 100 ? 0 : 2)}${r.confidence === "low" ? amberDot() : ""}`
      : `<span class="muted">Not disclosed</span>` },
  { key: "fy",      label: "Year",          num: false, get: (r) => (r.fy_used === "FY26" ? 0 : r.fy_used === "FY25" ? 1 : 2),
    cell: (r) => r.fy_used === "FY26" ? `<span class="badge fy26">FY26</span>` : r.fy_used === "FY25" ? `<span class="badge fy25">FY25</span>` : `<span class="muted">—</span>` },
  { key: "pct",     label: "% of Profit",   num: true,  get: (r) => pctOf(r) ?? -1,
    cell: (r) => { const v = pctOf(r); return v == null ? `<span class="muted">—</span>` : fmtPct(v, 2); } },
  { key: "he",      label: "Health/Edu",    num: false, get: (r) => (r.health_or_education === true ? 0 : 1),
    cell: (r) => r.health_or_education === true
      ? `<span class="badge yes"><i data-lucide="check"></i>Yes</span>`
      : `<span class="badge no">—</span>` },
  { key: "example", label: "Example",       num: false, get: (r) => ((r.examples || [])[0] || "").toLowerCase(),
    cell: (r) => { const e = (r.examples || [])[0]; return e ? `<span title="${esc((r.examples || []).join(" · "))}">${esc(e)}</span>` : `<span class="muted">—</span>`; } },
  { key: "src",     label: "Source",        num: false, get: (r) => 0,
    cell: (r) => r.source && r.source.annual_report_url
      ? `<a href="${esc(r.source.annual_report_url)}" target="_blank" rel="noopener"><i data-lucide="file-text"></i>AR${r.source.page ? " p." + r.source.page : ""}</a>`
      : `<span class="muted">—</span>` },
];

const pctOf = (r) => (isNum(r.csr_spent_cr) && isNum(r.pat_cr) && r.pat_cr > 0 ? (r.csr_spent_cr / r.pat_cr) * 100 : null);
const amberDot = () => `<span class="amber-dot" title="Lower-confidence extraction"></span>`;

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
    const th = el("th", { class: c.num ? "num" : "", ...(active ? { "aria-sort": sort.dir === 1 ? "ascending" : "descending" } : {}) });
    th.innerHTML = `<span class="th-in">${esc(c.label)}<i data-lucide="${active ? (sort.dir === 1 ? "chevron-up" : "chevron-down") : "chevrons-up-down"}"></i></span>`;
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
      COLS.forEach((c) => { const td = el("td", { class: (c.num ? "num" : "") + (c.key === "example" ? " example" : "") + (c.key === "src" ? " src" : "") }); td.innerHTML = c.cell(r); trr.append(td); });
      tb.append(trr);
    });
  }
  table.append(tb);
  wrap.innerHTML = "";
  wrap.append(table);
  const cnt = $("#explorer-count"); if (cnt) cnt.textContent = `${rows.length} shown`;
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
const CLIENT_COLS = [
  { h: "Company Name",         t: "text",  v: (r) => `${r.name} (${r.exchange || ""}:${r.ticker})` },
  { h: "PAT (FY26)",           t: "num",   v: (r) => (isNum(r.pat_cr) ? round2(r.pat_cr) : null) },
  { h: "Type of Institution",  t: "text",  v: (r) => (r.is_psu ? "PSU" : "Non-PSU") },
  { h: "CSR spend (INR cr)",   t: "money", v: (r) => (isNum(r.csr_spent_cr) ? round2(r.csr_spent_cr) : "Not disclosed") },
  { h: "Nature of spend",      t: "text",  v: (r) => (r.health_or_education === true ? "Yes" : r.health_or_education === false ? "No" : "N/A") },
  { h: "Relevant eg.",         t: "text",  v: (r) => ((r.examples || []).length ? r.examples.join("; ") : "—") },
  // provenance the client can trust the source with
  { h: "Data Year",            t: "text",  v: (r) => r.fy_used || "" },
  { h: "Confidence",           t: "text",  v: (r) => r.confidence || "" },
  { h: "2% Required (INR cr)", t: "num",   v: (r) => { const x = requiredOf(r); return isNum(x) ? round2(x) : null; } },
  { h: "Source",               t: "text",  v: (r) => (r.source && r.source.annual_report_url) || "" },
];
const COL_WIDTH = { "Company Name": 46, "Relevant eg.": 60, "Source": 52 };

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
    const ws = wb.addWorksheet("India CSR 200");
    ws.columns = CLIENT_COLS.map((c) => ({ header: c.h, key: c.h, width: COL_WIDTH[c.h] || Math.max(13, c.h.length + 3) }));
    const hr = ws.getRow(1);
    hr.font = { bold: true, color: { argb: "FFFFFFFF" } };
    hr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6366F1" } };
    hr.alignment = { vertical: "middle" };
    data.forEach((r) => {
      const row = ws.addRow(CLIENT_COLS.map((c) => c.v(r)));
      CLIENT_COLS.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        if ((c.t === "num" || c.t === "money") && typeof cell.value === "number") { cell.numFmt = "#,##0.00"; cell.alignment = { horizontal: "right" }; }
      });
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];
    const buf = await wb.xlsx.writeBuffer();
    download(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "india-csr-200.xlsx");
  } catch (e) { console.warn("Excel export failed, using CSV:", e); exportCSV(exportRows(rows)); }
}

function exportCSV(rows) {
  const data = exportRows(rows);
  const esc2 = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const lines = [CLIENT_COLS.map((c) => esc2(c.h)).join(",")];
  data.forEach((r) => lines.push(CLIENT_COLS.map((c) => esc2(c.v(r))).join(",")));
  download(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }), "india-csr-200.csv");
}

export async function exportPDF() {
  const wrap = $("#explorer-wrap");
  const table = wrap && wrap.querySelector("table");
  const jsPDFctor = window.jspdf && window.jspdf.jsPDF;
  if (!table || typeof window.html2canvas === "undefined" || !jsPDFctor) {
    return exportCSV(current.slice().sort(cmp)); // graceful fallback
  }
  try {
    const canvas = await window.html2canvas(table, { scale: 2, backgroundColor: "#ffffff", windowWidth: table.scrollWidth });
    const pdf = new jsPDFctor({ orientation: "landscape", unit: "pt", format: "a4" });
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    const margin = 24, iw = pw - margin * 2;
    const ih = (canvas.height * iw) / canvas.width;
    pdf.setFontSize(14); pdf.setTextColor("#0f172a"); pdf.text("India CSR 200 — CSR spending, FY26", margin, 28);
    const img = canvas.toDataURL("image/png");
    let remaining = ih, y = 40, sy = 0;
    const pageBody = ph - y - margin;
    if (ih <= pageBody) { pdf.addImage(img, "PNG", margin, y, iw, ih); }
    else { // slice tall tables across pages
      const ratio = canvas.width / iw;
      while (remaining > 0) {
        const sliceH = Math.min(pageBody, remaining);
        const sCanvas = el("canvas");
        sCanvas.width = canvas.width; sCanvas.height = sliceH * ratio;
        sCanvas.getContext("2d").drawImage(canvas, 0, sy * ratio, canvas.width, sliceH * ratio, 0, 0, canvas.width, sliceH * ratio);
        pdf.addImage(sCanvas.toDataURL("image/png"), "PNG", margin, y, iw, sliceH);
        remaining -= sliceH; sy += sliceH;
        if (remaining > 0) { pdf.addPage(); y = margin; }
      }
    }
    pdf.save("india-csr-200.pdf");
  } catch (e) { console.warn("PDF export failed, using CSV:", e); exportCSV(current.slice().sort(cmp)); }
}
