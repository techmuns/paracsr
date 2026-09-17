/**
 * extract.mjs — CSR extraction via the LLM seam (Claude on Bedrock, OpenAI fallback).
 * ===================================================================================
 * Two structured calls per company:
 *   A) classifyIsPsu(name) — the general-knowledge PSU flag + a sector guess the
 *      report text won't state.
 *   B) extractCsr(name, csrText) — the core figures, extracted (never invented)
 *      from the CSR note excerpt we located in the annual report.
 */

import { llmStructured, activeModel } from "./llm.mjs";

/* ----------------------------------------------------------------------------
   A) PSU classification (+ sector fallback).
   -------------------------------------------------------------------------- */

const PSU_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_psu", "sector_guess"],
  properties: {
    is_psu: { type: "boolean", description: "true only if a Public Sector Undertaking (government is majority owner / promoter)" },
    sector_guess: { type: "string", description: "short plain-English sector" },
  },
};

const PSU_SYSTEM =
  "You classify Indian listed companies. `is_psu` = true only if it is a Public " +
  "Sector Undertaking — the Government of India or a State Government owns the " +
  "majority / is the promoter (e.g. SBI, IOC, ONGC, NTPC, Coal India, BEL, HAL, " +
  "all nationalised banks, LIC). Otherwise false. `sector_guess` = a short " +
  "plain-English sector (e.g. 'Banking', 'Oil & Gas', 'IT Services', 'Pharma', " +
  "'Auto', 'FMCG', 'Power', 'Metals & Mining', 'Cement', 'Telecom').";

/**
 * @param {string} name company name
 * @returns {Promise<{is_psu:boolean, sector_guess:string|null}>}
 */
export async function classifyIsPsu(name) {
  try {
    const out = await llmStructured({
      system: PSU_SYSTEM,
      user: `Company: ${name}.`,
      schemaName: "psu_classification",
      schema: PSU_SCHEMA,
    });
    return {
      is_psu: !!out.is_psu,
      sector_guess: (out.sector_guess || "").trim() || null,
    };
  } catch (e) {
    console.warn("[extract] classifyIsPsu failed:", String(e.message || e).slice(0, 200));
    return { is_psu: false, sector_guess: null };
  }
}

/* ----------------------------------------------------------------------------
   B) CSR extraction.
   -------------------------------------------------------------------------- */

export const CSR_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["found", "fy_used", "csr_spent_cr", "csr_obligation_cr", "csr_required_2pct_cr",
             "csr_unspent_cr", "health_or_education", "examples", "confidence", "notes"],
  properties: {
    found: { type: "boolean", description: "true if a CSR / Section 135 disclosure was present in the text" },
    fy_used: { type: "string", enum: ["FY26", "FY25", "unknown"] },
    csr_spent_cr: { type: ["number", "null"], description: "Amount Spent during the Year, INR crore — THE KEY FIGURE" },
    csr_obligation_cr: { type: ["number", "null"], description: "Total CSR Obligation for the year, INR crore" },
    csr_required_2pct_cr: { type: ["number", "null"], description: "Gross amount required = 2% of average net profit (Section 135(5)), INR crore" },
    csr_unspent_cr: { type: ["number", "null"], description: "Amount Unspent during the year, INR crore (0 if fully spent)" },
    health_or_education: { type: ["boolean", "null"], description: "true if any CSR spend is in healthcare OR education" },
    examples: { type: "array", items: { type: "string" }, description: "1–4 short, concrete healthcare/education examples; empty if none" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    notes: { type: "string", description: "one short line: which note/section; any unit conversion" },
  },
};

const CSR_SYSTEM =
  "You extract Corporate Social Responsibility (CSR) figures from an Indian " +
  "company's annual report (Companies Act 2013, Section 135), from the notes to " +
  "accounts. Extract exactly what is stated — never estimate a missing number; " +
  "use null and a lower confidence. All amounts in INR crore — if the report " +
  "states ₹ lakh or ₹ million, convert (1 crore = 100 lakh = 10 million) and say " +
  "so in notes. Use the latest year present — prefer the year ending 31 March " +
  "2026 (FY26); else FY25 (set fy_used). csr_spent_cr is the row usually labelled " +
  '"Amount Spent during the Year". Determine health_or_education from the CSR ' +
  "project descriptions / focus areas / sector-wise spend (healthcare, hospitals, " +
  "medical, health camps; OR education, schools, scholarships, skilling, colleges). " +
  'Give 1–4 concrete examples only if such spends exist (e.g. "Built a 200-bed ' +
  'hospital", "Runs 12 schools", "Medical college at X"). CSR may be disclosed ' +
  "either as a numbered note in the accounts OR as a narrative annexure in the " +
  "Directors'/Board's Report (common for banks and insurers). The 'Amount Spent " +
  "during the Year' may appear as a table row OR in prose (e.g. '₹123.45 crore was " +
  "spent on CSR during the year'). Read both forms. For banks/NBFCs/insurers the " +
  "CSR figure is usually in the Directors'-report CSR annexure, not the " +
  "financial-statement notes. If no CSR disclosure is present, found:false and all " +
  "numbers null.";

/**
 * Extract CSR figures for one company from the located CSR excerpt.
 * @returns {Promise<object>} the CSR record (CSR_SCHEMA shape) + { model }.
 */
export async function extractCsr(name, csrText) {
  const out = await llmStructured({
    system: CSR_SYSTEM,
    user: `Company: ${name}\n\nCSR excerpt from the notes to accounts:\n${csrText}`,
    schemaName: "csr_disclosure",
    schema: CSR_SCHEMA,
  });
  return { ...out, model: activeModel() };
}
