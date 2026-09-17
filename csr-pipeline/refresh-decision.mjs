/**
 * refresh-decision.mjs — the credit-saving heart of a refresh run.
 * ================================================================
 * On a refresh we re-scan each company cheaply (PAT + the annual-report link, no
 * LLM). We only ever pay for a model read when the report itself is NEW. This
 * module decides that, and is kept pure + separate so it can be unit-tested
 * without importing run.mjs (which starts the pipeline on import).
 */

/** Normalise an annual-report URL so the SAME document compares equal across runs:
 *  lowercase scheme+host, drop the #fragment and any trailing slash; keep the path
 *  and query (that is what identifies the PDF). */
export function normUrl(u) {
  if (!u) return "";
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname}${x.search}`.replace(/\/+$/, "");
  } catch {
    return String(u).trim().replace(/#.*$/, "");
  }
}

/**
 * Can this company reuse its stored CSR (zero credits) or must it be re-read?
 *
 * @param {object|null} prev   existing csr.json record for the ticker (or null)
 * @param {string|null} newUrl newest annual-report URL scanned this run (or null)
 * @param {boolean} force      FORCE flag — re-read everything, ignore the cache
 * @returns {{reuse:boolean, sameReport:boolean, linkMiss:boolean, prevRead:boolean, prevUrl:string|null}}
 *
 * reuse=true  → keep every CSR figure, refresh only PAT/sector. No PDF, no LLM.
 * reuse=false → read the report (new report, first-ever read, or FORCE).
 *
 * - sameReport: we already read this exact URL → nothing new to read.
 * - linkMiss:   we had a report before but the link didn't render now → a transient
 *               scrape miss must NEVER nuke good data, so we hold the stored record.
 */
export function decideReuse(prev, newUrl, force) {
  const prevUrl = prev && prev.source ? (prev.source.annual_report_url || null) : null;
  const prevRead = !!(prev && prev.generated_at);
  const sameReport = prevRead && !!prevUrl && !!newUrl && normUrl(prevUrl) === normUrl(newUrl);
  const linkMiss = prevRead && !!prevUrl && !newUrl;
  const reuse = !force && (sameReport || linkMiss);
  return { reuse, sameReport, linkMiss, prevRead, prevUrl };
}
