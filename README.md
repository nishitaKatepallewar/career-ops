# Jobot

Jobot is a [career-ops](https://github.com/santifer/career-ops) fork that adds Telegram notifications, JD extraction, and new-grad-focused scoring. 

Jobot scans job portals, evaluates offers against a candidate's profile, and sends results to Telegram. Designed for new-grad software engineering and AI job hunters.

## Pipeline

### 1. Configure

**Input:** `portals.yml` — list of companies with career page URLs, ATS provider hints, title/location filters, and search queries.

**Process:** The user edits this file to add or remove companies, update target role keywords, or adjust location preferences.

**Output:** A configured scan target list.

### 2. Scan

**Input:** `portals.yml` company list + ATS API URLs (Greenhouse, Ashby, Lever, Workable, SmartRecruiters, Recruitee).

**Process:** `node scan.mjs` iterates every company. For each one, the matching provider calls the ATS API, fetches all open roles, filters by title/location keywords, deduplicates against `data/scan-history.tsv`, and writes new offers to `data/pipeline.md`.

Along the way, job descriptions are extracted from the API responses, stripped of HTML, and written to `jds/{md5(url)}.md`. These files are used later during scoring.

**Output:**
- `data/pipeline.md` — new offers appended to the Pendientes section
- `data/scan-history.tsv` — every seen URL logged (for dedup)
- `jds/{hash}.md` — one file per role containing the full JD text

### 3. Score

**Input:** Pipeline entries from step 2 + candidate profile (hardcoded in `telegram-notify.mjs`) + JD text from `jds/{hash}.md`.

**Process:** `telegram-notify.mjs` builds an LLM prompt containing:
- Candidate profile (target roles, skills, experience, visa status, location preferences, compensation targets)
- One entry per new role: title, company, location, URL, and first 3000 characters of the JD text
- Scoring instructions (1-5 scale, rationale format)

The prompt is sent to Anthropic Claude (`claude-sonnet-4-6`). The model returns one JSON line per role with a score and 5-word rationale.

**Output:** A list of scored roles with:
- `score` (1-5, one decimal)
- `reason` (short rationale)
- Original metadata (URL, company, title, location)

### 4. Notify

**Input:** Scored roles from step 3.

**Process:** Roles are grouped into tiers:
- Strong Matches (≥ 3.5) — multi-line per role with score, location, reason, and `[Apply]` link
- Worth a Look (2.5–3.4) — compact single-line per role
- Below 2.5 — count only
- Pipeline backlog count

The message is sent to a Telegram bot via the Bot API. Links use angle-bracket auto-link syntax (`<url>`) to remain clickable without breaking Markdown parsing.

**Output:** A Telegram message like:

```
Career-Ops Scan — 2026-06-05

32 new roles found

Strong Matches (≥ 3.5) — 3
4.2 Databricks — AI Engineer - FDE (Forward Deployed Engineer)
    Remote - India — AI FDE India, strong skills match
    [Apply](https://databricks.com/...)

3.8 Anthropic — Applied AI Engineer
    Sydney — Applied AI eng, Sydney visa needed
    [Apply](https://...)

Worth a Look (2.5–3.4) — 10
3.3 Sierra — Software Engineer, Agent
3.2 Sierra — Software Engineer, Agent
...

Below 2.5 — 19

43 roles pending in pipeline.
```

### 5. Evaluate (Deep Dive)

**Input:** A single pipeline entry the user wants to evaluate in depth.

**Process:** The AI reads `cv.md`, `config/profile.yml`, `modes/_shared.md`, `modes/_profile.md`, and the full JD. A 6-block evaluation (A-F: CV match, North Star alignment, compensation, culture, red flags, global score) plus Block G (posting legitimacy) is generated.

**Output:**
- `reports/{num}-{company}-{date}.md` — full evaluation report
- `output/{num}-{company}.pdf` — ATS-optimized CV PDF
- `data/applications.md` — tracker updated via `batch/tracker-additions/{num}-{company}.tsv` + `node merge-tracker.mjs`

## Next Steps 

- **53 companies cannot be scanned.** Companies with branded career pages (Google, Meta, Amazon, Apple, Nvidia, Jane Street, Citadel, OpenAI, and 45 others) use URLs that don't match any ATS provider. Their `scan_method: websearch` label in `portals.yml` is documentary — no websearch or Playwright provider exists in the script layer to handle them. A WebSearch API provider (SerpAPI/Tavily) or a Playwright generic scraper would be needed.
- **LLM scoring reads only the first 3000 characters of each JD.** For very long JDs (7000+ characters), the requirements section may be truncated.
- **Pipeline accumulates non-matches.** Roles like Production Associate, Warehouse Associate, and Commercial Terrain pass the title filter and enter the pipeline, wasting LLM scoring calls. Stricter negative keywords or pre-filtering are needed.
- **35 companies are mislabeled** as `scan_method: websearch` when their `careers_url` already matches an ATS provider. This is cosmetic — they are already being scanned — but the YAML metadata is misleading.
- **No automated discard.** Roles that are clearly not a fit still get LLM-scored. A pre-scoring classification step (rule-based, not LLM) would save API credits.