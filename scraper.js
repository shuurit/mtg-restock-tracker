const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Amazon storefront "page" IDs, discovered by clicking each nav tab on the
// MagicTheGathering storefront and reading window.location.
const TABS = {
  home: 'https://www.amazon.com/stores/page/1C5A2505-C20D-44F5-B31D-E91265896FF4?ingress=2&store_ref=bl_ast_dp_brandlogo_sto&ref_=ast_bln',
  preorder: 'https://www.amazon.com/stores/page/444201D0-E247-4164-B254-C36E737E7C06?ingress=2&store_ref=bl_ast_dp_brandlogo_sto&ref_=ast_bln',
  new_releases: 'https://www.amazon.com/stores/page/82E3FD96-0B6B-4E1D-A980-BC528EF4EEC8?ingress=2&store_ref=bl_ast_dp_brandlogo_sto&ref_=ast_bln',
};

const STATE_PATH = path.join(__dirname, 'state.json');
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return null;
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

async function extractTab(page, url) {
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
        asin,
        title: title ? title.trim() : null,
        price,
        available: !!price && !unavailable,
        lowStockNote: lowStock ? lowStock[0] : null,
      });
    }
    // Storefront carousels sometimes surface unrelated cross-sell ads
    // (e.g. an Amazon Business Card link) alongside real products. Only
    // keep items that are actually Magic-branded.
    return out.filter((item) => item.title && /magic/i.test(item.title));
  });

  return { blocked: false, items };
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

async function run() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  const prevState = loadState();
  const prevItems = prevState ? prevState.items || {} : {};
  const currentItems = {};

  for (const [tabName, url] of Object.entries(TABS)) {
    try {
      const { blocked, items } = await extractTab(page, url);
      if (blocked) {
        console.log(`Tab ${tabName} looks CAPTCHA'd/blocked, skipping it this run.`);
        continue;
      }
      for (const item of items) {
        if (!currentItems[item.asin]) {
          currentItems[item.asin] = { ...item, tabs: [tabName] };
        } else {
          currentItems[item.asin].tabs.push(tabName);
          if (!currentItems[item.asin].price && item.price) currentItems[item.asin].price = item.price;
          currentItems[item.asin].available = currentItems[item.asin].available || item.available;
        }
      }
    } catch (err) {
      console.error(`Error scraping tab ${tabName}:`, err.message);
    }
    await page.waitForTimeout(1500 + Math.random() * 1500);
  }

  await browser.close();

  if (Object.keys(currentItems).length === 0) {
    console.log('No items extracted this run (likely fully blocked). Leaving state untouched.');
    return;
  }

  if (!prevState) {
    saveState({ items: currentItems, lastChecked: new Date().toISOString() });
    await postDiscord(
      `🟢 MTG Amazon tracker is live — baseline captured, ${Object.keys(currentItems).length} SKUs seen across Home/Preorder/New Releases.`
    );
    console.log('Baseline captured.');
    return;
  }

  const newItems = [];
  const restocks = [];

  for (const [asin, item] of Object.entries(currentItems)) {
    const prev = prevItems[asin];
    if (!prev) {
      newItems.push(item);
    } else if (!prev.available && item.available) {
      restocks.push(item);
    }
  }

  const lines = [];
  for (const item of restocks) {
    lines.push(`🔄 **RESTOCK**: ${item.title || item.asin} — ${item.price || ''} https://www.amazon.com/dp/${item.asin}`);
  }
  for (const item of newItems) {
    lines.push(`🆕 **NEW**: ${item.title || item.asin} — ${item.price || 'price n/a'} https://www.amazon.com/dp/${item.asin}`);
  }

  if (lines.length > 0) {
    let chunk = '';
    for (const line of lines) {
      if ((chunk + '\n' + line).length > 1900) {
        await postDiscord(chunk);
        chunk = '';
      }
      chunk += (chunk ? '\n' : '') + line;
    }
    if (chunk) await postDiscord(chunk);
    console.log(`Posted ${lines.length} changes to Discord.`);
  } else {
    console.log('No changes detected.');
  }

  const mergedItems = { ...prevItems, ...currentItems };
  saveState({ items: mergedItems, lastChecked: new Date().toISOString() });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
