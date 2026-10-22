<?php

namespace JoomlaPlayground\Tests\Unit\Schema;

use JoomlaPlayground\Schema\ConversionResult;
use JoomlaPlayground\Schema\PostgresqlToSqliteConverter;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class PostgresqlToSqliteConverterTest extends TestCase
{
    private PostgresqlToSqliteConverter $converter;

    protected function setUp(): void
    {
        $this->converter = new PostgresqlToSqliteConverter();
    }

    public function testSplitsStatementsAndDropsComments(): void
    {
        $sql = "-- a comment; with a semicolon\nSELECT 1;\n/* block; comment */\nSELECT 'a;b';";

        $this->assertSame(['SELECT 1', "SELECT 'a;b'"], $this->converter->splitStatements($sql));
    }

    public function testDoubleQuotedIdentifiersBecomeBackticks(): void
    {
        $this->assertSame(['SELECT `id` FROM `#__users`'], $this->converter->splitStatements('SELECT "id" FROM "#__users"'));
    }

    /**
     * Joomla runs PostgreSQL with standard_conforming_strings = off: backslashes escape.
     */
    #[DataProvider('stringLiterals')]
    public function testDecodesPostgresqlStringLiterals(string $postgresql, string $sqlite): void
    {
        $this->assertSame(['SELECT ' . $sqlite], $this->converter->splitStatements('SELECT ' . $postgresql));
    }

    public static function stringLiterals(): array
    {
        return [
            'plain'                  => ["'abc'", "'abc'"],
            'doubled quote'          => ["'it''s'", "'it''s'"],
            'backslash quote'        => ["'it\\'s'", "'it''s'"],
            'escaped backslashes'    => ["'\\\\\\\\Joomla\\\\\\\\CMS'", "'\\\\Joomla\\\\CMS'"],
            'newline escape'         => ["'a\\nb'", "'a\nb'"],
            'double quotes in value' => ["'{\"a\":1}'", "'{\"a\":1}'"],
        ];
    }

    public function testKeepsDollarQuotedBodiesTogetherAndDropsFunctions(): void
    {
        $sql = "CREATE OR REPLACE FUNCTION f() RETURNS text AS \$\$ BEGIN RETURN 'x'; END; \$\$ LANGUAGE plpgsql;\nSELECT 1;";

        $this->assertCount(2, $this->converter->splitStatements($sql));
        $this->assertSame(['SELECT 1'], $this->converter->convert($sql)->statements);
    }

    public function testDropsCommentOnStatements(): void
    {
        $result = $this->converter->convert("COMMENT ON COLUMN \"#__a\".\"id\" IS 'Primary Key';");

        $this->assertSame([], $result->statements);
    }

    public function testSerialPrimaryKeyBecomesAutoincrement(): void
    {
        $sql = <<<'SQL'
            CREATE TABLE IF NOT EXISTS "#__assets" (
              "id" serial NOT NULL,
              "name" varchar(50) NOT NULL,
              "created" timestamp without time zone NOT NULL,
              "price" numeric(10,2) DEFAULT 0 NOT NULL,
              "data" bytea,
              PRIMARY KEY ("id"),
              CONSTRAINT "#__assets_idx_asset_name" UNIQUE ("name")
            );
            SQL;

        $this->assertSame(
            "CREATE TABLE IF NOT EXISTS `#__assets` (\n"
            . "  `id` INTEGER PRIMARY KEY AUTOINCREMENT,\n"
            . "  `name` varchar(50) NOT NULL,\n"
            . "  `created` DATETIME NOT NULL,\n"
            . "  `price` numeric(10,2) DEFAULT 0 NOT NULL,\n"
            . "  `data` BLOB,\n"
            . "  CONSTRAINT `#__assets_idx_asset_name` UNIQUE (`name`)\n"
            . ')',
            $this->converter->convert($sql)->statements[0]
        );
    }

    public function testCompositePrimaryKeyIsKept(): void
    {
        $sql = 'CREATE TABLE "#__map" ("a" bigint NOT NULL, "b" bigint NOT NULL, CONSTRAINT "#__map_pk" PRIMARY KEY ("a", "b"));';

        $this->assertStringContainsString('PRIMARY KEY (`a`, `b`)', $this->converter->convert($sql)->statements[0]);
    }

    public function testSetvalBecomesASequencePosition(): void
    {
        $sql = <<<'SQL'
            CREATE TABLE "#__update_sites" ("update_site_id" serial NOT NULL, PRIMARY KEY ("update_site_id"));
            SELECT setval('#__update_sites_update_site_id_seq', 5, false);
            SQL;

        $result = $this->converter->convert($sql);

        $this->assertCount(1, $result->statements);
        $this->assertSame(['#__update_sites' => 5], $result->sequences);
    }

    public function testSetvalForAnUnknownSequenceFails(): void
    {
        $this->expectException(\RuntimeException::class);

        $this->converter->convert("SELECT setval('#__nope_id_seq', 5, false);");
    }

    public function testConvertsSchedulerDateExpressions(): void
    {
        $converted = $this->converter->convertDateExpressions(
            "SELECT CONCAT('x', TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'FMDD'), TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'HH24:00')),"
            . " TO_TIMESTAMP(TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'UTC' + INTERVAL '30 days', 'YYYY-MM-DD HH24:00:00'), 'YYYY-MM-DD HH24:MI:SS'),"
            . " CURRENT_TIMESTAMP AT TIME ZONE 'UTC'"
        );

        $this->assertSame(
            "SELECT CONCAT('x', CAST(CAST(strftime('%d', 'now') AS INTEGER) AS TEXT), strftime('%H:00', 'now')),"
            . " strftime('%Y-%m-%d %H:00:00', 'now', '+30 days'),"
            . ' CURRENT_TIMESTAMP',
            $converted
        );
    }

    public function testSequenceStatementsSetTheNextId(): void
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');

        foreach (ConversionResult::sequenceStatements('t', 100) as $statement) {
            $pdo->exec($statement);
        }

        $pdo->exec("INSERT INTO t (v) VALUES ('x')");

        $this->assertSame('100', (string) $pdo->lastInsertId());
    }
}
