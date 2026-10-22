<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 *
 * Installs an unpacked Joomla Full Package on SQLite, with native PHP (no WebAssembly).
 *
 * Usage:
 *   php bin/install-sqlite-site.php --site=<joomla root> --admin-password=<password> [options]
 *
 * Options:
 *   --site=DIR              Joomla root, unpacked from a Full Package, still containing installation/ (required)
 *   --driver=DRIVER         playgroundsqlite (default): Joomla's PostgreSQL schema converted to SQLite;
 *                           mysqlonsqlite: Joomla's MySQL schema on WordPress's MySQL emulation for SQLite (spike)
 *   --db=PATH               SQLite database file, relative to the Joomla root (default: data/joomla.sqlite)
 *   --prefix=PREFIX         Table prefix (default: jos_)
 *   --site-name=NAME        Site name (default: Joomla Playground)
 *   --admin-name=NAME       Super User name (default: Super User)
 *   --admin-username=NAME   Super User username (default: admin)
 *   --admin-password=PASS   Super User password (default: a random one, printed at the end)
 *   --admin-email=EMAIL     Super User email (default: admin@example.invalid)
 *   --live-site=URL         Set $live_site, e.g. http://127.0.0.1:8080 when serving with `php -S`: Joomla takes the
 *                           cli-server SAPI for CLI and cannot derive its base URL from the request then
 *   --keep-installation     Do not delete the installation folder afterwards
 *
 * Steps:
 *   1. copy the overlay (autoloader, defines.php files, database driver) into the site;
 *   2. boot Joomla's own installation application;
 *   3. create the tables: from installation/sql/postgresql converted to SQLite (playgroundsqlite), or from
 *      installation/sql/mysql as it is (mysqlonsqlite);
 *   4. run Joomla's ConfigurationModel::setup(): configuration.php, schema version, manifest caches, Super User;
 *   5. delete the installation folder;
 *   6. install the Joomla Playground system plugin (plg_system_playground) with the site's CLI.
 */

const PLAYGROUND_ROOT = __DIR__ . '/..';

$options = getopt('', [
    'site:', 'driver:', 'db:', 'prefix:', 'site-name:', 'admin-name:', 'admin-username:', 'admin-password:', 'admin-email:',
    'live-site:', 'keep-installation', 'help',
]);

if (isset($options['help']) || empty($options['site'])) {
    fwrite(STDERR, "Usage: php bin/install-sqlite-site.php --site=<joomla root> [--admin-password=...] [--db=data/joomla.sqlite]\n");
    exit(isset($options['help']) ? 0 : 1);
}

$site = realpath($options['site']);

if ($site === false || !is_file($site . '/installation/joomla.php')) {
    fail('Not an unpacked Joomla Full Package with an installation folder: ' . $options['site']);
}

if (is_file($site . '/configuration.php')) {
    fail('Joomla is already installed in ' . $site . ' (configuration.php exists)');
}

$generatedPassword = !isset($options['admin-password']);
$drivers           = [
    'playgroundsqlite' => \JoomlaPlayground\Database\SqliteDriver::class,
    'mysqlonsqlite'    => \JoomlaPlayground\Database\MysqlOnSqlite\MysqlOnSqliteDriver::class,
];
$driver            = $options['driver'] ?? 'playgroundsqlite';

if (!isset($drivers[$driver])) {
    fail('Unknown driver ' . $driver . '; use ' . implode(' or ', array_keys($drivers)));
}

$config = [
    'db_type'                => $driver,
    'db_host'                => 'localhost',
    // SQLite needs neither, but the Global Configuration form requires a host and a user.
    'db_user'                => 'sqlite',
    'db_pass'                => '',
    'db_pass_plain'          => '',
    'db_name'                => $options['db'] ?? 'data/joomla.sqlite',
    'db_prefix'              => $options['prefix'] ?? 'jos_',
    'db_encryption'          => 0,
    'db_sslkey'              => '',
    'db_sslcert'             => '',
    'db_sslca'               => '',
    'db_sslcipher'           => '',
    'db_sslverifyservercert' => false,
    'site_name'              => $options['site-name'] ?? 'Joomla Playground',
    'admin_user'             => $options['admin-name'] ?? 'Super User',
    'admin_username'         => $options['admin-username'] ?? 'admin',
    'admin_password'         => '',
    'admin_password_plain'   => $options['admin-password'] ?? bin2hex(random_bytes(12)),
    'admin_email'            => $options['admin-email'] ?? 'admin@example.invalid',
    'language'               => 'en-GB',
    'helpurl'                => 'https://help.joomla.org/proxy?keyref=Help{major}{minor}:{keyref}&lang={langcode}',
];

