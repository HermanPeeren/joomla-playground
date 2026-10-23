<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 *
 * Builds the Joomla bundle for the browser playground (web/): a pre-installed site that the PHP worker unpacks
 * into its in-memory filesystem, and the static media files that the service worker serves directly.
 *
 * Usage:
 *   php bin/build-browser-bundle.php [--package=<Full Package zip>] [--out=web/public/joomla] [--driver=mysqlonsqlite]
 *
 * Output (in --out):
 *   site.zip       the installed site, with empty placeholders for the static files in media/ (Joomla checks that
 *                  they exist before linking them; the browser gets them from media/)
 *   media/         the static media files
 *   manifest.json  Joomla version, database driver, sizes
 */

const PLAYGROUND_ROOT = __DIR__ . '/..';

require PLAYGROUND_ROOT . '/vendor/autoload.php';

$options = getopt('', ['package:', 'out:', 'driver:']);
$version = getenv('JOOMLA_VERSION') ?: '6.2.0';
$package = $options['package'] ?? PLAYGROUND_ROOT . '/.cache/Joomla_' . $version . '-Stable-Full_Package.zip';
$out     = $options['out'] ?? PLAYGROUND_ROOT . '/web/public/joomla';
$driver  = $options['driver'] ?? 'mysqlonsqlite';
$work    = PLAYGROUND_ROOT . '/build/browser-bundle';
$site    = $work . '/site';

if (!is_file($package)) {
    fail('Joomla Full Package not found: ' . $package . ' (download it, or run the integration tests once)');
}

// 1. Unpack and install
step('Unpacking ' . basename($package));
removeTree($work);
mkdir($site, 0755, true);
$zip = new ZipArchive();
$zip->open($package) === true && $zip->extractTo($site) || fail('Cannot unpack ' . $package);
$zip->close();

step('Installing Joomla (' . $driver . ')');
// The worker sets the real URL and a new Super User password when the playground boots.
run([
    PHP_BINARY, PLAYGROUND_ROOT . '/bin/install-sqlite-site.php', '--site=' . $site, '--driver=' . $driver,
    '--site-name=Joomla Playground', '--admin-password=' . bin2hex(random_bytes(16)), '--live-site=http://playground.invalid',
]);

// 2. Playground settings: nothing that needs a network or a mail server, nothing that blocks the single PHP worker.
step('Applying playground settings');
$db = $driver === 'mysqlonsqlite'
    ? new JoomlaPlayground\Database\MysqlOnSqlite\MysqlOnSqliteDriver(['database' => $site . '/data/joomla.sqlite', 'prefix' => 'jos_'])
    : new JoomlaPlayground\Database\SqliteDriver(['database' => $site . '/data/joomla.sqlite', 'prefix' => 'jos_']);

$disabledPlugins = [
    'system'    => ['stats', 'schedulerunner'],
    // autoupdate asks update.joomla.org for the automated update status: without a network that blocks PHP for 20 s.
    'quickicon' => ['joomlaupdate', 'extensionupdate', 'eos', 'autoupdate'],
    'installer' => ['webinstaller'],
];

foreach ($disabledPlugins as $folder => $elements) {
    $db->setQuery(
        'UPDATE ' . $db->quoteName('#__extensions') . ' SET ' . $db->quoteName('enabled') . ' = 0'
        . " WHERE type = 'plugin' AND folder = " . $db->quote($folder) . ' AND element IN (' . implode(',', array_map([$db, 'quote'], $elements)) . ')'
    )->execute();
}

$db->setQuery("UPDATE #__scheduler_tasks SET state = 0 WHERE type = 'update.notification'")->execute();

// One database file without a write-ahead log, through the same SQLite connection.
$sqlite = $db->getConnection();
$sqlite = $sqlite instanceof WP_MySQL_On_SQLite ? $sqlite->get_sqlite_pdo() : $sqlite;
$sqlite->exec('PRAGMA wal_checkpoint(TRUNCATE)');
$sqlite->exec('PRAGMA journal_mode = DELETE');
$sqlite->exec('VACUUM');
$sqlite = null;
$db->disconnect();
$db = null;

