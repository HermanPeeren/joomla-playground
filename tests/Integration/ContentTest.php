<?php

namespace JoomlaPlayground\Tests\Integration;

use PHPUnit\Framework\Attributes\Depends;

/**
 * Article life cycle in the administrator and on the site. Each test builds on the previous one.
 */
final class ContentTest extends IntegrationTestCase
{
    private const TITLE = 'Hello from SQLite';

    public function testCreateArticle(): int
    {
        $admin = self::admin();
        $form  = $admin->get('administrator/index.php?option=com_content&task=article.add');

        $saved = $admin->post('administrator/index.php?option=com_content&layout=edit&id=0', [
            'jform'       => [
                'title'       => self::TITLE,
                'alias'       => '',
                'catid'       => 2,
                'state'       => 1,
                'access'      => 1,
                'language'    => '*',
                'featured'    => 1,
                'articletext' => '<p>This article is stored in SQLite. Playground keyword: zanzibar.</p>',
            ],
            'task'        => 'article.save',
            $form->token() => '1',
        ]);

        $this->assertPageOk($saved);
        $this->assertContains('Article saved.', array_column($saved->messages(), 'message'));

        $rows = self::query('SELECT id, asset_id, alias FROM jos_content WHERE title = ?', [self::TITLE]);

        $this->assertCount(1, $rows);
        $this->assertGreaterThan(0, (int) $rows[0]['id']);
        $this->assertSame('hello-from-sqlite', $rows[0]['alias']);

        $id = (int) $rows[0]['id'];

        $this->assertSame(
            'com_content.article.' . $id,
            self::query('SELECT name FROM jos_assets WHERE id = ?', [$rows[0]['asset_id']])[0]['name']
        );
        $this->assertCount(1, self::query("SELECT * FROM jos_workflow_associations WHERE item_id = ? AND extension = 'com_content.article'", [$id]));
        $this->assertCount(1, self::query('SELECT * FROM jos_content_frontpage WHERE content_id = ?', [$id]));

        return $id;
    }

    #[Depends('testCreateArticle')]
    public function testArticleShowsOnTheSite(int $id): int
    {
        $client = new \JoomlaPlayground\Tests\Integration\Support\HttpClient(self::$site->url);

        $home = $client->get('index.php');
        $this->assertPageOk($home);
        $this->assertStringContainsString(self::TITLE, $home->body, 'Featured article on the home page');

        $article = $client->get('index.php?option=com_content&view=article&id=' . $id . '&catid=2');
        $this->assertPageOk($article);
        $this->assertStringContainsString('Playground keyword: zanzibar', $article->body);

        $category = $client->get('index.php?option=com_content&view=category&id=2');
        $this->assertPageOk($category);
        $this->assertStringContainsString(self::TITLE, $category->body);

        $this->assertSame(1, (int) self::query('SELECT hits FROM jos_content WHERE id = ?', [$id])[0]['hits']);

        return $id;
    }

    #[Depends('testArticleShowsOnTheSite')]
    public function testEditArticleCreatesAVersion(int $id): int
    {
        $admin = self::admin();
        $form  = $admin->get('administrator/index.php?option=com_content&task=article.edit&id=' . $id);

        $this->assertPageOk($form);

        $pairs = array_values(array_filter(
            $form->formFields('item-form'),
            static fn (array $pair): bool => !\in_array($pair[0], ['jform[title]', 'task'], true)
        ));
        $pairs[] = ['jform[title]', self::TITLE . ' (edited)'];
        $pairs[] = ['task', 'article.save'];

        $saved = $admin->post('administrator/index.php?option=com_content&layout=edit&id=' . $id, $pairs);

        $this->assertPageOk($saved);
        $this->assertSame(self::TITLE . ' (edited)', self::query('SELECT title FROM jos_content WHERE id = ?', [$id])[0]['title']);
        $this->assertGreaterThanOrEqual(2, \count(self::query("SELECT * FROM jos_history WHERE item_id = ?", ['com_content.article.' . $id])));
        $this->assertNull(self::query('SELECT checked_out FROM jos_content WHERE id = ?', [$id])[0]['checked_out'], 'Checked in after saving');

        return $id;
    }

    /**
     * AdminModel::batchCopy() copies asset rules with UPDATE ... JOIN, rendered as UPDATE ... FROM.
     */
    #[Depends('testEditArticleCreatesAVersion')]
    public function testBatchCopy(int $id): int
    {
        $admin = self::admin();
        $list  = $admin->get('administrator/index.php?option=com_content&view=articles');

        $copied = $admin->post('administrator/index.php?option=com_content&view=articles', [
            'cid'           => [$id],
            'batch'         => ['category_id' => 2, 'move_copy' => 'c', 'assetgroup_id' => '', 'language_id' => '', 'tag' => '', 'workflowstage_id' => ''],
            'task'          => 'article.batch',
            'boxchecked'    => 1,
            $list->token()  => '1',
        ]);

        $this->assertPageOk($copied);

        $copies = self::query('SELECT id, asset_id, title FROM jos_content WHERE id <> ? ORDER BY id', [$id]);

        $this->assertCount(1, $copies, 'One copy');
        $this->assertGreaterThan($id, (int) $copies[0]['id']);

        $assets = self::query('SELECT name, title, rules FROM jos_assets WHERE id = ?', [$copies[0]['asset_id']]);

        $this->assertSame('com_content.article.' . $copies[0]['id'], $assets[0]['name'], 'Asset row kept its name');
        $this->assertNotSame('', $assets[0]['title'], 'Asset row kept its title');

        return (int) $copies[0]['id'];
    }

    #[Depends('testBatchCopy')]
    public function testTrashAndDelete(int $copyId): void
    {
        $admin = self::admin();
        $list  = $admin->get('administrator/index.php?option=com_content&view=articles');

        $trashed = $admin->post('administrator/index.php?option=com_content&view=articles', [
            'cid' => [$copyId], 'task' => 'articles.trash', 'boxchecked' => 1, $list->token() => '1',
        ]);
        $this->assertPageOk($trashed);
        $this->assertSame(-2, (int) self::query('SELECT state FROM jos_content WHERE id = ?', [$copyId])[0]['state']);

        $list    = $admin->get('administrator/index.php?option=com_content&view=articles&filter[published]=-2');
        $deleted = $admin->post('administrator/index.php?option=com_content&view=articles', [
            'cid' => [$copyId], 'task' => 'articles.delete', 'boxchecked' => 1, $list->token() => '1',
        ]);

        $this->assertPageOk($deleted);
        $this->assertSame([], self::query('SELECT id FROM jos_content WHERE id = ?', [$copyId]));
        $this->assertSame([], self::query('SELECT id FROM jos_assets WHERE name = ?', ['com_content.article.' . $copyId]));
    }
}
