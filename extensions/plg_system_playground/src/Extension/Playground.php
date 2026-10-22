<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 */

namespace JoomlaPlayground\Plugin\System\Playground\Extension;

use Joomla\CMS\Event\Model\PrepareFormEvent;
use Joomla\CMS\Plugin\CMSPlugin;
use Joomla\Database\DatabaseAwareTrait;
use Joomla\Event\SubscriberInterface;
use JoomlaPlayground\Database\SqliteDriver;

\defined('_JEXEC') or die;

/**
 * Adapts Joomla to running as a Joomla Playground site.
 */
final class Playground extends CMSPlugin implements SubscriberInterface
{
    use DatabaseAwareTrait;

    /**
     * @var boolean
     */
    protected $autoloadLanguage = true;

    public static function getSubscribedEvents(): array
    {
        return [
            'onContentPrepareForm' => 'onContentPrepareForm',
        ];
    }

    /**
     * The Global Configuration's Database Type field only lists the drivers in the Joomla Framework's own folder.
     * Without our driver as an option, the form would submit another type and the save would fail (or worse).
     */
    public function onContentPrepareForm(PrepareFormEvent $event): void
    {
        $form = $event->getForm();

        if ($form->getName() !== 'com_config.application' || !$this->getDatabase() instanceof SqliteDriver) {
            return;
        }

        $form->load(
            '<form><fieldset name="database"><field name="dbtype" type="list" filter="string"'
            . ' label="COM_CONFIG_FIELD_DATABASE_TYPE_LABEL" description="COM_CONFIG_FIELD_DATABASE_TYPE_DESC">'
            . '<option value="' . SqliteDriver::NAME . '">PLG_SYSTEM_PLAYGROUND_DATABASE_TYPE_SQLITE</option>'
            . '</field></fieldset></form>',
            true
        );
    }
}
