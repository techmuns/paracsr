/**
 * scrape.mjs — Screener login + PAT/sector + annual-report discovery + PDF→CSR text.
 * ==================================================================================
 * Everything here is DEFENSIVE: multiple selectors, try/catch around every network
 * or DOM step, an artifact dump on trouble, and a structured return value on every
 * path. These functions must NEVER throw — one bad company must not crash the run.
 *
 * The token-saving rule lives here too: we never send a whole 300–500 page annual
 * report to the model. We keyword-scan the PDF for the CSR / Section 135 note and
 * feed the model only those pages (see extractCsrText).
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { firecrawlScrape } from "./llm.mjs";

const BASE = "https://www.screener.in";
const ARTIFACTS = process.env.ARTIFACTS_DIR || "csr-pipeline/output";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const log = (...a) => console.log("[scrape]", ...a);
const warn = (...a) => console.warn("[scrape]", ...a);

export async function launchAndLogin() {
  const creds = [
    { email: process.env.SCREENER_PREMIUM_EMAIL, password: process.env.SCREENER_PREMIUM_PASSWORD, tier: "premium" },
    { email: process.env.SCREENER_EMAIL, password: process.env.SCREENER_PASSWORD, tier: "free" },
  ].filter((c) => c.email && c.password);
  if (!creds.length) throw new Error("No Screener credentials set (SCREENER_EMAIL/SCREENER_PASSWORD).");
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  for (let i = 0; i < creds.length; i++) {
    const { email, password, tier } = creds[i];
    const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 1200 } });
    const page = await context.newPage();
    log(`logging in… (${tier})`);
    await page.goto(`${BASE}/login/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    const uField = 'input[name="username"], input[type="email"], #id_username';
    const pField = 'input[name="password"], input[type="password"], #id_password';
    await page.fill(uField, email).catch(() => {});
    await page.fill(pField, password).catch(() => {});
    await Promise.all([
      page.waitForURL((u) => !/\/login\//.test(u.toString()), { timeout: 15000 }).catch(() => {}),
      (async () => {
        const btn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Login")').first();
        if (await btn.count().catch(() => 0)) await btn.click().catch(() => {});
        else await page.press(pField, "Enter").catch(() => {});
      })(),
    ]);
    await page.waitForTimeout(1500);
    const ok = !/\/login\//.test(page.url()) && (await page.locator(pField).count().catch(() => 1)) === 0;
    if (ok) { log(`login OK (${tier})`); return { browser, context, page }; }
    await context.close().catch(() => {});
  }
  await browser.close().catch(() => {});
  throw new Error("Screener login failed for all configured accounts");
}

// Consolidated first (matches the client's consolidated PAT), fall back to standalone.
export async function resolveCompanyUrl(context, ticker) {
  const cons = `${BASE}/company/${encodeURIComponent(ticker)}/consolidated/`;
  const base = `${BASE}/company/${encodeURIComponent(ticker)}/`;
  try { const r = await context.request.get(cons, { timeout: 30000 }); if (r.ok() && /consolidated/i.test(r.url())) return cons; } catch {}
  return base;
}

// Authenticated PDF fetch with per-host Referer; Firecrawl fallback for hotlink-blocked exchange PDFs.
export async function fetchPdfBuffer(context, url) {
  const host = (() => { try { return new URL(url).host; } catch { return ""; } })();
  const referer = /bseindia/i.test(host) ? "https://www.bseindia.com/"
    : /nseindia/i.test(host) ? "https://www.nseindia.com/" : BASE + "/";
  if (/nseindia/i.test(host)) { try { await context.request.get("https://www.nseindia.com/", { timeout: 30000 }); } catch {} }
  try {
    const res = await context.request.get(url, { headers: { Referer: referer, "User-Agent": UA, accept: "application/pdf,*/*" }, timeout: 120000 });
    if (res.ok()) { const buf = await res.body(); if (buf && buf.length > 1000) return { buffer: buf, via: "direct" }; }
    else warn("pdf direct fetch status", res.status());
  } catch (e) { warn("pdf direct fetch failed", e.message); }
  const fc = await firecrawlScrape(url); // returns markdown text (no buffer)
  if (fc.ok && fc.text) return { text: fc.text, via: "firecrawl" };
  return null;
}

/* ============================================================================
   Artifact dumps — screenshot + HTML when a step looks wrong. Best-effort only.
   ========================================================================== */

function ensureArtifacts() {
  try { fs.mkdirSync(ARTIFACTS, { recursive: true }); } catch {}
}

