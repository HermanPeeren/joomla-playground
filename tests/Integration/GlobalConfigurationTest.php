<?php

namespace JoomlaPlayground\Tests\Integration;

/**
 * Saving the Global Configuration must keep the SQLite database settings.
 */
final class GlobalConfigurationTest extends IntegrationTestCase
{
    public function testSaveKeepsTheDatabaseSettings(): void
    {
        $admin = self::admin();
        $form  = $admin->get('administrator/index.php?option=com_config');

        // plg_system_playground offers the driver as Database Type; Joomla itself only lists the framework's drivers.
        $this->assertMatchesRegularExpression(
            '#<option value="' . self::$site->driver . '" selected="selected">[^<]*\(Joomla Playground\)</option>#',
            $form->body
        );

        $pairs = array_values(array_filter(
            $form->formFields('application-form'),
            static fn (array $pair): bool => !\in_array($pair[0], ['jform[sitename]', 'task'], true)
        ));
        $pairs[] = ['jform[sitename]', 'Playground (saved)'];
        $pairs[] = ['task', 'application.apply'];

        $saved = $admin->post('administrator/index.php?option=com_config', $pairs);

        $this->assertPageOk($saved);

        $configuration = file_get_contents(self::$site->root . '/configuration.php');

        $this->assertStringContainsString("public \$sitename = 'Playground (saved)';", $configuration);
        $this->assertStringContainsString("public \$dbtype = '" . self::$site->driver . "';", $configuration);
        $this->assertStringContainsString("public \$db = 'data/joomla.sqlite';", $configuration);

        // The site still works with the saved configuration.
        $this->assertPageOk($admin->get('administrator/index.php?option=com_cpanel'));
    }
}
