# Joomla Playground

A complete Joomla site in your browser tab: no server, no installation, no account. Try a Joomla version, test
an idea, show something to someone, and throw it away, or keep it in your browser for later.

**Open it:** <https://hermanpeeren.github.io/joomla-playground/>

After a few seconds you see Joomla's administrator, already logged in as a Super User. Everything runs in your
browser: PHP is compiled to WebAssembly, and the site and its database live in the tab's memory. Nothing is
sent to a server.

## Demos

- **Multilingual site:** <https://hermanpeeren.github.io/joomla-playground/?blueprint=heritage-demo>. A site in
  English, Dutch, German, French and Spanish, with content about UNESCO World Heritage sites from the
  [demonstration data](https://github.com/ceford/cefjdemos-plg-demodata) of Clifford E Ford. It starts in a few
  seconds, from a prebuilt copy of
  the site. Add `&fresh=1` to watch the blueprint build it in your browser instead: that takes about 45 seconds,
  plus a minute for the Smart Search index while you can already look around.

## Logging in

The playground logs you in to the administrator by itself. If you log out, or want to log in on the front end:
- **Username:** `admin`
- **Password:** different for every playground. The toolbar shows it (top left, "Super User: admin / …"), and so
  does the login form. A saved site keeps its password.

A session lasts 4 hours (Joomla's default is 15 minutes); you can change that under System > Global
Configuration > System > Session Lifetime.

## Using the playground

The toolbar above the site:

| Button | What it does |
|---|---|
| **Site** / **Administrator** | Show the front end or the administrator of the site. |
| **New** | Start a new, empty playground. |
| **Start over** | Throw this playground away and start again from the same link (and blueprint). |
| **Save…** | Keep this playground in your browser under a name. From then on, changes are saved as you work. |
| **My sites** | Open, rename or delete the sites you saved. |
| **Mail** | The mails the site sent. They are caught here, not delivered: try a password reset or a contact form. |
| **Export** | Download the whole site as a zip. |
| **Import…** | Start a playground from such a zip, e.g. one someone sent you. |

On the right:
- **Joomla** switches the Joomla version (6.2 or 5.4): a new temporary playground starts with it. A saved site
  keeps the version it was made with.
- **PHP** switches the PHP version (8.3, 8.4 or 8.5): a saved site reopens with it, a temporary playground starts
  again from the same link.
- The Super User's name and password (see [Logging in](#logging-in)). Hover over the database driver for
  timings.

**Temporary or saved?**
- A new playground is temporary: reloading the page or closing the tab throws it away.
- After **Save…**, the address bar shows `?site=<name>`. That address reopens the site, also after a reload or a
  browser restart, and it is listed under **My sites**.
- A saved site stays in this browser only (in its private storage for this website). Use **Export** to move a
  site to another browser or computer, or to keep a copy elsewhere.
- A saved site can be open in one tab at a time.

**Good to know**
- Use a recent Chrome, Edge or other Chromium browser; Firefox and Safari are not tested yet.
- **Languages:** System > Install Languages works. The playground has the accredited language packs on board, so
  installing one takes a few seconds. `?language=nl-NL` starts a playground in that language (see below).
- The site reaches the internet through your browser, so only servers that allow requests from other websites
  (CORS) answer. Installing extensions from URLs or updating them mostly does not work: download the zip and use
  System > Install > Extensions > **Upload Package File**. A link or blueprint can install extensions from hosts
  that allow it (see below).
- The Mail inbox keeps the mails until the page is reloaded.
- Each tab is its own playground, with its own site and database.
- Clearing your browser's site data for this address deletes the saved sites.

## Setting up a playground with a link

A link can say how a new playground should look. Add these to the address:

| Parameter | Example | What it does |
|---|---|---|
| `joomla` | `?joomla=5.4` | Joomla version: 6.2 (default) or 5.4; `5` also works |
| `php` | `?php=8.3` | PHP version: 8.3, 8.4 (default) or 8.5 |
| `url` | `?url=/index.php` | The page to open first; default `/administrator/` |
| `login` | `?login=no` | Start logged out |
| `extension` | `?extension=https://example.org/mod_hello.zip` | Install an extension package (repeatable) |
| `language` | `?language=nl-NL` | Install that language and make it the default of the site and the administrator |
| `blueprint-url` | `?blueprint-url=https://example.org/blueprint.json` | Set up the site with a blueprint |
| `blueprint` | `?blueprint=heritage-demo` | Set up the site with one of the playground's own blueprints (from its prebuilt copy, if it has one) |
| `fresh` | `?blueprint=heritage-demo&fresh=1` | Run the blueprint, even if there is a prebuilt copy |

A **blueprint** is a small JSON file with the steps to set up a site. It can also be put in the address
itself, after `#`. For example, this one installs Joomla's blog sample data, renames the site and opens the
front end:

```json
{
  "preferredVersions": { "joomla": "6.2", "php": "8.4" },
  "landingPage": "/index.php",
  "steps": [
    { "step": "importSampleData" },
    { "step": "setGlobalConfig", "values": { "sitename": "My demo" } }
  ]
}
```

The steps:

| Step | Properties | What it does |
|---|---|---|
| `installExtension` | `url` | Install an extension package (zip) |
| `enableExtension` | `element`, `type`, `folder`, `client`, `params` | Enable an extension and set its options, e.g. `{"element": "debug", "type": "plugin", "folder": "system"}` |
| `importSampleData` | `type` (default `blog`), `group`, `query` | Install Joomla's sample data, or data of a plugin that works like it |
| `setGlobalConfig` | `values` | Set Global Configuration options (properties of `configuration.php`) |
| `setSiteLanguage` | `language`, `administrator` | Make a language the default (its pack is installed if needed) |
| `runSql` | `sql` | Run SQL statements (MySQL syntax; `#__` is the table prefix) |
| `runPHP` | `code` | Run PHP code in the site's root folder |
| `writeFile` | `path`, `data` | Write a file into the site |
| `unzip` | `url`, `to` | Unpack a zip into the site |
| `login` | | Log in as the Super User (done by default) |
| `installLanguage` | `language`, `publish` | Install a language and publish its content language |
| `addModule` | `module`, `title`, `position`, `client`, `params`, `language` | Publish a module on all pages |
| `addArticle` | `title`, `text`, `category`, `language`, `featured` | Add a published article |
| `addUserGroup` | `title`, `parent` | Add a user group |
| `disableExtension` | `element`, `type`, `folder`, `client` | Disable an extension |
| `indexSmartSearch` | | Build the Smart Search index, like its Index button |

Any step can have `"background": true`: it then runs after the playground is ready, while you use it, and the
toolbar shows its progress.

Downloads (`extension`, `installExtension`, `unzip`) need a host that allows it (CORS headers), such as
GitHub Pages or raw.githubusercontent.com; release downloads on GitHub do not. URLs in a blueprint are relative
to the blueprint. If a step fails, the playground still starts and the toolbar shows the error.

## Running your own copy

The playground is a static website: build it once and host it on any web server with HTTPS, such as GitHub
Pages. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for building, running it locally and the tests.

## How it works and what is next

- [docs/REPORT.md](docs/REPORT.md): how it works, what was tried and measured.
- [docs/PLAN.md](docs/PLAN.md): what comes next, such as choosing Joomla and PHP versions, installing
  extensions from a URL, and blueprints that set up a site.

Comparable to [WordPress Playground](https://wordpress.org/playground/), whose PHP-in-WebAssembly runtime it
uses.

## License

GNU General Public License version 2 or later, like Joomla and WordPress Playground.

## Credits

The playground runs on code from the WordPress community, both GPL-2.0-or-later like Joomla. No WordPress itself
(core, plugins or themes) is used.

- **[`@php-wasm`](https://github.com/WordPress/wordpress-playground)** (WordPress Playground, npm, version
  3.1.60): PHP compiled to WebAssembly, the runtime the whole playground stands on.

  | Package | Used for |
  |---|---|
  | `@php-wasm/web-8-3`, `-8-4`, `-8-5` | The compiled PHP binaries, with their extensions and ICU data |
  | `@php-wasm/web` | Loading PHP in the browser, and PHP's network access through `fetch()` (`tcpOverFetch`) |
  | `@php-wasm/universal` | The `PHP` class, `PHPRequestHandler` (a request becomes a PHP run), `setPhpIniEntries` |
  | `@php-wasm/fs-journal` | Noting which files change, for saving a site as a small snapshot |
  | `@php-wasm/util` | Catching `sendmail` for the Mail inbox |
  | `@php-wasm/node` | Running Joomla with WebAssembly PHP in Node, for the integration tests |

  Other packages come with them as dependencies, such as `@php-wasm/web-service-worker` and `@php-wasm/logger`.
- **[`WP_MySQL_On_SQLite`](https://github.com/WordPress/sqlite-database-integration)** (`wordpress/mysql-on-sqlite`,
  Composer, version 3.1.1): MySQL emulated on SQLite, in pure PHP. The default database driver, `mysqlonsqlite`,
  is built on it, so Joomla runs its MySQL code and install SQL unchanged.

Written for this playground, though several parts follow WordPress Playground's ideas: the page, the PHP worker
and the service worker; the blueprints (in the shape of WordPress's Blueprints v1, with Joomla's own steps); the
CORS proxy; both Joomla database drivers, the schema converter and the bundle builds.

The demonstration data of the multilingual demo is by Clifford E Ford
([plugin](https://github.com/ceford/cefjdemos-plg-demodata), [module](https://github.com/ceford/cefjdemos-mod-demodata)).