// 1. Overlay
step('Copying the overlay into the site');
copyTree(PLAYGROUND_ROOT . '/overlay', $site);
copyTree(PLAYGROUND_ROOT . '/src', $site . '/libraries/playground/src');
copyTree(PLAYGROUND_ROOT . '/vendor/wordpress/mysql-on-sqlite/packages/mysql-on-sqlite/src', $site . '/libraries/playground/mysql-on-sqlite');
copy(PLAYGROUND_ROOT . '/vendor/wordpress/mysql-on-sqlite/packages/mysql-on-sqlite/LICENSE', $site . '/libraries/playground/mysql-on-sqlite/LICENSE');

$databaseFile = $site . '/' . $config['db_name'];

if (!is_dir(\dirname($databaseFile))) {
    mkdir(\dirname($databaseFile), 0755, true);
}

if (!is_file(\dirname($databaseFile) . '/.htaccess')) {
    file_put_contents(\dirname($databaseFile) . '/.htaccess', "Require all denied\n");
}

if (is_file($databaseFile)) {
    unlink($databaseFile);
}

// 2. Boot the installation application, as installation/includes/cli.php does (without running it).
step('Booting the Joomla installation application');
\define('_JEXEC', 1);
\define('_JCLI_INSTALLATION', 1);
\define('JPATH_BASE', $site . DIRECTORY_SEPARATOR . 'installation');

require_once JPATH_BASE . '/includes/defines.php';
require_once $site . '/libraries/playground/autoload.php';
require_once JPATH_BASE . '/includes/framework.php';

JLoader::registerNamespace('Joomla\\CMS\\Installation', JPATH_INSTALLATION . '/src', false, false);

$container = \Joomla\CMS\Factory::getContainer();
$container->registerServiceProvider(new \Joomla\CMS\Installation\Service\Provider\Application());
$container->alias('session', 'session.cli')
    ->alias('JSession', 'session.cli')
    ->alias(\Joomla\CMS\Session\Session::class, 'session.cli')
    ->alias(\Joomla\Session\Session::class, 'session.cli')
    ->alias(\Joomla\Session\SessionInterface::class, 'session.cli');

$app = $container->get(\Joomla\CMS\Installation\Application\CliInstallationApplication::class);
\Joomla\CMS\Factory::$application = $app;

// DatabaseHelper::getDbo() keeps the first connection, so the installation models below all use this one.
$db = \Joomla\CMS\Installation\Helper\DatabaseHelper::getDbo(
    $config['db_type'],
    $config['db_host'],
    $config['db_user'],
    $config['db_pass_plain'],
    $config['db_name'],
    $config['db_prefix']
);

if (!$db instanceof $drivers[$driver]) {
    fail('The playground database driver was not loaded, got ' . $db::class);
}

// 3. Tables
if ($driver === 'mysqlonsqlite') {
    // Joomla's own MySQL install SQL, through Joomla's own installation model.
    $databaseModel = $app->getMVCFactory()->createModel('Database', 'Installation', ['dbo' => $db]);

    foreach (['base', 'supports', 'extensions', 'localise', 'custom'] as $schema) {
        $file = JPATH_INSTALLATION . '/sql/mysql/' . $schema . '.sql';

        if (is_file($file)) {
            step('Creating tables: ' . $schema . '.sql (MySQL)');

            // WP_MySQL_On_SQLite 3.1.1 stores VARBINARY as BLOB, which never equals a string in SQLite, so the
            // session table (session_id VARBINARY) would never find its rows. VARCHAR works for session ids.
            $sql  = preg_replace('/\bvarbinary\((\d+)\)/i', 'varchar($1)', file_get_contents($file));
            $file = $site . '/tmp/install-' . $schema . '.sql';
            file_put_contents($file, $sql);

            if (!$databaseModel->populateDatabase($db, $file)) {
                reportMessages($app);
                fail('Creating the tables failed');
            }
        }
    }
} else {
    $converter = new \JoomlaPlayground\Schema\PostgresqlToSqliteConverter();

    foreach (['base', 'supports', 'extensions', 'localise', 'custom'] as $schema) {
        $file = JPATH_INSTALLATION . '/sql/postgresql/' . $schema . '.sql';

        if (!is_file($file)) {
            continue;
        }

        step('Creating tables: ' . $schema . '.sql');
        $result = $converter->convert(file_get_contents($file));

        $db->transactionStart();

        foreach ($result->statements as $statement) {
            $db->setQuery($statement)->execute();
        }

        foreach ($result->sequences as $table => $next) {
            foreach (\JoomlaPlayground\Schema\ConversionResult::sequenceStatements($db->replacePrefix($table), $next) as $statement) {
                $db->setQuery($statement)->execute();
            }
        }

        $db->transactionCommit();
    }

    // ConfigurationModel::setup() takes the schema version from the newest update file of the server type.
    // There are no SQLite update files yet: an empty file with the newest PostgreSQL version stands in.
    $updates = JPATH_ADMINISTRATOR . '/components/com_admin/sql/updates/';
    $newest  = array_reduce(
        glob($updates . 'postgresql/*.sql'),
        static fn (string $carry, string $file): string => version_compare($carry, basename($file, '.sql')) < 0 ? basename($file, '.sql') : $carry,
        '0'
    );

    if (!is_dir($updates . 'sqlite')) {
        mkdir($updates . 'sqlite', 0755, true);
    }

    file_put_contents($updates . 'sqlite/' . $newest . '.sql', "-- Joomla Playground: SQLite schema equals PostgreSQL schema version $newest.\n");
}

