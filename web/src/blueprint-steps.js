// The steps of a blueprint (see blueprint.js), run by the PHP worker on a new playground, logged in as Super User.
//
//   installExtension  { url }                          installs an extension package (zip) with Joomla's installer
//   enableExtension   { element, type?, folder?, client? }   e.g. { element: "debug", type: "plugin", folder: "system" }
//   login             { }                              logs in as the Super User (done by default)
//   setGlobalConfig   { values: { sef: false, ... } }  sets properties of configuration.php
//   runPHP            { code }                         runs PHP code in the site's root folder
//   runSql            { sql }                          runs SQL statements on Joomla's database (MySQL syntax, #__ prefix)
//   writeFile         { path, data }                   writes a file, path relative to the site's root
//   unzip             { url, to? }                     unpacks a zip into a folder of the site
//   importSampleData  { type? }                        installs Joomla's sample data ("blog", the default)
//   setSiteLanguage   { language, administrator? }     makes an installed language the default of the site
//
// URLs are relative to the blueprint. Downloads need CORS headers from the host, or the playground's CORS proxy.

export class BlueprintError extends Error {}

/**
 * @param {object}   context
 * @param {object}   context.php       PHP instance
 * @param {Function} context.request   (url, init) => PHPResponse, through the logged-in request handler
 * @param {string}   context.siteUrl
 * @param {string}   context.root      document root
 * @param {Function} context.runPhp    (code) => PHPResponse; throws on errors
 * @param {Function} context.progress  (message) => void
 * @param {string}   context.baseUrl   URL the step URLs are relative to
 * @param {string}   [context.corsProxy] URL of a CORS proxy (proxy/cors-proxy.js)
 */
export async function runSteps(steps, context) {
  for (const [index, step] of steps.entries()) {
    context.progress(`Blueprint step ${index + 1} of ${steps.length}: ${step.step}`);

    try {
      await STEPS[step.step](step, context);
    } catch (error) {
      throw new BlueprintError(`Blueprint step ${index + 1} (${step.step}): ${error.message}`);
    }
  }
}

/**
 * PHP that boots Joomla's framework (as the administrator) and puts its database in $db.
 */
export function joomlaPhp(root) {
  return `
    define('_JEXEC', 1);
    define('JPATH_BASE', '${root}/administrator');
    if (is_file(JPATH_BASE . '/defines.php')) {
        include_once JPATH_BASE . '/defines.php';
    }
    if (!defined('_JDEFINES')) {
        require_once JPATH_BASE . '/includes/defines.php';
    }
    require_once JPATH_BASE . '/includes/framework.php';
    $db = \\Joomla\\CMS\\Factory::getContainer()->get(\\Joomla\\Database\\DatabaseInterface::class);
  `;
}

