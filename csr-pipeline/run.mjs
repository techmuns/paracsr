/**
 * run.mjs — the CSR pipeline orchestrator.
 * ========================================
 * Per company, in seed order:
 *   resolve Screener URL → read PAT + sector from the P&L → cross-verify PAT
 *   against the client's number → classify PSU → locate the CSR note in the
 *   FY26 annual report → extract the CSR figures → upsert + commit.
 *
 * The ranking is computed from the live PAT (never hardcoded) and recomputed
 * over every present record after each company. One bad company is caught and
 * recorded as failed — it never crashes the run.
 *
 * Env: TICKER (one, optional) · LIMIT (default 25) · FORCE (1 = redo done)
 *      TARGET_BRANCH (defaults to GITHUB_REF_NAME)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";

import { llmBanner, activeModel } from "./llm.mjs";
import {
  launchAndLogin, resolveCompanyUrl, extractPatAndSector, getCsrSourceForCompany,
} from "./scrape.mjs";
import { classifyIsPsu, extractCsr } from "./extract.mjs";

const DIR = "public/data";
const FILES = { companies: `${DIR}/companies.json`, csr: `${DIR}/csr.json`, jobs: `${DIR}/jobs.json`, metadata: `${DIR}/metadata.json` };
const BRANCH = process.env.TARGET_BRANCH || process.env.GITHUB_REF_NAME || "main";
const DRY_RUN = !process.env.GITHUB_ACTIONS && process.env.ALLOW_LOCAL_WRITE !== "1";

const log = (...a) => console.log("[run]", ...a);
const warn = (...a) => console.warn("[run]", ...a);
const now = () => new Date().toISOString();

const readJson = (f, fb) => { if (!fs.existsSync(f)) return fb; try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { throw new Error(`refusing to overwrite ${f}: not valid JSON (${e.message})`); } };
const writeJson = (f, o) => { const t = `${f}.tmp`; fs.writeFileSync(t, JSON.stringify(o, null, 2) + "\n"); fs.renameSync(t, f); };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const hasStaged = () => { try { execSync("git diff --cached --quiet"); return false; } catch { return true; } };

function persistAndPush(message, writeAll) {
  if (DRY_RUN) { console.log(`[dry-run] would commit "${message}"`); return false; }
  const commitOnce = () => { writeAll(); sh(`git add ${Object.values(FILES).join(" ")}`); if (!hasStaged()) return false; sh(`git commit -m ${JSON.stringify(message)}`); return true; };
  if (!commitOnce()) return false;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { sh(`git push origin HEAD:${BRANCH}`); console.log("[push]", message); return true; }
    catch { try { sh(`git fetch origin ${BRANCH}`); sh(`git reset --hard origin/${BRANCH}`); } catch {} ; if (!commitOnce()) return true; }
  }
  throw new Error(`push failed after retries for: ${message}`);
}

/* ----------------------------------------------------------------------------
   In-memory state (re-serialized on every commit so concurrent pushes merge
   logically, never as a text conflict).
   -------------------------------------------------------------------------- */

const seed = readJson(FILES.companies, { companies: [] });
const csr = readJson(FILES.csr, { updated_at: null, count: 0, companies: {} });
const jobs = readJson(FILES.jobs, { jobs: {} });
const metadata = readJson(FILES.metadata, { updated_at: null, total: 200, done: 0, pat_mismatches: 0 });
if (!csr.companies || typeof csr.companies !== "object") csr.companies = {};
if (!jobs.jobs || typeof jobs.jobs !== "object") jobs.jobs = {};

/** Rank by live PAT (desc) over every present record; refresh the counters. */
function recompute() {
  const recs = Object.values(csr.companies);
  const ranked = recs.filter((r) => typeof r.pat_cr === "number").sort((a, b) => b.pat_cr - a.pat_cr);
  ranked.forEach((r, i) => { r.rank = i + 1; });
  recs.filter((r) => typeof r.pat_cr !== "number").forEach((r) => { r.rank = null; });
  csr.count = recs.length;
  csr.updated_at = now();
  metadata.total = (seed.companies || []).length || 200;
  metadata.done = Object.values(jobs.jobs).filter((j) => j && j.status === "done").length;
  metadata.pat_mismatches = recs.filter((r) => r.pat_mismatch === true).length;
  metadata.updated_at = csr.updated_at;
}

