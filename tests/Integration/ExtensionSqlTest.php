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
        // Copy the fixture into the site, where PHP can see it in either runtime.
        self::copyTree(__DIR__ . '/../fixtures/com_playgroundtest', self::$site->root . '/tmp/com_playgroundtest');

        $admin = self::admin();
        $form  = $admin->get('administrator/index.php?option=com_installer&view=install');

        $installed = $admin->post('administrator/index.php?option=com_installer&view=install', [
            'installtype'       => 'folder',
            'install_directory' => self::$site->sitePath('tmp/com_playgroundtest'),
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

    private static function copyTree(string $source, string $target): void
    {
        $items = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($source, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::SELF_FIRST
        );

        is_dir($target) || mkdir($target, 0755, true);

        foreach ($items as $item) {
            $path = $target . '/' . substr($item->getPathname(), \strlen($source) + 1);
            $item->isDir() ? (is_dir($path) || mkdir($path, 0755, true)) : copy($item->getPathname(), $path);
        }
    }
}
