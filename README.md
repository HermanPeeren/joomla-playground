# Joomla Playground

Joomla running entirely in the browser, comparable to [WordPress Playground](https://wordpress.org/playground/):
PHP compiled to WebAssembly, no server, no account, a disposable site in a browser tab.

**Status: proof of concept, step 1a.** Joomla 6.2 runs on SQLite with native PHP. The browser part does
not exist yet. See the [exploration report](docs/REPORT.md) and the [plan](docs/PLAN.md).

## Why SQLite first

In the browser, PHP (php-wasm) has SQLite but no MySQL or PostgreSQL server. Joomla supports only MySQL and
PostgreSQL, so the first question is whether Joomla can run on SQLite at all. That question does not need
WebAssembly. Native PHP with `pdo_sqlite` runs the same code, so this step answers it on the desktop.

It needs no changes to Joomla core:

| Part | What it does |
|---|---|
| [`src/Database/SqliteDriver.php`](src/Database/SqliteDriver.php) | Driver for `$dbtype = 'playgroundsqlite'`, built on the Joomla Framework's SQLite driver |
| [`src/Database/SqliteQuery.php`](src/Database/SqliteQuery.php) | Query builder fixes: dates, `RANDOM()`, `REGEXP`, casts, `UPDATE … FROM`, window functions |
| [`src/Database/SqliteFunctions.php`](src/Database/SqliteFunctions.php) | PHP versions of SQL functions SQLite lacks (`REGEXP`, `CONCAT`, `SOUNDEX`, …) |
| [`src/Schema/PostgresqlToSqliteConverter.php`](src/Schema/PostgresqlToSqliteConverter.php) | Converts Joomla's PostgreSQL install SQL to SQLite |
| [`overlay/`](overlay) | Files copied into the site: `defines.php` hooks that register the autoloader |
| [`extensions/plg_system_playground`](extensions/plg_system_playground) | System plugin; for now it makes Global Configuration offer the SQLite driver |
| [`bin/install-sqlite-site.php`](bin/install-sqlite-site.php) | Installs a Joomla Full Package on SQLite, using Joomla's own installation models |

## Try it

You need PHP 8.3 or newer with `pdo_sqlite`, Composer, and a
[Joomla Full Package](https://github.com/joomla/joomla-cms/releases) unpacked in a folder, e.g. `joomla/`.

```bash
composer install
```

```bash
php bin/install-sqlite-site.php --site=joomla --admin-password=<your password> --live-site=http://127.0.0.1:8080
```

```bash
php -S 127.0.0.1:8080 -t joomla
```

Then open http://127.0.0.1:8080/administrator/. Joomla treats PHP's built-in web server (`cli-server`) as
CLI and cannot work out its base URL, which is why `--live-site` is needed with `php -S`.

## Tests

```bash
composer test
```

- **Unit tests** (`tests/Unit`) check the converter, the query builder and the driver against an in-memory
  SQLite database.
- **Integration tests** (`tests/Integration`) install a fresh site and serve it with `php -S`, then run real
  flows over HTTP:
  - administrator views;
  - creating, editing, batch-copying and deleting articles;
  - categories and menu items (nested sets);
  - users;
  - Smart Search;
  - Global Configuration;
  - the scheduler and the CLI.

  The site is installed from the release set by `JOOMLA_VERSION` in `phpunit.xml.dist`, downloaded once into
  `.cache/`.

## Documents

- [docs/REPORT.md](docs/REPORT.md): phase 1 exploration (what WordPress Playground does, what Joomla needs)
- [docs/PLAN.md](docs/PLAN.md): plan for building it

`npm install && npm run docs:pdf` renders both to PDF with headless Chrome. The PDFs are not committed.

## License

GNU General Public License version 2 or later, like Joomla and WordPress Playground.
