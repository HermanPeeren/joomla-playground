<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 */

namespace JoomlaPlayground\Plugin\System\Playground\Extension;

use Joomla\CMS\Event\Model\PrepareFormEvent;
use Joomla\CMS\Language\Text;
use Joomla\CMS\Plugin\CMSPlugin;
use Joomla\Database\DatabaseAwareTrait;
use Joomla\Event\SubscriberInterface;
use JoomlaPlayground\Database\MysqlOnSqlite\MysqlOnSqliteDriver;
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
            'onAfterRoute'         => 'onAfterRoute',
            'onContentPrepareForm' => 'onContentPrepareForm',
        ];
    }

    /**
     * Notices for the browser playground. Its PHP worker sets $_SERVER['JOOMLA_PLAYGROUND'], the Super User's name and
     * password, and whether the playground has a CORS proxy (see prependFile() in web/src/php-worker.js).
     */
    public function onAfterRoute(): void
    {
        $app = $this->getApplication();

        if (($_SERVER['JOOMLA_PLAYGROUND'] ?? '') !== 'browser') {
            return;
        }

        $option = $app->getInput()->getCmd('option');
        $view   = $app->getInput()->getCmd('view');

        // The login form: with which account to log in. The playground's password is random; the toolbar shows it too.
        // The administrator shows a guest the login form whatever the page (it sets the option later, at dispatch).
        $isPage  = $app->getInput()->getMethod() === 'GET' && $app->getInput()->getCmd('format', 'html') === 'html';
        $isLogin = $app->isClient('administrator')
            ? $app->getIdentity() === null || $app->getIdentity()->guest
            : $option === 'com_users' && $view === 'login';

        if ($isPage && $isLogin && !empty($_SERVER['JOOMLA_PLAYGROUND_PASSWORD'])) {
            $app->enqueueMessage(Text::sprintf('PLG_SYSTEM_PLAYGROUND_LOGIN', $_SERVER['JOOMLA_PLAYGROUND_USERNAME'] ?? 'admin', $_SERVER['JOOMLA_PLAYGROUND_PASSWORD']), 'info');
        }

        // In the browser, PHP's HTTP requests go through fetch(), so a server must allow cross-origin requests. The list
        // of languages (update.joomla.org) does; the language packs (downloads.joomla.org) do not. Say so on the page,
        // next to Joomla's own "Error connecting to the server" after an attempt. With a CORS proxy, the downloads work.
        if (empty($_SERVER['JOOMLA_PLAYGROUND_CORS_PROXY']) && $app->isClient('administrator') && $option === 'com_installer' && $view === 'languages') {
            $app->enqueueMessage(Text::_('PLG_SYSTEM_PLAYGROUND_NO_LANGUAGE_DOWNLOADS'), 'warning');
        }
    }

    /**
     * The Global Configuration's Database Type field only lists the drivers in the Joomla Framework's own folder.
     * Without our driver as an option, the form would submit another type and the save would fail (or worse).
     */
    public function onContentPrepareForm(PrepareFormEvent $event): void
    {
        $form = $event->getForm();

        $db = $this->getDatabase();

        if ($form->getName() !== 'com_config.application' || !($db instanceof SqliteDriver || $db instanceof MysqlOnSqliteDriver)) {
            return;
        }

        $form->load(
            '<form><fieldset name="database"><field name="dbtype" type="list" filter="string"'
            . ' label="COM_CONFIG_FIELD_DATABASE_TYPE_LABEL" description="COM_CONFIG_FIELD_DATABASE_TYPE_DESC">'
            . '<option value="' . $db->getName() . '">PLG_SYSTEM_PLAYGROUND_DATABASE_TYPE_' . strtoupper($db->getName()) . '</option>'
            . '</field></fieldset></form>',
            true
        );
    }
}
