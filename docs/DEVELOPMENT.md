# Developing the Joomla Playground

How the playground is built, how to run it locally and how it is tested. For using the playground, see the
[README](../README.md).

## The database

In the browser, PHP (php-wasm) has SQLite but no MySQL or PostgreSQL server, and Joomla supports only MySQL and
PostgreSQL. The playground therefore brings its own database drivers, without changes to Joomla core:

- **`mysqlonsqlite`** (default): Joomla's MySQL schema as it is, on WordPress's
  [MySQL emulation for SQLite](https://github.com/WordPress/sqlite-database-integration). It behaves like MySQL
  and runs third-party MySQL install SQL. In WebAssembly it is 1.2–1.5× slower than the other driver.
- **`playgroundsqlite`**: Joomla's PostgreSQL schema, converted to SQLite. It is the faster fallback and
  behaves like PostgreSQL.

See [REPORT §10](REPORT.md) for the comparison.

## Parts

| Part | What it does |
|---|---|
| [`web/`](../web) | The browser playground: page, PHP worker, service worker (`@php-wasm/web`, Vite) |
| [`bin/build-browser-bundle.php`](../bin/build-browser-bundle.php) | Builds the pre-installed Joomla bundle for the browser |
| [`src/Database/SqliteDriver.php`](../src/Database/SqliteDriver.php) | Driver for `$dbtype = 'playgroundsqlite'`, built on the Joomla Framework's SQLite driver |
| [`src/Database/SqliteQuery.php`](../src/Database/SqliteQuery.php) | Query builder fixes: dates, `RANDOM()`, `REGEXP`, casts, `UPDATE … FROM`, window functions |
| [`src/Database/SqliteFunctions.php`](../src/Database/SqliteFunctions.php) | PHP versions of SQL functions SQLite lacks (`REGEXP`, `CONCAT`, `SOUNDEX`, …) |
| [`src/Database/MysqlOnSqlite/`](../src/Database/MysqlOnSqlite) | Driver for `$dbtype = 'mysqlonsqlite'`: Joomla's MySQL driver on `WP_MySQL_On_SQLite`, with emulated prepared statements |
| [`src/Schema/PostgresqlToSqliteConverter.php`](../src/Schema/PostgresqlToSqliteConverter.php) | Converts Joomla's PostgreSQL install SQL to SQLite |
| [`overlay/`](../overlay) | Files copied into the site: `defines.php` hooks that register the autoloader |
| [`extensions/plg_system_playground`](../extensions/plg_system_playground) | System plugin; for now it makes Global Configuration offer the playground database driver |
| [`wasm/`](../wasm) | Serves a site and runs its CLI with PHP in WebAssembly (`@php-wasm/node`) |
| [`bin/install-sqlite-site.php`](../bin/install-sqlite-site.php) | Installs a Joomla Full Package on SQLite, using Joomla's own installation models |

## The browser playground

You need PHP 8.3 or newer with `pdo_sqlite` and `zip`, Composer, and Node.js (24 recommended).

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
- `npm run bundle` downloads the Joomla release set by `JOOMLA_VERSION` in `phpunit.xml.dist` into `.cache/`,
  installs it and packs it for the browser (`web/public/joomla/`).
- `npm run web:dev` serves the playground.
- `npm run web:build` writes a static site to `web/dist/`, which any static web server can host. Service workers
  need `localhost` or HTTPS.
- The page starts PHP in a Web Worker and unpacks Joomla into memory. It then opens the administrator, already
  logged in.
- PHP 8.3, 8.4 and 8.5 are built in (`web/vite.config.js`); the others point to a stub.
- `VITE_CORS_PROXY` (at build time) sets a CORS proxy for blueprint downloads from hosts without CORS headers,
  as a URL prefix to which the encoded download URL is appended, e.g. `https://proxy.example.org/?url=`.
- Blueprints: `web/src/blueprint.js` reads them from the URL, `web/src/blueprint-steps.js` runs the steps in
  the PHP worker.

## Joomla on SQLite with native PHP

The same drivers work with native PHP, which is handy for debugging. Unpack a
[Joomla Full Package](https://github.com/joomla/joomla-cms/releases) in a folder, e.g. `joomla/`.

```bash
php bin/install-sqlite-site.php --site=joomla --admin-password=<your password> --live-site=http://127.0.0.1:8080
```

This uses the default `mysqlonsqlite` driver; add `--driver=playgroundsqlite` for the other one.

```bash
php -S 127.0.0.1:8080 -t joomla
```

Then open http://127.0.0.1:8080/administrator/. Joomla treats PHP's built-in web server (`cli-server`) as
CLI and cannot work out its base URL, which is why `--live-site` is needed with `php -S`.

### In WebAssembly, in Node

The same installed site can be served by PHP 8.4 compiled to WebAssembly.

```bash
npm run wasm:serve -- --site=joomla --port=8090
```

```bash
npm run wasm:cli -- --site=joomla -- user:list
```

The runner mounts the site folder into PHP's virtual filesystem at `/var/www/html`. It also updates `live_site`,
`tmp_path` and `log_path` in `configuration.php` to match.

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
  run web:build`) in headless Chrome: booting, forms, saving and reopening, export and import.

## Documents

- [REPORT.md](REPORT.md): the exploration and what was built, with measurements
- [PLAN.md](PLAN.md): the plan

`npm run docs:pdf` renders the documents to PDF with headless Chrome. The PDFs are not committed.
