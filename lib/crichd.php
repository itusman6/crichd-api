<?php
// lib/crichd.php
// Shared CricHD scraper library. Used by build_playlist.php (CLI) and index.php (web).

// --- Site constants ---
if (!defined('BASE_URL'))           define('BASE_URL', 'https://crichd.mobile');
if (!defined('PLAYER_HOST'))        define('PLAYER_HOST', 'https://playsza.st');
if (!defined('PLAYER_PATH'))        define('PLAYER_PATH', '/player.php');
if (!defined('UEMBED_PATH'))        define('UEMBED_PATH', '/uembed.php');
if (!defined('DEFAULT_WELLO_HOST')) define('DEFAULT_WELLO_HOST', 'https://bhalocast.com');

// --- FlareSolverr ---
if (!defined('FLARESOLVERR_URL'))         define('FLARESOLVERR_URL', getenv('FLARESOLVERR_URL') ?: 'http://127.0.0.1:8191/v1');
if (!defined('FLARESOLVERR_TIMEOUT_MS'))  define('FLARESOLVERR_TIMEOUT_MS', 90000);
if (!defined('USER_AGENT_FALLBACK'))      define('USER_AGENT_FALLBACK', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36');

// --- Cache ---
if (!defined('CACHE_FILE'))      define('CACHE_FILE', sys_get_temp_dir() . '/crichd_playlist.m3u');
if (!defined('CACHE_LIFETIME'))  define('CACHE_LIFETIME', 21600);
if (!defined('MAX_CACHE_AGE'))   define('MAX_CACHE_AGE', 43200);

// --- HTTP ---
if (!defined('CURL_TIMEOUT'))         define('CURL_TIMEOUT', 30);
if (!defined('CURL_CONNECT_TIMEOUT')) define('CURL_CONNECT_TIMEOUT', 10);

// ==================== FlareSolverr ====================
function fetchPlaysza($url, $referer = '', $extraCookies = [])
{
    $payload = [
        'cmd' => 'request.get',
        'url' => $url,
        'maxTimeout' => FLARESOLVERR_TIMEOUT_MS
    ];
    $headers = [];
    if ($referer) $headers['Referer'] = $referer;
    if (!empty($headers)) $payload['headers'] = $headers;

    $ch = curl_init(FLARESOLVERR_URL);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($payload),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_TIMEOUT => (FLARESOLVERR_TIMEOUT_MS / 1000) + 15,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => 0
    ]);
    $raw = curl_exec($ch);
    $err = curl_error($ch);
    curl_close($ch);

    if ($raw === false || $err) {
        error_log("FlareSolverr cURL error for $url: $err");
        return ['body' => '', 'http_code' => 0, 'user_agent' => USER_AGENT_FALLBACK, 'cookies' => []];
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded) || ($decoded['status'] ?? '') !== 'ok') {
        $msg = is_array($decoded) ? ($decoded['message'] ?? 'unknown') : 'invalid JSON';
        error_log("FlareSolverr failed for $url: $msg");
        return ['body' => '', 'http_code' => 0, 'user_agent' => USER_AGENT_FALLBACK, 'cookies' => []];
    }

    $sol = $decoded['solution'] ?? [];
    return [
        'body' => $sol['response'] ?? '',
        'http_code' => (int)($sol['status'] ?? 0),
        'user_agent' => $sol['userAgent'] ?? USER_AGENT_FALLBACK,
        'cookies' => $sol['cookies'] ?? []
    ];
}

