<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 *
 * Downloads the files the playground's own blueprints install (web/public/blueprints/assets.json), so a browser can
 * get them from the playground's website: GitHub's archive and release downloads send no CORS headers.
 *
 * Usage:
 *   php bin/download-blueprint-assets.php [--list=web/public/blueprints/assets.json] [--out=web/public/blueprints/assets]
 *
 * assets.json:
 *   { "<path in --out>": { "url": "<zip to download>", "folder": "<optional folder in the zip>",
 *                          "patches": [ { "file": "<path in the package>", "replace": "...", "with": "...",
 *                                         "why": "..." } ] } }
 *
 * With "folder", the zip is packed again with only that folder, at its root: a GitHub archive of a repository
 * becomes an installable extension package. "patches" correct known bugs of a package until its author fixes
 * them; a patch whose text is no longer there is skipped (fixed upstream) with a notice. Always downloaded fresh,
 * so a new build has the newest version.
 */

const PLAYGROUND_ROOT = __DIR__ . '/..';

$options = getopt('', ['list:', 'out:']);
$list    = $options['list'] ?? PLAYGROUND_ROOT . '/web/public/blueprints/assets.json';
$out     = $options['out'] ?? PLAYGROUND_ROOT . '/web/public/blueprints/assets';
$assets  = json_decode(file_get_contents($list), true, flags: JSON_THROW_ON_ERROR);

foreach ($assets as $path => $asset) {
    if (!preg_match('#^[a-z0-9_.-]+(/[a-z0-9_.-]+)*$#i', $path) || str_contains($path, '..')) {
        fail('Not a path for an asset: ' . $path);
    }

    $target = $out . '/' . $path;
    is_dir(\dirname($target)) || mkdir(\dirname($target), 0755, true);

    $context  = stream_context_create(['http' => ['user_agent' => 'Joomla Playground build', 'timeout' => 120, 'follow_location' => 1]]);
    $download = tempnam(sys_get_temp_dir(), 'asset');
    $bytes    = @file_get_contents($asset['url'], false, $context);

    $bytes !== false || fail('Cannot download ' . $asset['url']);
    file_put_contents($download, $bytes);

    if (empty($asset['folder'])) {
        rename($download, $target);
        printf("  %s: %.1f MB\n", $path, filesize($target) / 1048576);
        continue;
    }

    // Repack the folder: "<repository>-main/<folder>/..." becomes "...".
    $source = new ZipArchive();
    $source->open($download) === true || fail('Not a zip: ' . $asset['url']);
    $zip = new ZipArchive();
    $zip->open($target . '.part', ZipArchive::CREATE | ZipArchive::OVERWRITE);
    $files   = 0;
    $applied = [];

    for ($index = 0; $index < $source->numFiles; $index++) {
        $name = $source->getNameIndex($index);

        if (!preg_match('#^(?:[^/]+/)?' . preg_quote(trim($asset['folder'], '/'), '#') . '/(.+)$#', $name, $match)) {
            continue;
        }

        if (str_ends_with($name, '/')) {
            $zip->addEmptyDir(rtrim($match[1], '/'));
        } else {
            $zip->addFromString($match[1], patched($path, $match[1], $source->getFromIndex($index), $asset['patches'] ?? [], $applied));
            $files++;
        }
    }

    $source->close();

    $zip->close();
    unlink($download);

    foreach ($asset['patches'] ?? [] as $number => $patch) {
        echo isset($applied[$number])
            ? "  $path: patched {$patch['file']} ({$patch['why']})
"
            : "  $path: patch of {$patch['file']} not needed any more, fixed upstream? ({$patch['why']})
";
    }
    $files > 0 || fail('No folder "' . $asset['folder'] . '" in ' . $asset['url']);
    rename($target . '.part', $target);
    printf("  %s: %d files, %.1f MB\n", $path, $files, filesize($target) / 1048576);
}

/**
 * A file of a package with the patches for it applied; notes which patches applied.
 */
function patched(string $asset, string $file, string $text, array $patches, array &$applied): string
{
    foreach ($patches as $number => $patch) {
        if ($patch['file'] === $file && str_contains($text, $patch['replace'])) {
            $text = str_replace($patch['replace'], $patch['with'], $text);
            $applied[$number] = true;
        }
    }

    return $text;
}

function fail(string $message): never
{
    fwrite(STDERR, 'ERROR: ' . $message . PHP_EOL);
    exit(1);
}