// Sessions of 4 hours instead of 15 minutes: a playground is for trying things, often with pauses.
setConfiguration($site . '/configuration.php', ['mailonline' => false, 'gzip' => false, 'caching' => 0, 'lifetime' => 240]);

// 3. Files the browser playground does not need
step('Removing build sources, caches and logs');
$removed = 0;

foreach (files($site . '/media') as $file) {
    if (preg_match('/\.(gz|scss|less|ts|map)$/', $file)) {
        unlink($file);
        $removed++;
    }
}

// Caches hold absolute paths of this machine (e.g. administrator/cache/autoload_psr4.php, Joomla's namespace map),
// which do not exist in the browser's virtual filesystem. Joomla rebuilds them.
$transient = [...glob($site . '/tmp/*'), ...glob($site . '/administrator/logs/*'), ...glob($site . '/administrator/cache/*'), ...glob($site . '/cache/*')];

foreach ($transient as $file) {
    if (basename($file) !== 'index.html') {
        is_dir($file) ? removeTree($file) : unlink($file);
    }
}

echo '  removed ' . $removed . " files\n";

// 4. Package
step('Writing ' . $out);
removeTree($out);
mkdir($out . '/media', 0755, true);

$zip = new ZipArchive();
$zip->open($out . '/site.zip', ZipArchive::CREATE | ZipArchive::OVERWRITE);
$mediaFiles = 0;
$mediaBytes = 0;

foreach (files($site) as $file) {
    $relative = str_replace('\\', '/', substr($file, \strlen($site) + 1));

    if (str_starts_with($relative, 'media/') && !str_ends_with($relative, '.json')) {
        $target = $out . '/' . $relative;
        is_dir(\dirname($target)) || mkdir(\dirname($target), 0755, true);
        copy($file, $target);
        $zip->addFromString($relative, '');
        $mediaFiles++;
        $mediaBytes += filesize($file);

        continue;
    }

    $zip->addFile($file, $relative);
    $zip->setCompressionName($relative, ZipArchive::CM_DEFLATE, 9);
}

$zip->close();

$manifest = [
    'joomla'     => $version,
    'driver'     => $driver,
    'built'      => gmdate('c'),
    'siteZip'    => filesize($out . '/site.zip'),
    'mediaFiles' => $mediaFiles,
    'mediaBytes' => $mediaBytes,
];
file_put_contents($out . '/manifest.json', json_encode($manifest, JSON_PRETTY_PRINT) . "\n");

printf("\nsite.zip %.1f MB, media %d files %.1f MB\n", $manifest['siteZip'] / 1048576, $mediaFiles, $mediaBytes / 1048576);

function setConfiguration(string $file, array $values): void
{
    $configuration = file_get_contents($file);

    foreach ($values as $key => $value) {
        $configuration = preg_replace('/public \$' . $key . ' = [^;]*;/', 'public $' . $key . ' = ' . var_export($value, true) . ';', $configuration);
    }

    file_put_contents($file, $configuration);
}

function step(string $message): void
{
    echo '- ' . $message . PHP_EOL;
}

function fail(string $message): never
{
    fwrite(STDERR, 'ERROR: ' . $message . PHP_EOL);
    exit(1);
}

function run(array $command): void
{
    $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes);
    $output  = stream_get_contents($pipes[1]);
    fclose($pipes[1]);

    if (proc_close($process) !== 0) {
        fail("Command failed:\n" . $output);
    }
}

/**
 * @return Generator<string>
 */
function files(string $directory): Generator
{
    $items = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS));

    foreach ($items as $item) {
        if ($item->isFile()) {
            yield $item->getPathname();
        }
    }
}

function removeTree(string $directory): void
{
    if (!is_dir($directory)) {
        return;
    }

    $items = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );

    foreach ($items as $item) {
        if ($item->isDir()) {
            rmdir($item->getPathname());
        } else {
            chmod($item->getPathname(), 0666);
            unlink($item->getPathname());
        }
    }

    rmdir($directory);
}