function writeAll() {
  recompute();
  writeJson(FILES.csr, csr);
  writeJson(FILES.jobs, jobs);
  writeJson(FILES.metadata, metadata);
}

/* ----------------------------------------------------------------------------
   PAT cross-verification. pat_cr = screener when found, else the client's.
   -------------------------------------------------------------------------- */

function crossVerifyPat(seedPat, screenerPat) {
  const pat_client_cr = typeof seedPat === "number" ? seedPat : null;
  const pat_screener_cr = typeof screenerPat === "number" ? screenerPat : null;
  const pat_cr = pat_screener_cr != null ? pat_screener_cr : pat_client_cr;
  let pat_mismatch = false;
  let pat_delta_pct = null;
  if (pat_client_cr != null && pat_screener_cr != null && pat_client_cr !== 0) {
    const delta = (pat_screener_cr - pat_client_cr) / pat_client_cr;
    pat_delta_pct = Math.round(delta * 10000) / 100; // percent, 2dp
    pat_mismatch = Math.abs(delta) > 0.05;
  }
  return { pat_client_cr, pat_screener_cr, pat_cr, pat_mismatch, pat_delta_pct };
}

/* ----------------------------------------------------------------------------
   Sector buckets. Screener's industry labels get very granular at 200 companies,
   so the dashboard groups by a broad bucket (`sector`) while the original label is
   kept as `sector_detail` (add-only — the dashboard ignores it). Order matters;
   the map is idempotent so a re-stamp of an already-broad value is a no-op.
   -------------------------------------------------------------------------- */

const SECTOR_RULES = [
  [/insurance|reinsur/i, "Insurance"],
  [/nbfc|non[- ]?banking|financial institution|financial\b|housing finance|asset management|\bamc\b|broking|capital market|stock exchange|\bexchange\b|mutual fund/i, "Financial Services"],
  [/\bbank\b|banking/i, "Banking"],
  [/finance|holding|investment|leasing/i, "Financial Services"],
  [/oil|gas|petroleum|refiner|lng|exploration|drilling|\bfuel/i, "Oil & Gas"],
  [/software|it services|computers|information technology|technology|consulting|internet|digital/i, "IT Services"],
  [/pharma|healthcare|health care|hospital|medical|life science|drug|diagnostic|biotech/i, "Pharma & Healthcare"],
  [/telecom|cellular|communication|tower/i, "Telecom"],
  [/auto|automobile|vehicle|tyre|tire|wheeler|tractor|passenger car|commercial vehicle|motorcycle|ancillar|bearing/i, "Auto & Ancillaries"],
  [/power|electric|utilit|renewable|solar|hydro|transmission|\bgeneration\b|\benergy\b/i, "Power & Utilities"],
  [/steel|metal|mining|mineral|alumin|zinc|copper|\biron\b|\bcoal\b|\bore\b|ferro/i, "Metals & Mining"],
  [/cement|construction|infrastructure|realty|real estate|residential|commercial project|building|engineering|\bepc\b|\bport\b|shipping|logistics|capital goods/i, "Cement & Construction"],
  [/chemical|fertiliser|fertilizer|\bpaint|petrochem|pesticide|agrochem|explosive|\bdye|pigment/i, "Chemicals"],
  [/fmcg|food|beverage|personal care|household|tobacco|cigarette|\btea\b|coffee|dairy|edible|\bagro\b|sugar/i, "FMCG"],
  [/retail|consumer|apparel|footwear|jewell|watch|supermarket|\bstore\b|e-?commerce|durable|media|entertainment|hotel|hospitality|textile|trading|distribut/i, "Consumer & Retail"],
];

function broadSector(detail) {
  const s = (detail || "").trim();
  if (!s) return "Other";
  for (const [re, bucket] of SECTOR_RULES) if (re.test(s)) return bucket;
  return "Other";
}

