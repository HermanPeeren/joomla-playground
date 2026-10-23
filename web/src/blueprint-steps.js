// The steps of a blueprint (see blueprint.js), run by the PHP worker on a new playground, logged in as Super User.
//
//   installExtension  { url }                          installs an extension package (zip) with Joomla's installer
//   enableExtension   { element, type?, folder?, client?, params? }   e.g. { element: "debug", type: "plugin",
//                                                      folder: "system" }; params are merged into the extension's
//   disableExtension  { element, type?, folder?, client? }   the opposite of enableExtension
//   indexSmartSearch  { }                              builds the Smart Search index, like its Index button
//   installLanguage   { language, publish? }           installs a language pack the playground ships, and
//                                                      publishes its content language (publish: false does not)
//   addModule         { module, title, position, client?, params?, language?, showtitle?, ordering? }
//                                                      publishes a module on all pages; for an administrator module,
//                                                      it uses the instance its install left without a position
//   addArticle        { title, text, alias?, category?, language?, featured? }   saves an article, published
//   addUserGroup      { title, parent? }               adds a user group (parent: a group title, default Registered)
//   login             { }                              logs in as the Super User (done by default)
//   setGlobalConfig   { values: { sef: false, ... } }  sets properties of configuration.php
//   runPHP            { code }                         runs PHP code in the site's root folder
//   runSql            { sql }                          runs SQL statements on Joomla's database (MySQL syntax, #__ prefix)
//   writeFile         { path, data }                   writes a file, path relative to the site's root
//   unzip             { url, to? }                     unpacks a zip into a folder of the site
//   importSampleData  { type?, group?, query? }        installs Joomla's sample data ("blog", the default); with
//                                                      group (e.g. "demodata"), the data of another plugin group
//                                                      that works like it, with extra query parameters
//   setSiteLanguage   { language, administrator? }     makes a language the default of the site (and of the
//                                                      administrator); installs its pack first if needed
//
// Any step can have "background": true: it then runs after the playground is ready, between the page's requests.
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
 * @param {string}   [context.languagePacks] URL of the bundle's language packs (<tag>.zip), if it has them
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

  async enableExtension({ element, type = null, folder = null, client = null, params = null }, context) {
    context.php.writeFile('/tmp/blueprint.json', JSON.stringify(params ?? {}));
    const response = await context.runPhp(`
      ${joomlaPhp(context.root)}
      $params = json_decode(file_get_contents('/tmp/blueprint.json'), true);
      unlink('/tmp/blueprint.json');
      $query = $db->getQuery(true)->select('extension_id, params')->from('#__extensions')->where('element = ' . $db->quote(${phpString(element)}));
      ${type ? `$query->where('type = ' . $db->quote(${phpString(type)}));` : ''}
      ${folder ? `$query->where('folder = ' . $db->quote(${phpString(folder)}));` : ''}
      ${client ? `$query->where('client_id = ' . ${client === 'administrator' ? 1 : 0});` : ''}
      $rows = $db->setQuery($query)->loadObjectList();
      foreach ($rows as $row) {
          $merged = array_merge(json_decode((string) $row->params, true) ?: [], $params);
          $db->setQuery($db->getQuery(true)->update('#__extensions')->set('enabled = 1')
              ->set('params = ' . $db->quote(json_encode($merged)))->where('extension_id = ' . (int) $row->extension_id))->execute();
      }
      echo count($rows);
    `);

    if (Number(response.text) < 1) {
      throw new Error(`No extension "${element}" found`);
    }
  },

  async disableExtension({ element, type = null, folder = null, client = null }, context) {
    const response = await context.runPhp(`
      ${joomlaPhp(context.root)}
      $query = $db->getQuery(true)->update('#__extensions')->set('enabled = 0')->where('element = ' . $db->quote(${phpString(element)}));
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

  async indexSmartSearch(step, context) {
    const token = csrfToken(await context.request(`${context.siteUrl}/administrator/index.php?option=com_finder&view=index`), 'Smart Search');
    const task = async (name) => {
      const response = await context.request(`${context.siteUrl}/administrator/index.php?option=com_finder&tmpl=component&format=json&task=indexer.${name}&${token}=1`);
      const start = response.text.indexOf('{');

      try {
        return JSON.parse(response.text.slice(Math.max(0, start)));
      } catch {
        throw new Error(`Smart Search ${name} gave no JSON (HTTP ${response.httpStatusCode}): ${plainText(response.text)}`);
      }
    };

    // Like the Index button (media/com_finder/js/indexer.js): start, batches until all items are done, optimize.
    // Each is a request of its own: in the background, the page's requests come in between.
    const started = await task('start');
    let offset = 0;

    if (started.error) {
      throw new Error(started.header ?? started.message ?? 'Smart Search could not start');
    }

    while (offset < (started.totalItems ?? 0)) {
      context.progress(`Smart Search index: ${offset} of ${started.totalItems} items`);

      const batch = await task('batch');

      if (batch.error || !batch.batchOffset) {
        throw new Error(batch.header ?? batch.message ?? `Smart Search stopped at ${offset} of ${started.totalItems} items`);
      }

      offset += batch.batchOffset;
    }

    await task('optimize');
  },

  async installLanguage({ language, publish = true }, context) {
    if (!(await languageInstalled(language, context))) {
      if (!context.languagePacks) {
        throw new Error(`The playground has no language packs; install ${language} with installExtension`);
      }

      await STEPS.installExtension({ url: new URL(`${language}.zip`, context.languagePacks).href }, context);
    }

    // Installing a language pack creates its content language, unpublished.
    if (publish) {
      await context.runPhp(`
        ${joomlaPhp(context.root)}
        $db->setQuery($db->getQuery(true)->update('#__languages')->set('published = 1')
            ->where('lang_code = ' . $db->quote(${phpString(language)})))->execute();
      `);
    }
  },

  async addModule({ module, title, position, client = 'site', params = {}, language = '*', showtitle = true, ordering = 0 }, context) {
    context.php.writeFile('/tmp/blueprint.json', JSON.stringify({ module, title, position, params, language, showtitle, ordering, client: client === 'administrator' ? 1 : 0 }));
    const response = await context.runPhp(`
      ${joomlaPhp(context.root)}
      $spec = json_decode(file_get_contents('/tmp/blueprint.json'), true);
      unlink('/tmp/blueprint.json');
      if (!$db->setQuery($db->getQuery(true)->select('COUNT(*)')->from('#__extensions')
          ->where("type = 'module'")->where('element = ' . $db->quote($spec['module'])))->loadResult()) {
          echo 'missing';
          return;
      }
      $module = (object) [
          'title'     => $spec['title'],
          'position'  => $spec['position'],
          'module'    => $spec['module'],
          'published' => 1,
          'access'    => 1,
          'showtitle' => $spec['showtitle'] ? 1 : 0,
          'params'    => json_encode((object) $spec['params']),
          'client_id' => $spec['client'],
          'language'  => $spec['language'],
          'ordering'  => (int) $spec['ordering'],
      ];
      // Installing an administrator module leaves an unpublished instance without a position: use that one.
      $module->id = (int) $db->setQuery($db->getQuery(true)->select('id')->from('#__modules')
          ->where('module = ' . $db->quote($spec['module']))->where('client_id = ' . (int) $spec['client'])
          ->where("position = ''")->where('published = 0'), 0, 1)->loadResult();
      if ($module->id) {
          $db->updateObject('#__modules', $module, 'id');
      } else {
          unset($module->id);
          $module->content = '';
          $module->note    = '';
          $db->insertObject('#__modules', $module, 'id');
      }
      // On all pages.
      $db->setQuery($db->getQuery(true)->delete('#__modules_menu')->where('moduleid = ' . (int) $module->id))->execute();
      $db->setQuery($db->getQuery(true)->insert('#__modules_menu')->columns('moduleid, menuid')->values((int) $module->id . ', 0'))->execute();
      echo $module->id;
    `);

    if (response.text.trim() === 'missing') {
      throw new Error(`No module "${module}" is installed`);
    }
  },

  async addUserGroup({ title, parent = 'Registered' }, context) {
    const parentId = (
      await context.runPhp(`
        ${joomlaPhp(context.root)}
        echo (int) $db->setQuery($db->getQuery(true)->select('id')->from('#__usergroups')
            ->where('title = ' . $db->quote(${phpString(parent)})), 0, 1)->loadResult();
      `)
    ).text.trim();

    if (!Number(parentId)) {
      throw new Error(`No user group "${parent}"`);
    }

    await saveForm(context, {
      add: 'option=com_users&task=group.add',
      edit: 'option=com_users&view=group&layout=edit',
      save: 'option=com_users&layout=edit&id=0',
      list: 'option=com_users&view=groups',
      fields: { 'jform[title]': title, 'jform[parent_id]': parentId, task: 'group.save' },
      what: `the user group "${title}"`,
    });
  },

  async addArticle({ title, text, alias = '', category = 'uncategorised', language = '*', featured = false }, context) {
    const catid = (
      await context.runPhp(`
        ${joomlaPhp(context.root)}
        echo (int) $db->setQuery($db->getQuery(true)->select('id')->from('#__categories')
            ->where("extension = 'com_content'")->where('alias = ' . $db->quote(${phpString(category)})), 0, 1)->loadResult();
      `)
    ).text.trim();

    if (!Number(catid)) {
      throw new Error(`No article category "${category}"`);
    }

    await saveForm(context, {
      add: 'option=com_content&task=article.add',
      edit: 'option=com_content&view=article&layout=edit',
      save: 'option=com_content&layout=edit&id=0',
      list: 'option=com_content&view=articles',
      fields: {
        'jform[title]': title,
        'jform[alias]': alias,
        'jform[articletext]': text,
        'jform[catid]': catid,
        'jform[state]': '1',
        'jform[featured]': featured ? '1' : '0',
        'jform[language]': language,
        'jform[access]': '1',
        task: 'article.save',
      },
      what: `the article "${title}"`,
    });
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

  async importSampleData({ type = 'blog', group = 'sampledata', query = {} }, context) {
    const token = csrfToken(await context.request(`${context.siteUrl}/administrator/index.php`), 'the administrator');
    const event = `${group.charAt(0).toUpperCase()}${group.slice(1)}ApplyStep`;
    const extra = new URLSearchParams(query).toString();

    // Like the Sample Data module: step 1, 2, ... until the plugin has no further step.
    for (let step = 1; step <= 50; step++) {
      context.progress(`Installing the ${type} data: step ${step}`);

      const response = await context.request(
        `${context.siteUrl}/administrator/index.php?option=com_ajax&format=json&group=${encodeURIComponent(group)}&${token}=1&type=${encodeURIComponent(type)}&plugin=${event}${step}&step=${step}${extra ? `&${extra}` : ''}`
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
        throw new Error(result.message ? `Step ${step} of the ${type} data: ${result.message}` : `No sample data "${type}"`);
      }

      if (answers.length === 0) {
        return;
      }

      const failed = answers.find((answer) => !answer.success);

      if (failed) {
        throw new Error(`Step ${step} of the ${type} data: ${failed.message}`);
      }
    }
  },

  async setSiteLanguage({ language, administrator = false }, context) {
    // A language pack the playground ships, installed when the language is not there yet (by the PHP below).
    if (context.languagePacks && !(await languageInstalled(language, context))) {
      await STEPS.installExtension({ url: new URL(`${language}.zip`, context.languagePacks).href }, context);
    }

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
      throw new Error(`The language ${language} is not installed, and the playground has no language pack for it`);
    }
  },
};

async function languageInstalled(language, context) {
  const response = await context.runPhp(`
    ${joomlaPhp(context.root)}
    echo $db->setQuery($db->getQuery(true)->select('COUNT(*)')->from('#__extensions')
        ->where("type = 'language'")->where('client_id = 0')->where('element = ' . $db->quote(${phpString(language)})))->loadResult();
  `);

  return Number(response.text.trim()) > 0;
}

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

/**
 * Saves an item through its administrator form, like a user: open the new item's form, post it, read the messages
 * on the list it returns to.
 */
async function saveForm(context, { add, edit, save, list, fields, what }) {
  const page = (query) => `${context.siteUrl}/administrator/index.php?${query}`;

  await context.request(page(add));

  const token = csrfToken(await context.request(page(edit)), `the form of ${what}`);
  const body = new URLSearchParams({ ...fields, [token]: '1' });

  await context.request(page(save), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new TextEncoder().encode(body.toString()),
  });

  const messages = joomlaMessages(await context.request(page(list)));

  if (messages.error?.length || messages.danger?.length || !(messages.success?.length || messages.message?.length)) {
    throw new Error([...(messages.error ?? []), ...(messages.danger ?? []), ...(messages.warning ?? [])].join(' ') || `Saving ${what} gave no result`);
  }
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
