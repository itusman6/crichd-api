<?php
// build_playlist.php
// CLI entry point used by GitHub Actions.

error_reporting(E_ALL);
ini_set('display_errors', 'stderr');
ini_set('log_errors', 1);
ini_set('error_log', 'php://stderr');

require __DIR__ . '/lib/crichd.php';

// Quick health check so the workflow fails fast if FlareSolverr is dead
$ch = curl_init(str_replace('/v1', '/health', FLARESOLVERR_URL));
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 5,
    CURLOPT_CONNECTTIMEOUT => 3
]);
$health = curl_exec($ch);
curl_close($ch);

if ($health === false || strpos($health, '"ok"') === false) {
    fwrite(STDERR, "FlareSolverr health check failed at " . FLARESOLVERR_URL . "\n");
    fwrite(STDERR, "Health response: " . var_export($health, true) . "\n");
    exit(1);
}
fwrite(STDERR, "FlareSolverr is healthy.\n");

$playlist = buildCombinedPlaylistSync();
$count = countPlaylistEntries($playlist);
fwrite(STDERR, "Built playlist with $count stream(s).\n");

if ($count === 0) {
    fwrite(STDERR, "No streams were resolved. Outputting error playlist for debugging.\n");
}

echo $playlist;
