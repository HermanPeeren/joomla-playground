<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 */

namespace JoomlaPlayground\Database;

/**
 * PHP implementations of SQL functions that Joomla uses and SQLite does not have (or not in every version).
 */
final class SqliteFunctions
{
    /**
     * @return array<string, array{0: callable, 1: int}>  Function name => [callback, number of arguments (-1: variadic)].
     */
    public static function all(): array
    {
        return [
            // `x REGEXP y` calls regexp(y, x).
            'regexp'    => [self::regexp(...), 2],
            // Native since SQLite 3.44; Smart Search and the install SQL use them.
            'concat'    => [self::concat(...), -1],
            'concat_ws' => [self::concatWs(...), -1],
            // MySQL has SOUNDEX() built in; on PostgreSQL Joomla installs a PL/pgSQL soundex().
            'soundex'   => [self::soundex(...), 1],
        ];
    }

    /**
     * Case-insensitive regular expression match, as MySQL's REGEXP with a _ci collation and PostgreSQL's ~*.
     * Understands the [[:<:]] and [[:>:]] word boundaries that Joomla passes on non-MySQL databases.
     */
    public static function regexp(?string $pattern, ?string $value): ?int
    {
        if ($pattern === null || $value === null) {
            return null;
        }

        $pattern = str_replace(['[[:<:]]', '[[:>:]]'], '\b', $pattern);

        return @preg_match('/' . str_replace('/', '\/', $pattern) . '/iu', $value) === 1 ? 1 : 0;
    }

    public static function concat(...$values): string
    {
        return implode('', array_map(static fn ($value): string => (string) $value, $values));
    }

    public static function concatWs(?string $separator, ...$values): ?string
    {
        if ($separator === null) {
            return null;
        }

        return implode($separator, array_map(
            static fn ($value): string => (string) $value,
            array_filter($values, static fn ($value): bool => $value !== null)
        ));
    }

    public static function soundex(?string $value): ?string
    {
        return $value === null ? null : soundex($value);
    }
}
