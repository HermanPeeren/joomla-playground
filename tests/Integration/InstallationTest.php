<?php

namespace JoomlaPlayground\Tests\Integration;

/**
 * The installed database looks like a regular Joomla installation.
 */
final class InstallationTest extends IntegrationTestCase
{
    public function testAllTablesAreCreated(): void
    {
        $tables = array_column(self::query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'jos\\_%' ESCAPE '\\'"), 'name');

        // installation/sql/postgresql creates 76 tables in Joomla 6.2.
        $this->assertGreaterThanOrEqual(76, \count($tables));
        $this->assertContains('jos_content', $tables);
        $this->assertContains('jos_finder_terms', $tables);
    }

    public function testConfigurationUsesThePlaygroundDriver(): void
    {
        $configuration = file_get_contents(self::$site->root . '/configuration.php');

        $this->assertStringContainsString("public \$dbtype = 'playgroundsqlite';", $configuration);
        $this->assertStringContainsString("public \$db = 'data/joomla.sqlite';", $configuration);
        $this->assertDirectoryDoesNotExist(self::$site->root . '/installation');
    }

    public function testSuperUserIsCreated(): void
    {
        $users = self::query(
            'SELECT u.id, u.username, m.group_id FROM jos_users u JOIN jos_user_usergroup_map m ON m.user_id = u.id'
        );

        $this->assertCount(1, $users);
        $this->assertSame('admin', $users[0]['username']);
        $this->assertSame(8, (int) $users[0]['group_id']);
    }

    public function testSchemaVersionAndManifestCachesAreSet(): void
    {
        $schema = self::query(
            "SELECT s.version_id FROM jos_schemas s JOIN jos_extensions e ON e.extension_id = s.extension_id WHERE e.name = 'files_joomla'"
        );

        $this->assertMatchesRegularExpression('/^\d+\.\d+\.\d+-\d{4}-\d\d-\d\d$/', $schema[0]['version_id']);

        $empty = self::query("SELECT COUNT(*) AS n FROM jos_extensions WHERE manifest_cache = '' OR manifest_cache IS NULL");

        $this->assertSame(0, (int) $empty[0]['n']);
    }

    public function testJsonValuesKeepTheirBackslashes(): void
    {
        $params = self::query("SELECT params FROM jos_extensions WHERE name = 'plg_fields_editor'")[0]['params'];

        $this->assertSame('\\Joomla\\CMS\\Component\\ComponentHelper::filterText', json_decode($params, true)['filter']);
    }

    public function testSequencesContinueAfterTheInstalledRows(): void
    {
        $next = self::query("SELECT seq FROM sqlite_sequence WHERE name = 'jos_menu'")[0]['seq'];

        $this->assertGreaterThanOrEqual(101, (int) $next);
    }
}
