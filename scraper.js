const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Amazon storefront "page" IDs, discovered by clicking each nav tab on the
// MagicTheGathering storefront and reading window.location.
const AMAZON_TABS = {
  home: 'https://www.amazon.com/stores/page/1C5A2505-C20D-44F5-B31D-E91265896FF4?ingress=2&store_ref=bl_ast_dp_brandlogo_sto&ref_=ast_bln',
  preorder: 'https://www.amazon.com/stores/page/444201D0-E247-4164-B254-C36E737E7C06?ingress=2&store_ref=bl_ast_dp_brandlogo_sto&ref_=ast_bln',
  new_releases: 'https://www.amazon.com/stores/page/82E3FD96-0B6B-4E1D-A980-BC528EF4EEC8?ingress=2&store_ref=bl_ast_dp_brandlogo_sto&ref_=ast_bln',
};

// Wizards of The Coast / Magic: The Gathering, filtered to items sold &
// shipped by Best Buy itself (marketplace/third-party sellers excluded).
const BESTBUY_SEARCH_BASE =
  'https://www.bestbuy.com/site/searchpage.jsp?browsedCategory=pcmcat1604992984556&id=pcat17071&qp=brand_facet%3DBrand%7EWizards+of+The+Coast%5Ebbyonly_facet%3DSold+%26+shipped+by%7EBest+Buy&st=categoryid%24pcmcat1604992984556';
const BESTBUY_MAX_PAGES = 20; // safety cap — real pagination end is detected from the page itself

const STATE_PATH = path.join(__dirname, 'state.json');
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return null;
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

async function postDiscord(content) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log('No DISCORD_WEBHOOK_URL set, skipping Discord post:\n' + content);
    return;
  }
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    console.error('Discord post failed', res.status, await res.text());
  }
}

async function postLines(lines) {
  let chunk = '';
  for (const line of lines) {
    if ((chunk + '\n' + line).length > 1900) {
      await postDiscord(chunk);
      chunk = '';
    }
    chunk += (chunk ? '\n' : '') + line;
  }
  if (chunk) await postDiscord(chunk);
}

// ---------- Amazon ----------

async function extractAmazonTab(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  try {
    await page.waitForSelector('a[href*="/dp/"]', { timeout: 15000 });
  } catch {
    // fall through — extraction below will just find 0 items and the
    // caller treats an empty tab as "skip, don't touch state"
  }
  await page.waitForTimeout(1500);

  // Lower carousel rows only mount into the DOM once scrolled into view,
  // so a static load can non-deterministically miss whole rows depending
  // on what's prefetched. Walk the page top to bottom to force everything
  // to mount before reading it.
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.85);
    let lastHeight = 0;
    for (let y = 0; y < document.body.scrollHeight + step; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 400));
      if (document.body.scrollHeight === lastHeight && y > document.body.scrollHeight) break;
      lastHeight = document.body.scrollHeight;
    }
    window.scrollTo(0, 0);
  });

  // Product tiles hydrate price/availability text slightly after the DOM
  // node appears; without this settle time a price can read as missing
  // and falsely look like a restock/de-stock on the next diff.
  await page.waitForTimeout(2500);

  const bodyText = await page.evaluate(() => document.body.innerText);
  if (/enter the characters you see|sorry, we just need to make sure/i.test(bodyText)) {
    return { blocked: true, items: [] };
  }

  const items = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/dp/"]'));
    const seen = new Set();
    const out = [];
    for (const a of anchors) {
      const m = a.href.match(/\/dp\/([A-Z0-9]{10})/);
      if (!m) continue;
      const asin = m[1];
      if (seen.has(asin)) continue;
      seen.add(asin);

      const title = a.getAttribute('aria-label') || a.innerText || null;

      // Walk up to the nearest tile/card container so we read this
      // product's own price/availability, not a whole row of siblings.
      let scopeEl = a;
      let scopeText = '';
      for (let i = 0; i < 6 && scopeEl; i++) {
        const cls = (scopeEl.className || '').toString();
        if (/innerContent|item-info/i.test(cls)) {
          scopeText = scopeEl.innerText || '';
          break;
        }
        scopeEl = scopeEl.parentElement;
      }

      const flat = scopeText.replace(/\s+/g, ' ');
      const priceMatch = flat.match(/\$\s*[\d,]+\s*\.\s*\d{2}/);
      const price = priceMatch ? priceMatch[0].replace(/\s+/g, '') : null;
      const unavailable = /currently unavailable/i.test(flat);
      const lowStock = flat.match(/only \d+ left in stock/i);

      out.push({
        key: asin,
        title: title ? title.trim() : null,
        price,
        available: !!price && !unavailable,
        lowStockNote: lowStock ? lowStock[0] : null,
        url: `https://www.amazon.com/dp/${asin}`,
      });
    }
    // Storefront carousels sometimes surface unrelated cross-sell ads
    // (e.g. an Amazon Business Card link) alongside real products. Only
    // keep items that are actually Magic-branded.
    return out.filter((item) => item.title && /magic/i.test(item.title));
  });

  return { blocked: false, items };
}

