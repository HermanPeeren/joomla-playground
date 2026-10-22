<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 */

namespace JoomlaPlayground\Database;

use Joomla\Database\DatabaseQuery;
use Joomla\Database\Sqlite\SqliteQuery as FrameworkSqliteQuery;

/**
 * SQLite query builder for the Joomla CMS.
 *
 * Fills in what the Joomla Framework's SqliteQuery leaves to the MySQL-flavoured defaults of DatabaseQuery
 * (dates, random order, regular expressions, casts) and replaces two emulations with native SQLite:
 * - UPDATE ... JOIN becomes UPDATE ... FROM (SQLite 3.33+), the form Joomla also uses for PostgreSQL.
 *   The framework's INSERT OR REPLACE emulation deletes and re-inserts rows, which loses data.
 * - selectRowNumber() uses the ROW_NUMBER() window function (SQLite 3.25+).
 */
class SqliteQuery extends FrameworkSqliteQuery
{
    /**
     * Interval units of MySQL's DATE_ADD() and their SQLite date modifier, with a multiplier.
     */
    private const DATE_UNITS = [
        'MICROSECOND' => ['seconds', 0.000001],
        'SECOND'      => ['seconds', 1],
        'MINUTE'      => ['minutes', 1],
        'HOUR'        => ['hours', 1],
        'DAY'         => ['days', 1],
        'WEEK'        => ['days', 7],
        'MONTH'       => ['months', 1],
        'QUARTER'     => ['months', 3],
        'YEAR'        => ['years', 1],
    ];

    public function __toString()
    {
        if ($this->sql) {
            return $this->processLimit($this->sql, $this->limit, $this->offset);
        }

        if ($this->type === 'update' && $this->join) {
            return $this->updateFrom();
        }

        if ($this->type === 'select' && $this->selectRowNumber) {
            return DatabaseQuery::__toString();
        }

        return parent::__toString();
    }

    public function selectRowNumber($orderBy, $orderColumnAlias)
    {
        $this->validateRowNumber($orderBy, $orderColumnAlias);

        return $this->select("ROW_NUMBER() OVER (ORDER BY $orderBy) AS $orderColumnAlias");
    }

    public function castAs(string $type, string $value, ?string $length = null)
    {
        return match (strtoupper($type)) {
            'CHAR'  => 'CAST(' . $value . ' AS TEXT)',
            'INT'   => 'CAST(' . $value . ' AS INTEGER)',
            default => parent::castAs($type, $value, $length),
        };
    }

    public function castAsChar($value, $len = null)
    {
        return $len ? 'substr(CAST(' . $value . ' AS TEXT), 1, ' . (int) $len . ')' : 'CAST(' . $value . ' AS TEXT)';
    }

    public function currentTimestamp()
    {
        return 'CURRENT_TIMESTAMP';
    }

    /**
     * MySQL: DATE_ADD(date, INTERVAL interval datePart). The interval may be negative.
     */
    public function dateAdd($date, $interval, $datePart)
    {
        [$unit, $multiplier] = self::DATE_UNITS[strtoupper($datePart)]
            ?? throw new \InvalidArgumentException('Unsupported date part for dateAdd(): ' . $datePart);

        if (is_numeric($interval)) {
            $amount = $interval * $multiplier;

            return 'datetime(' . $date . ', ' . $this->quote(\sprintf('%+g %s', $amount, $unit)) . ')';
        }

        // An SQL expression: build the modifier at runtime.
        return 'datetime(' . $date . ', ((' . $interval . ') * ' . $multiplier . ") || ' " . $unit . "')";
    }

    public function year($date)
    {
        return $this->datePart('%Y', $date);
    }

    public function month($date)
    {
        return $this->datePart('%m', $date);
    }

    public function day($date)
    {
        return $this->datePart('%d', $date);
    }

    public function hour($date)
    {
        return $this->datePart('%H', $date);
    }

    public function minute($date)
    {
        return $this->datePart('%M', $date);
    }

    public function second($date)
    {
        return $this->datePart('%S', $date);
    }

    public function rand()
    {
        return ' RANDOM() ';
    }

    /**
     * Uses the regexp() function that SqliteDriver registers.
     */
    public function regexp($value)
    {
        return ' REGEXP ' . $value;
    }

    public function findInSet($value, $set)
    {
        return " (',' || " . $set . " || ',') LIKE ('%,' || " . $value . " || ',%') ";
    }

    private function datePart(string $format, string $date): string
    {
        return "CAST(strftime('" . $format . "', " . $date . ') AS INTEGER)';
    }

    /**
     * UPDATE table SET ... FROM joined tables WHERE join conditions AND where conditions.
     */
    private function updateFrom(): string
    {
        $query = (string) $this->update . (string) $this->set;

        $savedFrom   = $this->from;
        $savedWhere  = $this->where ? clone $this->where : null;
        $this->from  = null;

        try {
            foreach ($this->join as $join) {
                $elements = $join->getElements();

                $this->from($elements[0]);

                if (isset($elements[1])) {
                    $this->where($elements[1]);
                }
            }

            $query .= (string) $this->from;

            if ($this->where) {
                $query .= (string) $this->where;
            }
        } finally {
            $this->from  = $savedFrom;
            $this->where = $savedWhere;
        }

        return $query;
    }
}
