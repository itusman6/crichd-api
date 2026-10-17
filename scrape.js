// scrape.js — Playwright + residential proxy + headed mode
import { chromium } from 'rebrowser-playwright';

const PROXY = process.env.RESIDENTIAL_PROXY;
if (!PROXY) {
  console.error('RESIDENTIAL_PROXY secret is required. Datacenter IPs will be blocked.');
  process.exit(1);
}

const BASE = 'https://crichd.mobile';
const PLAYER = 'https://playsza.st';

async function main() {
  // Parse proxy: http://user:pass@host:port
  const proxyUrl = new URL(PROXY);
  const proxyConfig = {
    server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
    username: proxyUrl.username,
    password: proxyUrl.password
  };

  // Headed mode is REQUIRED for managed Turnstile challenges
  // Xvfb provides the virtual display
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  // Persistent context: cookies survive between runs
  const context = await browser.newContext({
    proxy: proxyConfig,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    storageState: './storage.json'  // Load saved cookies if they exist
  });

  const page = await context.newPage();

  // 1. Fetch homepage to get channel list
  console.log('# Fetching homepage...', { stream: 'stderr' });
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  const channels = await page.evaluate(() => {
    const links = [];
    document.querySelectorAll('a[href*="/channels/"]').forEach(a => {
      const img = a.querySelector('img[title]');
      if (img) {
        links.push({ url: a.href, name: img.title.replace(/\s+Live Streaming.*$/i, '') });
      }
    });
    return links;
  });

  console.log(`# Found ${channels.length} channels`, { stream: 'stderr' });

  const results = [];

  for (const ch of channels.slice(0, 5)) {  // Start with 5 for testing
    console.log(`# Processing: ${ch.name}`, { stream: 'stderr' });

    try {
      // 2. Channel page → extract player ID
      await page.goto(ch.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      const playerId = await page.evaluate(() => {
        const html = document.documentElement.innerHTML;
        const m = html.match(/playsza\.st\/player\.php\?id=([A-Za-z0-9_-]+)/) ||
                  html.match(/player\.php\?id=([A-Za-z0-9_-]+)/);
        return m ? m[1] : null;
      });

      if (!playerId) { console.log(`# No player for ${ch.name}`, { stream: 'stderr' }); continue; }

      // 3. Player page → extract fid (this is where Cloudflare challenges)
      const playerUrl = `${PLAYER}/player.php?id=${playerId}`;
      console.log(`# Player: ${playerUrl}`, { stream: 'stderr' });
      await page.goto(playerUrl, { waitUntil: 'networkidle', timeout: 60000 });

      // Wait for Cloudflare challenge to clear (if present)
      await page.waitForFunction(() => {
        const text = document.body?.innerText || '';
        return !text.includes('Just a moment') && !text.includes('Checking your browser');
      }, { timeout: 30000 }).catch(() => {});

      const playerHtml = await page.content();
      const fidMatch = playerHtml.match(/fid\s*=\s*["']([^"']+)["']/);
      if (!fidMatch) { console.log(`# No fid for ${ch.name}`, { stream: 'stderr' }); continue; }
      const fid = fidMatch[1];

      // 4. uembed page → extract m3u8
      const uembedUrl = `${PLAYER}/uembed.php?v=${fid}`;
      console.log(`# uembed: ${uembedUrl}`, { stream: 'stderr' });
      await page.goto(uembedUrl, { waitUntil: 'networkidle', timeout: 60000 });

      const uembedHtml = await page.content();
      const m3u8Match = uembedHtml.match(/https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?/i);
      if (!m3u8Match) { console.log(`# No m3u8 for ${ch.name}`, { stream: 'stderr' }); continue; }

      results.push({
        name: ch.name,
        m3u8: m3u8Match[0],
        fid
      });
      console.log(`# OK: ${ch.name}`, { stream: 'stderr' });

    } catch (err) {
      console.log(`# Error ${ch.name}: ${err.message}`, { stream: 'stderr' });
    }

    // Delay between channels to avoid rate limiting
    await page.waitForTimeout(5000);
  }

  // 5. Save cookies for next run (reuse challenge clearance)
  await context.storageState({ path: './storage.json' });

  // 6. Output M3U
  console.log('#EXTM3U');
  console.log(`# Generated: ${new Date().toISOString()}`);
  for (const r of results) {
    console.log(`#EXTINF:-1 group-title="CricHD",${r.name}`);
    console.log(`#EXTVLCOPT:http-referrer=https://playsza.st/`);
    console.log(r.m3u8);
  }

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
