/**
 * universe.mjs — dynamic top-200 membership (safe-fail).
 * ======================================================
 * Logs into Screener, runs a screen ranked by annual profit descending, pages
 * through ~200 companies, and — ONLY if a safety gate passes — promotes the
 * result to public/data/companies.json. Otherwise it writes the attempt to
 * companies.candidate.json, warns loudly, and exits 0. It can NEVER wipe the
 * working list: the gate requires a plausible, high-overlap scrape.
 *
 * PAT and the ranking are already live in csr.json, so the only thing this
 * changes is WHICH 200 companies are tracked. New entrants get picked up as
 * "undone" by the next `csr` run automatically.
 */

import fs from "node:fs";
import { execSync } from "node:child_process";
import { launchAndLogin } from "./scrape.mjs";

const BASE = "https://www.screener.in";
const DIR = "public/data";
const COMPANIES = `${DIR}/companies.json`;
const CANDIDATE = `${DIR}/companies.candidate.json`;
const WANT = 200;
const MIN_SCRAPED = 180;   // gate: must scrape at least this many
const MIN_OVERLAP = 0.70;  // gate: at least this fraction of the current list must reappear

const log = (...a) => console.log("[universe]", ...a);
const warn = (...a) => console.warn("[universe]", ...a);

const BRANCH = process.env.TARGET_BRANCH || process.env.GITHUB_REF_NAME || "main";
const DRY_RUN = !process.env.GITHUB_ACTIONS && process.env.ALLOW_LOCAL_WRITE !== "1";
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

function writeJson(f, o) { const t = `${f}.tmp`; fs.writeFileSync(t, JSON.stringify(o, null, 2) + "\n"); fs.renameSync(t, f); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } }

// Stage additions for files that exist and deletions for tracked files that don't
// — so `git add` can never error on a candidate path that was never created.
function stageFiles(files) {
  for (const f of files) {
    if (fs.existsSync(f)) { try { sh(`git add ${f}`); } catch {} }
    else { try { sh(`git rm -q --cached ${f}`); } catch {} }
  }
}

function commitPush(files, message) {
  if (DRY_RUN) { log(`[dry-run] would commit "${message}" (${files.join(", ")})`); return; }
  stageFiles(files);
  let staged = true; try { execSync("git diff --cached --quiet"); staged = false; } catch {}
  if (!staged) { log("no changes to commit"); return; }
  sh(`git commit -m ${JSON.stringify(message)}`);
  for (let i = 0; i < 4; i++) {
    try { sh(`git push origin HEAD:${BRANCH}`); log("[push]", message); return; }
    catch { try { sh(`git fetch origin ${BRANCH}`); sh(`git reset --hard origin/${BRANCH}`); stageFiles(files); sh(`git commit -m ${JSON.stringify(message)}`); } catch {} }
  }
  warn("push failed after retries — leaving local commit");
}

const inferExchange = (t) => (/^\d+$/.test(t) ? "BSE" : "NSEI");