const STEPS = {
  async installExtension({ url }, context) {
    const bytes = await download(url, context);
    const name = decodeURIComponent(new URL(url, context.baseUrl).pathname.split('/').pop() || 'extension.zip');
    const page = `${context.siteUrl}/administrator/index.php?option=com_installer&view=install`;
    const token = csrfToken(await context.request(page), 'the installer');
    const form = new FormData();

    form.append('install_package', new Blob([bytes], { type: 'application/zip' }), name.endsWith('.zip') ? name : `${name}.zip`);
    form.append('installtype', 'upload');
    form.append('task', 'install.install');
    form.append(token, '1');

    // Let the browser encode the form (multipart/form-data with a boundary).
    const encoded = new Request('http://localhost/', { method: 'POST', body: form });

    const posted = await context.request(`${context.siteUrl}/administrator/index.php?option=com_installer&view=install`, {
      method: 'POST',
      headers: { 'content-type': encoded.headers.get('content-type') },
      body: new Uint8Array(await encoded.arrayBuffer()),
    });

    // The installer redirects to its page, which shows the messages it queued.
    const after = await context.request(page);
    const messages = joomlaMessages(after);

    if (messages.error?.length || messages.danger?.length || !(messages.success?.length || messages.message?.length)) {
      throw new Error(
        [...(messages.error ?? []), ...(messages.danger ?? []), ...(messages.warning ?? [])].join(' ')
          || `Installing ${name} gave no result (HTTP ${posted.httpStatusCode}): ${plainText(after.text)}`
      );
    }
  },

  async enableExtension({ element, type = null, folder = null, client = null }, context) {
    const response = await context.runPhp(`
      ${joomlaPhp(context.root)}
      $query = $db->getQuery(true)->update('#__extensions')->set('enabled = 1')->where('element = ' . $db->quote(${phpString(element)}));
      ${type ? `$query->where('type = ' . $db->quote(${phpString(type)}));` : ''}
      ${folder ? `$query->where('folder = ' . $db->quote(${phpString(folder)}));` : ''}
      ${client ? `$query->where('client_id = ' . ${client === 'administrator' ? 1 : 0});` : ''}
      $db->setQuery($query)->execute();
      echo $db->getAffectedRows();
    `);

    if (Number(response.text) < 1) {
      throw new Error(`No extension "${element}" found`);
    }
  },

  async login(step, context) {
    await context.logIn();
  },

  async setGlobalConfig({ values }, context) {
    context.php.writeFile('/tmp/blueprint.json', JSON.stringify(values));
    await context.runPhp(`
      $file   = '${context.root}/configuration.php';
      $values = json_decode(file_get_contents('/tmp/blueprint.json'), true);
      unlink('/tmp/blueprint.json');
      $configuration = file_get_contents($file);
      foreach ($values as $key => $value) {
          if (!preg_match('/^[a-z_][a-z0-9_]*$/i', $key)) {
              throw new InvalidArgumentException('Not a configuration property: ' . $key);
          }
          $line = 'public $' . $key . ' = ' . var_export($value, true) . ';';
          $configuration = preg_match('/public \\$' . $key . ' = [^;]*;/', $configuration)
              ? preg_replace_callback('/public \\$' . $key . ' = [^;]*;/', fn () => $line, $configuration)
              : preg_replace('/}\\s*$/', "\\t" . $line . "\\n}\\n", $configuration);
      }
      chmod($file, 0644);
      file_put_contents($file, $configuration);
    `);
  },

  async runPHP({ code }, context) {
    const source = /^\s*<\?php/.test(code) ? code : `<?php ${code}`;
    const response = await context.runPhp(`chdir('${context.root}'); ?>${source}`);

    if (response.text) {
      console.info('runPHP:', response.text);
    }
  },

  async runSql({ sql }, context) {
    context.php.writeFile('/tmp/blueprint.sql', sql);
    await context.runPhp(`
      ${joomlaPhp(context.root)}
      $sql = file_get_contents('/tmp/blueprint.sql');
      unlink('/tmp/blueprint.sql');
      foreach ($db->splitSql($sql) as $statement) {
          if (trim($statement) !== '') {
              $db->setQuery($statement)->execute();
          }
      }
    `);
  },

  async writeFile({ path, data }, context) {
    const target = sitePath(path, context);

    await context.runPhp(`is_dir(dirname('${target}')) || mkdir(dirname('${target}'), 0777, true);`);
    context.php.writeFile(target, typeof data === 'string' ? data : JSON.stringify(data));
  },

  async unzip({ url, to = '' }, context) {
    const target = sitePath(to || '.', context);

    context.php.writeFile('/tmp/blueprint.zip', await download(url, context));
    await context.runPhp(`
      $zip = new ZipArchive();
      if ($zip->open('/tmp/blueprint.zip') !== true || !$zip->extractTo('${target}')) {
          throw new RuntimeException('Cannot unpack the zip');
      }
      $zip->close();
      unlink('/tmp/blueprint.zip');
    `);
  },

  async importSampleData({ type = 'blog' }, context) {
    const token = csrfToken(await context.request(`${context.siteUrl}/administrator/index.php`), 'the administrator');

    // Like the Sample Data module: step 1, 2, ... until the plugin has no further step.
    for (let step = 1; step <= 20; step++) {
      const response = await context.request(
        `${context.siteUrl}/administrator/index.php?option=com_ajax&format=json&group=sampledata&${token}=1&type=${encodeURIComponent(type)}&plugin=SampledataApplyStep${step}&step=${step}`
      );
      let result;

      // PHP warnings may come before the JSON.
      const start = response.text.indexOf('{"success"');

      if (start > 0) {
        console.warn(`Sample data step ${step}: ${plainText(response.text.slice(0, start))}`);
      }

      try {
        result = JSON.parse(response.text.slice(Math.max(0, start)));
      } catch {
        throw new Error(`Step ${step} of the sample data gave no JSON (HTTP ${response.httpStatusCode}): ${plainText(response.text)}`);
      }

      const answers = (result.data ?? []).filter(Boolean);

      if (!result.success || (step === 1 && answers.length === 0)) {
        throw new Error(result.message || `No sample data "${type}"`);
      }

      if (answers.length === 0) {
        return;
      }

      const failed = answers.find((answer) => !answer.success);

      if (failed) {
        throw new Error(failed.message);
      }
    }
  },

  async setSiteLanguage({ language, administrator = false }, context) {
    const response = await context.runPhp(`
      ${joomlaPhp(context.root)}
      $language = ${phpString(language)};
      $installed = $db->setQuery($db->getQuery(true)->select('COUNT(*)')->from('#__extensions')
          ->where("type = 'language'")->where('client_id = 0')->where('element = ' . $db->quote($language)))->loadResult();
      if (!$installed) {
          echo 'missing';
          return;
      }
      $query  = $db->getQuery(true)->select('extension_id, params')->from('#__extensions')->where("element = 'com_languages'");
      $row    = $db->setQuery($query)->loadObject();
      $params = json_decode($row->params, true) ?: [];
      $params['site'] = $language;
      ${administrator ? `$params['administrator'] = $language;` : ''}
      $db->setQuery($db->getQuery(true)->update('#__extensions')->set('params = ' . $db->quote(json_encode($params)))
          ->where('extension_id = ' . (int) $row->extension_id))->execute();
      echo 'ok';
    `);

    if (response.text.trim() === 'missing') {
      throw new Error(`The language ${language} is not installed; install its package first (installExtension)`);
    }
  },
};