/** One-time (idempotent) re-stamp of existing records to broad sectors: keep the
 *  original granular label as sector_detail, set sector to the broad bucket.
 *  Returns true if anything changed. */
function migrateSectors() {
  let changed = false;
  for (const r of Object.values(csr.companies)) {
    const detail = r.sector_detail != null ? r.sector_detail : r.sector; // original granular label
    const broad = broadSector(detail);
    if (r.sector_detail !== (detail ?? null)) { r.sector_detail = detail ?? null; changed = true; }
    if (r.sector !== broad) { r.sector = broad; changed = true; }
  }
  return changed;
}

/* ----------------------------------------------------------------------------
   Work list — undone/failed first, then (on REFRESH or when nothing is undone)
   stale records whose generated_at is older than REFRESH_DAYS, oldest first.
   -------------------------------------------------------------------------- */

function buildWorklist() {
  const companies = seed.companies || [];
  const explicit = (process.env.TICKER || "").trim();
  if (explicit) {
    // One or more explicit tickers (comma-separated) — always processed, done or not.
    const wanted = explicit.split(",").map((s) => s.trim()).filter(Boolean);
    return wanted.map((t) => companies.find((c) => String(c.ticker) === t)).filter(Boolean);
  }
  const force = process.env.FORCE === "1";
  const refresh = process.env.REFRESH === "1";
  const refreshDays = parseInt(process.env.REFRESH_DAYS || "", 10) || 90;
  const maxPerRun = parseInt(process.env.MAX_PER_RUN || "", 10) || 60;
  const limitEnv = parseInt(process.env.LIMIT || "", 10);
  const cap = Number.isFinite(limitEnv) && limitEnv > 0 ? limitEnv : maxPerRun;
  const isDone = (t) => { const j = jobs.jobs[t]; return !!(j && j.status === "done"); };

  // (a) undone / failed first, in seed (rank) order. FORCE re-does everything.
  const undone = companies.filter((co) => force || !isDone(co.ticker));
  const list = undone.slice(0, cap);

  // (b) top up with stale, done companies (oldest first) when refreshing or when
  // nothing is left undone.
  if (list.length < cap && !force && (refresh || undone.length === 0)) {
    const cutoff = Date.now() - refreshDays * 86400000;
    const stale = companies
      .filter((co) => isDone(co.ticker))
      .map((co) => ({ co, gen: Date.parse((csr.companies[co.ticker] || {}).generated_at || "") || 0 }))
      .filter((x) => x.gen && x.gen < cutoff)
      .sort((a, b) => a.gen - b.gen)
      .map((x) => x.co);
    for (const co of stale) { if (list.length >= cap) break; if (!list.includes(co)) list.push(co); }
  }
  return list.slice(0, cap);
}

/* ----------------------------------------------------------------------------
   Main.
   -------------------------------------------------------------------------- */