/** Page through the profit-ranked screen and collect { name, ticker, pat }. */
async function scrapeUniverse(page) {
  const rows = [];
  const seen = new Set();
  for (let p = 1; p <= 10 && rows.length < WANT + 20; p++) {
    const url = `${BASE}/screen/raw/?sort=${encodeURIComponent("Profit after tax")}&order=desc&query=${encodeURIComponent("Profit after tax > 0")}&page=${p}`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(700);
    } catch (e) { warn(`page ${p} nav failed: ${e.message}`); break; }

    const pageRows = await page.evaluate(() => {
      const out = [];
      const table = document.querySelector("table.data-table") || document.querySelector("table");
      if (!table) return out;
      const ths = Array.from(table.querySelectorAll("thead th"));
      let profitIdx = -1;
      ths.forEach((th, i) => { if (profitIdx < 0 && /profit\s*after\s*tax|net\s*profit|\bprofit\b/i.test((th.textContent || "").replace(/\s+/g, " ").trim())) profitIdx = i; });
      table.querySelectorAll("tbody tr").forEach((tr) => {
        const link = tr.querySelector('a[href^="/company/"]');
        if (!link) return;
        const m = (link.getAttribute("href") || "").match(/\/company\/([^/]+)\//);
        if (!m) return;
        const ticker = decodeURIComponent(m[1]);
        const name = (link.textContent || "").replace(/\s+/g, " ").trim();
        const cells = Array.from(tr.children);
        let pat = null;
        if (profitIdx >= 0 && cells[profitIdx]) {
          const v = parseFloat((cells[profitIdx].textContent || "").replace(/,/g, "").replace(/[^0-9.\-]/g, ""));
          if (!Number.isNaN(v)) pat = v;
        }
        out.push({ name, ticker, pat });
      });
      return out;
    }).catch((e) => { warn(`page ${p} parse failed: ${e.message}`); return []; });

    if (!pageRows.length) { warn(`page ${p}: no rows — stopping`); break; }
    let added = 0;
    for (const r of pageRows) { if (r.ticker && !seen.has(r.ticker)) { seen.add(r.ticker); rows.push(r); added++; } }
    log(`page ${p}: +${added} (total ${rows.length})`);
    if (added === 0) break;
  }
  // Guarantee the ranking even if the server sort was ignored: sort by captured
  // PAT desc when we have it (nulls last), else keep the server order.
  const havePat = rows.filter((r) => typeof r.pat === "number").length;
  if (havePat >= rows.length * 0.6) {
    rows.sort((a, b) => (b.pat ?? -Infinity) - (a.pat ?? -Infinity));
  }
  return rows.slice(0, WANT);
}

function toCompaniesJson(rows) {
  return {
    updated_at: new Date().toISOString(),
    count: rows.length,
    companies: rows.map((r, i) => ({
      rank: i + 1, name: r.name, ticker: r.ticker, exchange: inferExchange(r.ticker),
      pat_fy26_cr: typeof r.pat === "number" ? r.pat : null,
    })),
  };
}

async function main() {
  const current = readJson(COMPANIES, { companies: [] });
  const currentTickers = new Set((current.companies || []).map((c) => String(c.ticker)));

  let rows = [];
  let browser;
  try {
    const res = await launchAndLogin();
    browser = res.browser;
    rows = await scrapeUniverse(res.page);
  } catch (e) {
    warn(`scrape failed: ${e.message} — leaving companies.json untouched`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const scraped = rows.length;
  const newTickers = new Set(rows.map((r) => String(r.ticker)));
  const overlapCount = [...currentTickers].filter((t) => newTickers.has(t)).length;
  const overlap = currentTickers.size ? overlapCount / currentTickers.size : 0;
  log(`scraped=${scraped} overlap=${(overlap * 100).toFixed(1)}% of ${currentTickers.size} current`);

  const gatePass = scraped >= MIN_SCRAPED && overlap >= MIN_OVERLAP;

  if (!gatePass) {
    warn(`⚠️  SAFETY GATE FAILED (need ≥${MIN_SCRAPED} scraped AND ≥${MIN_OVERLAP * 100}% overlap). ` +
      `Keeping companies.json untouched; writing attempt to companies.candidate.json.`);
    writeJson(CANDIDATE, toCompaniesJson(rows));
    commitPush([CANDIDATE], `universe: safe no-op (scraped ${scraped}, overlap ${(overlap * 100).toFixed(0)}%) → candidate`);
    process.exit(0);
  }

  const promoted = toCompaniesJson(rows);
  const entered = [...newTickers].filter((t) => !currentTickers.has(t));
  const exited = [...currentTickers].filter((t) => !newTickers.has(t));
  log(`✅ gate passed — promoting ${scraped} companies.`);
  log(`entered (${entered.length}): ${entered.slice(0, 50).join(", ")}${entered.length > 50 ? " …" : ""}`);
  log(`exited  (${exited.length}): ${exited.slice(0, 50).join(", ")}${exited.length > 50 ? " …" : ""}`);
  writeJson(COMPANIES, promoted);
  try { if (fs.existsSync(CANDIDATE)) fs.rmSync(CANDIDATE); } catch {}
  commitPush([COMPANIES, CANDIDATE], `universe: promote top ${scraped} by live PAT (+${entered.length}/-${exited.length})`);
  process.exit(0);
}

main().catch((err) => {
  warn(`fatal (handled, not wiping list): ${err && err.stack ? err.stack : err}`);
  process.exit(0);
});