async function scrapeAmazon(page) {
  const currentItems = {};
  for (const [tabName, url] of Object.entries(AMAZON_TABS)) {
    try {
      const { blocked, items } = await extractAmazonTab(page, url);
      if (blocked) {
        console.log(`Amazon tab ${tabName} looks CAPTCHA'd/blocked, skipping it this run.`);
        continue;
      }
      for (const item of items) {
        if (!currentItems[item.key]) {
          currentItems[item.key] = { ...item, tabs: [tabName] };
        } else {
          currentItems[item.key].tabs.push(tabName);
          if (!currentItems[item.key].price && item.price) currentItems[item.key].price = item.price;
          currentItems[item.key].available = currentItems[item.key].available || item.available;
        }
      }
    } catch (err) {
      console.error(`Error scraping Amazon tab ${tabName}:`, err.message);
    }
    await page.waitForTimeout(1500 + Math.random() * 1500);
  }
  return currentItems;
}

// ---------- Best Buy ----------

async function scrapeBestBuy(page) {
  const currentItems = {};

  for (let cp = 1; cp <= BESTBUY_MAX_PAGES; cp++) {
    const url = `${BESTBUY_SEARCH_BASE}&cp=${cp}`;
    let result;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1800);

      const bodyText = await page.evaluate(() => document.body.innerText);
      if (/enter the characters you see|verify you are human|are you a robot|unusual traffic|access to this page has been denied/i.test(bodyText)) {
        console.log(`Best Buy page ${cp} looks CAPTCHA'd/blocked, stopping pagination for this run.`);
        break;
      }

      result = await page.evaluate(() => {
        const tiles = Array.from(document.querySelectorAll('.product-list-item')).filter((li) =>
          li.querySelector('a[href*="/product/"]')
        );
        const out = [];
        for (const li of tiles) {
          const a = li.querySelector('a[href*="/product/"]');
          const m = a.href.match(/\/sku\/(\d+)/);
          if (!m) continue;
          const sku = m[1];
          const rawText = li.innerText || '';
          const title = (a.getAttribute('aria-label') || rawText.split('\n')[0] || '').trim();
          const text = rawText.replace(/\s+/g, ' ').trim();
          const priceMatch = text.match(/\$\s*[\d,]+\.\d{2}/);
          const price = priceMatch ? priceMatch[0].replace(/\s+/g, '') : null;
          const soldOut = /sold out/i.test(text);
          out.push({
            key: sku,
            title: title || null,
            price,
            available: !!price && !soldOut,
            url: a.href,
          });
        }

        const pagEl = document.querySelector('[class*="pagination"]');
        const pagText = pagEl ? pagEl.innerText : '';
        const rangeMatch = pagText.match(/([\d,]+)\s*-\s*([\d,]+) of ([\d,]+) items/i);
        let done = tiles.length === 0;
        if (rangeMatch) {
          const end = parseInt(rangeMatch[2].replace(/,/g, ''), 10);
          const total = parseInt(rangeMatch[3].replace(/,/g, ''), 10);
          if (end >= total) done = true;
        }
        return { items: out, done };
      });
    } catch (err) {
      console.error(`Error scraping Best Buy page ${cp}:`, err.message);
      break;
    }

    for (const item of result.items) {
      if (!item.title || !/magic/i.test(item.title)) continue; // skip non-MTG WotC items / sponsored noise
      currentItems[item.key] = item;
    }

    if (result.done) break;
    await page.waitForTimeout(1200 + Math.random() * 1200);
  }

  return currentItems;
}

// ---------- Diffing (shared between sources) ----------

