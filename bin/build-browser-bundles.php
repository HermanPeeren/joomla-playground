<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 *
 * Builds a browser bundle (bin/build-browser-bundle.php) for every Joomla version in joomla-versions.json, and the
 * list the playground chooses from.
 *
 * Usage:
 *   php bin/build-browser-bundles.php [--out=web/public/joomla] [--version=<one version>]
 *
 * Output (in --out):
 *   <version>/     one bundle: site.zip, media/, manifest.json
 *   versions.json  { "default": "6.2.0", "versions": [ <manifest of each bundle>, ... ] }
 *
 * A Full Package that is not in .cache/ yet is downloaded from the joomla/joomla-cms releases on GitHub.
 */

const PLAYGROUND_ROOT = __DIR__ . '/..';

$options  = getopt('', ['out:', 'version:']);
$out      = $options['out'] ?? PLAYGROUND_ROOT . '/web/public/joomla';
$list     = json_decode(file_get_contents(PLAYGROUND_ROOT . '/joomla-versions.json'), true, flags: JSON_THROW_ON_ERROR);
$versions = isset($options['version']) ? [$options['version']] : $list['versions'];

if (!\in_array($list['default'], $list['versions'], true)) {
    fail('joomla-versions.json: the default version is not in the list');
}

// Bundles of the old layout (one version directly in --out) and of versions no longer listed go.
if (!isset($options['version']) && is_dir($out)) {
    foreach (scandir($out) as $name) {
        if ($name !== '.' && $name !== '..' && !\in_array($name, $list['versions'], true)) {
            removeTree($out . '/' . $name);
        }
    }
}

foreach ($versions as $version) {
    if (!preg_match('/^\d+\.\d+\.\d+$/', $version)) {
        fail('Not a stable Joomla version: ' . $version);
    }

    $package = PLAYGROUND_ROOT . '/.cache/Joomla_' . $version . '-Stable-Full_Package.zip';

    if (!is_file($package)) {
        $url = 'https://github.com/joomla/joomla-cms/releases/download/' . $version . '/' . basename($package);
        echo "== Downloading $url\n";
        is_dir(\dirname($package)) || mkdir(\dirname($package), 0755, true);
        copy($url, $package . '.part') && rename($package . '.part', $package) || fail('Cannot download ' . $url);
    }

    echo "== Joomla $version\n";
    $process = proc_open(
        [PHP_BINARY, __DIR__ . '/build-browser-bundle.php', '--package=' . $package, '--out=' . $out . '/' . $version],
        [1 => STDOUT, 2 => STDERR],
        $pipes,
        null,
        [...getenv(), 'JOOMLA_VERSION' => $version]
    );

    proc_close($process) === 0 || fail('Building the bundle of Joomla ' . $version . ' failed');
}

$manifests = [];

foreach ($list['versions'] as $version) {
    $file = $out . '/' . $version . '/manifest.json';
    is_file($file) || fail('No bundle of Joomla ' . $version . ' in ' . $out);
    $manifests[] = json_decode(file_get_contents($file), true);
}

file_put_contents($out . '/versions.json', json_encode(['default' => $list['default'], 'versions' => $manifests], JSON_PRETTY_PRINT) . "\n");
echo "\nBundles: " . implode(', ', $list['versions']) . ' (default ' . $list['default'] . ")\n";

function fail(string $message): never
{
    fwrite(STDERR, 'ERROR: ' . $message . PHP_EOL);
    exit(1);
}

function removeTree(string $path): void
{
    if (is_dir($path) && !is_link($path)) {
        foreach (array_diff(scandir($path), ['.', '..']) as $name) {
            removeTree($path . '/' . $name);
        }

        rmdir($path);
    } elseif (file_exists($path)) {
        unlink($path);
    }
}