/**
 * Downloads a file: directly, or through the CORS proxy when the host does not allow it.
 */
export async function download(url, { baseUrl, corsProxy = null, progress = () => {} }) {
  const absolute = new URL(url, baseUrl).href;

  progress(`Downloading ${absolute}`);

  let response;

  try {
    response = await fetch(absolute);
  } catch (error) {
    if (!corsProxy) {
      throw new Error(`Cannot download ${absolute}: the host does not allow it (CORS), and no CORS proxy is set up`);
    }

    response = await fetch(`${corsProxy}?url=${encodeURIComponent(absolute)}`);
  }

  if (!response.ok) {
    throw new Error(`Cannot download ${absolute}: HTTP ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function csrfToken(response, where) {
  const token = response.text.match(/"csrf\.token":"([a-f0-9]{32})"/)?.[1] ?? response.text.match(/name="([a-f0-9]{32})" value="1"/)?.[1];

  if (!token) {
    throw new Error(`No form token in ${where} (HTTP ${response.httpStatusCode}); is the Super User logged in?`);
  }

  return token;
}

/**
 * The messages Joomla queued for a page, by type: { success: [...], error: [...], ... }.
 */
function joomlaMessages(response) {
  const options = response.text.match(/<script[^>]*class="joomla-script-options[^"]*"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  const messages = {};

  try {
    for (const group of JSON.parse(options)['joomla.messages'] ?? []) {
      for (const [type, texts] of Object.entries(group)) {
        messages[type] = [...(messages[type] ?? []), ...texts.map((text) => text.replace(/<[^>]+>/g, ''))];
      }
    }
  } catch {
    // No messages.
  }

  return messages;
}

function plainText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

function sitePath(path, { root }) {
  const parts = String(path).split('/').filter((part) => part && part !== '.');

  if (parts.includes('..') || /['\\]/.test(path)) {
    throw new Error(`Not a path inside the site: ${path}`);
  }

  return [root, ...parts].join('/');
}

function phpString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
