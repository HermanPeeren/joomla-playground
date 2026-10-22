<?php

namespace JoomlaPlayground\Tests\Unit\Database;

use JoomlaPlayground\Database\SqliteDriver;
use JoomlaPlayground\Database\SqliteQuery;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class SqliteDriverTest extends TestCase
{
    private SqliteDriver $db;

    protected function setUp(): void
    {
        $this->db = new SqliteDriver(['database' => ':memory:', 'prefix' => 'jos_']);
        $this->db->setQuery(
            "CREATE TABLE `#__items` (`id` INTEGER PRIMARY KEY AUTOINCREMENT, `title` varchar(255) DEFAULT '' NOT NULL,"
            . " `note` text DEFAULT 'it''s', `hits` bigint DEFAULT 0 NOT NULL, `created` DATETIME)"
        )->execute();
    }

    public function testReportsItsOwnNameAndSqliteServerType(): void
    {
        // Saving the Global Configuration writes getName() back to configuration.php as $dbtype.
        $this->assertSame('playgroundsqlite', $this->db->getName());
        $this->assertSame('sqlite', $this->db->getServerType());
    }

    public function testCreatesPlaygroundQueries(): void
    {
        $this->assertInstanceOf(SqliteQuery::class, $this->db->createQuery());
    }

    public function testInsertObjectGeneratesAnIdForKeyZero(): void
    {
        $first  = (object) ['id' => 0, 'title' => 'first'];
        $second = (object) ['id' => '0', 'title' => 'second'];

        $this->db->insertObject('#__items', $first, 'id');
        $this->db->insertObject('#__items', $second, 'id');

        $this->assertSame([1, 2], [(int) $first->id, (int) $second->id]);
        $this->assertSame(['1', '2'], array_map('strval', $this->db->setQuery('SELECT id FROM #__items ORDER BY id')->loadColumn()));
    }

    public function testInsertObjectKeepsAnExplicitId(): void
    {
        $item = (object) ['id' => 42, 'title' => 'answer'];

        $this->db->insertObject('#__items', $item, 'id');

        $this->assertSame('answer', $this->db->setQuery('SELECT title FROM #__items WHERE id = 42')->loadResult());
    }

    /**
     * BaseDatabaseModel::_getListCount() counts grouped list queries with execute() and getNumRows().
     */
    public function testNumRowsCountsTheRowsOfASelect(): void
    {
        $this->db->setQuery("INSERT INTO `#__items` (`title`) VALUES ('a'), ('a'), ('b')")->execute();

        $this->assertSame(3, $this->db->getAffectedRows(), 'Affected rows of an INSERT');

        $query = $this->db->createQuery()->select('title, COUNT(*)')->from('#__items')->group('title');
        $this->db->setQuery($query)->execute();

        $this->assertSame(2, $this->db->getNumRows());
        $this->assertCount(2, $this->db->loadObjectList(), 'The rows can still be loaded afterwards');
    }

    public function testTableColumnsReportUnquotedDefaults(): void
    {
        $columns = $this->db->getTableColumns('#__items', false);

        $this->assertSame('', $columns['title']->Default);
        $this->assertSame("it's", $columns['note']->Default);
        $this->assertSame('0', $columns['hits']->Default);
        $this->assertNull($columns['created']->Default);
        $this->assertSame('PRI', $columns['id']->Key);
        $this->assertSame('NO', $columns['title']->Null);
        $this->assertSame(['id', 'title', 'note', 'hits', 'created'], array_keys($this->db->getTableColumns('#__items')));
    }

    public function testTableListHidesSqliteInternalTables(): void
    {
        $this->assertSame(['jos_items'], $this->db->getTableList());
    }

    public function testEscapeDoublesSingleQuotes(): void
    {
        $this->assertSame("it''s", $this->db->escape("it's"));
        $this->assertSame("'it''s'", $this->db->quote("it's"));
    }

    #[DataProvider('rawSql')]
    public function testRewritesRawPostgresqlStatements(string $sql, string $expected): void
    {
        $this->assertSame($expected, SqliteDriver::rewriteRawSql($sql));
    }

    public static function rawSql(): array
    {
        return [
            'vacuum table'  => ['VACUUM `#__finder_terms`', 'ANALYZE `#__finder_terms`'],
            'reindex table' => ['REINDEX TABLE `#__finder_terms`', 'REINDEX `#__finder_terms`'],
            'other'         => ['SELECT 1', 'SELECT 1'],
        ];
    }

    public function testFinderOptimizeStatementsRun(): void
    {
        $this->db->setQuery('VACUUM ' . $this->db->quoteName('#__items'))->execute();
        $this->db->setQuery('REINDEX TABLE ' . $this->db->quoteName('#__items'))->execute();

        $this->addToAssertionCount(1);
    }

    public function testRegistersMissingSqlFunctions(): void
    {
        $this->assertSame('ab1', $this->db->setQuery("SELECT CONCAT('a', 'b', 1)")->loadResult());
        $this->assertSame('a:b', $this->db->setQuery("SELECT CONCAT_WS(':', 'a', NULL, 'b')")->loadResult());
        $this->assertSame('R163', $this->db->setQuery("SELECT SOUNDEX('Robert')")->loadResult());
        $this->assertSame(1, (int) $this->db->setQuery("SELECT 'Joomla CMS' REGEXP '[[:<:]]cms[[:>:]]'")->loadResult());
        $this->assertSame(0, (int) $this->db->setQuery("SELECT 'JoomlaCMS' REGEXP '[[:<:]]cms[[:>:]]'")->loadResult());
    }

    public function testRelativeDatabasePathsAreLeftAloneOutsideJoomla(): void
    {
        $this->assertSame('data/joomla.sqlite', SqliteDriver::resolveDatabasePath('data/joomla.sqlite'));
        $this->assertSame(':memory:', SqliteDriver::resolveDatabasePath(':memory:'));
        $this->assertSame('C:/x/db.sqlite', SqliteDriver::resolveDatabasePath('C:/x/db.sqlite'));
        $this->assertSame('/x/db.sqlite', SqliteDriver::resolveDatabasePath('/x/db.sqlite'));
    }
}
