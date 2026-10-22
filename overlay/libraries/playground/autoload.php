<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 *
 * Autoloader for the Joomla Playground classes inside a Joomla site (libraries/playground/src).
 *
 * Joomla's DatabaseFactory derives the driver class from configuration.php's $dbtype as
 * Joomla\Database\{Type}\{Type}Driver, so $dbtype = 'playgroundsqlite' and 'mysqlonsqlite' are mapped to our
 * drivers here.
 */

\defined('_JEXEC') or die;

spl_autoload_register(static function (string $class): void {
    $aliases = [
        'Joomla\\Database\\Playgroundsqlite\\PlaygroundsqliteDriver' => 'JoomlaPlayground\\Database\\SqliteDriver',
        'Joomla\\Database\\Playgroundsqlite\\PlaygroundsqliteQuery'  => 'JoomlaPlayground\\Database\\SqliteQuery',
        'Joomla\\Database\\Mysqlonsqlite\\MysqlonsqliteDriver'       => 'JoomlaPlayground\\Database\\MysqlOnSqlite\\MysqlOnSqliteDriver',
    ];

    if (isset($aliases[$class])) {
        class_alias($aliases[$class], $class);

        return;
    }

    // WordPress's MySQL emulation for SQLite (wordpress/mysql-on-sqlite), loaded all at once when first used.
    if (str_starts_with($class, 'WP_MySQL_') || str_starts_with($class, 'WP_SQLite_') || str_starts_with($class, 'WP_Parser')) {
        require_once __DIR__ . '/mysql-on-sqlite/load.php';

        return;
    }

    if (str_starts_with($class, 'JoomlaPlayground\\')) {
        $file = __DIR__ . '/src/' . str_replace('\\', '/', substr($class, \strlen('JoomlaPlayground\\'))) . '.php';

        if (is_file($file)) {
            require_once $file;
        }
    }
});
