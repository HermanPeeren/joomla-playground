<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 */

namespace JoomlaPlayground\Database\MysqlOnSqlite;

use Joomla\Database\Mysql\MysqlQuery;

/**
 * Joomla's MySQL query builder, minus the syntax that WP_MySQL_On_SQLite 3.1.1 does not translate yet.
 */
class MysqlOnSqliteQuery extends MysqlQuery
{
    /**
     * The emulator passes GROUP_CONCAT(... SEPARATOR ...) to SQLite untranslated. Without SEPARATOR the default
     * comma applies, in MySQL as in SQLite.
     */
    public function groupConcat($expression, $separator = ',')
    {
        if ($separator === ',') {
            return 'GROUP_CONCAT(' . $expression . ')';
        }

        return parent::groupConcat($expression, $separator);
    }
}