async function dumpPage(page, tag) {
  ensureArtifacts();
  const safe = String(tag).replace(/[^a-z0-9_-]/gi, "_").slice(0, 80);
  try { await page.screenshot({ path: path.join(ARTIFACTS, `${safe}.png`), fullPage: false }); } catch {}
  try { fs.writeFileSync(path.join(ARTIFACTS, `${safe}.html`), await page.content()); } catch {}
}

/* ============================================================================
   1) PAT (from Screener's annual P&L) + sector.
   ========================================================================== */

/**
 * Read the latest annual Net Profit from Screener's Profit & Loss table, plus a
 * short sector string. Returns { pat_cr, pat_fy, pat_basis, sector }.
 * pat_cr is null (never throws) when the table/row can't be read.
 */
export async function extractPatAndSector(page) {
  const url = page.url();
  const pat_basis = /\/consolidated\//i.test(url) ? "consolidated" : "standalone";

  let pat = { pat_cr: null, pat_fy: null };
  try {
    pat = await page.evaluate(() => {
      const res = { pat_cr: null, pat_fy: null };
      const table = document.querySelector("#profit-loss table");
      if (!table) return res;
      // Header: ["", "Mar 2015", …, "Mar 2026", "TTM"]. Take the rightmost real FY
      // column (a header matching /Mar 20\d\d/), ignoring a trailing TTM column.
      const ths = Array.from(table.querySelectorAll("thead th"));
      let bestIdx = -1, bestYear = -1, bestHeader = "";
      ths.forEach((th, idx) => {
        const m = (th.textContent || "").match(/Mar\s*(20\d\d)/i);
        if (m) { const y = parseInt(m[1], 10); if (y >= bestYear) { bestYear = y; bestIdx = idx; bestHeader = (th.textContent || "").trim(); } }
      });
      if (bestIdx < 0) return res;
      const rows = Array.from(table.querySelectorAll("tbody tr"));
      for (const tr of rows) {
        const cells = Array.from(tr.children);
        if (!cells.length) continue;
        const label = (cells[0].textContent || "").replace(/\+/g, "").replace(/\s+/g, " ").trim();
        if (/^net profit/i.test(label)) {
          const cell = cells[bestIdx];
          if (!cell) break;
          const num = parseFloat((cell.textContent || "").replace(/,/g, "").replace(/[^0-9.\-]/g, ""));
          if (!Number.isNaN(num)) {
            res.pat_cr = num;
            const ym = bestHeader.match(/Mar\s*20(\d\d)/i);
            res.pat_fy = ym ? `FY${ym[1]}` : null;
          }
          break;
        }
      }
      return res;
    });
  } catch (e) { warn("extractPat failed", e.message); }

  if (pat.pat_cr == null) { await dumpPage(page, `pat-miss-${Date.now()}`); }

  let sector = null;
  try {
    sector = await page.evaluate(() => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      // Screener classifies via /market/INxx/INxxyy/… links: deeper path = more
      // specific. Pick the deepest (most specific) label.
      let best = null, bestDepth = -1;
      document.querySelectorAll('a[href*="/market/"]').forEach((a) => {
        const t = clean(a.textContent);
        if (!t || t.length < 2 || t.length > 60) return;
        if (/view|more|screen|compare|all\b/i.test(t)) return;
        const depth = ((a.getAttribute("href") || "").match(/IN\d+/g) || []).length;
        if (depth > bestDepth) { bestDepth = depth; best = t; }
      });
      if (best) return best;
      const cmp = [];
      document.querySelectorAll('a[href*="/company/compare/"]').forEach((a) => {
        const t = clean(a.textContent);
        if (t && t.length >= 2 && t.length <= 60 && !/compare|peers|view|more/i.test(t)) cmp.push(t);
      });
      if (cmp.length) { cmp.sort((a, b) => b.length - a.length); return cmp[0]; }
      const m = (document.body.innerText || "").match(/(?:Industry|Sector)\s*:\s*([A-Za-z][A-Za-z0-9&,\-\/ ]{2,50})/i);
      return m ? clean(m[1]) : null;
    });
  } catch (e) { warn("extractSector failed", e.message); }

  return { pat_cr: pat.pat_cr, pat_fy: pat.pat_fy, pat_basis, sector };
}

/* ============================================================================
   2) Annual report URL — newest year from the Documents → Annual reports list.
   ========================================================================== */

