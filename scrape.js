import { chromium } from 'rebrowser-playwright';
import * as cheerio from 'cheerio';
import fs from 'fs';

const BASE = 'https://crichd.mobile';
const PLAYER = 'https://playsza.st';

async function main() {
  console.error('Launching browser...');
  
  // Use persistent context to keep cookies/sessions (helps bypass CF faster)
  const browser = await chromium.launchPersistentContext('./chrome-session', {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ],
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await browser.pages()[0] || await browser.newPage();
  console.error('Fetching CricHD homepage...');
  
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Wait a few seconds to let CF challenge pass
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

  // 1. EXTRACT SCHEDULES
  // Look for the table rows that contain match schedules
  $('table.CRICKET-SCHEDULE, table').find('tr').each((_, el) => {
    const $row = $(el);
    const league = $row.find('td').eq(1).text().trim();
    const title = $row.find('td').eq(2).text().trim();
    const time = $row.find('td').eq(3).text().trim().replace(/\s+/g, ' ');
    
    if (title && league && time) {
      schedules.push({ league, title, time });
    }
  });

  // 2. EXTRACT CHANNELS
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

  console.error(`Found ${channels.length} channels and ${schedules.length} schedule entries.`);
  
  const results = [];

  // Process only the first 5 channels to prevent GitHub Actions timeout (45 mins max)
  // Change to `channels` if you want all of them.
  for (const ch of channels.slice(0, 5)) {
    const p = await browser.newPage();
    let capturedM3u8 = null;

    // THIS IS YOUR BRILLIANT LOGIC
    p.on('request', request => {
      const url = request.url();
      if (url.includes('.m3u8')) {
        capturedM3u8 = url;
      }
    });

    try {
      console.error(`Processing channel: ${ch.name}`);
      await p.goto(ch.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
          await p.goto(pPageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
        await p.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }

      // Wait up to 10 seconds for the network sniffer to catch the m3u8
      for (let i = 0; i < 10; i++) {
        if (capturedM3u8) break;
        await p.waitForTimeout(1000);
      }

      await p.close();

      if (capturedM3u8) {
        console.error(`   [OK] Captured stream for ${ch.name}`);
        results.push({ name: ch.name, logo: ch.logo, m3u8: capturedM3u8 });
      } else {
        console.error(`   [Error] No .m3u8 request intercepted for ${ch.name}`);
      }
    } catch (err) {
      await p.close();
      console.error(`   [Error] ${ch.name}: ${err.message}`);
    }
  }

  await browser.close();

  // 3. GENERATE PLAYLIST M3U
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

  // 4. GENERATE SCHEDULE JSON
  fs.writeFileSync('schedule.json', JSON.stringify(schedules, null, 2), 'utf8');

  console.error(`\nFinished! Saved playlist.m3u (${results.length} streams) and schedule.json (${schedules.length} matches).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
