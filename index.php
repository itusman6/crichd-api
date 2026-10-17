<?php
// index.php
// Web entry point. Serves the playlist over HTTP with caching.

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);
ini_set('error_log', __DIR__ . '/api_errors.log');

require __DIR__ . '/lib/crichd.php';

// CORS
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Accept, User-Agent');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') { http_response_code(204); exit; }

$uri = $_SERVER['REQUEST_URI'] ?? '';

if (strpos($uri, 'playlist.m3u') !== false || isset($_GET['playlist'])) {
    header('Content-Type: audio/x-mpegurl; charset=utf-8');
    header('Cache-Control: no-cache, must-revalidate');

    if (file_exists(CACHE_FILE)) {
        $age = time() - filemtime(CACHE_FILE);
        if ($age < MAX_CACHE_AGE) {
            header('X-Cache-Status: HIT');
            readfile(CACHE_FILE);
            exit;
        }
    }

    header('X-Cache-Status: MISS');
    $content = buildCombinedPlaylistSync();
    @file_put_contents(CACHE_FILE, $content, LOCK_EX);
    echo $content;
    exit;
}

if (isset($_GET['refresh'])) {
    @unlink(CACHE_FILE);
    header('Content-Type: application/json');
    $content = buildCombinedPlaylistSync();
    echo json_encode([
        'status' => 'ok',
        'streams' => countPlaylistEntries($content),
        'size' => strlen($content)
    ]);
    exit;
}

if (isset($_GET['stream']) && $_GET['stream'] !== '') {
    header('Content-Type: application/json');
    $id = preg_replace('/[^A-Za-z0-9_-]/', '', $_GET['stream']);
    $playerUrl = PLAYER_HOST . PLAYER_PATH . '?id=' . rawurlencode($id);
    $player = fetchPlaysza($playerUrl, BASE_URL . '/');
    $fid = '';
    if (preg_match('~\bfid\s*=\s*["\']([^"\']+)["\']~i', $player['body'], $m)) $fid = $m[1];
    $welloUrl = $fid ? PLAYER_HOST . UEMBED_PATH . '?v=' . rawurlencode($fid) : '';
    $wello = $welloUrl ? fetchPlaysza($welloUrl, $playerUrl) : ['body' => '', 'http_code' => 0];
    $m3u8 = extractObfuscatedM3u8($wello['body']);
    echo json_encode([
        'status' => $m3u8 ? 'success' : 'error',
        'fid' => $fid ?: null,
        'player_http' => $player['http_code'],
        'uembed_http' => $wello['http_code'] ?? 0,
        'm3u8_url' => $m3u8 ?: null
    ], JSON_PRETTY_PRINT);
    exit;
}

header('Content-Type: application/json');
echo json_encode([
    'status' => 'running',
    'flaresolverr' => FLARESOLVERR_URL,
    'endpoints' => [
        'playlist' => '/index.php?playlist=1',
        'stream'   => '/index.php?stream=willow',
        'refresh'  => '/index.php?refresh=1'
    ]
], JSON_PRETTY_PRINT);
