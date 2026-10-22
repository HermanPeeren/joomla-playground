<?php

namespace JoomlaPlayground\Tests\Integration;

/**
 * Categories and menu items are nested sets (lft/rgt arithmetic); users touch the group map and action logs.
 */
final class NestedSetsAndUsersTest extends IntegrationTestCase
{
    public function testCreateNestedCategories(): void
    {
        $parent = self::submitAdminForm(
            'option=com_categories&task=category.add&extension=com_content',
            'item-form',
            ['jform[title]' => 'Parent category', 'jform[published]' => '1'],
            'category.save'
        );
        $this->assertPageOk($parent);

        $parentId = (int) self::query("SELECT id FROM jos_categories WHERE title = 'Parent category'")[0]['id'];

        $child = self::submitAdminForm(
            'option=com_categories&task=category.add&extension=com_content',
            'item-form',
            ['jform[title]' => 'Child category', 'jform[parent_id]' => (string) $parentId, 'jform[published]' => '1'],
            'category.save'
        );
        $this->assertPageOk($child);

        $rows = self::query(
            "SELECT title, parent_id, level, lft, rgt, path FROM jos_categories WHERE title IN ('Parent category', 'Child category') ORDER BY lft"
        );

        $this->assertSame(['Parent category', 'Child category'], array_column($rows, 'title'));
        $this->assertSame($parentId, (int) $rows[1]['parent_id']);
        $this->assertSame('parent-category/child-category', $rows[1]['path']);
        $this->assertSame((int) $rows[0]['level'] + 1, (int) $rows[1]['level']);
        $this->assertTrue($rows[0]['lft'] < $rows[1]['lft'] && $rows[1]['rgt'] < $rows[0]['rgt'], 'Child is nested inside its parent');
        $this->assertNestedSetIsConsistent('jos_categories');
    }

    public function testCreateMenuItem(): void
    {
        $saved = self::submitAdminForm(
            'option=com_menus&task=item.add&menutype=mainmenu',
            'item-form',
            [
                'jform[title]'     => 'Playground link',
                'jform[type]'      => 'url',
                'jform[link]'      => 'https://www.joomla.org',
                'jform[menutype]'  => 'mainmenu',
                'jform[published]' => '1',
            ],
            'item.save'
        );

        $this->assertPageOk($saved);
        $this->assertCount(1, self::query("SELECT id FROM jos_menu WHERE title = 'Playground link' AND menutype = 'mainmenu'"));
        $this->assertNestedSetIsConsistent('jos_menu');
    }

    public function testCreateUser(): void
    {
        $saved = self::submitAdminForm(
            'option=com_users&task=user.add',
            'user-form',
            [
                'jform[name]'      => 'Test Author',
                'jform[username]'  => 'author',
                'jform[email]'     => 'author@example.invalid',
                'jform[password]'  => 'a-long-test-password-1',
                'jform[password2]' => 'a-long-test-password-1',
                'jform[groups][]'  => '3',
            ],
            'user.save'
        );

        $this->assertPageOk($saved);

        $user = self::query("SELECT id FROM jos_users WHERE username = 'author'");

        $this->assertCount(1, $user);
        $this->assertSame(['3'], array_map('strval', array_column(self::query('SELECT group_id FROM jos_user_usergroup_map WHERE user_id = ?', [$user[0]['id']]), 'group_id')));
        $this->assertNotEmpty(self::query("SELECT id FROM jos_action_logs WHERE extension = 'com_users' AND message_language_key = 'PLG_SYSTEM_ACTIONLOGS_CONTENT_ADDED'"));
    }

    /**
     * Every node's lft < rgt, and the root spans all nodes.
     */
    private function assertNestedSetIsConsistent(string $table): void
    {
        $broken = self::query("SELECT id FROM $table WHERE lft >= rgt");
        $root   = self::query("SELECT lft, rgt FROM $table WHERE parent_id = 0 AND level = 0")[0];
        $count  = (int) self::query("SELECT COUNT(*) AS n FROM $table")[0]['n'];

        $this->assertSame([], $broken, "$table: nodes with lft >= rgt");
        $this->assertSame(0, (int) $root['lft']);
        $this->assertSame(2 * $count - 1, (int) $root['rgt'], "$table: root rgt matches the number of nodes");
    }
}
