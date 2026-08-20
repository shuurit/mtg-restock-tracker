# mtg-restock-tracker

Checks Amazon and Best Buy for Magic: The Gathering (Wizards of The Coast)
products once an hour and posts to Discord when it sees:

- a **new** product (not seen in any previous run), or
- a **restock** (a known product that flips from unavailable to available)

Sources tracked:

- **Amazon** — the "Magic: The Gathering" storefront's Home, Preorder Now,
  and New Releases tabs.
- **Best Buy** — the Wizards of The Coast / Magic: The Gathering search
  results, filtered to items **sold & shipped by Best Buy** (third-party
  marketplace sellers excluded), paginated across every result page.

## How it works

`scraper.js` drives a headless Chromium browser (via Playwright) to each
source, extracts every product tile by its stable ID (Amazon ASIN /
Best Buy SKU), reads the tile's own price/availability text, and diffs the
result against `state.json`, which the workflow commits back to the repo
after every run — so `git log -p state.json` doubles as a change history.

A first sighting of a new product is held as a "pending candidate" rather
than alerted immediately, and only promoted to a real 🆕 NEW alert once
seen again on a later run (within 24h). Both sites' listing pages don't
reliably serve the exact same product set on every request — Amazon's
carousels rotate/lazy-load, Best Buy's result grid pads real matches with
shifting sponsored slots — so a genuinely-unchanged item can otherwise
look "new" for one run and vanish the next. Restocks alert immediately;
that flakiness mode wasn't observed for already-known items.

## Availability signal per source

- **Amazon**: a tile counts as available if it has a matched `$price` and
  its text doesn't contain "Currently unavailable".
- **Best Buy**: a tile counts as available if it has a matched `$price`
  and its text doesn't contain "Sold Out". Note: Best Buy's "High demand
  product" reservation-queue badge does **not** mean unavailable — checked
  against several product pages directly, those items still have a fully
  enabled Add to Cart button underneath the badge.

## Setup

1. `npm install`
2. Add a repo secret `DISCORD_WEBHOOK_URL` (Settings → Secrets and
   variables → Actions) pointing at the Discord channel webhook to post to.
3. The `.github/workflows/track.yml` workflow runs on `workflow_dispatch`
   only (no built-in `schedule:` — GitHub's own cron trigger is
   best-effort and can be delayed or skipped under load). It's triggered
   externally on an hourly schedule via cron-job.org calling GitHub's
   workflow dispatch API. Trigger it manually with
   `gh workflow run track.yml` to test.

## Known limitations

- Amazon coverage is 3 of the storefront's ~10 tabs (Shop by Expansion,
  Accessories, Apparel, etc. aren't scraped). Add entries to `AMAZON_TABS`
  in `scraper.js` to expand; each tab is one more page load per run.
- Both sites render client-side and use bot-detection. If a run gets
  served a CAPTCHA/verification page, that source is skipped for the run
  (no false-positive alerts, but also no data for it) rather than retried
  aggressively. GitHub Actions runners use well-known shared IP ranges,
  which bot-detection may flag more readily than a normal residential
  browser session — if runs start getting blocked consistently, that's why.
- Best Buy's per-page organic-item count fluctuates (sponsored slots churn
  independently of real inventory), which is exactly what the pending-
  candidate confirmation step exists to absorb.
- Title text comes from the DOM (`aria-label` where present, otherwise the
  tile's first text line), not a stable product API.
