import axios from 'axios';
import fs from 'fs';
import * as cheerio from 'cheerio';

// Aapki di hui list
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

async function fetchM3u8(channel) {
  try {
    const url = `${PLAYER}/uembed.php?v=${channel.fid}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://playsza.st/'
      },
      timeout: 10000
    });

    const html = response.data;

    const directMatch = html.match(/https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?/i);
    if (directMatch) {
      return directMatch[0];
    }

    const baseMatch = html.match(/var\s+gTMjeSH\s*=\s*['"]([^'"]+)['"]/);
    if (baseMatch) {
      const md5Match = html.match(/md5=([^&'"]+)/);
      const expiresMatch = html.match(/expires=([^&'"]+)/);
      const sMatch = html.match(/&s=([^&'"]+)/);
      const chMatch = html.match(/&ch=([^&'"]+)/);
      
      if (md5Match && expiresMatch && sMatch && chMatch) {
        return `https://mz01.bhalocast.com:7060/hls/${channel.fid}.m3u8?md5=${md5Match[1]}&expires=${expiresMatch[1]}&ch=${chMatch[1]}&s=${sMatch[1]}`;
      }
    }

    throw new Error('Could not extract m3u8 URL');
  } catch (err) {
    console.error(`   [Error] ${channel.name}: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log('=== FETCHING M3U8 LINKS DIRECTLY ===');
  
  let schedules = [];
  try {
    const homeRes = await axios.get('https://crichd.mobile/', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const $ = cheerio.load(homeRes.data);
    $('table').find('tr').each((_, el) => {
      const $row = $(el);
      const league = $row.find('td').eq(1).text().trim();
      const title = $row.find('td').eq(2).text().trim();
      const time = $row.find('td').eq(3).text().trim().replace(/\s+/g, ' ');
      if (title && league && time) schedules.push({ league, title, time });
    });
  } catch (err) {
    console.error('Failed to fetch schedules:', err.message);
  }

  const results = [];

  const fetchPromises = channelsData.map(async (ch) => {
    console.log(`Fetching: ${ch.name}`);
    const m3u8 = await fetchM3u8(ch);
    if (m3u8) {
      console.log(`   [OK] ${ch.name}`);
      results.push({ ...ch, m3u8 });
    }
  });

  await Promise.all(fetchPromises);

  let playlistContent = '#EXTM3U\n';
  playlistContent += `# Generated: ${new Date().toISOString()}\n\n`;

  for (const r of results) {
    playlistContent += `#EXTINF:-1 tvg-logo="${r.logo}" group-title="24/7 Channels", ${r.name}\n`;
    playlistContent += `#EXTVLCOPT:http-origin=https://bhalocast.com\n`;
    playlistContent += `#EXTVLCOPT:http-referrer=https://bhalocast.com/\n`;
    playlistContent += `#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\n`;
    playlistContent += `${r.m3u8}\n\n`;
  }

  // ALL SCHEDULES IN ONE GROUP
  for (const s of schedules) {
    playlistContent += `#EXTINF:-1 group-title="Schedules", ${s.title} (${s.time})\n`;
    playlistContent += `https://crichd.mobile/\n\n`;
  }

  fs.writeFileSync('playlist.m3u', playlistContent, 'utf8');
  console.log(`\nDone! Generated playlist.m3u with ${results.length} streams and ${schedules.length} schedules.`);
}

main();
