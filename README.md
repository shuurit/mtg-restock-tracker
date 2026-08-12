# mtg-restock-tracker

Checks the Amazon "Magic: The Gathering" storefront (Home, Preorder Now, and
New Releases tabs) once an hour and posts to Discord when it sees:

- a **new** product (ASIN not seen in a previous run), or
- a **restock** (a known ASIN that flips from unavailable to available)

## How it works

`scraper.js` drives a headless Chromium browser (via Playwright) to each
storefront tab, extracts every product tile by its ASIN (`/dp/<ASIN>/`),
reads the tile's own price/availability text, and diffs the result against
`state.json`, which the workflow commits back to the repo after every run —
so `git log -p state.json` doubles as a change history of the storefront.

## Setup

1. `npm install`
2. Add a repo secret `DISCORD_WEBHOOK_URL` (Settings → Secrets and
   variables → Actions) pointing at the Discord channel webhook to post to.
3. The `.github/workflows/track.yml` workflow runs hourly via
   `workflow_dispatch`/`schedule`. Trigger it manually with
   `gh workflow run track.yml` to test.

## Known limitations

- Only covers the Home, Preorder Now, and New Releases tabs — not every tab
  on the storefront (Shop by Expansion, Accessories, Apparel, etc. are not
  scraped). Add more entries to the `TABS` map in `scraper.js` to expand
  coverage; each additional tab is one more automated page load per run.
- Amazon's storefronts render client-side and use bot-detection. If a run
  gets served a CAPTCHA/verification page, that tab is skipped for the run
  (no false-positive alerts, but also no data for that tab) rather than
  retried aggressively. GitHub Actions runners use well-known shared IP
  ranges, which Amazon's bot-detection may flag more readily than a normal
  residential browser session — if runs start getting blocked consistently,
  that's why.
- Title text comes from the product tile's `aria-label`, which is generally
  accurate but sourced from the DOM, not a stable product API.
