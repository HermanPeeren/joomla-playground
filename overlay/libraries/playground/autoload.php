<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 *
 * Autoloader for the Joomla Playground classes inside a Joomla site (libraries/playground/src).
 *
 * Joomla's DatabaseFactory derives the driver class from configuration.php's $dbtype as
 * Joomla\Database\{Type}\{Type}Driver, so $dbtype = 'playgroundsqlite' is mapped to our driver here.
 */

\defined('_JEXEC') or die;

spl_autoload_register(static function (string $class): void {
    $aliases = [
        'Joomla\\Database\\Playgroundsqlite\\PlaygroundsqliteDriver' => 'JoomlaPlayground\\Database\\SqliteDriver',
        'Joomla\\Database\\Playgroundsqlite\\PlaygroundsqliteQuery'  => 'JoomlaPlayground\\Database\\SqliteQuery',
    ];

    if (isset($aliases[$class])) {
        class_alias($aliases[$class], $class);

        return;
    }

    if (str_starts_with($class, 'JoomlaPlayground\\')) {
        $file = __DIR__ . '/src/' . str_replace('\\', '/', substr($class, \strlen('JoomlaPlayground\\'))) . '.php';

        if (is_file($file)) {
            require_once $file;
        }
    }
});
