<?php

namespace JoomlaPlayground\Tests\Integration\Support;

/**
 * A freshly installed Joomla site on SQLite, shared by all integration tests.
 *
 * JOOMLA_TEST_RUNTIME chooses how it runs: 'native' (default) serves it with PHP's built-in web server and runs
 * the CLI with this PHP; 'wasm' serves it and runs the CLI with PHP compiled to WebAssembly (wasm/serve.mjs and
 * wasm/cli.mjs, on @php-wasm/node).
 *
 * The Full Package of JOOMLA_VERSION is downloaded once into .cache/, unpacked into build/test-site and
 * installed with bin/install-sqlite-site.php and a random Super User password, using the database driver in
 * JOOMLA_TEST_DRIVER (playgroundsqlite or mysqlonsqlite).
 */
final class TestSite
{
    private static ?self $instance = null;

    /**
     * @var resource|null
     */
    private $server;

    private function __construct(
        public readonly string $root,
        public readonly string $url,
        public readonly string $username,
        public readonly string $password,
        public readonly string $driver,
        public readonly string $runtime,
    ) {
    }

    public static function get(): self
    {
        return self::$instance ??= self::create();
    }

    private static function create(): self
    {
        $project = \dirname(__DIR__, 3);
        $version = getenv('JOOMLA_VERSION') ?: throw new \RuntimeException('JOOMLA_VERSION is not set');
        $port    = (int) (getenv('JOOMLA_TEST_PORT') ?: 8781);
        $driver  = getenv('JOOMLA_TEST_DRIVER') ?: 'playgroundsqlite';
        $runtime = getenv('JOOMLA_TEST_RUNTIME') ?: 'native';
        $root    = $project . '/build/test-site';
        $url     = 'http://127.0.0.1:' . $port;

        $package = self::downloadPackage($project . '/.cache', $version);

        if (is_dir($root)) {
            self::removeTree($root);
        }

        mkdir($root, 0755, true);

        $zip = new \ZipArchive();

        if ($zip->open($package) !== true || !$zip->extractTo($root)) {
            throw new \RuntimeException('Cannot unpack ' . $package);
        }

        $zip->close();

        $password = bin2hex(random_bytes(12));

        [$exitCode, $output] = self::run([
            PHP_BINARY, '-d', 'xdebug.mode=off', $project . '/bin/install-sqlite-site.php',
            '--site=' . $root, '--driver=' . $driver, '--admin-username=admin', '--admin-password=' . $password, '--live-site=' . $url,
        ]);

        if ($exitCode !== 0) {
            throw new \RuntimeException("Installing the test site failed:\n" . $output);
        }

        $site = new self($root, $url, 'admin', $password, $driver, $runtime);
        $site->startServer($port);

        return $site;
    }

    /**
     * A path inside the site as PHP sees it: on the host, or in the WebAssembly runtime's virtual filesystem.
     */
    public function sitePath(string $relativePath): string
    {
        return ($this->runtime === 'wasm' ? '/var/www/html' : $this->root) . '/' . ltrim($relativePath, '/');
    }

    public function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite:' . $this->root . '/data/joomla.sqlite');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(\PDO::ATTR_DEFAULT_FETCH_MODE, \PDO::FETCH_ASSOC);

        return $pdo;
    }

    /**
     * Runs the Joomla CLI (cli/joomla.php) of the test site.
     *
     * @return array{0: int, 1: string}  Exit code and output.
     */
    public function cli(string ...$arguments): array
    {
        if ($this->runtime === 'wasm') {
            return self::run(['node', \dirname(__DIR__, 3) . '/wasm/cli.mjs', '--site=' . $this->root, '--', ...$arguments]);
        }

        return self::run([PHP_BINARY, '-d', 'xdebug.mode=off', $this->root . '/cli/joomla.php', ...$arguments], $this->root);
    }

    /**
     * @return array{0: int, 1: string}
     */
    private static function run(array $command, ?string $cwd = null): array
    {
        $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes, $cwd);
        $output  = stream_get_contents($pipes[1]);
        fclose($pipes[1]);

        return [proc_close($process), $output];
    }

    private function startServer(int $port): void
    {
        $log = $this->root . '/../php-server.log';

        $command = $this->runtime === 'wasm'
            ? ['node', \dirname(__DIR__, 3) . '/wasm/serve.mjs', '--site=' . $this->root, '--port=' . $port]
            : [PHP_BINARY, '-d', 'xdebug.mode=off', '-S', '127.0.0.1:' . $port, '-t', $this->root];

        $this->server = proc_open(
            $command,
            [0 => ['pipe', 'r'], 1 => ['file', $log, 'a'], 2 => ['file', $log, 'a']],
            $pipes,
            $this->root
        );

        register_shutdown_function(function (): void {
            if (\is_resource($this->server)) {
                proc_terminate($this->server);
            }
        });

        // Loading PHP's WebAssembly binary takes a few seconds.
        for ($attempt = 0; $attempt < 300; $attempt++) {
            $socket = @fsockopen('127.0.0.1', $port, $errno, $error, 0.2);

            if ($socket) {
                fclose($socket);

                return;
            }

            usleep(100000);
        }

        throw new \RuntimeException('The PHP web server did not start on port ' . $port);
    }

    private static function downloadPackage(string $cacheDirectory, string $version): string
    {
        $file = $cacheDirectory . '/Joomla_' . $version . '-Stable-Full_Package.zip';

        if (is_file($file)) {
            return $file;
        }

        is_dir($cacheDirectory) || mkdir($cacheDirectory, 0755, true);

        $url    = 'https://github.com/joomla/joomla-cms/releases/download/' . $version . '/' . basename($file);
        $handle = fopen($file . '.part', 'wb');
        $curl   = curl_init($url);

        curl_setopt_array($curl, [CURLOPT_FILE => $handle, CURLOPT_FOLLOWLOCATION => true, CURLOPT_FAILONERROR => true]);
        $ok = curl_exec($curl);
        fclose($handle);

        if (!$ok) {
            unlink($file . '.part');

            throw new \RuntimeException('Cannot download ' . $url . ': ' . curl_error($curl));
        }

        rename($file . '.part', $file);

        return $file;
    }

    private static function removeTree(string $directory): void
    {
        $items = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($directory, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );

        foreach ($items as $item) {
            if ($item->isDir() && !$item->isLink()) {
                $removed = rmdir($item->getPathname());
            } else {
                // Saving the Global Configuration makes configuration.php read-only, which blocks unlink() on Windows.
                chmod($item->getPathname(), 0666);
                $removed = unlink($item->getPathname());
            }

            if (!$removed) {
                throw new \RuntimeException('Cannot remove ' . $item->getPathname());
            }
        }

        rmdir($directory);
    }
}
