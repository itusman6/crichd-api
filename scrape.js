import { chromium } from 'rebrowser-playwright';

const PROXY = process.env.RESIDENTIAL_PROXY;
if (!PROXY) {
  console.error('CRITICAL ERROR: RESIDENTIAL_PROXY secret is missing.');
  process.exit(1);
}

const BASE = 'https://crichd.mobile';
const PLAYER = 'https://playsza.st';

async function main() {
  const proxyUrl = new URL(PROXY);
  
  const proxyConfig = {
    server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
    username: proxyUrl.username,
    password: proxyUrl.password
  };

  console.error('Starting browser...');
  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage'
      ]
    });
  } catch (err) {
    console.error('Failed to launch browser:', err.message);
    process.exit(1);
  }

  const context = await browser.newContext({
    proxy: proxyConfig,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York'
  });

  const page = await context.newPage();

  console.error('# Fetching homepage...');
  try {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (err) {
    console.error('Failed to load homepage (Proxy might be dead):', err.message);
    await browser.close();
    process.exit(1);
  }
  
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

  console.error(`# Found ${channels.length} channels`);

  const results = [];

  for (const ch of channels.slice(0, 5)) { 
    console.error(`# Processing: ${ch.name}`);
    try {
      await page.goto(ch.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      const playerId = await page.evaluate(() => {
        const html = document.documentElement.innerHTML;
        const m = html.match(/playsza\.st\/player\.php\?id=([A-Za-z0-9_-]+)/) ||
                  html.match(/player\.php\?id=([A-Za-z0-9_-]+)/);
        return m ? m[1] : null;
      });

      if (!playerId) { console.error(`# No player for ${ch.name}`); continue; }

      const playerUrl = `${PLAYER}/player.php?id=${playerId}`;
      await page.goto(playerUrl, { waitUntil: 'networkidle', timeout: 60000 });

      await page.waitForFunction(() => {
        const text = document.body?.innerText || '';
        return !text.includes('Just a moment') && !text.includes('Checking your browser');
      }, { timeout: 30000 }).catch(() => {});

      const playerHtml = await page.content();
      const fidMatch = playerHtml.match(/fid\s*=\s*["']([^"']+)["']/);
      if (!fidMatch) { console.error(`# No fid for ${ch.name} (CF Blocked?)`); continue; }
      const fid = fidMatch[1];

      const uembedUrl = `${PLAYER}/uembed.php?v=${fid}`;
      await page.goto(uembedUrl, { waitUntil: 'networkidle', timeout: 60000 });

      const uembedHtml = await page.content();
      const m3u8Match = uembedHtml.match(/https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?/i);
      if (!m3u8Match) { console.error(`# No m3u8 for ${ch.name}`); continue; }

      results.push({ name: ch.name, m3u8: m3u8Match[0], fid });
      console.error(`# OK: ${ch.name}`);

    } catch (err) {
      console.error(`# Error ${ch.name}: ${err.message}`);
    }
    await page.waitForTimeout(5000);
  }

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
