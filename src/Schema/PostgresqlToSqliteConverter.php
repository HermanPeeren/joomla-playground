<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 */

namespace JoomlaPlayground\Schema;

/**
 * Converts Joomla's PostgreSQL install SQL (installation/sql/postgresql/*.sql) into SQLite SQL.
 *
 * The PostgreSQL files are a better source than the MySQL ones: indexes are separate statements and the
 * column types are portable. What needs converting:
 * - string literals: Joomla runs PostgreSQL with standard_conforming_strings = off, so backslash escapes
 *   are decoded and the literal is re-encoded for SQLite (only '' is special there);
 * - "identifiers" become `identifiers`, because Joomla's generic replacePrefix() skips double quotes;
 * - serial primary keys become INTEGER PRIMARY KEY AUTOINCREMENT, other PostgreSQL types get SQLite names;
 * - COMMENT ON statements are dropped;
 * - setval() calls are returned as sequence positions, to be applied with the real table prefix.
 */
final class PostgresqlToSqliteConverter
{
    /**
     * Sequence names ("{table}_{column}_seq") of the serial columns seen so far, mapped to their table.
     *
     * @var array<string, string>
     */
    private array $sequenceTables = [];

    public function convert(string $sql): ConversionResult
    {
        $statements = [];
        $sequences  = [];

        foreach ($this->splitStatements($sql) as $statement) {
            // Comments and PL/pgSQL functions (soundex(); the SQLite driver provides it as a PHP function).
            if (preg_match('/^(COMMENT\s+ON|CREATE\s+(OR\s+REPLACE\s+)?FUNCTION)\b/i', $statement)) {
                continue;
            }

            if (preg_match('/^SELECT\s+setval\s*\(\s*\'([^\']+)\'\s*,\s*(\d+)\s*(?:,\s*(true|false)\s*)?\)$/i', $statement, $match)) {
                $sequence = $match[1];

                if (!isset($this->sequenceTables[$sequence])) {
                    throw new \RuntimeException(sprintf('setval() for unknown sequence %s', $sequence));
                }

                $isCalled = strtolower($match[3] ?? 'true') === 'true';

                $sequences[$this->sequenceTables[$sequence]] = (int) $match[2] + ($isCalled ? 1 : 0);

                continue;
            }

            if (preg_match('/^CREATE\s+TABLE\b/i', $statement)) {
                $statement = $this->convertCreateTable($statement);
            }

            $statements[] = $this->convertDateExpressions($statement);
        }

        return new ConversionResult($statements, $sequences);
    }

    /**
     * Splits SQL into statements, dropping comments and converting literals and identifiers on the way.
     *
     * @return string[]
     */
    public function splitStatements(string $sql): array
    {
        $statements = [];
        $current    = '';
        $length     = \strlen($sql);
        $i          = 0;

        while ($i < $length) {
            $char = $sql[$i];
            $next = $sql[$i + 1] ?? '';

            if ($char === '-' && $next === '-') {
                $end = strpos($sql, "\n", $i);
                $i   = $end === false ? $length : $end;

                continue;
            }

            if ($char === '/' && $next === '*') {
                $end = strpos($sql, '*/', $i + 2);
                $i   = $end === false ? $length : $end + 2;

                continue;
            }

            if ($char === "'") {
                [$value, $i] = $this->readStringLiteral($sql, $i);
                $current .= self::quote($value);

                continue;
            }

            if ($char === '$' && preg_match('/\G\$([A-Za-z_]*)\$/', $sql, $tag, 0, $i)) {
                // Dollar-quoted body (PL/pgSQL functions): keep it intact, semicolons included.
                $end = strpos($sql, $tag[0], $i + \strlen($tag[0]));

                if ($end === false) {
                    throw new \RuntimeException('Unterminated dollar-quoted string at offset ' . $i);
                }

                $current .= substr($sql, $i, $end + \strlen($tag[0]) - $i);
                $i = $end + \strlen($tag[0]);

                continue;
            }

            if ($char === '"') {
                $end = strpos($sql, '"', $i + 1);

                if ($end === false) {
                    throw new \RuntimeException('Unterminated quoted identifier at offset ' . $i);
                }

                $current .= '`' . substr($sql, $i + 1, $end - $i - 1) . '`';
                $i = $end + 1;

                continue;
            }

            if ($char === ';') {
                $statements[] = trim($current);
                $current      = '';
                $i++;

                continue;
            }

            $current .= $char;
            $i++;
        }

        $statements[] = trim($current);

        return array_values(array_filter($statements, static fn (string $statement): bool => $statement !== ''));
    }

