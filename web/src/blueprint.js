// Blueprints: what a new playground should look like, read from the page URL.
//
//   #{"landingPage": "/administrator/index.php?option=com_content", "steps": [...]}   a blueprint in the fragment
//   ?blueprint-url=https://example.org/blueprint.json                                 a blueprint to download
//   ?php=8.3  ?url=/index.php  ?login=no  ?extension=<zip URL> (repeatable)  ?language=nl-NL
//                                                                                     shortcuts, added on top
//
// A blueprint:
//   {
//     "preferredVersions": { "php": "8.4", "joomla": "6.2" },
//     "landingPage": "/administrator/",
//     "login": true,
//     "steps": [ { "step": "installExtension", "url": "https://example.org/my_extension.zip" }, ... ]
//   }
// The steps are run by the PHP worker (see blueprint-steps.js), which also documents them.

export const PHP_VERSIONS = ['8.3', '8.4', '8.5'];
export const DEFAULT_PHP_VERSION = '8.4';

export const STEPS = {
  installExtension: ['url'],
  enableExtension: ['element'],
  login: [],
  setGlobalConfig: ['values'],
  runPHP: ['code'],
  runSql: ['sql'],
  writeFile: ['path', 'data'],
  unzip: ['url'],
  importSampleData: [],
  setSiteLanguage: ['language'],
};

const KEYS = ['$schema', 'preferredVersions', 'landingPage', 'login', 'steps', 'meta'];

/**
 * @returns {Promise<object|null>} The blueprint of this page URL, or null when the URL asks for none.
 */
export async function blueprintFromUrl(url) {
  const params = url.searchParams;
  const fragment = decodeURIComponent(url.hash.slice(1)).trim();
  let blueprint = null;

  if (fragment.startsWith('{')) {
    blueprint = parseJson(fragment, 'the blueprint in the URL');
  } else if (params.get('blueprint-url')) {
    const source = new URL(params.get('blueprint-url'), url);
    const response = await fetch(source);

    if (!response.ok) {
      throw new Error(`Cannot download the blueprint ${source}: HTTP ${response.status}`);
    }

    blueprint = parseJson(await response.text(), `the blueprint ${source}`);
    blueprint.baseUrl = source.href;
  }

  const shortcuts = {
    php: params.get('php'),
    joomla: params.get('joomla'),
    landingPage: params.get('url'),
    login: params.get('login'),
    extensions: params.getAll('extension'),
    language: params.get('language'),
  };

  if (!blueprint && !Object.values(shortcuts).some((value) => (Array.isArray(value) ? value.length : value))) {
    return null;
  }

  blueprint = { steps: [], ...(blueprint ?? {}) };
  blueprint.steps = [...(blueprint.steps ?? [])];

  if (shortcuts.php || shortcuts.joomla) {
    blueprint.preferredVersions = { ...blueprint.preferredVersions };
    shortcuts.php && (blueprint.preferredVersions.php = shortcuts.php);
    shortcuts.joomla && (blueprint.preferredVersions.joomla = shortcuts.joomla);
  }

  if (shortcuts.landingPage) {
    blueprint.landingPage = shortcuts.landingPage;
  }

  if (shortcuts.login) {
    blueprint.login = !['no', '0', 'false'].includes(shortcuts.login.toLowerCase());
  }

  for (const extension of shortcuts.extensions) {
    blueprint.steps.push({ step: 'installExtension', url: extension });
  }

  if (shortcuts.language) {
    blueprint.steps.push({ step: 'setSiteLanguage', language: shortcuts.language, administrator: true });
  }

  validate(blueprint);

  return blueprint;
}

/**
 * Throws an error that says what is wrong with a blueprint.
 */
export function validate(blueprint) {
  if (typeof blueprint !== 'object' || blueprint === null || Array.isArray(blueprint)) {
    throw new Error('A blueprint is a JSON object');
  }

  for (const key of Object.keys(blueprint)) {
    if (!KEYS.includes(key) && key !== 'baseUrl') {
      throw new Error(`Unknown blueprint property "${key}"; known: ${KEYS.join(', ')}`);
    }
  }

  const php = blueprint.preferredVersions?.php;

  if (php && !PHP_VERSIONS.includes(String(php))) {
    throw new Error(`PHP ${php} is not available; choose ${PHP_VERSIONS.join(', ')}`);
  }

  if (blueprint.landingPage !== undefined && !String(blueprint.landingPage).startsWith('/')) {
    throw new Error('The landing page is a path of the site, starting with "/"');
  }

  if (!Array.isArray(blueprint.steps)) {
    throw new Error('The steps of a blueprint are a list');
  }

  blueprint.steps.forEach((step, index) => {
    const required = STEPS[step?.step];

    if (!required) {
      throw new Error(`Step ${index + 1}: unknown step "${step?.step}"; known: ${Object.keys(STEPS).join(', ')}`);
    }

    for (const property of required) {
      if (step[property] === undefined) {
        throw new Error(`Step ${index + 1} (${step.step}) needs "${property}"`);
      }
    }
  });
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot read ${what}: ${error.message}`);
  }
}
