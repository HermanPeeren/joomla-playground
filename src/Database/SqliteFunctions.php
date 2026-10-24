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

    /**
     * MySQL's TIME_FORMAT(time, format): only the hour, minute, second and microsecond specifiers.
     */
    public static function timeFormat(?string $time, ?string $format): ?string
    {
        if ($time === null || $format === null || !preg_match('/(\d{1,3}):(\d\d)(?::(\d\d)(?:\.(\d{1,6}))?)?\s*$/', $time, $match)) {
            return null;
        }

        [$hour, $minute, $second, $micro] = [(int) $match[1], (int) $match[2], (int) ($match[3] ?? 0), str_pad($match[4] ?? '', 6, '0')];
        $hour12 = $hour % 12 === 0 ? 12 : $hour % 12;

        return preg_replace_callback('/%(.)/', static fn (array $m): string => match ($m[1]) {
            'H'      => sprintf('%02d', $hour),
            'k'      => (string) $hour,
            'h', 'I' => sprintf('%02d', $hour12),
            'l'      => (string) $hour12,
            'i'      => sprintf('%02d', $minute),
            'S', 's' => sprintf('%02d', $second),
            'f'      => $micro,
            'p'      => $hour < 12 ? 'AM' : 'PM',
            'T'      => sprintf('%02d:%02d:%02d', $hour, $minute, $second),
            'r'      => sprintf('%02d:%02d:%02d %s', $hour12, $minute, $second, $hour < 12 ? 'AM' : 'PM'),
            default  => $m[1],
        }, $format);
    }

    public static function soundex(?string $value): ?string
    {
        return $value === null ? null : soundex($value);
    }

    /**
     * MySQL's FIND_IN_SET(str, strlist): the 1-based position of str in a comma-separated list, 0 when absent.
     * Compares case-insensitively, as with the utf8mb4_unicode_ci collation Joomla's tables use.
     */
    public static function findInSet($needle, $list): ?int
    {
        if ($needle === null || $list === null) {
            return null;
        }

        $needle = mb_strtolower((string) $needle);

        if ((string) $list === '' || str_contains($needle, ',')) {
            return 0;
        }

        $position = array_search($needle, array_map('mb_strtolower', explode(',', (string) $list)), true);

        return $position === false ? 0 : $position + 1;
    }

    /**
     * MySQL's CONVERT_TZ(dt, from_tz, to_tz) for offsets ('+05:30') and named zones ('Europe/Amsterdam').
     * Returns NULL for an invalid argument, as MySQL does.
     */
    public static function convertTz(?string $datetime, ?string $from, ?string $to): ?string
    {
        if ($datetime === null || $from === null || $to === null) {
            return null;
        }

        try {
            $date = new \DateTimeImmutable($datetime, new \DateTimeZone($from));
            $zone = new \DateTimeZone($to);
        } catch (\Exception) {
            return null;
        }

        return $date->setTimezone($zone)->format(str_contains($datetime, '.') ? 'Y-m-d H:i:s.u' : 'Y-m-d H:i:s');
    }

    /**
     * MySQL's JSON_UNQUOTE(json_val). SQLite's JSON_EXTRACT() already returns strings unquoted, so a value that is
     * not a JSON string literal is returned as it is.
     */
    public static function jsonUnquote($value): ?string
    {
        if ($value === null) {
            return null;
        }

        $value = (string) $value;

        if (\strlen($value) >= 2 && $value[0] === '"' && $value[-1] === '"') {
            $decoded = json_decode($value);

            if (\is_string($decoded)) {
                return $decoded;
            }
        }

        return $value;
    }
}
