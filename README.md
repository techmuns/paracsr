# paracsr — India CSR 200

A **CSR (Corporate Social Responsibility) spending tracker** for the **top 200 listed
Indian companies by Profit After Tax (PAT)**.

- **Static site** (plain HTML/CSS/JS) served by **Cloudflare Pages** from `public/`.
- **The heavy work runs in GitHub Actions**: it opens each company's Screener page,
  reads PAT from the annual P&L, finds the FY26 annual report, locates the CSR note
  (Section 135 / "Note NN — Corporate Social Responsibility") **without reading the
  whole report**, and extracts the figures with Claude (via Amazon Bedrock).
- **Committed JSON is the single source of truth** — the site reads only
  `public/data/*.json`. The pipeline commits results back to the repo, and Cloudflare
  redeploys automatically.

> This is the **foundation + data pipeline** (Prompt 1). The dashboard UI comes next.
> `public/index.html` is a minimal holding page so the first deploy isn't a 404.

## Layout

```
public/
  index.html            # holding page (fetches data/metadata.json)
  data/
    companies.json      # the 200-company seed (client list + client PAT)
    csr.json            # pipeline output, keyed by ticker
    jobs.json           # per-ticker status
    metadata.json       # counters for the holding page
csr-pipeline/
  llm.mjs               # structured-output client (Bedrock primary, OpenAI fallback)
  check-llm.mjs         # 5-second LLM key preflight
  scrape.mjs            # Screener login + PAT/sector + annual report + PDF→CSR text
  extract.mjs           # CSR schema + prompts + LLM calls
  run.mjs               # orchestrator: PAT cross-verify + CSR + rank + commit loop
.github/workflows/
  csr.yml               # the pipeline (workflow_dispatch)
  check-llm.yml          # manual LLM key check
```

## What the pipeline does, per company

1. Resolve the Screener URL (consolidated first, standalone fallback).
2. Read **PAT** from the annual **Profit & Loss** table (latest `Mar 20YY` column,
   `Net Profit` row) and a short **sector** string.
3. **Cross-verify PAT** against the client's seed number. `pat_cr` is authoritative =
   Screener when found, else the client's. `pat_mismatch` when they differ by > 5%.
4. Classify **PSU** (general knowledge the report won't state) via one small LLM call.
5. Find the **FY26 annual report**, keyword-scan the PDF for the **CSR note**, and send
   Claude **only** those pages.
6. Extract the CSR figures (amount spent, obligation, 2% required, unspent, health/
   education flag + examples) — **exactly what the report states, never estimated**.
7. **Commit after each company** (partial progress is never lost). The **rank** is
   recomputed from live PAT (descending) over every present record on each run.

Nothing that can be measured is hardcoded: PAT and the ranking are live from Screener;
the client's numbers are kept only to cross-check.

## Data model (`public/data/csr.json`)

Keyed by ticker so re-runs upsert cleanly. See a full example record and the field
rules in the pipeline; the key figures:

- `pat_cr` — authoritative PAT (Screener when found, else client).
- `pat_mismatch` / `pat_delta_pct` — data-quality signal vs the client's number.
- `rank` — position by `pat_cr` descending, recomputed every run.
- `csr_spent_cr` — **the key figure** ("Amount Spent during the Year").
- `health_or_education` + `examples` — healthcare/education focus and concrete examples.
- `found` / `confidence` / `source` / `model` — provenance for every record.

## One-time setup (then it runs forever, automatically)

### 1) GitHub Actions secrets

Add these under **Settings → Secrets and variables → Actions**:

| Secret | Required | Notes |
| --- | --- | --- |
| `BEDROCK_API_KEY` | ✅ | Claude via Amazon Bedrock |
| `BEDROCK_REGION` | optional | defaults to `us-east-1` |
| `BEDROCK_MODEL` | optional | pin a model; blank uses the built-in chain |
| `SCREENER_EMAIL` + `SCREENER_PASSWORD` | ✅ | (or `SCREENER_PREMIUM_EMAIL` + `SCREENER_PREMIUM_PASSWORD`) |
| `FIRECRAWL_API_KEY` | ✅ | fallback fetch for hotlink-blocked exchange PDFs |
| `OPENAI_API_KEY` | optional | automatic LLM fallback |
| `LLM_PROVIDER` | optional | blank = Bedrock first; `openai` to flip |

Verify the key any time with the **Check LLM key** workflow (Actions tab → Run workflow).

### 2) Cloudflare Pages (connect once → auto-deploy on every commit)

Connect the repo to Cloudflare Pages **once** and every push (including the pipeline's
JSON commits) deploys automatically — no manual step ever again:

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
2. Pick the `techmuns/paracsr` repository.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty — there is no build step)*
   - **Build output directory:** `public`
4. Save & Deploy. Cloudflare now rebuilds on every commit to the production branch.

> Because the pipeline commits `public/data/*.json` back to the repo, each pipeline run
> triggers a fresh Cloudflare deploy on its own.

## Running the pipeline

Actions tab → **CSR pipeline** → **Run workflow**:

- `limit` — max companies this run (default `25`).
- `ticker` — a single ticker (blank = batch).
- `force` — re-do companies already marked done.

Locally you can dry-run without writing (prints what it *would* commit):

```bash
npm install --no-save playwright pdfjs-dist
npx playwright install --with-deps chromium
# needs SCREENER_* + BEDROCK_API_KEY + FIRECRAWL_API_KEY in the environment
node csr-pipeline/run.mjs        # DRY_RUN unless GITHUB_ACTIONS or ALLOW_LOCAL_WRITE=1
```

## Principles / guardrails

- **No build step.** Deps install on-the-fly in CI (`npm install --no-save`).
- **Never read the whole annual report** — only the keyword-matched CSR pages.
- **The model extracts, it does not invent** — missing figures are `null`, not guesses.
- **Secrets never touch the client** — all keys come from Actions secrets.
- One bad company never crashes the run (per-company try/catch → `jobs[ticker]=failed`).