    /**
     * Translates the PostgreSQL date expressions used in the install SQL (scheduler tasks) to SQLite.
     * SQLite's CURRENT_TIMESTAMP and 'now' are UTC already.
     */
    public function convertDateExpressions(string $statement): string
    {
        $utcNow = "CURRENT_TIMESTAMP(?:\s+AT\s+TIME\s+ZONE\s+'UTC')?";

        // TO_TIMESTAMP(TO_CHAR(now + INTERVAL '30 days', 'format'), 'format')
        $statement = preg_replace_callback(
            "/TO_TIMESTAMP\(\s*TO_CHAR\(\s*$utcNow\s*\+\s*INTERVAL\s+'(\d+)\s+(\w+)'\s*,\s*'([^']+)'\s*\)\s*,\s*'[^']+'\s*\)/i",
            static fn (array $m): string => "strftime('" . self::toStrftimeFormat($m[3]) . "', 'now', '+" . $m[1] . ' ' . $m[2] . "')",
            $statement
        );

        // TO_CHAR(now, 'format'); the FM prefix suppresses leading zeros.
        $statement = preg_replace_callback(
            "/TO_CHAR\(\s*$utcNow\s*,\s*'(FM)?([^']+)'\s*\)/i",
            static function (array $m): string {
                $expression = "strftime('" . self::toStrftimeFormat($m[2]) . "', 'now')";

                return $m[1] !== '' ? 'CAST(CAST(' . $expression . ' AS INTEGER) AS TEXT)' : $expression;
            },
            $statement
        );

        return preg_replace("/CURRENT_TIMESTAMP\s+AT\s+TIME\s+ZONE\s+'UTC'/i", 'CURRENT_TIMESTAMP', $statement);
    }

    private static function toStrftimeFormat(string $format): string
    {
        return strtr($format, ['YYYY' => '%Y', 'HH24' => '%H', 'MI' => '%M', 'SS' => '%S', 'MM' => '%m', 'DD' => '%d']);
    }

    /**
     * Encodes a value as an SQLite string literal.
     */
    public static function quote(string $value): string
    {
        return "'" . str_replace("'", "''", $value) . "'";
    }

    /**
     * Reads a PostgreSQL string literal (standard_conforming_strings = off) that starts at $start.
     *
     * @return array{0: string, 1: int}  The decoded value and the offset just after the closing quote.
     */
    private function readStringLiteral(string $sql, int $start): array
    {
        $escapes = ['n' => "\n", 'r' => "\r", 't' => "\t", 'b' => "\x08", 'f' => "\f"];
        $value   = '';
        $length  = \strlen($sql);
        $i       = $start + 1;

        while ($i < $length) {
            $char = $sql[$i];

            if ($char === '\\' && $i + 1 < $length) {
                $escaped = $sql[$i + 1];
                $value  .= $escapes[$escaped] ?? $escaped;
                $i      += 2;

                continue;
            }

            if ($char === "'") {
                if (($sql[$i + 1] ?? '') === "'") {
                    $value .= "'";
                    $i     += 2;

                    continue;
                }

                return [$value, $i + 1];
            }

            $value .= $char;
            $i++;
        }

        throw new \RuntimeException('Unterminated string literal at offset ' . $start);
    }