// 4. configuration.php, schema version, manifest caches, Super User
step('Writing configuration.php and creating the Super User');
$configurationModel = $app->getMVCFactory()->createModel('Configuration', 'Installation', ['dbo' => $db]);

if (!$configurationModel->setup($config)) {
    reportMessages($app);
    fail('ConfigurationModel::setup() failed');
}

reportMessages($app);

if (!empty($options['live-site'])) {
    $configurationFile = JPATH_CONFIGURATION . '/configuration.php';
    $configuration     = preg_replace(
        '/public \$live_site = \'\';/',
        'public $live_site = ' . var_export(rtrim($options['live-site'], '/'), true) . ';',
        file_get_contents($configurationFile)
    );
    file_put_contents($configurationFile, $configuration);
}

// 5. Clean up: Joomla only runs once the installation folder is gone.
if (isset($options['keep-installation'])) {
    echo 'Kept the installation folder, so the Joomla Playground system plugin is not installed.' . PHP_EOL;
} else {
    step('Deleting the installation folder');
    removeTree(JPATH_INSTALLATION);

    // 6. The Joomla Playground system plugin, installed by the site's own CLI so that it uses the site's database.
    step('Installing the Joomla Playground system plugin');
    $package = zipFolder(PLAYGROUND_ROOT . '/extensions/plg_system_playground', $site . '/tmp/plg_system_playground.zip');
    $process = proc_open(
        [PHP_BINARY, $site . '/cli/joomla.php', 'extension:install', '--path=' . $package],
        [1 => ['pipe', 'w'], 2 => ['redirect', 1]],
        $pipes,
        $site
    );
    $output = stream_get_contents($pipes[1]);
    fclose($pipes[1]);

    // extension:install normally removes the package itself.
    is_file($package) && unlink($package);

    if (proc_close($process) !== 0) {
        fail("Installing plg_system_playground failed:\n" . $output);
    }

    $db->setQuery(
        "UPDATE #__extensions SET enabled = 1 WHERE type = 'plugin' AND folder = 'system' AND element = 'playground'"
    )->execute();
}

echo PHP_EOL . 'Joomla ' . JVERSION . ' is installed on SQLite in ' . $site . PHP_EOL;
echo '  database: ' . $databaseFile . PHP_EOL;
echo '  Super User: ' . $config['admin_username'] . ($generatedPassword ? ' / ' . $config['admin_password_plain'] : '') . PHP_EOL;

function step(string $message): void
{
    echo '- ' . $message . PHP_EOL;
}

function fail(string $message): never
{
    fwrite(STDERR, 'ERROR: ' . $message . PHP_EOL);
    exit(1);
}

function reportMessages(object $app): void
{
    $errors = 0;

    foreach ($app->getMessageQueue(true) as $message) {
        echo '  [' . $message['type'] . '] ' . $message['message'] . PHP_EOL;
        $errors += $message['type'] === 'error' ? 1 : 0;
    }

    if ($errors) {
        fail($errors . ' error(s) during installation');
    }
}

function copyTree(string $source, string $target): void
{
    is_dir($target) || mkdir($target, 0755, true);

    $items = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($source, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST
    );

    foreach ($items as $item) {
        $path = $target . '/' . substr($item->getPathname(), \strlen($source) + 1);

        if ($item->isDir()) {
            is_dir($path) || mkdir($path, 0755, true);
        } else {
            copy($item->getPathname(), $path);
        }
    }
}

function zipFolder(string $folder, string $zipFile): string
{
    $folder = realpath($folder);
    $zip    = new ZipArchive();
    $zip->open($zipFile, ZipArchive::CREATE | ZipArchive::OVERWRITE);

    $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($folder, FilesystemIterator::SKIP_DOTS));

    foreach ($files as $file) {
        $zip->addFile($file->getPathname(), str_replace('\\', '/', substr($file->getPathname(), \strlen($folder) + 1)));
    }

    $zip->close();

    return $zipFile;
}

function removeTree(string $directory): void
{
    $items = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );

    foreach ($items as $item) {
        $item->isDir() ? rmdir($item->getPathname()) : unlink($item->getPathname());
    }

    rmdir($directory);
}
