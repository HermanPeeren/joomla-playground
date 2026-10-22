# Joomla Playground

A complete Joomla site in your browser tab: no server, no installation, no account. Try a Joomla version, test
an idea, show something to someone, and throw it away, or keep it in your browser for later.

**Open it:** <https://hermanpeeren.github.io/joomla-playground/>

After a few seconds you see Joomla's administrator, already logged in as a Super User. Everything runs in your
browser: PHP is compiled to WebAssembly, and the site and its database live in the tab's memory. Nothing is
sent to a server.

## Using the playground

The toolbar above the site:

| Button | What it does |
|---|---|
| **Site** / **Administrator** | Show the front end or the administrator of the site. |
| **New** | Start a new, empty playground. |
| **Save…** | Keep this playground in your browser under a name. From then on, changes are saved as you work. |
| **My sites** | Open, rename or delete the sites you saved. |
| **Mail** | The mails the site sent. They are caught here, not delivered: try a password reset or a contact form. |
| **Export** | Download the whole site as a zip. |
| **Import…** | Start a playground from such a zip, e.g. one someone sent you. |

On the right, the toolbar shows the Super User's name and password, in case you log out or want to see the site
as a logged-in user. Hover over the Joomla version for timings.

**Temporary or saved?**
- A new playground is temporary: reloading the page or closing the tab throws it away.
- After **Save…**, the address bar shows `?site=<name>`. That address reopens the site, also after a reload or a
  browser restart, and it is listed under **My sites**.
- A saved site stays in this browser only (in its private storage for this website). Use **Export** to move a
  site to another browser or computer, or to keep a copy elsewhere.
- A saved site can be open in one tab at a time.

**Good to know**
- Use a recent Chrome, Edge or other Chromium browser; Firefox and Safari are not tested yet.
- The site cannot reach the internet yet: installing extensions or languages from within Joomla and update
  checks do not work. A link or blueprint can install extensions (see below).
- The Mail inbox keeps the mails until the page is reloaded.
- Each tab is its own playground, with its own site and database.
- Clearing your browser's site data for this address deletes the saved sites.

## Setting up a playground with a link

A link can say how a new playground should look. Add these to the address:

| Parameter | Example | What it does |
|---|---|---|
| `php` | `?php=8.3` | PHP version: 8.3, 8.4 (default) or 8.5 |
| `url` | `?url=/index.php` | The page to open first; default `/administrator/` |
| `login` | `?login=no` | Start logged out |
| `extension` | `?extension=https://example.org/mod_hello.zip` | Install an extension package (repeatable) |
| `language` | `?language=nl-NL` | Make an installed language the site's default |
| `blueprint-url` | `?blueprint-url=https://example.org/blueprint.json` | Set up the site with a blueprint |

A **blueprint** is a small JSON file with the steps to set up a site. It can also be put in the address
itself, after `#`. For example, this one installs Joomla's blog sample data, renames the site and opens the
front end:

```json
{
  "preferredVersions": { "php": "8.4" },
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
| `enableExtension` | `element`, `type`, `folder`, `client` | Enable an extension, e.g. `{"element": "debug", "type": "plugin", "folder": "system"}` |
| `importSampleData` | `type` (default `blog`) | Install Joomla's sample data |
| `setGlobalConfig` | `values` | Set Global Configuration options (properties of `configuration.php`) |
| `setSiteLanguage` | `language`, `administrator` | Make an installed language the default |
| `runSql` | `sql` | Run SQL statements (MySQL syntax; `#__` is the table prefix) |
| `runPHP` | `code` | Run PHP code in the site's root folder |
| `writeFile` | `path`, `data` | Write a file into the site |
| `unzip` | `url`, `to` | Unpack a zip into the site |
| `login` | | Log in as the Super User (done by default) |

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
