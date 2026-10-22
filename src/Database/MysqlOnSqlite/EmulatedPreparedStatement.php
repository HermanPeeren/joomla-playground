<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 */

namespace JoomlaPlayground\Database\MysqlOnSqlite;

use Joomla\Database\FetchMode;
use Joomla\Database\FetchOrientation;
use Joomla\Database\ParameterType;
use Joomla\Database\StatementInterface;

/**
 * A prepared statement for WP_MySQL_On_SQLite, which does not support prepare() and parameter binding (yet).
 *
 * Bound values are inlined into the SQL as literals when the statement is executed, the way PDO's
 * ATTR_EMULATE_PREPARES does (Joomla's MySQL driver enables that too). Strings are quoted by the connection,
 * so they get MySQL's escaping rules, which the emulator implements.
 */
final class EmulatedPreparedStatement implements StatementInterface
{
    private const FETCH_MODES = [
        FetchMode::ASSOCIATIVE     => \PDO::FETCH_ASSOC,
        FetchMode::NUMERIC         => \PDO::FETCH_NUM,
        FetchMode::MIXED           => \PDO::FETCH_BOTH,
        FetchMode::STANDARD_OBJECT => \PDO::FETCH_OBJ,
        FetchMode::COLUMN          => \PDO::FETCH_COLUMN,
        FetchMode::CUSTOM_OBJECT   => \PDO::FETCH_CLASS,
    ];

    /**
     * Bound variables (by reference) and their types, keyed by placeholder (':name' or 1-based position).
     *
     * @var array<string|int, array{value: mixed, type: string}>
     */
    private array $bindings = [];

    private ?\PDOStatement $result = null;

    private ?array $fetchMode = null;

    private ?\PDOException $error = null;

    public function __construct(private readonly \PDO $connection, private readonly string $sql)
    {
    }

    public function bindParam($parameter, &$variable, string $dataType = ParameterType::STRING, ?int $length = null, ?array $driverOptions = null)
    {
        $this->bindings[$parameter] = ['value' => &$variable, 'type' => $dataType];

        return true;
    }

    public function execute(?array $parameters = null)
    {
        $bindings = $this->bindings;

        foreach ($parameters ?? [] as $key => $value) {
            $bindings[\is_int($key) ? $key + 1 : $key] = ['value' => $value, 'type' => ParameterType::STRING];
        }

        $this->error = null;

        try {
            $this->result = $this->connection->query(self::inline($this->sql, $bindings, $this->connection));
        } catch (\PDOException $exception) {
            $this->error = $exception;

            throw $exception;
        }

        if ($this->fetchMode !== null) {
            $this->result->setFetchMode(...$this->fetchMode);
        }

        return true;
    }

    /**
     * Replaces :name and ? placeholders outside string literals, quoted identifiers and comments.
     *
     * @param  array<string|int, array{value: mixed, type: string}>  $bindings
     */
    public static function inline(string $sql, array $bindings, \PDO $connection): string
    {
        if ($bindings === []) {
            return $sql;
        }

        $result   = '';
        $length   = \strlen($sql);
        $position = 0;

        for ($i = 0; $i < $length; $i++) {
            $char = $sql[$i];

            // String literals and quoted identifiers: copy them as they are.
            if ($char === "'" || $char === '"' || $char === '`') {
                $end     = self::endOfQuoted($sql, $i, $char);
                $result .= substr($sql, $i, $end - $i + 1);
                $i       = $end;

                continue;
            }

            // Comments: -- (followed by whitespace), # and /* */.
            if (($char === '-' && substr($sql, $i, 2) === '--' && ctype_space($sql[$i + 2] ?? ' ')) || $char === '#') {
                $end     = strpos($sql, "\n", $i);
                $end     = $end === false ? $length - 1 : $end;
                $result .= substr($sql, $i, $end - $i + 1);
                $i       = $end;

                continue;
            }

            if ($char === '/' && ($sql[$i + 1] ?? '') === '*') {
                $end     = strpos($sql, '*/', $i + 2);
                $end     = $end === false ? $length - 1 : $end + 1;
                $result .= substr($sql, $i, $end - $i + 1);
                $i       = $end;

                continue;
            }

            if ($char === '?') {
                $position++;
                $result .= isset($bindings[$position]) ? self::literal($bindings[$position], $connection) : '?';

                continue;
            }

            if ($char === ':' && preg_match('/\G:[A-Za-z_][A-Za-z0-9_]*/', $sql, $match, 0, $i) && !preg_match('/[A-Za-z0-9_:]/', $sql[$i - 1] ?? ' ')) {
                $name    = $match[0];
                $result .= \array_key_exists($name, $bindings) ? self::literal($bindings[$name], $connection) : $name;
                $i      += \strlen($name) - 1;

                continue;
            }

            $result .= $char;
        }

        return $result;
    }

    public function fetch(?int $fetchStyle = null, int $cursorOrientation = FetchOrientation::NEXT, int $cursorOffset = 0)
    {
        if ($this->result === null) {
            return false;
        }

        return $fetchStyle === null ? $this->result->fetch() : $this->result->fetch(self::FETCH_MODES[$fetchStyle]);
    }

    public function setFetchMode(int $fetchMode, ...$args): void
    {
        $this->fetchMode = [self::FETCH_MODES[$fetchMode], ...$args];

        $this->result?->setFetchMode(...$this->fetchMode);
    }

    public function rowCount(): int
    {
        return $this->result?->rowCount() ?? 0;
    }

    public function closeCursor(): void
    {
        $this->result?->closeCursor();
        $this->result = null;
    }

    public function errorCode()
    {
        return $this->error ? (string) $this->error->getCode() : '00000';
    }

    public function errorInfo()
    {
        return $this->error ? ($this->error->errorInfo ?? ['HY000', null, $this->error->getMessage()]) : ['00000', null, null];
    }

    /**
     * @param  array{value: mixed, type: string}  $binding
     */
    private static function literal(array $binding, \PDO $connection): string
    {
        $value = $binding['value'];

        if ($value === null || $binding['type'] === ParameterType::NULL) {
            return 'NULL';
        }

        return match ($binding['type']) {
            ParameterType::INTEGER => (string) (int) $value,
            ParameterType::BOOLEAN => $value ? '1' : '0',
            default                => $connection->quote(\is_bool($value) ? (string) (int) $value : (string) $value),
        };
    }

    /**
     * Offset of the closing quote; MySQL escapes with a backslash or by doubling the quote.
     */
    private static function endOfQuoted(string $sql, int $start, string $quote): int
    {
        $length = \strlen($sql);

        for ($i = $start + 1; $i < $length; $i++) {
            if ($sql[$i] === '\\' && $quote !== '`') {
                $i++;

                continue;
            }

            if ($sql[$i] === $quote) {
                if (($sql[$i + 1] ?? '') === $quote) {
                    $i++;

                    continue;
                }

                return $i;
            }
        }

        return $length - 1;
    }
}
