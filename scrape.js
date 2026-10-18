import { chromium } from 'rebrowser-playwright';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

const BASE = 'https://crichd.mobile';
const PLAYER = 'https://playsza.st';

async function main() {
  console.error('=== PHASE 1: FETCHING CHANNELS ===');
  
  const browser1 = await chromium.launch({ headless: true });
  const page1 = await browser1.newPage();
  await page1.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const homeHtml = await page1.content();
  const $ = cheerio.load(homeHtml);
  
  const channels = [];
  const schedules = [];

  // Schedules Extract
  $('table').find('tr').each((_, el) => {
    const $row = $(el);
    const league = $row.find('td').eq(1).text().trim();
    const title = $row.find('td').eq(2).text().trim();
    const time = $row.find('td').eq(3).text().trim().replace(/\s+/g, ' ');
    if (title && league && time) schedules.push({ league, title, time });
  });

  // Channels Extract
  $('a[href*="/channels/"]').each((_, el) => {
    const href = $(el).attr('href');
    const img = $(el).find('img[title]');
    if (img.length && href) {
      const name = img.attr('title').replace(/\s+Live Streaming.*$/i, '').trim();
      const fullUrl = href.startsWith('http') ? href : `${BASE}${href}`;
      let rawImgSrc = img.attr('src') || '';
      const logoUrl = rawImgSrc.startsWith('http') ? rawImgSrc : `${BASE}${rawImgSrc}`;
      if (!channels.some(c => c.name === name)) {
        channels.push({ name, channelUrl: fullUrl, logo: logoUrl });
      }
    }
  });
  
  await browser1.close();
  console.error(`Found ${channels.length} channels and ${schedules.length} schedules.`);

  const browser2 = await chromium.launch({ headless: true });
  const page2 = await browser2.newPage();
  const validChannels = [];
  
  for (const ch of channels) {
    try {
      await page2.goto(ch.channelUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const cHtml = await page2.content();
      let playerUrl = '';
      if (cHtml.includes('uembed.php?v=')) {
        const match = cHtml.match(/uembed\.php\?v=([A-Za-z0-9_-]+)/);
        if (match) playerUrl = `${PLAYER}/uembed.php?v=${match[1]}`;
      } else if (cHtml.includes('player.php?id=')) {
        const match = cHtml.match(/player\.php\?id=([A-Za-z0-9_-]+)/);
        if (match) playerUrl = `${PLAYER}/player.php?id=${match[1]}`;
      }
      if (playerUrl) {
        validChannels.push({ ...ch, playerUrl });
        console.log(`   [+] ${ch.name}`);
      }
    } catch (e) {
      console.log(`   [!] Error on ${ch.name}`);
    }
  }
  await browser2.close();

  console.error(`\n=== PHASE 2: OPENING FRESH SESSIONS ===`);
  
  const results = [];
  const extensionPath = path.resolve('./turnstile-solver');

  for (const ch of validChannels) {
    console.error(`\nProcessing: ${ch.name}`);
    let capturedM3u8 = null;

    const browser = await chromium.launchPersistentContext(`./session-${ch.name.replace(/[^a-z0-9]/gi, '')}`, {
      headless: false,
      channel: 'chromium',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ],
      viewport: { width: 1280, height: 720 }
    });

    const p = await browser.pages()[0] || await browser.newPage();

    p.on('request', request => {
      if (request.url().includes('.m3u8')) capturedM3u8 = request.url();
    });

    try {
      console.error(`   -> Opening: ${ch.playerUrl}`);
      await p.goto(ch.playerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      
      console.error(`   -> Waiting 10s for Turnstile solver...`);
      await p.waitForTimeout(10000);

      let targetUrl = ch.playerUrl;

      if (ch.playerUrl.includes('player.php')) {
        const pHtml = await p.content();
        const fMatch = pHtml.match(/fid\s*=\s*["']([^"']+)["']/);
        
        if (fMatch) {
          targetUrl = `${PLAYER}/uembed.php?v=${fMatch[1]}`;
          console.error(`   -> Found fid: ${fMatch[1]}`);
          await p.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } else {
          console.error(`   -> [Error] Cloudflare still blocking.`);
        }
      }

      for (let i = 0; i < 20; i++) {
        if (capturedM3u8) break;
        await p.waitForTimeout(1000);
      }

      if (capturedM3u8) {
        console.error(`   [OK] Captured!`);
        results.push({ name: ch.name, logo: ch.logo, m3u8: capturedM3u8 });
      } else {
        console.error(`   [Error] No m3u8.`);
      }

    } catch (err) {
      console.error(`   [Error] ${err.message}`);
    } finally {
      await browser.close();
    }
  }

  // Generate M3U with Groups
  let playlistContent = '#EXTM3U\n';
  playlistContent += `# Generated: ${new Date().toISOString()}\n\n`;

  // 1. Channels Group
  for (const r of results) {
    playlistContent += `#EXTINF:-1 tvg-logo="${r.logo}" group-title="24/7 Channels", ${r.name}\n`;
    playlistContent += `#EXTVLCOPT:http-origin=https://bhalocast.com\n`;
    playlistContent += `#EXTVLCOPT:http-referrer=https://bhalocast.com/\n`;
    playlistContent += `#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\n`;
    playlistContent += `${r.m3u8}\n\n`;
  }

  // 2. Schedules Group (Adding schedules as M3U entries with channel link)
  for (const s of schedules) {
    playlistContent += `#EXTINF:-1 group-title="${s.league} Schedule", ${s.title} (${s.time})\n`;
    // Since schedule doesn't have a direct stream, we link to the channel page as a fallback
    playlistContent += `${BASE}/\n\n`;
  }

  fs.writeFileSync('playlist.m3u', playlistContent, 'utf8');
  console.error(`\nDone! Generated playlist.m3u with ${results.length} streams and ${schedules.length} schedules.`);
}

main();
