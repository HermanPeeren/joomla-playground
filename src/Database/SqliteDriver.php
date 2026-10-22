<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 */

namespace JoomlaPlayground\Database;

use Joomla\Database\Pdo\PdoDriver;
use Joomla\Database\QueryInterface;
use Joomla\Database\Sqlite\SqliteDriver as FrameworkSqliteDriver;

/**
 * SQLite driver for running the Joomla CMS, building on the Joomla Framework's SqliteDriver.
 *
 * Joomla creates it for configuration.php's $dbtype = 'playgroundsqlite' (see the autoloader in
 * overlay/libraries/playground). It reports 'sqlite' as server type, so Joomla follows its non-MySQL code
 * paths, which were written for PostgreSQL and use portable SQL.
 *
 * Compared with the framework driver it:
 * - keeps its own name, because saving the Global Configuration writes $db->getName() back as dbtype;
 * - resolves a relative database path against JPATH_ROOT, so every entry point uses the same file;
 * - uses SqliteQuery from this package (dialect fixes);
 * - registers PHP functions that Joomla's SQL needs and SQLite lacks (REGEXP, CONCAT, SOUNDEX, ...);
 * - rewrites the few raw PostgreSQL statements that core sends on the non-MySQL path;
 * - reports column defaults without SQL quoting, like the MySQL and PostgreSQL drivers do.
 */
class SqliteDriver extends FrameworkSqliteDriver
{
    public const NAME = 'playgroundsqlite';

    /**
     * @var string
     */
    public $name = self::NAME;

    /**
     * @var string
     */
    public $serverType = 'sqlite';

    public function __construct(array $options)
    {
        // PdoDriver builds the DSN from the driver option.
        $options['driver']   = 'sqlite';
        $options['database'] = self::resolveDatabasePath((string) ($options['database'] ?? ''));

        parent::__construct($options);
    }

    /**
     * A relative path is relative to the Joomla root (JPATH_ROOT); absolute paths and ':memory:' stay as they are.
     */
    public static function resolveDatabasePath(string $path): string
    {
        if ($path === '' || $path === ':memory:' || !\defined('JPATH_ROOT')) {
            return $path;
        }

        if (preg_match('#^([a-zA-Z]:)?[/\\\\]#', $path)) {
            return $path;
        }

        return JPATH_ROOT . '/' . $path;
    }

    public static function isSupported()
    {
        return class_exists(\PDO::class) && \in_array('sqlite', \PDO::getAvailableDrivers(), true);
    }

    public function connect()
    {
        if ($this->connection) {
            return;
        }

        // Skip the framework driver's ROW_NUMBER emulation: SQLite has had window functions since 3.25.
        PdoDriver::connect();

        $this->connection->exec('PRAGMA busy_timeout = 5000');

        foreach (SqliteFunctions::all() as $name => [$callback, $arguments]) {
            $this->createFunction($name, $callback, $arguments);
        }
    }

    public function createQuery(): QueryInterface
    {
        return new SqliteQuery($this);
    }

    public function escape($text, $extra = false)
    {
        if (\is_int($text)) {
            return $text;
        }

        if (\is_float($text)) {
            // Force the dot as a decimal point.
            return str_replace(',', '.', (string) $text);
        }

        return str_replace("'", "''", (string) $text);
    }

    public function setQuery($query, $offset = 0, $limit = 0)
    {
        if (\is_string($query)) {
            $query = self::rewriteRawSql($query);
        }

        return parent::setQuery($query, $offset, $limit);
    }

    /**
     * Rewrites raw SQL that Joomla core only sends to PostgreSQL ("the non-MySQL path") into SQLite syntax.
     */
    public static function rewriteRawSql(string $sql): string
    {
        // Smart Search's optimize(): VACUUM takes a schema name in SQLite and REINDEX has no TABLE keyword.
        if (preg_match('/^\s*VACUUM\s+(\S+)\s*$/i', $sql, $match)) {
            return 'ANALYZE ' . $match[1];
        }

        if (preg_match('/^\s*REINDEX\s+TABLE\s+(\S+)\s*$/i', $sql, $match)) {
            return 'REINDEX ' . $match[1];
        }

        return $sql;
    }

    /**
     * PDO's rowCount() is 0 for a SELECT on SQLite: SQLite only reports the rows changed by INSERT, UPDATE and DELETE.
     * Joomla counts grouped list queries this way (BaseDatabaseModel::_getListCount()), so count a SELECT's rows by
     * fetching them. The load*() methods execute the query again, so consuming the statement here is safe.
     */
    public function getNumRows()
    {
        $this->connect();

        if (!$this->statement) {
            return 0;
        }

        if (!preg_match('/^\s*(SELECT|WITH|PRAGMA|VALUES)\b/i', (string) $this->sql)) {
            return $this->statement->rowCount();
        }

        $rows = 0;

        while ($this->statement->fetch() !== false) {
            $rows++;
        }

        return $rows;
    }

    /**
     * MySQL generates a new AUTO_INCREMENT id for a primary key of 0 and the PostgreSQL driver leaves such a key
     * out. SQLite would store the 0, so leave it out here too.
     */
    public function insertObject($table, &$object, $key = null)
    {
        if (\is_string($key) && isset($object->$key) && ($object->$key === 0 || $object->$key === '0')) {
            $object->$key = null;

            try {
                return parent::insertObject($table, $object, $key);
            } finally {
                $object->$key ??= 0;
            }
        }

        return parent::insertObject($table, $object, $key);
    }

    public function getTableColumns($table, $typeOnly = true)
    {
        $this->connect();

        $columns = [];
        $fields  = $this->setQuery('PRAGMA table_info(' . $this->quoteName($table) . ')')->loadObjectList();

        foreach ($fields as $field) {
            if ($typeOnly) {
                $columns[$field->name] = $field->type;

                continue;
            }

            $columns[$field->name] = (object) [
                'Field'   => $field->name,
                'Type'    => $field->type,
                'Null'    => $field->notnull ? 'NO' : 'YES',
                'Default' => self::unquoteDefault($field->dflt_value),
                'Key'     => $field->pk ? 'PRI' : '',
                'Extra'   => $field->pk && strtoupper($field->type) === 'INTEGER' ? 'auto_increment' : '',
            ];
        }

        return $columns;
    }

    /**
     * Turns a column default as SQLite reports it (an SQL expression) into the value the other drivers report.
     */
    public static function unquoteDefault(?string $default): ?string
    {
        if ($default === null || strtoupper($default) === 'NULL') {
            return null;
        }

        if (preg_match("/^'(.*)'$/s", $default, $match)) {
            return str_replace("''", "'", $match[1]);
        }

        return $default;
    }

    public function getTableList()
    {
        return array_values(array_filter(
            parent::getTableList(),
            static fn (string $table): bool => !str_starts_with($table, 'sqlite_')
        ));
    }

    private function createFunction(string $name, callable $callback, int $arguments): void
    {
        $flags = \defined('PDO::SQLITE_DETERMINISTIC') ? \PDO::SQLITE_DETERMINISTIC : 0;

        if ($this->connection instanceof \Pdo\Sqlite) {
            $this->connection->createFunction($name, $callback, $arguments, $flags);

            return;
        }

        $this->connection->sqliteCreateFunction($name, $callback, $arguments, $flags);
    }
}