// ==================== Extraction chain ====================
function extractM3u8FromCurrentPage($html, $page_referer = BASE_URL . '/')
{
    $playerId = '';
    $patterns = [
        '~https?://playsza\.st/player\.php\?id=([A-Za-z0-9_-]+)~i',
        '~/player\.php\?id=([A-Za-z0-9_-]+)~i',
        '~data-player-id=["\']([A-Za-z0-9_-]+)["\']~i',
        '~<iframe[^>]+src=["\'][^"\']*/player\.php\?id=([A-Za-z0-9_-]+)["\']~i'
    ];
    foreach ($patterns as $p) {
        if (preg_match($p, $html, $m)) { $playerId = $m[1]; break; }
    }
    if (!$playerId) {
        $slug = basename(parse_url($page_referer, PHP_URL_PATH) ?: '');
        $playerId = preg_replace('/-(?:live-streaming|streaming|free|hd|\d+).*$/i', '', $slug);
    }
    if (!$playerId) return ['status' => 'not_found', 'error' => 'No player ID'];

    $playerUrl = PLAYER_HOST . PLAYER_PATH . '?id=' . rawurlencode($playerId);
    $player = fetchPlaysza($playerUrl, $page_referer);

    if (empty($player['body']) || $player['http_code'] >= 400) {
        return ['status' => 'not_found', 'error' => 'Player HTTP ' . $player['http_code']];
    }

    $fid = '';
    if (preg_match('~\bfid\s*=\s*["\']([^"\']+)["\']~i', $player['body'], $m)) $fid = trim($m[1]);
    if (!$fid) return ['status' => 'not_found', 'error' => 'No fid'];

    $welloUrl = PLAYER_HOST . UEMBED_PATH . '?v=' . rawurlencode($fid);
    $wello = fetchPlaysza($welloUrl, $playerUrl);

    if (empty($wello['body']) || $wello['http_code'] >= 400) {
        return ['status' => 'not_found', 'error' => 'uembed HTTP ' . $wello['http_code']];
    }

    $m3u8 = extractObfuscatedM3u8($wello['body']);
    if (!$m3u8 && preg_match('~https?://[^"\'\s<>]+\.m3u8(?:\?[^"\'\s<>]*)?~i', $wello['body'], $m)) {
        $m3u8 = normalizeM3u8Url($m[0]);
    }

    if ($m3u8) {
        return ['status' => 'success', 'm3u8_url' => $m3u8, 'fid' => $fid,
                'player_url' => $playerUrl, 'wello_url' => $welloUrl,
                'user_agent' => $player['user_agent']];
    }
    return ['status' => 'not_found', 'error' => 'No m3u8 in uembed'];
}

function extractObfuscatedM3u8($html)
{
    if (empty($html)) return '';
    $code = preg_replace_callback('/\\\\x([0-9a-fA-F]{2})/', fn($m) => chr(hexdec($m[1])), $html);

    if (preg_match('~https?://[^"\'\s<>]+\.m3u8(?:\?[^"\'\s<>]*)?~i', $code, $m)) return normalizeM3u8Url($m[0]);

    $vars = [];
    if (preg_match_all('/(?:var|let|const)?\s*([a-zA-Z0-9_$]+)\s*=\s*\[\s*((?:[\'"][^\'"]*[\'"]\s*,?\s*)+)\]\s*\.join\s*\(\s*[\'"]{2}\s*\)/is', $code, $arr, PREG_SET_ORDER)) {
        foreach ($arr as $m) { preg_match_all('/[\'"]([^\'"]*)[\'"]/', $m[2], $p); $vars[$m[1]] = implode('', $p[1] ?? []); }
    }
    if (preg_match_all('/(?:var|let|const)?\s*([a-zA-Z0-9_$]+)\s*=\s*[\'"]([^\'"\r\n]+)[\'"]/i', $code, $str, PREG_SET_ORDER)) {
        foreach ($str as $m) if (!isset($vars[$m[1]])) $vars[$m[1]] = $m[2];
    }

    foreach (['~function\s+Titmyle\s*\([^)]*\)\s*\{([^}]+)\}~is', '~function\s+[a-zA-Z0-9_$]+\s*\([^)]*\)\s*\{([^}]+)\}~is', '~return\s+([^;}\n]+\.m3u8[^;}\n]*)~is'] as $pat) {
        if (preg_match_all($pat, $code, $ms)) {
            foreach ($ms[1] as $block) {
                $resolved = resolveJsConcat($block, $vars);
                if (preg_match('~https?://[^"\'\s<>]+\.m3u8(?:\?[^"\'\s<>]*)?~i', $resolved, $f)) return normalizeM3u8Url($f[0]);
            }
        }
    }
    return '';
}

