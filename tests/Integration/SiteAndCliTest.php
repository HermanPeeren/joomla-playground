<?php

namespace JoomlaPlayground\Tests\Integration;

use JoomlaPlayground\Tests\Integration\Support\HttpClient;

/**
 * Site pages, Smart Search, the scheduler and the Joomla CLI.
 */
final class SiteAndCliTest extends IntegrationTestCase
{
    public function testHomePage(): void
    {
        $page = (new HttpClient(self::$site->url))->get('index.php');

        $this->assertPageOk($page);
        $this->assertSame('Home', $page->title());
    }

    public function testLoginPage(): void
    {
        $this->assertPageOk((new HttpClient(self::$site->url))->get('index.php?option=com_users&view=login'));
    }

    public function testSiteLoginAndLogout(): void
    {
        $client = new HttpClient(self::$site->url);
        $form   = $client->get('index.php?option=com_users&view=login');

        $profile = $client->post('index.php?option=com_users&task=user.login', [
            'username'     => self::$site->username,
            'password'     => self::$site->password,
            'return'       => base64_encode('index.php?option=com_users&view=profile'),
            $form->token() => '1',
        ]);

        $this->assertPageOk($profile);
        $this->assertStringContainsString(self::$site->username, $profile->body);
        $this->assertGreaterThan(0, \count(self::query('SELECT * FROM jos_session WHERE guest = 0 AND client_id = 0')));
    }

    public function testCliListsUsers(): void
    {
        [$exitCode, $output] = self::$site->cli('user:list');

        $this->assertSame(0, $exitCode, $output);
        $this->assertStringContainsString(self::$site->username, $output);
    }

    public function testCliListsExtensions(): void
    {
        [$exitCode, $output] = self::$site->cli('extension:list', '--type=component');

        $this->assertSame(0, $exitCode, $output);
        $this->assertStringContainsString('com_content', $output);
    }

    /**
     * The indexer uses UPDATE ... JOIN, SOUNDEX and the VACUUM/REINDEX optimize step.
     */
    public function testSmartSearchIndexAndSearch(): void
    {
        $this->createArticle('Indexed in SQLite', 'A playground article about marmalade.');

        [$exitCode, $output] = self::$site->cli('finder:index', '--minproctime=1');

        $this->assertSame(0, $exitCode, $output);
        $this->assertGreaterThan(0, (int) self::query('SELECT COUNT(*) AS n FROM jos_finder_links')[0]['n'], 'Links indexed');

        $page = (new HttpClient(self::$site->url))->get('index.php?option=com_finder&view=search&q=marmalade');

        $this->assertPageOk($page);
        $this->assertStringContainsString('Indexed in SQLite', $page->body);
    }

    public function testSchedulerRunsSessionGarbageCollection(): void
    {
        $id = (int) self::query("SELECT id FROM jos_scheduler_tasks WHERE type = 'session.gc'")[0]['id'];

        [$exitCode, $output] = self::$site->cli('scheduler:run', '--id=' . $id);

        $this->assertSame(0, $exitCode, $output);
        $this->assertNotNull(self::query('SELECT last_execution FROM jos_scheduler_tasks WHERE id = ?', [$id])[0]['last_execution']);
    }

    private function createArticle(string $title, string $text): void
    {
        $admin = self::admin();
        $form  = $admin->get('administrator/index.php?option=com_content&task=article.add');

        $this->assertPageOk($admin->post('administrator/index.php?option=com_content&layout=edit&id=0', [
            'jform'        => [
                'title'       => $title,
                'catid'       => 2,
                'state'       => 1,
                'access'      => 1,
                'language'    => '*',
                'articletext' => '<p>' . $text . '</p>',
                // Smart Search only finds items published before the current minute.
                'publish_up'  => gmdate('Y-m-d H:i:s', time() - 3600),
            ],
            'task'         => 'article.save',
            $form->token() => '1',
        ]));
    }
}
