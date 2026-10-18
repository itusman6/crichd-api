import { chromium } from 'rebrowser-playwright';
import * as cheerio from 'cheerio';
import fs from 'fs';

const BASE = 'https://crichd.mobile';
const PLAYER = 'https://playsza.st';

async function main() {
  console.log('Launching robust stealth browser with IPLoop proxy support...');
  
  const proxyUrl = process.env.RESIDENTIAL_PROXY_URL;
  let proxyConfig = undefined;

  if (proxyUrl) {
    proxyConfig = { server: proxyUrl.trim() };
    console.log('[Proxy Configured] Routing traffic through IPLoop proxy.');
  }

  const browserOptions = {
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--ignore-certificate-errors',
      '--window-size=1920,1080'
    ]
  };

  if (proxyConfig) {
    browserOptions.proxy = proxyConfig;
  }

  const browser = await chromium.launch(browserOptions);

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90000);

  console.log('Fetching CricHD homepage via proxy...');
  
  try {
    await page.goto(BASE, { waitUntil: 'commit', timeout: 90000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);
  } catch (err) {
    console.error('Failed to load homepage through proxy:', err.message);
    await browser.close();
    process.exit(1);
  }

  const homeHtml = await page.content();
  const $ = cheerio.load(homeHtml);
  const channels = [];

  $('a[href*="/channels/"]').each((_, el) => {
    const href = $(el).attr('href');
    const img = $(el).find('img[title]');
    if (img.length && href) {
      const name = img.attr('title').replace(/\s+Live Streaming.*$/i, '').trim();
      const fullUrl = href.startsWith('http') ? href : `${BASE}${href}`;
      let rawImgSrc = img.attr('src') || '';
      const logoUrl = rawImgSrc.startsWith('http') ? rawImgSrc : `${BASE}${rawImgSrc}`;

      if (!channels.some(c => c.url === fullUrl)) {
        channels.push({ name, url: fullUrl, logo: logoUrl });
      }
    }
  });

  console.log(`Found ${channels.length} channels. Extracting streams...\n`);
  const results = [];

  for (const ch of channels) {
    let capturedM3u8 = null;
    let attempts = 0;

    while (!capturedM3u8 && attempts < 2) {
      attempts++;
      const p = await context.newPage();
      p.setDefaultNavigationTimeout(60000);

      p.on('request', request => {
        const url = request.url();
        if (url.includes('.m3u8')) {
          capturedM3u8 = url;
        }
      });

      try {
        console.log(`Processing: ${ch.name} (Attempt ${attempts})`);
        await p.goto(ch.url, { waitUntil: 'commit', timeout: 60000 });
        await p.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await p.waitForTimeout(1500);

        const channelHtml = await p.content();
        let playerUrl = '';
        
        if (channelHtml.includes('uembed.php?v=')) {
          const match = channelHtml.match(/uembed\.php\?v=([A-Za-z0-9_-]+)/);
          if (match) playerUrl = `${PLAYER}/uembed.php?v=${match[1]}`;
        } else if (channelHtml.includes('player.php?id=')) {
          const match = channelHtml.match(/player\.php\?id=([A-Za-z0-9_-]+)/);
          if (match) {
            const pPageUrl = `${PLAYER}/player.php?id=${match[1]}`;
            await p.goto(pPageUrl, { waitUntil: 'commit', timeout: 60000 });
            await p.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            await p.waitForTimeout(2000);
            const pHtml = await p.content();
            const fMatch = pHtml.match(/fid\s*=\s*["']([^"']+)["']/);
            if (fMatch) {
              playerUrl = `${PLAYER}/uembed.php?v=${fMatch[1]}`;
            }
          }
        }

        if (!playerUrl) {
          const frames = p.frames();
          for (const frame of frames) {
            const fUrl = frame.url();
            if (fUrl.includes('uembed.php') || fUrl.includes('player.php')) {
              playerUrl = fUrl;
              break;
            }
          }
        }

        if (playerUrl && !p.url().includes(playerUrl)) {
          await p.goto(playerUrl, { waitUntil: 'commit', timeout: 60000 });
          await p.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        }

        for (let i = 0; i < 12; i++) {
          if (capturedM3u8) break;
          await p.waitForTimeout(1000);
        }

        await p.close();
      } catch (err) {
        await p.close();
        console.log(`   [Error on attempt ${attempts}] ${ch.name}: ${err.message}`);
      }
    }

    if (capturedM3u8) {
      console.log(`   [OK] Captured stream for ${ch.name}`);
      results.push({ name: ch.name, logo: ch.logo, m3u8: capturedM3u8 });
    } else {
      console.log(`   [Warning] Failed to intercept .m3u8 for ${ch.name}`);
    }
  }

  await browser.close();

  let playlistContent = '#EXTM3U\n';
  playlistContent += `# Generated: ${new Date().toISOString()}\n`;

  for (const r of results) {
    playlistContent += `#EXTINF:-1 tvg-logo="${r.logo}" group-title="Sports", ${r.name}\n`;
    playlistContent += `#EXTVLCOPT:http-origin=https://bhalocast.com\n`;
    playlistContent += `#EXTVLCOPT:http-referrer=https://bhalocast.com/\n`;
    playlistContent += `#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\n`;
    playlistContent += `${r.m3u8}\n`;
  }

  fs.writeFileSync('playlist.m3u', playlistContent, 'utf8');
  console.log(`\nFinished! Successfully generated playlist.m3u with ${results.length} channels.`);
}

main();
