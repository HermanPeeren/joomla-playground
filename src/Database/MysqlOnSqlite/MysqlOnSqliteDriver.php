<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 */

namespace JoomlaPlayground\Database\MysqlOnSqlite;

use Joomla\Database\DatabaseEvents;
use Joomla\Database\Event\ConnectionEvent;
use Joomla\Database\Exception\ConnectionFailureException;
use Joomla\Database\Exception\PrepareStatementFailureException;
use Joomla\Database\Mysql\MysqlDriver;
use Joomla\Database\QueryInterface;
use Joomla\Database\StatementInterface;
use JoomlaPlayground\Database\CountsSelectRows;
use JoomlaPlayground\Database\SqliteDriver;
use JoomlaPlayground\Database\SqliteFunctions;

/**
 * Joomla's MySQL driver on top of WordPress's MySQL emulation for SQLite (WP_MySQL_On_SQLite).
 *
 * Spike for the "Option C" database strategy: Joomla sees MySQL (server type 'mysql'), runs its MySQL code paths
 * and its MySQL install SQL unchanged, and the emulator translates every query to SQLite.
 *
 * Joomla creates it for configuration.php's $dbtype = 'mysqlonsqlite' (see overlay/libraries/playground).
 * $db is the SQLite file, relative to the Joomla root.
 */
class MysqlOnSqliteDriver extends MysqlDriver
{
    use CountsSelectRows;

    public const NAME = 'mysqlonsqlite';

    /**
     * @var string
     */
    public $name = self::NAME;

    /**
     * Server variables Joomla asks for with SHOW VARIABLES, which the emulator answers with no rows: MySQL's defaults.
     * Smart Search sizes its memory table from max_heap_table_size, and warns when it gets no row.
     */
    private const SERVER_VARIABLES = [
        'max_allowed_packet'  => '67108864',
        'max_heap_table_size' => '16777216',
    ];

    public function __construct(array $options)
    {
        $options['driver']   = 'mysql';
        $options['database'] = SqliteDriver::resolveDatabasePath((string) ($options['database'] ?? ''));

        parent::__construct($options);
    }

    public static function isSupported()
    {
        return class_exists(\WP_MySQL_On_SQLite::class) && \in_array('sqlite', \PDO::getAvailableDrivers(), true);
    }

    /**
     * Replaces the PDO MySQL connection; the rest follows MysqlDriver::connect().
     */
    public function connect()
    {
        if ($this->getConnection()) {
            return;
        }

        $dsn = 'mysql-on-sqlite:path=' . str_replace(';', ';;', $this->options['database']) . ';dbname=joomla';

        try {
            $this->connection = new \WP_MySQL_On_SQLite($dsn, null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        } catch (\PDOException $exception) {
            throw new ConnectionFailureException('Could not connect to MySQL on SQLite: ' . $exception->getMessage(), (int) $exception->getCode(), $exception);
        }

        // MySQL functions the emulator does not provide (yet): TIME_FORMAT is in Joomla's install SQL; CONCAT_WS
        // (native only since SQLite 3.44) and SOUNDEX (Smart Search) are used when saving content.
        // PHP 8.5 deprecates PDO::sqliteCreateFunction() in favour of Pdo\Sqlite::createFunction() (PHP 8.4+).
        $sqlite   = $this->connection->get_sqlite_pdo();
        $register = $sqlite instanceof \Pdo\Sqlite ? $sqlite->createFunction(...) : $sqlite->sqliteCreateFunction(...);
        $register('TIME_FORMAT', [SqliteFunctions::class, 'timeFormat'], 2);
        $register('CONCAT_WS', [SqliteFunctions::class, 'concatWs'], -1);
        $register('SOUNDEX', [SqliteFunctions::class, 'soundex'], 1);

        $this->utf8mb4 = true;
        $this->mariadb = false;

        if ($this->options['sqlModes'] !== []) {
            $this->connection->query("SET @@SESSION.sql_mode = '" . implode(',', $this->options['sqlModes']) . "'");
        }

        $this->dispatchEvent(new ConnectionEvent(DatabaseEvents::POST_CONNECT, $this));
    }

    /**
     * The factory would look for a query class named after the driver.
     */
    public function createQuery(): QueryInterface
    {
        return new MysqlOnSqliteQuery($this);
    }

    protected function prepareStatement(string $query): StatementInterface
    {
        if (!$this->connection instanceof \WP_MySQL_On_SQLite) {
            throw new PrepareStatementFailureException('Not connected to MySQL on SQLite');
        }

        if (preg_match("/^\s*SHOW\s+(?:SESSION\s+|GLOBAL\s+)?VARIABLES\s+LIKE\s+'([a-z_]+)'\s*;?\s*$/i", $query, $match)) {
            $name  = strtolower($match[1]);
            $value = self::SERVER_VARIABLES[$name] ?? null;

            if ($value !== null) {
                $query = "SELECT '$name' AS Variable_name, '$value' AS Value";
            }
        }

        return new EmulatedPreparedStatement($this->connection, $query);
    }

    public function getVersion()
    {
        $this->connect();

        return $this->connection->getAttribute(\PDO::ATTR_SERVER_VERSION);
    }

    /**
     * A local SQLite file has no TLS; MysqlDriver would ask with SHOW SESSION STATUS, which the emulator lacks.
     */
    public function getConnectionEncryption(): string
    {
        return '';
    }

    public function isConnectionEncryptionSupported(): bool
    {
        return false;
    }

    /**
     * The emulator has no connection to lose.
     */
    public function connected()
    {
        return $this->connection !== null;
    }
}