function resolveJsConcat($expr, $vars)
{
    $expr = preg_replace('/^(?:return|\w+\s*=)\s*/i', '', trim($expr));
    $expr = rtrim($expr, ';');
    $out = '';
    foreach (explode('+', $expr) as $tok) {
        $tok = trim($tok);
        if ($tok === '') continue;
        if (preg_match('/^[\'"](.*)[\'"]$/s', $tok, $m)) { $out .= $m[1]; continue; }
        if (isset($vars[$tok])) { $out .= $vars[$tok]; continue; }
        $out .= trim($tok, "\"' \t\n\r\0\x0B");
    }
    return str_replace(['\/', '\\"', "\\'"], ['/', '"', "'"], $out);
}

// ==================== Playlist build ====================
function buildCombinedPlaylistSync()
{
    if (function_exists('set_time_limit')) @set_time_limit(0);
    error_log("Starting build at " . date('Y-m-d H:i:s'));

    $items = []; $seen = [];
    $home = fetchPlaysza(BASE_URL . '/');
    if (!$home['body'] || $home['http_code'] < 200 || $home['http_code'] >= 400) {
        error_log("Homepage failed: HTTP {$home['http_code']}");
        return generateErrorPlaylist('Homepage fetch failed');
    }

    preg_match_all(
        '~<a\s+href="([^"]*?(?:/channels/|/channel/)[^"]*)"[^>]*>\s*<img[^>]*src="([^"]*)"[^>]*title="([^"]*)"[^>]*>\s*</a>~is',
        $home['body'], $matches, PREG_SET_ORDER
    );

    foreach ($matches as $m) {
        $url = absoluteUrl($m[1], BASE_URL);
        if (!$url) continue;
        $key = normalizeUrl($url);
        if (isset($seen[$key])) continue;
        $name = trim($m[3]) ?: channelNameFromUrl($url);
        $name = trim(preg_replace('/\s+Live Streaming.*$/i', '', $name));
        if ($name && strlen($name) > 1) {
            $seen[$key] = true;
            $items[] = ['name' => $name, 'url' => $url, 'logo' => absoluteUrl($m[2], BASE_URL), 'group' => '24/7 Channels'];
        }
    }

    if (empty($items)) return generateErrorPlaylist('No channels found');
    error_log("Processing " . count($items) . " channels");

    $playlist = ['#EXTM3U', '# Generated: ' . date('Y-m-d H:i:s'), ''];
    $streamSeen = []; $processedCount = 0;

    $SKIP = ['star sports 2','ptv sports','a sports','ten sports','geo super','t sports hd',
             'fox sports cricket','astro cricket','sony sports ten 5','sony sports ten 2',
             'sky sports cricket','supersport cricket','criclife 2','criclife 3'];

    foreach ($items as $item) {
        if (in_array(strtolower($item['name']), $SKIP)) continue;
        error_log("Channel: " . $item['name']);

        // Channel page (crichd.mobile) — also goes through FlareSolverr for consistency
        $page = fetchPlaysza($item['url'], BASE_URL . '/');
        if (!$page['body'] || $page['http_code'] >= 400) {
            error_log("  Page fetch failed"); continue;
        }

        $stream = extractM3u8FromCurrentPage($page['body'], $item['url']);
        if (($stream['status'] ?? '') !== 'success' || empty($stream['m3u8_url'])) {
            error_log("  No stream: " . ($stream['error'] ?? 'unknown')); continue;
        }

        $m3u8 = trim($stream['m3u8_url']);
        if (!filter_var($m3u8, FILTER_VALIDATE_URL) || isset($streamSeen[$m3u8])) continue;
        $streamSeen[$m3u8] = true;

        $name = cleanPlaylistText($item['name']);
        $logo = $item['logo'] ?: '';
        $group = $item['group'];
        $welloHost = parse_url($stream['wello_url'] ?? DEFAULT_WELLO_HOST, PHP_URL_SCHEME) . '://'
                   . parse_url($stream['wello_url'] ?? DEFAULT_WELLO_HOST, PHP_URL_HOST);

        $playlist[] = sprintf('#EXTINF:-1 tvg-logo="%s" group-title="%s",%s',
            escapeM3uAttribute($logo), escapeM3uAttribute($group), $name ?: 'Unknown');
        $playlist[] = '#EXTVLCOPT:http-referrer=' . $welloHost . '/';
        $playlist[] = '#EXTVLCOPT:http-origin=' . $welloHost;
        $playlist[] = '#EXTVLCOPT:http-user-agent=' . ($stream['user_agent'] ?? USER_AGENT_FALLBACK);
        $playlist[] = $m3u8;

        $processedCount++;
        error_log("  OK: " . $name);
    }

    if ($processedCount === 0) return generateErrorPlaylist('No working streams');

    $content = implode("\n", $playlist) . "\n";
    return $content;
}

