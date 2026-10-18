import { chromium } from 'rebrowser-playwright';
import * as cheerio from 'cheerio';
import fs from 'fs';

const BASE = 'https://crichd.mobile';
const PLAYER = 'https://playsza.st';

async function main() {
  const PROXY = process.env.RESIDENTIAL_PROXY;
  
  const launchOptions = {
    headless: false, // Must be false for Cloudflare bypass
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ],
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  };

  // Configure Proxy if provided in GitHub Secrets
  if (PROXY) {
    console.error('Proxy detected. Configuring proxy...');
    const proxyUrl = new URL(PROXY);
    launchOptions.proxy = {
      server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
      username: proxyUrl.username || 'iploop', 
      password: proxyUrl.password
    };
  } else {
    console.error('No proxy detected. Running with local IP...');
  }

  console.error('Launching browser...');
  const browser = await chromium.launchPersistentContext('./chrome-session', launchOptions);
  
  // Use the SAME page for everything to maintain the Cloudflare session
  const page = await browser.pages()[0] || await browser.newPage();

  // Optimize loading by blocking heavy images/media (except logos)
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) {
      if (!route.request().url().includes('/assets/channels/')) {
        route.abort();
      } else {
        route.continue();
      }
    } else {
      route.continue();
    }
  });

  console.error('Fetching CricHD homepage...');
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000); // Give Cloudflare time to auto-solve
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
  $('table').find('tr').each((_, el) => {
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

  for (const ch of channels) {
    console.error(`Processing: ${ch.name}`);
    let capturedM3u8 = null;
    
    // Set up network sniffer for this channel
    const requestHandler = req => { 
      if (req.url().includes('.m3u8')) capturedM3u8 = req.url(); 
    };
    page.on('request', requestHandler);

    try {
      // 1. Load Channel Page
      await page.goto(ch.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);
      
      let html = await page.content();
      let playerId = null;

      if (html.includes('player.php?id=')) {
        const match = html.match(/player\.php\?id=([A-Za-z0-9_-]+)/);
        if (match) playerId = match[1];
      }

      if (!playerId) { 
        console.error(`   [Error] No player ID found.`); 
        page.off('request', requestHandler);
        continue; 
      }

      // 2. Load Player Page in the SAME TAB
      await page.goto(`${PLAYER}/player.php?id=${playerId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      // CRITICAL: Wait 3 seconds to let Cloudflare finish its background checks
      await page.waitForTimeout(3000); 
      
      html = await page.content();
      const fidMatch = html.match(/fid\s*=\s*["']([^"']+)["']/);
      
      if (!fidMatch) { 
        console.error(`   [Error] No fid found (Cloudflare blocked).`); 
        page.off('request', requestHandler);
        continue; 
      }

      // 3. Load uEmbed Page in the SAME TAB
      await page.goto(`${PLAYER}/uembed.php?v=${fidMatch[1]}`, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // 4. Wait for the network sniffer to catch the m3u8
      for (let i = 0; i < 10; i++) {
        if (capturedM3u8) break;
        await page.waitForTimeout(1000);
      }

      if (capturedM3u8) {
        console.error(`   [OK] Captured stream`);
        results.push({ name: ch.name, logo: ch.logo, m3u8: capturedM3u8 });
      } else {
        console.error(`   [Error] No m3u8 intercepted`);
      }

    } catch (err) {
      console.error(`   [Error] ${ch.name}: ${err.message}`);
    }
    
    // Remove sniffer for the next channel
    page.off('request', requestHandler);
  }

  await browser.close();

  // Generate Output Files
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

  console.error(`\nFinished! Saved playlist.m3u (${results.length} streams) and schedule.json (${schedules.length} matches).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
