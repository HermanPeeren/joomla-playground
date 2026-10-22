# Joomla Playground

Joomla running entirely in the browser, comparable to [WordPress Playground](https://wordpress.org/playground/):
PHP compiled to WebAssembly, no server, no account, a disposable site in a browser tab.

**Status: proof of concept, steps 1a–3.** Joomla 6.2 runs on SQLite (two database drivers), with native PHP,
with PHP in WebAssembly in Node, and **in the browser**. See the [exploration report](docs/REPORT.md) and the [plan](docs/PLAN.md).

**Try it:** <https://hermanpeeren.github.io/joomla-playground/>. Joomla starts in your browser tab, logged in to the administrator. Nothing is stored:
reloading the page gives a new site.

## Why SQLite first

In the browser, PHP (php-wasm) has SQLite but no MySQL or PostgreSQL server. Joomla supports only MySQL and
PostgreSQL, so the first question is whether Joomla can run on SQLite at all. That question does not need
WebAssembly. Native PHP with `pdo_sqlite` runs the same code, so this step answers it on the desktop.

There are two database drivers, both without changes to Joomla core:

- **`mysqlonsqlite`** (default): Joomla's MySQL schema as it is, on WordPress's
  [MySQL emulation for SQLite](https://github.com/WordPress/sqlite-database-integration). It behaves like MySQL
  and runs third-party MySQL install SQL. In WebAssembly it is 1.2–1.5× slower than the other driver.
- **`playgroundsqlite`**: Joomla's PostgreSQL schema, converted to SQLite. It is the faster fallback and
  behaves like PostgreSQL.

See [REPORT §10](docs/REPORT.md) for the comparison.

| Part | What it does |
|---|---|
| [`src/Database/SqliteDriver.php`](src/Database/SqliteDriver.php) | Driver for `$dbtype = 'playgroundsqlite'`, built on the Joomla Framework's SQLite driver |
| [`src/Database/SqliteQuery.php`](src/Database/SqliteQuery.php) | Query builder fixes: dates, `RANDOM()`, `REGEXP`, casts, `UPDATE … FROM`, window functions |
| [`src/Database/SqliteFunctions.php`](src/Database/SqliteFunctions.php) | PHP versions of SQL functions SQLite lacks (`REGEXP`, `CONCAT`, `SOUNDEX`, …) |
| [`src/Database/MysqlOnSqlite/`](src/Database/MysqlOnSqlite) | Driver for `$dbtype = 'mysqlonsqlite'`: Joomla's MySQL driver on `WP_MySQL_On_SQLite`, with emulated prepared statements |
| [`src/Schema/PostgresqlToSqliteConverter.php`](src/Schema/PostgresqlToSqliteConverter.php) | Converts Joomla's PostgreSQL install SQL to SQLite |
| [`overlay/`](overlay) | Files copied into the site: `defines.php` hooks that register the autoloader |
| [`extensions/plg_system_playground`](extensions/plg_system_playground) | System plugin; for now it makes Global Configuration offer the playground database driver |
| [`web/`](web) | The browser playground: page, PHP worker, service worker (`@php-wasm/web`, Vite) |
| [`bin/build-browser-bundle.php`](bin/build-browser-bundle.php) | Builds the pre-installed Joomla bundle for the browser |
| [`wasm/`](wasm) | Serves a site and runs its CLI with PHP in WebAssembly (`@php-wasm/node`) |
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

This uses the default `mysqlonsqlite` driver; add `--driver=playgroundsqlite` for the other one.

```bash
php -S 127.0.0.1:8080 -t joomla
```

Then open http://127.0.0.1:8080/administrator/. Joomla treats PHP's built-in web server (`cli-server`) as
CLI and cannot work out its base URL, which is why `--live-site` is needed with `php -S`.

### In WebAssembly

The same installed site can be served by PHP 8.4 compiled to WebAssembly, the runtime of WordPress Playground.
This needs Node.js (24 recommended).

```bash
npm install
```

```bash
npm run wasm:serve -- --site=joomla --port=8090
```

```bash
npm run wasm:cli -- --site=joomla -- user:list
```

The runner mounts the site folder into PHP's virtual filesystem at `/var/www/html`. It also updates `live_site`,
`tmp_path` and `log_path` in `configuration.php` to match.

## In the browser

```bash
composer install
```

```bash
npm install
```

```bash
npm run bundle
```

```bash
npm run web:dev
```

Then open http://localhost:5400/.
- `npm run bundle` installs a Joomla site and packs it for the browser (`web/public/joomla/`).
- `npm run web:dev` serves the playground.
- The page starts PHP in a Web Worker and unpacks Joomla into memory. It then opens the administrator, already
  logged in; the toolbar shows the Super User's password.
- Service workers need `localhost` or HTTPS.
- `npm run web:build` writes a static site to `web/dist/`, which any static web server can host.

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

  `JOOMLA_TEST_DRIVER` (`mysqlonsqlite`, the default, or `playgroundsqlite`) chooses the database driver.
  `JOOMLA_TEST_RUNTIME` (`native` or `wasm`) chooses whether PHP runs natively or in WebAssembly.
- **Browser tests** (`tests/browser`, `npm run test:browser`) run the built playground (`npm run bundle && npm
  run web:build`) in headless Chrome. The site is
  installed from the release set by `JOOMLA_VERSION` in `phpunit.xml.dist`, downloaded once into
  `.cache/`.

## Documents

- [docs/REPORT.md](docs/REPORT.md): phase 1 exploration (what WordPress Playground does, what Joomla needs)
- [docs/PLAN.md](docs/PLAN.md): plan for building it

`npm install && npm run docs:pdf` renders both to PDF with headless Chrome. The PDFs are not committed.

## License

GNU General Public License version 2 or later, like Joomla and WordPress Playground.