// ==================== Helpers ====================
function generateErrorPlaylist($msg)
{
    return "#EXTM3U\n# Generated: " . date('Y-m-d H:i:s') . "\n"
        . "#EXTINF:-1,Error: " . $msg . "\n"
        . "https://invalid.local/error.m3u8\n";
}

function absoluteUrl($url, $base)
{
    $url = trim(html_entity_decode($url, ENT_QUOTES | ENT_HTML5));
    if ($url === '' || $url === '#') return '';
    if (preg_match('~^https?://~i', $url)) return $url;
    if (strpos($url, '//') === 0) return 'https:' . $url;
    if ($url[0] === '/') {
        $p = parse_url($base);
        return $p ? $p['scheme'] . '://' . $p['host'] . $url : '';
    }
    return rtrim($base, '/') . '/' . ltrim($url, '/');
}

function channelNameFromUrl($url)
{
    $slug = basename(trim(parse_url($url, PHP_URL_PATH) ?: '', '/'));
    $slug = preg_replace('/-(?:live-streaming|streaming|free|hd|24-7).*$/i', '', $slug);
    return ucwords(trim(str_replace('-', ' ', preg_replace('/-\d+$/', '', $slug))));
}

function cleanText($html)
{
    return trim(preg_replace('/\s+/', ' ', strip_tags(html_entity_decode($html, ENT_QUOTES | ENT_HTML5))));
}

function cleanPlaylistText($t)
{
    return trim(str_replace(["\r", "\n", ','], ['', '', ' '], cleanText($t)));
}

function escapeM3uAttribute($v)
{
    return str_replace(['\\', '"', "\r", "\n"], ['\\\\', '\\"', '', ' '], (string)$v);
}

function normalizeM3u8Url($u)
{
    $u = html_entity_decode(trim($u), ENT_QUOTES | ENT_HTML5);
    return trim(str_replace(['\\/', '\\u0026', '\\u003d', '\\u003f'], ['/', '&', '=', '?'], $u), "\"' \t\r\n");
}

function normalizeUrl($u)
{
    $p = parse_url($u);
    return $p ? strtolower($p['scheme'] ?? 'https') . '://' . strtolower($p['host'] ?? '') . ($p['path'] ?? '/') : strtolower(trim($u));
}

function countPlaylistEntries($p)
{
    return is_string($p) && $p !== '' ? (preg_match_all('/^#EXTINF:/m', $p, $x) ?: 0) : 0;
}
