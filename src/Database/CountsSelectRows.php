<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 */

namespace JoomlaPlayground\Database;

/**
 * getNumRows() for drivers on SQLite.
 *
 * PDO's rowCount() is 0 for a SELECT on SQLite: SQLite only reports the rows changed by INSERT, UPDATE and DELETE.
 * Joomla counts grouped list queries this way (BaseDatabaseModel::_getListCount()), so count a SELECT's rows by
 * fetching them. The load*() methods execute the query again, so consuming the statement here is safe.
 */
trait CountsSelectRows
{
    public function getNumRows()
    {
        $this->connect();

        if (!$this->statement) {
            return 0;
        }

        if (!preg_match('/^\s*(SELECT|WITH|PRAGMA|VALUES|SHOW|DESCRIBE)\b/i', (string) $this->sql)) {
            return $this->statement->rowCount();
        }

        $rows = 0;

        while ($this->statement->fetch() !== false) {
            $rows++;
        }

        return $rows;
    }
}
