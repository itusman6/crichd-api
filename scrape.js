import { chromium } from 'rebrowser-playwright';
import * as cheerio from 'cheerio';
import fs from 'fs';

const BASE = 'https://crichd.mobile';
const PLAYER = 'https://playsza.st';

async function main() {
  console.error('Launching proxy-free headless stealth browser...');
  
  const browser = await chromium.launch({
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
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  // Block heavy resources to make loading super fast
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    if (['media', 'font'].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  console.error('Fetching CricHD homepage...');
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(5000); 
  } catch (err) {
    console.error('Failed to load homepage:', err.message);
    await browser.close();
    process.exit(1);
  }

  const homeHtml = await page.content();
  const $ = cheerio.load(homeHtml);
  const channels = [];
  const schedules = [];

  // Extract Schedules
  $('table').find('tr').each((_, el) => {
    const $row =$(el);
    const league = $row.find('td').eq(1).text().trim();
    const title = $row.find('td').eq(2).text().trim();
    const time = $row.find('td').eq(3).text().trim().replace(/\s+/g, ' ');
    if (title && league && time) schedules.push({ league, title, time });
  });

  // Extract Channels
  $('a[href*="/channels/"]').each((_, el) => {
    const href = $(el).attr('href');
    const img = $(el).find('img[title], img[alt]');
    const titleAttr = $(el).attr('title') || img.attr('title') || img.attr('alt');
    
    if (href && titleAttr) {
      const name = titleAttr.replace(/\s+Live Streaming.*$/i, '').trim();
      const fullUrl = href.startsWith('http') ? href : `${BASE}${href}`;
      let rawImgSrc = img.attr('src') || '';
      const logoUrl = rawImgSrc ? (rawImgSrc.startsWith('http') ? rawImgSrc : `${BASE}${rawImgSrc}`) : '';

      if (!channels.some(c => c.url === fullUrl)) {
        channels.push({ name, url: fullUrl, logo: logoUrl });
      }
    }
  });

  console.error(`Found ${channels.length} channels and ${schedules.length} schedule entries.`);
  
  const results = [];

  for (const ch of channels) {
    let capturedM3u8 = null;
    const p = await context.newPage();

    p.on('request', request => {
      const reqUrl = request.url();
      if (reqUrl.includes('.m3u8')) {
        capturedM3u8 = reqUrl;
      }
    });

    try {
      console.error(`Processing: ${ch.name}`);
      await p.goto(ch.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
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
          await p.goto(pPageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await p.waitForTimeout(3000); 
          const pHtml = await p.content();
          const fMatch = pHtml.match(/fid\s*=\s*["']([^"']+)["']/);
          if (fMatch) playerUrl = `${PLAYER}/uembed.php?v=${fMatch[1]}`;
        }
      }

      if (playerUrl) {
        await p.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      }

      for (let i = 0; i < 12; i++) {
        if (capturedM3u8) break;
        await p.waitForTimeout(1000);
      }

      await p.close();

      if (capturedM3u8) {
        console.error(`   [OK] Captured stream for ${ch.name}`);
        results.push({ name: ch.name, logo: ch.logo, m3u8: capturedM3u8 });
      } else {
        console.error(`   [Error] Failed to intercept .m3u8 for ${ch.name}`);
      }
    } catch (err) {
      await p.close();
      console.error(`   [Error] ${ch.name}: ${err.message}`);
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
  fs.writeFileSync('schedule.json', JSON.stringify(schedules, null, 2), 'utf8');
  
  console.error(`\nFinished! Generated playlist.m3u with ${results.length} streams.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
