import { chromium } from 'rebrowser-playwright';
import * as cheerio from 'cheerio';
import fs from 'fs';

const BASE = 'https://crichd.mobile';
const PLAYER = 'https://playsza.st';

async function main() {
  console.log('Launching headless stealth browser for production...');
  
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,720'
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 }
  });

  const page = await context.newPage();
  console.log('Fetching CricHD homepage...');
  
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000); // Allow Cloudflare JS challenge to resolve in headless mode
  } catch (err) {
    console.error('Failed to load homepage:', err.message);
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
    const p = await context.newPage();
    let capturedM3u8 = null;

    p.on('request', request => {
      const url = request.url();
      if (url.includes('.m3u8')) {
        capturedM3u8 = url;
      }
    });

    try {
      console.log(`Processing: ${ch.name}`);
      await p.goto(ch.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.waitForTimeout(2000);

      const channelHtml = await p.content();
      let playerUrl = '';
      
      if (channelHtml.includes('uembed.php?v=')) {
        const match = channelHtml.match(/uembed\.php\?v=([A-Za-z0-9_-]+)/);
        if (match) playerUrl = `${PLAYER}/uembed.php?v=${match[1]}`;
      } else if (channelHtml.includes('player.php?id=')) {
        const match = channelHtml.match(/player\.php\?id=([A-Za-z0-9_-]+)/);
        if (match) {
          const pPageUrl = `${PLAYER}/player.php?id=${match[1]}`;
          await p.goto(pPageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await p.waitForTimeout(3000);
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
        await p.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }

      // Wait up to 15 seconds for the player to initialize and trigger the .m3u8 request
      for (let i = 0; i < 15; i++) {
        if (capturedM3u8) break;
        await p.waitForTimeout(1000);
      }

      await p.close();

      if (capturedM3u8) {
        console.log(`   [OK] Captured stream`);
        results.push({ name: ch.name, logo: ch.logo, m3u8: capturedM3u8 });
      } else {
        console.log(`   [Warning] No .m3u8 intercepted for ${ch.name}`);
      }
    } catch (err) {
      await p.close();
      console.log(`   [Error] Failed to process ${ch.name}: ${err.message}`);
    }
  }

  await browser.close();

  // Generate M3U playlist file content
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
