<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 */

namespace JoomlaPlayground\Schema;

/**
 * The outcome of converting an SQL file: the statements to run and the AUTOINCREMENT positions to set afterwards.
 */
final readonly class ConversionResult
{
    /**
     * @param  string[]            $statements  SQLite statements, still with the #__ table prefix placeholder.
     * @param  array<string, int>  $sequences   Next id per table (table names with the #__ placeholder).
     */
    public function __construct(
        public array $statements,
        public array $sequences,
    ) {
    }

    /**
     * Renders the result as an SQL script. Sequence positions need the real table prefix, so they are added
     * as SQL for the given prefix.
     */
    public function toSql(string $prefix): string
    {
        $sql = implode(";\n\n", $this->statements) . ";\n";

        foreach ($this->sequences as $table => $next) {
            $sql .= "\n" . implode(";\n", self::sequenceStatements(str_replace('#__', $prefix, $table), $next)) . ";\n";
        }

        return $sql;
    }

    /**
     * SQL that makes the next AUTOINCREMENT id of a table equal to $next.
     *
     * @return string[]
     */
    public static function sequenceStatements(string $table, int $next): array
    {
        $name = PostgresqlToSqliteConverter::quote($table);

        return [
            'DELETE FROM sqlite_sequence WHERE name = ' . $name,
            'INSERT INTO sqlite_sequence (name, seq) VALUES (' . $name . ', ' . ($next - 1) . ')',
        ];
    }
}
