<?php

namespace JoomlaPlayground\Tests\Integration;

use PHPUnit\Framework\Attributes\DataProvider;

/**
 * Every main administrator view loads on SQLite without database errors.
 */
final class AdministratorPagesTest extends IntegrationTestCase
{
    #[DataProvider('views')]
    public function testViewLoads(string $query): void
    {
        $this->assertPageOk(self::admin()->get('administrator/index.php?' . $query));
    }

    public static function views(): array
    {
        $views = [
            'option=com_cpanel',
            'option=com_content&view=articles',
            'option=com_content&view=featured',
            'option=com_categories&view=categories&extension=com_content',
            'option=com_fields&view=fields&context=com_content.article',
            'option=com_media',
            'option=com_menus&view=menus',
            'option=com_menus&view=items&menutype=mainmenu',
            'option=com_modules&view=modules&client_id=0',
            'option=com_modules&view=modules&client_id=1',
            'option=com_plugins&view=plugins',
            'option=com_users&view=users',
            'option=com_users&view=groups',
            'option=com_users&view=levels',
            'option=com_users&view=notes',
            'option=com_banners&view=banners',
            'option=com_banners&view=clients',
            'option=com_banners&view=tracks',
            'option=com_contact&view=contacts',
            'option=com_newsfeeds&view=newsfeeds',
            'option=com_tags&view=tags',
            'option=com_finder&view=index',
            'option=com_finder&view=maps',
            'option=com_finder&view=searches',
            'option=com_associations&view=associations',
            'option=com_guidedtours&view=tours',
            'option=com_workflow&view=workflows&extension=com_content.article',
            'option=com_scheduler&view=tasks',
            'option=com_actionlogs&view=actionlogs',
            'option=com_privacy&view=requests',
            'option=com_privacy&view=consents',
            'option=com_messages&view=messages',
            'option=com_mails&view=templates',
            'option=com_languages&view=installed',
            'option=com_languages&view=overrides',
            'option=com_templates&view=styles&client_id=0',
            'option=com_templates&view=templates&client_id=0',
            'option=com_installer&view=manage',
            'option=com_installer&view=database',
            'option=com_installer&view=discover',
            'option=com_installer&view=warnings',
            'option=com_checkin',
            'option=com_cache',
            'option=com_admin&view=sysinfo',
            'option=com_config',
            'option=com_postinstall',
            // Opened as a modal by the article edit form.
            'option=com_contenthistory&view=history&layout=modal&tmpl=component&item_id=com_content.article.1',
        ];

        return array_combine($views, array_map(static fn (string $view): array => [$view], $views));
    }

    /**
     * Redirect shows an error-type notice while its system plugin is disabled, as it is after installation.
     */
    public function testRedirectViewLoads(): void
    {
        $page = self::admin()->get('administrator/index.php?option=com_redirect&view=links');

        $this->assertSame(200, $page->status);
        $this->assertSame(
            ['The Redirect System Plugin is disabled. It needs to be enabled for this component to work.'],
            $page->errors()
        );
    }

    public function testDatabaseCheckReportsNoProblems(): void
    {
        $page = self::admin()->get('administrator/index.php?option=com_installer&view=database');

        $this->assertPageOk($page);
        $this->assertStringNotContainsString('Database table structure not up to date', $page->body);
    }

    public function testSystemInformationShowsTheDriver(): void
    {
        $page = self::admin()->get('administrator/index.php?option=com_admin&view=sysinfo');

        $this->assertStringContainsString('playgroundsqlite', $page->body);
    }
}
