<?php

namespace JoomlaPlayground\Tests\Unit\Database;

use Joomla\Database\ParameterType;
use JoomlaPlayground\Database\MysqlOnSqlite\EmulatedPreparedStatement;
use JoomlaPlayground\Database\MysqlOnSqlite\MysqlOnSqliteDriver;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class MysqlOnSqliteDriverTest extends TestCase
{
    private MysqlOnSqliteDriver $db;

    protected function setUp(): void
    {
        $this->db = new MysqlOnSqliteDriver(['database' => ':memory:', 'prefix' => 'jos_']);
        $this->db->setQuery(
            'CREATE TABLE IF NOT EXISTS `#__items` ('
            . ' `id` int unsigned NOT NULL AUTO_INCREMENT,'
            . " `title` varchar(255) NOT NULL DEFAULT '',"
            . ' `hits` int unsigned NOT NULL DEFAULT 0,'
            . ' `created` datetime NOT NULL,'
            . ' PRIMARY KEY (`id`),'
            . ' KEY `idx_title` (`title`(100))'
            . ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 DEFAULT COLLATE=utf8mb4_unicode_ci'
        )->execute();
    }

    public function testIsAMysqlServerForJoomla(): void
    {
        $this->assertSame('mysqlonsqlite', $this->db->getName());
        $this->assertSame('mysql', $this->db->getServerType());
        $this->assertStringStartsWith('8.0.38', $this->db->getVersion());
        $this->assertTrue($this->db->hasUTF8mb4Support());
    }

    public function testBoundQueriesAndMysqlSemantics(): void
    {
        $item = (object) ['id' => 0, 'title' => "O'Reilly \\ Joomla", 'created' => '2026-10-22 12:00:00'];
        $this->db->insertObject('#__items', $item, 'id');

        $this->assertSame(1, (int) $item->id, 'An id of 0 gets the next AUTO_INCREMENT value, as in MySQL');

        $title = "o'reilly \\ joomla";
        $query = $this->db->createQuery()
            ->select('id, title')
            ->from('#__items')
            ->where('title = :title')
            ->whereIn('id', [1, 2])
            ->bind(':title', $title);

        $row = $this->db->setQuery($query)->loadObject();

        $this->assertSame("O'Reilly \\ Joomla", $row->title, 'Values round-trip, and comparison is case-insensitive like utf8mb4_unicode_ci');
    }

    public function testMysqlSpecificSql(): void
    {
        $this->db->setQuery("INSERT INTO `#__items` (`id`, `title`, `created`) VALUES (5, 'a', NOW())")->execute();
        $this->db->setQuery("INSERT INTO `#__items` (`id`, `title`, `created`) VALUES (5, 'b', NOW()) ON DUPLICATE KEY UPDATE `hits` = `hits` + 1")->execute();

        $this->assertSame(['5', 'a', '1'], array_map('strval', array_values($this->db->setQuery('SELECT id, title, hits FROM `#__items`')->loadAssoc())));
        $this->assertSame('2026-01-31', $this->db->setQuery("SELECT DATE(DATE_ADD('2026-01-30 10:00:00', INTERVAL 1 DAY))")->loadResult());
        $this->assertSame(['jos_items'], $this->db->getTableList());
        $this->assertSame(['id', 'title', 'hits', 'created'], array_keys($this->db->getTableColumns('#__items')));
    }

    /**
     * MySQL functions and syntax the emulator lacks (3.1.1), worked around by the driver and its query class.
     */
    public function testWorkaroundsForEmulatorGaps(): void
    {
        $this->assertSame('09:00 AM', $this->db->setQuery("SELECT TIME_FORMAT('2026-10-22 09:05:07', '%h:00 %p')")->loadResult());
        $this->assertSame('a:b', $this->db->setQuery("SELECT CONCAT_WS(':', 'a', NULL, 'b')")->loadResult());
        $this->assertSame('R163', $this->db->setQuery("SELECT SOUNDEX('Robert')")->loadResult());
        $this->assertSame('', $this->db->getConnectionEncryption());

        $this->db->setQuery("INSERT INTO `#__items` (`title`, `created`) VALUES ('a', NOW()), ('b', NOW())")->execute();
        $query = $this->db->createQuery();
        $query->select($query->groupConcat($query->castAs('CHAR', 'title')))->from('#__items');

        $this->assertSame('a,b', $this->db->setQuery($query)->loadResult());
    }

    public function testNumRowsCountsTheRowsOfASelect(): void
    {
        $this->db->setQuery("INSERT INTO `#__items` (`title`, `created`) VALUES ('a', NOW()), ('a', NOW()), ('b', NOW())")->execute();
        $this->db->setQuery('SELECT title, COUNT(*) FROM `#__items` GROUP BY title')->execute();

        $this->assertSame(2, $this->db->getNumRows());
    }

    #[DataProvider('placeholders')]
    public function testInlinesPlaceholdersOutsideQuotesAndComments(string $sql, array $bindings, string $expected): void
    {
        $pdo = new \WP_MySQL_On_SQLite('mysql-on-sqlite:path=:memory:;dbname=test');

        $this->assertSame($expected, EmulatedPreparedStatement::inline($sql, $bindings, $pdo));
    }

    public static function placeholders(): array
    {
        $string  = static fn (mixed $value): array => ['value' => $value, 'type' => ParameterType::STRING];
        $integer = static fn (mixed $value): array => ['value' => $value, 'type' => ParameterType::INTEGER];

        return [
            'named'                    => ['SELECT :a, :b', [':a' => $string('x'), ':b' => $integer('7abc')], "SELECT 'x', 7"],
            'quoted string with :name' => ["SELECT ':a', \":a\", `:a`, :a", [':a' => $string('y')], "SELECT ':a', \":a\", `:a`, 'y'"],
            'escaped quote in string'  => ["SELECT 'it\\'s :a', :a", [':a' => $string('z')], "SELECT 'it\\'s :a', 'z'"],
            'comments'                 => ["SELECT 1 -- :a\n, :a /* :a */", [':a' => $string('q')], "SELECT 1 -- :a\n, 'q' /* :a */"],
            'prefix of a longer name'  => ['SELECT :a1, :a', [':a' => $string('s'), ':a1' => $string('t')], "SELECT 't', 's'"],
            'unbound stays'            => ['SELECT :unbound', [':a' => $string('s')], 'SELECT :unbound'],
            'null and boolean'         => ['SELECT :n, :b', [':n' => $string(null), ':b' => ['value' => true, 'type' => ParameterType::BOOLEAN]], 'SELECT NULL, 1'],
            'quote and backslash'      => ['SELECT :a', [':a' => $string("a'b\\c")], "SELECT 'a\\'b\\\\c'"],
            'positional'               => ['SELECT ?, ?', [1 => $string('x'), 2 => $integer(3)], "SELECT 'x', 3"],
        ];
    }
}
