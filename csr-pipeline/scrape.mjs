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

/** Score a chunk of text for CSR-note signals. >0 means "worth sending".
 *  The KEY row ("Amount spent during the year") is weighted far above the rest
 *  so windows containing it are prioritised. */
function csrSignalScore(txt) {
  if (!txt) return 0;
  let score = 0;
  if (/amount spent during the year/i.test(txt)) score += 100; // THE KEY row
  if (/corporate social responsibility/i.test(txt)) score += 5;
  if (/section\s*135/i.test(txt)) score += 5;
  if (/csr\s*(committee|expenditure|obligation)/i.test(txt)) score += 4;
  if (/2%\s*of\s*(the\s*)?average net profit/i.test(txt)) score += 4;
  if (/(unspent|total).{0,25}csr/i.test(txt)) score += 3;
  const notes = /notes?\s*to\s*(the\s*)?(financial\s*)?(standalone|consolidated)?\s*(statements|accounts)/i.test(txt);
  const csrMention = /corporate social responsibility|\bcsr\b|section\s*135/i.test(txt);
  if (notes && csrMention) score += 2;
  return score;
}

const CSR_CAP = 18000; // hard ceiling on characters sent to the model

async function extractCsrTextFromBuffer(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const total = Math.min(doc.numPages, 600);
  const cache = new Array(total + 1).fill(null);
  const textOf = async (p) => {
    if (p < 1 || p > total) return "";
    if (cache[p] != null) return cache[p];
    try {
      const pg = await doc.getPage(p);
      const content = await pg.getTextContent();
      cache[p] = content.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
    } catch { cache[p] = ""; }
    return cache[p];
  };

  // Pass 1: find every page that shows a CSR signal.
  const matches = [];
  for (let p = 1; p <= total; p++) {
    const s = csrSignalScore(await textOf(p));
    if (s > 0) matches.push({ page: p, score: s });
  }
  if (!matches.length) return { text: "", firstPage: null };

  // Pass 2: build windows [p, p+1, p+2], KEY windows first, then by score, then
  // by page order. Concatenate until the char cap.
  matches.sort((a, b) => (b.score - a.score) || (a.page - b.page));
  const used = new Set();
  let out = "";
  let firstPage = null;
  for (const m of matches) {
    if (out.length >= CSR_CAP) break;
    for (let d = 0; d < 3; d++) {
      const p = m.page + d;
      if (p > total || used.has(p)) continue;
      used.add(p);
      const t = await textOf(p);
      if (!t) continue;
      if (firstPage == null) firstPage = m.page;
      out += (out ? "\n\n" : "") + `[page ${p}] ${t}`;
      if (out.length >= CSR_CAP) break;
    }
  }
  return { text: out.slice(0, CSR_CAP + 1500), firstPage };
}

function extractCsrTextFromText(fullText) {
  if (!fullText || !fullText.trim()) return { text: "", firstPage: null };
  const blocks = fullText.split(/\f|\n{2,}/).map((b) => b.replace(/\s+/g, " ").trim()).filter(Boolean);
  const scored = blocks.map((b, i) => ({ i, b, score: csrSignalScore(b) })).filter((x) => x.score > 0);
  if (!scored.length) return { text: "", firstPage: null };
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  const used = new Set();
  let out = "";
  for (const s of scored) {
    if (out.length >= CSR_CAP) break;
    for (let d = 0; d < 3; d++) {
      const idx = s.i + d;
      if (idx >= blocks.length || used.has(idx)) continue;
      used.add(idx);
      out += (out ? "\n\n" : "") + blocks[idx];
      if (out.length >= CSR_CAP) break;
    }
  }
  return { text: out.slice(0, CSR_CAP + 1500), firstPage: null };
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

export async function getCsrSourceForCompany(page, context) {
  const ar = await findAnnualReportUrl(page);
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
