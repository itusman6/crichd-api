import { chromium } from 'rebrowser-playwright';
import fs from 'fs';
import * as cheerio from 'cheerio';

// Aapki list
const channelsData = [
  { name: "Willow Cricket", fid: "willow2c", logo: "https://crichd.mobile/assets/channels/willow.webp" },
  { name: "Willow 2", fid: "wextres5", logo: "https://crichd.mobile/assets/channels/willowextra.webp" },
  { name: "Star Sports 1", fid: "star1kibich5", logo: "https://crichd.mobile/assets/channels/star1.webp" },
  { name: "Star Sports 1 Hindi", fid: "star4b", logo: "https://crichd.mobile/assets/channels/starhindi.webp" },
  { name: "Star Sports 2", fid: "star2u", logo: "https://crichd.mobile/assets/channels/star2.webp" },
  { name: "PTV Sports", fid: "ptvskpr", logo: "https://crichd.mobile/assets/channels/ptv.webp" },
  { name: "A Sports", fid: "asports3c", logo: "https://crichd.mobile/assets/channels/asports.webp" },
  { name: "Ten Sports", fid: "tenspk", logo: "https://crichd.mobile/assets/channels/tensp.webp" },
  { name: "Geo Super", fid: "geosp", logo: "https://crichd.mobile/assets/channels/geosp.webp" },
  { name: "T Sports HD", fid: "gtvbd", logo: "https://crichd.mobile/assets/channels/tsports.webp" },
  { name: "Astro Cricket", fid: "astro2v", logo: "https://crichd.mobile/assets/channels/astrocric.webp" },
  { name: "Sony Sports Ten 5", fid: "sony5c", logo: "https://crichd.mobile/assets/channels/ten5.webp" },
  { name: "Sony Sports Ten 1", fid: "sony1c", logo: "https://crichd.mobile/assets/channels/ten1.webp" },
  { name: "Sony Sports Ten 2", fid: "ten2endia", logo: "https://crichd.mobile/assets/channels/ten2.webp" },
  { name: "Sony Sports Ten 3", fid: "sony3c", logo: "https://crichd.mobile/assets/channels/ten3.webp" },
  { name: "Criclife 1", fid: "criclife1", logo: "https://crichd.mobile/assets/channels/cl1.webp" },
  { name: "Criclife 2", fid: "criclife2", logo: "https://crichd.mobile/assets/channels/cl2.webp" },
  { name: "Criclife 3", fid: "criclife3", logo: "https://crichd.mobile/assets/channels/cl3.webp" }
];

const PLAYER = 'https://playsza.st';

async function main() {
  console.log('=== FETCHING M3U8 LINKS VIA DEVTOOLS SNIFFER ===');
  
  // 1. Fetch schedules via simple HTTP (fast, no Cloudflare on homepage)
  let schedules = [];
  try {
    const response = await fetch('https://crichd.mobile/');
    const html = await response.text();
    const $ = cheerio.load(html);
    $('table').find('tr').each((_, el) => {
      const $row = $(el);
      const league = $row.find('td').eq(1).text().trim();
      const title = $row.find('td').eq(2).text().trim();
      const time = $row.find('td').eq(3).text().trim().replace(/\s+/g, ' ');
      if (title && league && time) schedules.push({ league, title, time });
    });
  } catch (err) {
    console.log('Failed to fetch schedules:', err.message);
  }

  // 2. Launch Chromium (No extension needed for uembed)
  const browser = await chromium.launch({
    headless: false,
    channel: 'chromium',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage'
    ],
    viewport: { width: 1280, height: 720 }
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const results = [];

  // 3. Process each FID
  for (const ch of channelsData) {
    console.log(`Fetching: ${ch.name}`);
    const page = await context.newPage();
    let capturedM3u8 = null;

    // DevTools Network Sniffer
    page.on('request', request => {
      if (request.url().includes('.m3u8')) {
        capturedM3u8 = request.url();
      }
    });

    try {
      // Open uembed directly using the fid
      await page.goto(`${PLAYER}/uembed.php?v=${ch.fid}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      // Wait up to 5 seconds for the m3u8 request to fire
      for (let i = 0; i < 5; i++) {
        if (capturedM3u8) break;
        await page.waitForTimeout(1000);
      }

      if (capturedM3u8) {
        console.log(`   [OK] ${ch.name}`);
        results.push({ ...ch, m3u8: capturedM3u8 });
      } else {
        console.log(`   [Error] No m3u8 intercepted for ${ch.name}`);
      }

    } catch (err) {
      console.log(`   [Error] ${ch.name}: ${err.message}`);
    } finally {
      await page.close();
    }
  }

  await browser.close();

  // 4. Generate M3U file
  let playlistContent = '#EXTM3U\n';
  playlistContent += `# Generated: ${new Date().toISOString()}\n\n`;

  // Channels Group
  for (const r of results) {
    playlistContent += `#EXTINF:-1 tvg-logo="${r.logo}" group-title="24/7 Channels", ${r.name}\n`;
    playlistContent += `#EXTVLCOPT:http-origin=https://bhalocast.com\n`;
    playlistContent += `#EXTVLCOPT:http-referrer=https://bhalocast.com/\n`;
    playlistContent += `#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\n`;
    playlistContent += `${r.m3u8}\n\n`;
  }

  // Schedules Group (All in one group)
  for (const s of schedules) {
    playlistContent += `#EXTINF:-1 group-title="Schedules", ${s.title} (${s.time})\n`;
    playlistContent += `https://crichd.mobile/\n\n`;
  }

  fs.writeFileSync('playlist.m3u', playlistContent, 'utf8');
  console.log(`\nDone! Generated playlist.m3u with ${results.length} streams and ${schedules.length} schedules.`);
}

main();
