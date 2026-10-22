<?php

namespace JoomlaPlayground\Tests\Unit\Database;

use JoomlaPlayground\Database\SqliteDriver;
use PHPUnit\Framework\TestCase;

/**
 * Runs the generated SQL against SQLite: the point is that it is valid and means what MySQL means.
 */
final class SqliteQueryTest extends TestCase
{
    private SqliteDriver $db;

    protected function setUp(): void
    {
        $this->db = new SqliteDriver(['database' => ':memory:', 'prefix' => 'jos_']);
    }

    private function selectOne(string $expression): mixed
    {
        return $this->db->setQuery($this->db->createQuery()->select($expression))->loadResult();
    }

    public function testDateAdd(): void
    {
        $query = $this->db->createQuery();
        $date  = $this->db->quote('2026-01-31 10:00:00');

        $this->assertSame('2026-02-01 10:00:00', $this->selectOne($query->dateAdd($date, 1, 'DAY')));
        $this->assertSame('2026-01-01 10:00:00', $this->selectOne($query->dateAdd($date, -30, 'DAY')));
        $this->assertSame('2026-01-30 10:00:00', $this->selectOne($query->dateAdd($date, '-1', 'DAY')));
        $this->assertSame('2026-02-14 10:00:00', $this->selectOne($query->dateAdd($date, 2, 'WEEK')));
        $this->assertSame('2026-01-31 08:00:00', $this->selectOne($query->dateAdd($date, -2, 'HOUR')));
        $this->assertSame('2027-01-31 10:00:00', $this->selectOne($query->dateAdd($date, 1, 'YEAR')));
        $this->assertSame('2026-02-03 10:00:00', $this->selectOne($query->dateAdd($date, '1 + 2', 'DAY')));
    }

    public function testDateParts(): void
    {
        $query = $this->db->createQuery();
        $date  = $this->db->quote('2026-03-04 05:06:07');

        $this->assertSame(
            [2026, 3, 4, 5, 6, 7],
            array_map(
                fn (string $part): int => (int) $this->selectOne($query->$part($date)),
                ['year', 'month', 'day', 'hour', 'minute', 'second']
            )
        );
    }

    public function testCurrentTimestamp(): void
    {
        $this->assertMatchesRegularExpression('/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/', $this->selectOne($this->db->createQuery()->currentTimestamp()));
    }

    public function testCasts(): void
    {
        $query = $this->db->createQuery();

        $this->assertSame('42:alias', $this->selectOne($query->concatenate([$query->castAs('CHAR', '42'), "'alias'"], ':')));
        $this->assertSame(7, $this->selectOne($query->castAs('INT', "'7'")));
        $this->assertSame('123', $this->selectOne($query->castAsChar('12345', 3)));
    }

    public function testRandomOrderIsValid(): void
    {
        $query = $this->db->createQuery()->select('1 AS x')->order($this->db->createQuery()->rand());

        $this->assertSame(1, $this->db->setQuery($query)->loadResult());
    }

    public function testRegexpUsesTheRegisteredFunction(): void
    {
        $query = $this->db->createQuery();

        $this->assertSame(1, (int) $this->selectOne("'banner keyword' " . $query->regexp("'[[:<:]]KEYWORD[[:>:]]'")));
    }

    public function testFindInSet(): void
    {
        $query = $this->db->createQuery();

        $this->assertSame(1, (int) $this->selectOne($query->findInSet('2', "'1,2,3'")));
        $this->assertSame(0, (int) $this->selectOne($query->findInSet('4', "'1,2,3'")));
    }

    /**
     * Joomla's non-MySQL path (AdminModel batch copy, Smart Search): unqualified SET columns plus a join.
     * The framework's INSERT OR REPLACE emulation would reset the columns that are not set.
     */
    public function testUpdateWithJoinUpdatesOnlyTheSetColumns(): void
    {
        $this->db->setQuery('CREATE TABLE `#__assets` (`id` INTEGER PRIMARY KEY, `name` TEXT, `rules` TEXT)')->execute();
        $this->db->setQuery("INSERT INTO `#__assets` VALUES (1, 'source', '{\"a\":1}'), (2, 'target', '{}')")->execute();

        $query = $this->db->createQuery()
            ->update($this->db->quoteName('#__assets', 't'))
            ->join('INNER', $this->db->quoteName('#__assets', 's'), $this->db->quoteName('s.id') . ' = 1')
            ->set($this->db->quoteName('rules') . ' = ' . $this->db->quoteName('s.rules'))
            ->where($this->db->quoteName('t.id') . ' = 2');

        $this->assertStringStartsWith('UPDATE', trim((string) $query));

        $this->db->setQuery($query)->execute();

        $this->assertSame(
            [['id' => 1, 'name' => 'source', 'rules' => '{"a":1}'], ['id' => 2, 'name' => 'target', 'rules' => '{"a":1}']],
            $this->db->setQuery('SELECT * FROM `#__assets` ORDER BY id')->loadAssocList()
        );
    }

    public function testSelectRowNumberUsesTheWindowFunction(): void
    {
        $this->db->setQuery('CREATE TABLE `#__items` (`id` INTEGER PRIMARY KEY, `ordering` INTEGER)')->execute();
        $this->db->setQuery('INSERT INTO `#__items` VALUES (1, 30), (2, 10), (3, 20)')->execute();

        $query = $this->db->createQuery()
            ->select($this->db->quoteName('id'))
            ->from($this->db->quoteName('#__items'))
            ->selectRowNumber($this->db->quoteName('ordering'), 'new_ordering');

        $this->assertSame(
            [2 => 1, 3 => 2, 1 => 3],
            array_map('intval', array_column($this->db->setQuery($query)->loadAssocList(), 'new_ordering', 'id'))
        );
    }

    public function testUnionAndLimit(): void
    {
        $first  = $this->db->createQuery()->select('1 AS x');
        $second = $this->db->createQuery()->select('2 AS x');

        $this->assertSame(['1', '2'], array_map('strval', $this->db->setQuery($first->union($second))->loadColumn()));

        $limited = $this->db->createQuery()->select('x')->from('(SELECT 1 AS x UNION ALL SELECT 2 UNION ALL SELECT 3) AS t')->order('x')->setLimit(1, 1);

        $this->assertSame(['2'], array_map('strval', $this->db->setQuery($limited)->loadColumn()));
    }
}