    private function convertCreateTable(string $statement): string
    {
        if (!preg_match('/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`\s*\((.*)\)$/is', $statement, $match)) {
            throw new \RuntimeException('Cannot parse CREATE TABLE statement: ' . substr($statement, 0, 100));
        }

        $table        = $match[1];
        $columns      = [];
        $constraints  = [];
        $primaryKey   = [];
        $serialColumn = [];

        foreach ($this->splitTopLevel($match[2]) as $item) {
            if (preg_match('/^(?:CONSTRAINT\s+`[^`]+`\s+)?PRIMARY\s+KEY\s*\((.+)\)$/is', $item, $pk)) {
                $primaryKey = array_map(static fn (string $column): string => trim($column, " `\t\n\r"), explode(',', $pk[1]));

                continue;
            }

            if (preg_match('/^(CONSTRAINT|UNIQUE|CHECK|FOREIGN)\b/i', $item)) {
                $constraints[] = $item;

                continue;
            }

            if (!preg_match('/^`([^`]+)`\s+(.*)$/s', $item, $column)) {
                throw new \RuntimeException(sprintf('Cannot parse column definition in %s: %s', $table, $item));
            }

            [$type, $rest, $isSerial] = $this->convertColumnType($column[2]);

            if ($isSerial) {
                $serialColumn[]                                         = $column[1];
                $this->sequenceTables[$table . '_' . $column[1] . '_seq'] = $table;
            }

            $columns[$column[1]] = ['type' => $type, 'rest' => $rest];
        }

        $autoIncrement = \count($primaryKey) === 1 && \in_array($primaryKey[0], $serialColumn, true) ? $primaryKey[0] : null;

        foreach ($serialColumn as $name) {
            if ($name !== $autoIncrement) {
                throw new \RuntimeException(sprintf('Serial column %s.%s is not the single primary key column', $table, $name));
            }
        }

        $definitions = [];

        foreach ($columns as $name => $column) {
            if ($name === $autoIncrement) {
                // INTEGER PRIMARY KEY makes the column the rowid; AUTOINCREMENT keeps ids from being reused, like MySQL and PostgreSQL.
                $definitions[] = '`' . $name . '` INTEGER PRIMARY KEY AUTOINCREMENT';

                continue;
            }

            $definitions[] = trim('`' . $name . '` ' . $column['type'] . ' ' . $column['rest']);
        }

        if ($primaryKey && $autoIncrement === null) {
            $definitions[] = 'PRIMARY KEY (' . implode(', ', array_map(static fn (string $column): string => '`' . $column . '`', $primaryKey)) . ')';
        }

        $definitions = array_merge($definitions, $constraints);

        return 'CREATE TABLE IF NOT EXISTS `' . $table . '` (' . "\n  " . implode(",\n  ", $definitions) . "\n)";
    }

    /**
     * Maps a PostgreSQL column type to SQLite.
     *
     * @return array{0: string, 1: string, 2: bool}  The SQLite type, the rest of the definition, whether it was serial.
     */
    private function convertColumnType(string $definition): array
    {
        $map = [
            '/^(?:small|big)?serial\b/i'                         => 'INTEGER',
            '/^timestamp(?:\s+with(?:out)?\s+time\s+zone)?\b/i'  => 'DATETIME',
            '/^character\s+varying\b/i'                          => 'VARCHAR',
            '/^double\s+precision\b/i'                           => 'REAL',
            '/^bytea\b/i'                                        => 'BLOB',
            '/^boolean\b/i'                                      => 'BOOLEAN',
        ];

        foreach ($map as $pattern => $type) {
            if (preg_match($pattern, $definition, $match)) {
                $rest   = substr($definition, \strlen($match[0]));
                $length = '';

                if (preg_match('/^\s*(\([\d,\s]+\))/', $rest, $lengthMatch)) {
                    $length = $lengthMatch[1];
                    $rest   = substr($rest, \strlen($lengthMatch[0]));
                }

                return [$type . $length, trim($rest), str_contains(strtolower($match[0]), 'serial')];
            }
        }

        if (!preg_match('/^([a-z]+(?:\s*\([\d,\s]+\))?)(.*)$/is', $definition, $match)) {
            throw new \RuntimeException('Cannot parse column type: ' . $definition);
        }

        return [$match[1], trim($match[2]), false];
    }

    /**
     * Splits a CREATE TABLE body on commas that are not inside parentheses or string literals.
     *
     * @return string[]
     */
    private function splitTopLevel(string $body): array
    {
        $items   = [];
        $current = '';
        $depth   = 0;
        $quote   = null;
        $length  = \strlen($body);

        for ($i = 0; $i < $length; $i++) {
            $char = $body[$i];

            if ($quote !== null) {
                $current .= $char;

                if ($char === $quote) {
                    $quote = null;
                }

                continue;
            }

            if ($char === "'" || $char === '`') {
                $quote    = $char;
                $current .= $char;

                continue;
            }

            if ($char === '(') {
                $depth++;
            } elseif ($char === ')') {
                $depth--;
            } elseif ($char === ',' && $depth === 0) {
                $items[] = trim($current);
                $current = '';

                continue;
            }

            $current .= $char;
        }

        $items[] = trim($current);

        return array_values(array_filter($items, static fn (string $item): bool => $item !== ''));
    }
}