export async function findAnnualReportUrl(page) {
  try {
    // Screener lazy-renders the Documents card; scroll it in and give it a beat.
    await page.evaluate(() => {
      const el = document.querySelector("#documents") || document.querySelector('[id*="document"]');
      if (el) el.scrollIntoView({ block: "center" });
    }).catch(() => {});
    await page.waitForTimeout(1000);

    const found = await page.evaluate(() => {
      const yearOf = (s) => {
        const m = (s || "").match(/20(2[0-7]|1\d|0\d)/); // 2000–2027
        return m ? parseInt(m[0], 10) : 0;
      };
      const isReportHref = (href) => /AnnualReport/i.test(href) || /\.pdf(\?|#|$)/i.test(href);
      const candidates = [];
      const pushFrom = (root, scoped) => {
        if (!root || !root.querySelectorAll) return;
        root.querySelectorAll("a[href]").forEach((a) => {
          const href = a.href;
          if (!href || !isReportHref(href)) return;
          const txt = (a.textContent || "").replace(/\s+/g, " ").trim();
          const yr = yearOf(txt) || yearOf(href);
          candidates.push({ url: href, year: yr, txt, scoped });
        });
      };

      // High precision: the list that follows an "Annual reports" heading.
      const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,summary,button,span,div"))
        .filter((h) => /annual\s*reports?/i.test((h.textContent || "").trim()) && (h.textContent || "").trim().length < 40);
      for (const h of headings) {
        let sib = h.nextElementSibling, hops = 0;
        while (sib && hops < 4) { pushFrom(sib, true); sib = sib.nextElementSibling; hops++; }
      }
      // Fallback: anywhere on the page.
      if (!candidates.some((c) => c.scoped)) pushFrom(document, false);
      if (!candidates.length) return null;

      // Prefer scoped candidates, then newest year, then explicit "annual" text.
      candidates.sort((a, b) =>
        (Number(b.scoped) - Number(a.scoped)) ||
        (b.year - a.year) ||
        (Number(/annual/i.test(b.txt)) - Number(/annual/i.test(a.txt)))
      );
      const best = candidates[0];
      return best && best.url ? { url: best.url, year: best.year || null } : null;
    });
    return found;
  } catch (e) {
    warn("findAnnualReportUrl failed", e.message);
    return null;
  }
}

/* ============================================================================
   3) Locate the CSR note WITHOUT reading the whole report.
   ========================================================================== */

/* CSR lives in one of two places: a numbered note in the accounts (industrials)
   OR a narrative "Annual Report on CSR Activities" annexure in the Directors'/
   Board's Report (banks, NBFCs, insurers) — sometimes prose, not a table. These
   signals catch BOTH, so a bank's annexure is never missed. */
const CSR_SIGNALS = [
  /amount spent during the year/i,
  /amount spent (for|during) the financial year/i,
  /total amount spent/i,
  /amount required to be spent/i,
  /corporate social responsibility/i,
  /section\s*135/i,
  /csr\s*(committee|expenditure|obligation|activit|policy|project)/i,
  /composition of the csr committee/i,
  /annual report on csr/i,
  /report on csr\s*activit/i,
  /annexure[^.]{0,40}csr/i,
  /2%\s*of\s*(the\s*)?average net profit/i,
  /(unspent|total).{0,25}csr/i,
];
const NOTES_RE = /notes?\s*to\s*(the\s*)?(financial\s*)?(standalone|consolidated)?\s*(statements|accounts)/i;
const RUPEE_NUM = /(₹|rs\.?|inr)\s?[\d,]+/i;
const AMOUNT_NUM = /[\d,]+\.\d+\s*(cr|crore|lakh|million)/i;

/** Is this chunk worth pulling into a CSR window at all? */
function isCsrCandidate(txt) {
  if (!txt) return false;
  if (CSR_SIGNALS.some((re) => re.test(txt))) return true;
  if (NOTES_RE.test(txt) && /corporate social responsibility|\bcsr\b|section\s*135/i.test(txt)) return true;
  return false;
}

/** Score a WINDOW (a candidate chunk + its neighbours) so the annexure/table that
 *  actually carries the figure is concatenated first — even when it sits far from
 *  a "Note NN". A window with an "amount spent" line AND a real rupee figure wins. */
function windowScore(txt) {
  if (!txt) return 0;
  let s = 0;
  const hasSpent = /amount spent/i.test(txt);
  const hasNum = RUPEE_NUM.test(txt) || AMOUNT_NUM.test(txt);
  if (hasSpent && hasNum) s += 3;                                   // the real figure, table OR prose
  if (/amount required to be spent/i.test(txt)) s += 2;
  if (/amount spent during the year/i.test(txt)) s += 3;           // the canonical row label
  const generic = [
    /corporate social responsibility/i, /section\s*135/i, /csr\s*committee/i,
    /annual report on csr/i, /report on csr/i, /2%\s*of\s*(the\s*)?average net profit/i,
    /composition of the csr committee/i, /\bunspent\b/i,
  ];
  s += Math.min(4, generic.reduce((a, re) => a + (re.test(txt) ? 1 : 0), 0)); // +1 each, capped
  if (hasNum) s += 1;
  return s;
}

const CSR_CAP = 25000; // hard ceiling on characters sent to the model (wider for banks)
const WIN = 3;         // window = a candidate chunk plus the next 2

/** Take scored windows, richest first, and concatenate their (deduped) chunks up
 *  to CSR_CAP. `chunkText(i)` returns the text for index i; `label(i)` prefixes it. */
function assembleWindows(candidates, scoreOf, chunkText, label) {
  if (!candidates.length) return { text: "", firstPage: null };
  const windows = candidates.map((start) => {
    const idxs = [];
    for (let d = 0; d < WIN; d++) idxs.push(start + d);
    const joined = idxs.map(chunkText).filter(Boolean).join(" ");
    return { start, idxs, score: scoreOf(joined) };
  });
  windows.sort((a, b) => (b.score - a.score) || (a.start - b.start));
  const used = new Set();
  let out = "";
  let firstPage = null;
  for (const w of windows) {
    if (out.length >= CSR_CAP) break;
    let seg = "";
    for (const i of w.idxs) {
      if (used.has(i)) continue;
      used.add(i);
      const t = chunkText(i);
      if (t) seg += (seg ? "\n" : "") + label(i) + t;
    }
    if (!seg) continue;
    if (firstPage == null) firstPage = w.start;
    out += (out ? "\n\n" : "") + seg;
  }
  return { text: out.slice(0, CSR_CAP + 2000), firstPage };
}

async function extractCsrTextFromBuffer(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const total = Math.min(doc.numPages, 600);
  const cache = new Array(total + 1).fill(null);
  const textOf = (p) => (p >= 1 && p <= total ? cache[p] || "" : "");
  for (let p = 1; p <= total; p++) {
    try {
      const pg = await doc.getPage(p);
      const content = await pg.getTextContent();
      cache[p] = content.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
    } catch { cache[p] = ""; }
  }
  // Every page that shows ANY CSR signal is a window anchor (not just the first).
  const candidates = [];
  for (let p = 1; p <= total; p++) if (isCsrCandidate(cache[p])) candidates.push(p);
  return assembleWindows(candidates, windowScore, (i) => (i <= total ? textOf(i) : ""), (i) => `[page ${i}] `);
}

function extractCsrTextFromText(fullText) {
  if (!fullText || !fullText.trim()) return { text: "", firstPage: null };
  const blocks = fullText.split(/\f|\n{2,}/).map((b) => b.replace(/\s+/g, " ").trim()).filter(Boolean);
  const candidates = [];
  blocks.forEach((b, i) => { if (isCsrCandidate(b)) candidates.push(i); });
  const res = assembleWindows(candidates, windowScore, (i) => blocks[i] || "", () => "");
  return { text: res.text, firstPage: null };
}

/**
 * Locate the CSR note text. `source` is { buffer } (a PDF) or { text } (Firecrawl
 * markdown). Never throws — returns { text:"", firstPage:null } on any trouble.
 */
export async function extractCsrText(source) {
  try {
    if (source && source.buffer) return await extractCsrTextFromBuffer(source.buffer);
    if (source && source.text) return extractCsrTextFromText(source.text);
  } catch (e) {
    warn("extractCsrText failed", e.message);
  }
  return { text: "", firstPage: null };
}

/* ============================================================================
   4) Convenience entry: annual report → PDF/text → CSR excerpt.
   ========================================================================== */

export async function getCsrSourceForCompany(page, context, arOverride) {
  // `arOverride` lets the caller reuse an annual-report link it already scanned
  // (the refresh path scans once, cheaply, to decide whether a re-read is needed).
  const ar = arOverride || await findAnnualReportUrl(page);
  if (!ar || !ar.url) { log("no annual report link found"); return { csrText: "" }; }
  log(`annual report ${ar.year || "?"}: ${ar.url.slice(0, 90)}`);
  const src = await fetchPdfBuffer(context, ar.url);
  if (!src) return { csrText: "", sourceUrl: ar.url, reportYear: ar.year, page: null };
  const res = await extractCsrText(src);
  return {
    csrText: res.text || "",
    sourceUrl: ar.url,
    reportYear: ar.year || null,
    page: res.firstPage ?? null,
    via: src.via || null,
  };
}
