<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 *
 * Builds a browser bundle (bin/build-browser-bundle.php) for every Joomla version in joomla-versions.json, and the
 * list the playground chooses from.
 *
 * Usage:
 *   php bin/build-browser-bundles.php [--out=web/public/joomla] [--version=<one version>] [--no-languages]
 *
 * Output (in --out):
 *   <version>/     one bundle: site.zip, media/, manifest.json, and languages/ with the accredited language packs
 *                  (bin/download-language-packs.php), unless --no-languages
 *   versions.json  { "default": "6.2.0", "versions": [ <manifest of each bundle>, ... ] }
 *
 * A Full Package that is not in .cache/ yet is downloaded from the joomla/joomla-cms releases on GitHub. At the end,
 * the files of the playground's own blueprints are downloaded too (bin/download-blueprint-assets.php).
 */

const PLAYGROUND_ROOT = __DIR__ . '/..';

$options  = getopt('', ['out:', 'version:', 'no-languages']);
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

    $languages = 0;

    if (!isset($options['no-languages'])) {
        echo "== Language packs for Joomla $version\n";
        $process = proc_open(
            [PHP_BINARY, __DIR__ . '/download-language-packs.php', '--joomla=' . $version, '--out=' . $out . '/' . $version . '/languages'],
            [1 => STDOUT, 2 => STDERR],
            $pipes
        );
        proc_close($process) === 0 || fail('Downloading the language packs of Joomla ' . $version . ' failed');
        $languages = \count(json_decode(file_get_contents($out . '/' . $version . '/languages/index.json'), true)['packs']);
    }

    // The playground uses the language packs of a bundle when its manifest counts them.
    $file     = $out . '/' . $version . '/manifest.json';
    $manifest = json_decode(file_get_contents($file), true);
    file_put_contents($file, json_encode([...$manifest, 'languages' => $languages], JSON_PRETTY_PRINT) . "\n");
}

$manifests = [];

foreach ($list['versions'] as $version) {
    $file = $out . '/' . $version . '/manifest.json';
    is_file($file) || fail('No bundle of Joomla ' . $version . ' in ' . $out);
    $manifests[] = json_decode(file_get_contents($file), true);
}

file_put_contents($out . '/versions.json', json_encode(['default' => $list['default'], 'versions' => $manifests], JSON_PRETTY_PRINT) . "\n");

// Joomla's loader, which the page shows while a playground starts (before it knows which bundle it will use).
copy($out . '/' . $list['default'] . '/media/system/js/joomla-core-loader.min.js', $out . '/joomla-core-loader.js')
    || fail('No joomla-core-loader.min.js in the bundle of Joomla ' . $list['default']);

echo "== Files of the playground's blueprints\n";
$process = proc_open([PHP_BINARY, __DIR__ . '/download-blueprint-assets.php'], [1 => STDOUT, 2 => STDERR], $pipes);
proc_close($process) === 0 || fail('Downloading the files of the blueprints failed');

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