async function main() {
  console.log(llmBanner());

  // One-time (idempotent) re-stamp of existing records to broad sector buckets.
  if (migrateSectors()) {
    log("re-stamped sectors to broad buckets");
    persistAndPush("csr: re-stamp sectors to broad buckets", writeAll);
  }

  const worklist = buildWorklist();
  const refresh = process.env.REFRESH === "1";
  log(`branch=${BRANCH} dry_run=${DRY_RUN} worklist=${worklist.length}` +
    (process.env.TICKER ? ` tickers=${process.env.TICKER}` : ` cap=${process.env.LIMIT || process.env.MAX_PER_RUN || 60} refresh=${refresh} force=${process.env.FORCE === "1"}`));
  if (!worklist.length) { log("nothing to do — all done and nothing stale (use FORCE=1 or REFRESH=1 to redo)"); writeAll(); return; }

  const { browser, context, page } = await launchAndLogin();

  try {
    for (const co of worklist) {
      const ticker = co.ticker;
      try {
        jobs.jobs[ticker] = { status: "running", updated_at: now(), error: null };
        persistAndPush(`csr: ${ticker} running`, writeAll);

        const url = await resolveCompanyUrl(context, ticker);
        log(`${ticker} → ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(600);

        const { pat_cr: screenerPat, pat_fy, pat_basis, sector } = await extractPatAndSector(page);
        const pv = crossVerifyPat(co.pat_fy26_cr, screenerPat);
        if (pv.pat_mismatch) {
          warn(`PAT mismatch ${ticker}: client ${co.pat_fy26_cr} vs screener ${screenerPat} (${pv.pat_delta_pct}%)`);
        }

        const { is_psu, sector_guess } = await classifyIsPsu(co.name);
        const sectorDetail = sector || sector_guess || null;

        const base = {
          name: co.name,
          ticker,
          exchange: co.exchange,
          sector: broadSector(sectorDetail), // broad bucket the dashboard groups by
          sector_detail: sectorDetail,        // original granular label (add-only)
          is_psu,
          pat_client_cr: pv.pat_client_cr,
          pat_screener_cr: pv.pat_screener_cr,
          pat_screener_fy: pat_fy || null,
          pat_basis: pat_basis || null,
          pat_cr: pv.pat_cr,
          pat_mismatch: pv.pat_mismatch,
          pat_delta_pct: pv.pat_delta_pct,
        };

        const csrSrc = await getCsrSourceForCompany(page, context);
        let record;
        if (!csrSrc.csrText) {
          record = {
            ...base,
            fy_used: "unknown",
            csr_spent_cr: null, csr_obligation_cr: null, csr_required_2pct_cr: null, csr_unspent_cr: null,
            health_or_education: null, examples: [],
            found: false, confidence: "low",
            notes: csrSrc.sourceUrl ? "CSR note not located in the annual report" : "annual report not found on Screener",
            source: { annual_report_url: csrSrc.sourceUrl || null, page: csrSrc.page ?? null },
            model: null,
            generated_at: now(),
          };
          log(`${ticker}: no CSR text (${record.notes})`);
        } else {
          const ex = await extractCsr(co.name, csrSrc.csrText);
          record = {
            ...base,
            fy_used: ex.fy_used,
            csr_spent_cr: ex.csr_spent_cr,
            csr_obligation_cr: ex.csr_obligation_cr,
            csr_required_2pct_cr: ex.csr_required_2pct_cr,
            csr_unspent_cr: ex.csr_unspent_cr,
            health_or_education: ex.health_or_education,
            examples: Array.isArray(ex.examples) ? ex.examples : [],
            found: ex.found,
            confidence: ex.confidence,
            notes: ex.notes,
            source: { annual_report_url: csrSrc.sourceUrl || null, page: csrSrc.page ?? null },
            model: ex.model || activeModel(),
            generated_at: now(),
          };
          log(`${ticker}: found=${record.found} spent=${record.csr_spent_cr} conf=${record.confidence}`);
        }

        // Preserve rank across upsert; recompute() will overwrite it anyway.
        csr.companies[ticker] = { rank: (csr.companies[ticker] || {}).rank ?? null, ...record };
        jobs.jobs[ticker] = { status: "done", updated_at: now(), error: null };
        persistAndPush(`csr: ${ticker} ${record.found ? "done" : "no-csr"} (pat ${record.pat_cr}${pv.pat_mismatch ? " ⚠pat" : ""})`, writeAll);
      } catch (e) {
        const msg = String(e && e.message ? e.message : e).slice(0, 300);
        warn(`FAILED ${ticker}: ${msg}`);
        jobs.jobs[ticker] = { status: "failed", updated_at: now(), error: msg };
        try { persistAndPush(`csr: ${ticker} failed`, writeAll); } catch (e2) { warn("commit-after-fail failed:", e2.message); }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Final stamp (covers the dry-run path and any last counter change).
  writeAll();
  log(`done. present=${csr.count} done=${metadata.done} pat_mismatches=${metadata.pat_mismatches}`);
}

main().catch((err) => {
  console.error("[run] fatal:", err && err.stack ? err.stack : err);
  process.exit(1);
});
