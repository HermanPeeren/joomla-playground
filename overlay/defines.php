<?php

/**
 * @package    Joomla Playground
 * @license    GNU General Public License version 2 or later
 *
 * Joomla includes this file (if present) before its own defines in index.php and cli/joomla.php.
 * It only registers the Joomla Playground autoloader; Joomla's path constants are left alone.
 */

\defined('_JEXEC') or die;

require_once __DIR__ . '/libraries/playground/autoload.php';