// A first sighting of an item is held as a "pending" candidate rather than
// alerted immediately, and only promoted to a real NEW alert once seen
// again on a later run. This guards against both sites' listing pages not
// reliably serving the same product set on every request (carousel
// rotation on Amazon, sponsored-slot churn on Best Buy) — a genuinely
// unchanged item can otherwise look "new" for one run and then vanish.
function diffSource(sourceLabel, currentItems, prevSource) {
  const prevItems = (prevSource && prevSource.items) || {};
  const prevPending = (prevSource && prevSource.pendingNew) || {};
  const nextPending = {};
  const now = Date.now();

  const newItems = [];
  const restocks = [];

  for (const [key, item] of Object.entries(currentItems)) {
    const prev = prevItems[key];
    if (prev) {
      if (!prev.available && item.available) restocks.push(item);
      continue;
    }
    if (prevPending[key]) {
      newItems.push(item);
    } else {
      nextPending[key] = { item, firstSeenAt: now };
    }
  }

  for (const [key, pending] of Object.entries(prevPending)) {
    if (currentItems[key]) continue; // already promoted or already confirmed above
    if (now - pending.firstSeenAt < PENDING_TTL_MS) {
      nextPending[key] = pending;
    }
  }

  const lines = [];
  for (const item of restocks) {
    lines.push(`🔄 **RESTOCK** [${sourceLabel}]: ${item.title} — ${item.price || ''} ${item.url}`);
  }
  for (const item of newItems) {
    lines.push(`🆕 **NEW** [${sourceLabel}]: ${item.title} — ${item.price || 'price n/a'} ${item.url}`);
  }

  const mergedItems = { ...prevItems, ...currentItems };
  return { lines, nextState: { items: mergedItems, pendingNew: nextPending } };
}

// ---------- Main ----------

function normalizePrevState(prevState) {
  // Migrates the old Amazon-only state shape ({items, pendingNew,
  // lastChecked}) into the new multi-source shape ({amazon, bestbuy,
  // lastChecked}) so existing history isn't lost when Best Buy is added.
  if (!prevState) return { amazon: null, bestbuy: null };
  if (prevState.amazon || prevState.bestbuy) {
    return { amazon: prevState.amazon || null, bestbuy: prevState.bestbuy || null };
  }
  if (prevState.items) {
    return { amazon: { items: prevState.items, pendingNew: prevState.pendingNew || {} }, bestbuy: null };
  }
  return { amazon: null, bestbuy: null };
}

async function run() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  const rawPrevState = loadState();
  const { amazon: prevAmazon, bestbuy: prevBestBuy } = normalizePrevState(rawPrevState);

  const currentAmazon = await scrapeAmazon(page);
  const currentBestBuy = await scrapeBestBuy(page);

  await browser.close();

  const lines = [];
  const newState = { lastChecked: new Date().toISOString() };

  if (Object.keys(currentAmazon).length === 0) {
    console.log('No Amazon items extracted this run (likely fully blocked) — keeping prior Amazon state.');
    newState.amazon = prevAmazon || { items: {}, pendingNew: {} };
  } else if (!prevAmazon) {
    newState.amazon = { items: currentAmazon, pendingNew: {} };
    lines.push(`🟢 [Amazon] tracker baseline captured — ${Object.keys(currentAmazon).length} SKUs.`);
  } else {
    const { lines: amazonLines, nextState } = diffSource('Amazon', currentAmazon, prevAmazon);
    lines.push(...amazonLines);
    newState.amazon = nextState;
  }

  if (Object.keys(currentBestBuy).length === 0) {
    console.log('No Best Buy items extracted this run (likely fully blocked) — keeping prior Best Buy state.');
    newState.bestbuy = prevBestBuy || { items: {}, pendingNew: {} };
  } else if (!prevBestBuy) {
    newState.bestbuy = { items: currentBestBuy, pendingNew: {} };
    lines.push(`🟢 [Best Buy] tracker baseline captured — ${Object.keys(currentBestBuy).length} SKUs.`);
  } else {
    const { lines: bbLines, nextState } = diffSource('Best Buy', currentBestBuy, prevBestBuy);
    lines.push(...bbLines);
    newState.bestbuy = nextState;
  }

  if (lines.length > 0) {
    await postLines(lines);
    console.log(`Posted ${lines.length} line(s) to Discord.`);
  } else {
    console.log('No changes detected.');
  }

  saveState(newState);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
