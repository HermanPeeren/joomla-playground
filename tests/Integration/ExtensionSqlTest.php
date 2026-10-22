<?php

namespace JoomlaPlayground\Tests\Integration;

/**
 * Many third-party extensions only ship MySQL install SQL (<file driver="mysql">). Joomla's installer skips SQL
 * files for other server types without a warning, so on the SQLite driver such an extension installs without its
 * tables. The MySQL emulation runs the MySQL SQL as it is.
 */
final class ExtensionSqlTest extends IntegrationTestCase
{
    public function testExtensionWithMysqlOnlySql(): void
    {
        $admin = self::admin();
        $form  = $admin->get('administrator/index.php?option=com_installer&view=install');

        $installed = $admin->post('administrator/index.php?option=com_installer&view=install', [
            'installtype'       => 'folder',
            'install_directory' => realpath(__DIR__ . '/../fixtures/com_playgroundtest'),
            'task'              => 'install.install',
            $form->token()      => '1',
        ]);

        $this->assertPageOk($installed);
        $this->assertContains('Installation of the component was successful.', array_column($installed->messages(), 'message'));

        $tableExists = (bool) self::query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'jos_playgroundtest_items'")[0]['n'];

        if (self::$site->driver === 'mysqlonsqlite') {
            $this->assertTrue($tableExists, 'The MySQL install SQL ran');
            $this->assertSame('First item', self::query('SELECT title FROM jos_playgroundtest_items')[0]['title']);
        } else {
            $this->assertFalse($tableExists, 'Known limitation of the SQLite driver: MySQL-only extension SQL is skipped');
        }
    }
}
