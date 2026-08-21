# mtg-restock-tracker

Checks Amazon and Best Buy for Magic: The Gathering (Wizards of The Coast)
products once an hour and posts to Discord on a **restock** — a
previously-tracked product that flips from unavailable to available.
Brand-new products are silently added to the tracked set the first time
they're seen (whatever their availability), with no alert — this tracker
is restock-only by design, not a "new product" feed.

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

A restock (unavailable -> available on a product already being tracked)
is held as a "pending candidate" rather than alerted immediately, and only
promoted to a real 🔄 RESTOCK alert once seen again on a later run
(within 24h). Both sites' listing pages don't reliably serve identical
availability data on every request — Amazon's carousels rotate/lazy-load,
Best Buy's result grid pads real matches with shifting sponsored slots,
and either site can just misread a tile's text on a given page load — so
a genuinely-still-out-of-stock item can otherwise look restocked for one
run and revert on the next. (An earlier version of this tracker alerted
immediately on restocks and also alerted on new products via the same
two-sighting gate; a live false-positive restock — and the fact that new
products aren't restocks and shouldn't page anyone — led to narrowing it
down to just this.) Going available -> unavailable is applied immediately
either way, since that direction is never alerted on.

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
  restock confirmation step exists to absorb.
- Title text comes from the DOM (`aria-label` where present, otherwise the
  tile's first text line), not a stable product API.
