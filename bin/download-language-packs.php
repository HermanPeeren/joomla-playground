<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 *
 * Downloads the accredited language packs for one Joomla version, so the browser playground can install them
 * without downloads.joomla.org (which a browser may not download from: it sends no CORS headers).
 *
 * Usage:
 *   php bin/download-language-packs.php --joomla=6.2.0 --out=web/public/joomla/6.2.0/languages
 *
 * Output (in --out):
 *   <tag>.zip    the language pack, e.g. nl-NL.zip
 *   index.json   { "packs": { "nl-NL": { "name", "version", "file", "downloadurl", "sha256" } } }
 *
 * The pack for a language is the newest one whose target platform matches the Joomla version, as Joomla's own
 * installer chooses it (System > Install Languages). Downloads are cached in .cache/language-packs/.
 */

const PLAYGROUND_ROOT = __DIR__ . '/..';

$options = getopt('', ['joomla:', 'out:']);
$joomla  = $options['joomla'] ?? fail('--joomla=<version> is missing');
$out     = $options['out'] ?? fail('--out=<folder> is missing');
$cache   = PLAYGROUND_ROOT . '/.cache/language-packs';
$major   = explode('.', $joomla)[0];

is_dir($out) || mkdir($out, 0755, true);
is_dir($cache) || mkdir($cache, 0755, true);

$list  = simplexml_load_string(fetch('https://update.joomla.org/language/translationlist_' . $major . '.xml'));
$packs = [];
$bytes = 0;

foreach ($list->extension as $extension) {
    $tag = substr((string) $extension['element'], 4);

    try {
        $update = bestUpdate(simplexml_load_string(fetch((string) $extension['detailsurl'])), $joomla);
    } catch (RuntimeException $exception) {
        echo "  $tag: " . $exception->getMessage() . "\n";
        continue;
    }

    if (!$update) {
        echo "  $tag: no pack for Joomla $joomla\n";
        continue;
    }

    $url    = trim((string) $update->downloads->downloadurl);
    $sha256 = strtolower(trim((string) $update->sha256));
    $cached = $cache . '/' . hash('sha256', $url) . '.zip';

    if (!is_file($cached) || ($sha256 && hash_file('sha256', $cached) !== $sha256)) {
        file_put_contents($cached . '.part', fetch($url));
        rename($cached . '.part', $cached);
    }

    if ($sha256 && hash_file('sha256', $cached) !== $sha256) {
        echo "  $tag: checksum mismatch, left out\n";
        continue;
    }

    copy($cached, $out . '/' . $tag . '.zip');
    $bytes += filesize($cached);
    $packs[$tag] = [
        'name'        => (string) $extension['name'],
        'version'     => (string) $update->version,
        'file'        => $tag . '.zip',
        'downloadurl' => $url,
        'sha256'      => $sha256,
    ];
}

ksort($packs);
file_put_contents($out . '/index.json', json_encode(['joomla' => $joomla, 'packs' => $packs], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
printf("  %d language packs for Joomla %s, %.1f MB\n", \count($packs), $joomla, $bytes / 1048576);

/**
 * The newest <update> whose target platform matches the Joomla version.
 */
function bestUpdate(SimpleXMLElement $details, string $joomla): ?SimpleXMLElement
{
    $best = null;

    foreach ($details->update as $update) {
        $platform = $update->targetplatform;

        if ((string) $platform['name'] !== 'joomla' || !preg_match('/^' . str_replace('/', '\/', (string) $platform['version']) . '/', $joomla)) {
            continue;
        }

        if (!$best || version_compare((string) $update->version, (string) $best->version, '>')) {
            $best = $update;
        }
    }

    return $best;
}

function fetch(string $url): string
{
    $context = stream_context_create(['http' => ['user_agent' => 'Joomla Playground build', 'timeout' => 60, 'follow_location' => 1]]);

    for ($attempt = 1; ; $attempt++) {
        $data = @file_get_contents($url, false, $context);

        if ($data !== false) {
            return $data;
        }

        if ($attempt === 3) {
            throw new RuntimeException('Cannot download ' . $url);
        }

        sleep(2);
    }
}

function fail(string $message): never
{
    fwrite(STDERR, 'ERROR: ' . $message . PHP_EOL);
    exit(1);
}
