# Joomla Playground — draft build plan

*Starting point for discussion. Builds on [REPORT.md](REPORT.md). Status 2026-10-22: phase 1 steps 1a (Joomla on SQLite), 1b (MySQL emulated on SQLite), 2 (Joomla in `@php-wasm/node`) and 3 (Joomla in the browser, first version) done, and the playground is public at <https://hermanpeeren.github.io/joomla-playground/>; next is the MVP (phase 2).*

## Goal

Anyone can open a URL and get a working, disposable Joomla site in their browser tab within seconds, with
no server, no account and no install. Developers can preconfigure that site with a URL or a JSON
"blueprint" (version, extensions, content, login). It is comparable to WordPress Playground and reuses its
runtime (`@php-wasm/*`) instead of rebuilding it.

## Guiding principles (taken from WordPress Playground)

1. **Reuse the runtime, own the CMS layer.**
   - Depend on `@php-wasm/web`, `/node`, `/universal` and `/web-service-worker` from npm.
   - Write only the Joomla-specific boot layer, build script and UI.
2. **No core fork.**
   - Everything for the playground is packaging, configuration, overrides through the autoloader, and
     plugins.
   - Core fixes we find go upstream as normal joomla-cms / joomla-framework PRs.
3. **Ship small, pre-installed builds.**
   - Minified Joomla with the static `media/` split out and a pre-built SQLite database.
   - No installer at boot.
4. **Prove risks cheaply first.**
   - Database before WASM, Node before browser, a minimal page before UI polish.
5. **Everything is GPL-2.0-or-later**, compatible with Joomla and the Playground packages.

## Phase 0: decisions and setup (½ day)

- Repository name and location (e.g. `joomla-playground` under a personal GitHub account first, perhaps
  `joomla-projects` later).
- Tooling:
  - Node LTS + TypeScript + Vite for the web part.
  - A PHP build script for the Joomla bundle.
- Pin versions: Joomla 6.2.0 Full Package, `@php-wasm/*` 3.1.x, PHP 8.4.
- Local test site under a git-ignored `/joomla` folder, per the usual conventions.

## Phase 1: proof of concept (≈ 2–3 weeks)

### Step 1a: Joomla on SQLite, natively (no WASM) · *highest risk, do first*

- Unpack the Full Package 6.2.0 with native PHP 8.3+ (WAMP) and pdo_sqlite.
- Create `sqlite/{base,extensions,supports}.sql` from the PostgreSQL install SQL.
  - Do this with a conversion script, kept in the repo, so it can be rerun per release.
- Write `JoomlaPlayground\Database\Sqlite` (or put a patched `SqliteQuery` / `SqliteDriver` in place):
  - `dateAdd`, `year`, `month`, `day`, `rand`, `regexp`, `currentTimestamp`;
  - REGEXP and date UDFs.
- Write `configuration.php` with `dbtype` set to the custom driver, the DB path, `session_handler=database`
  and `mailonline=0`.
- Smoke test:
  - Front end with sample data.
  - Admin login.
  - Create, edit and delete an article.
  - Menu items.
  - Batch copy (the UPDATE…JOIN path!).
  - Smart Search indexing.
  - Install an extension from a zip.
  - System → Database check.
- Write down every failure: it becomes the core-patch list and future upstream PRs.
- **Exit criterion:** core admin and front-end flows work on SQLite.

**Done (2026-10-22).** All of the above works, with no Joomla core changes and 112 automated tests (see
REPORT §9). The test list grew: sample data and installing a zip through the administrator are not yet
covered; the zip installer is exercised through the CLI. Differences from the plan:
- The SQLite schema is converted at install time instead of committed as `.sql` files.
- `mailonline` is left at the default for now.
- A system plugin (`plg_system_playground`) is needed for the Global Configuration form.

Left over for later:
- Install the sample data (Blog/Multilingual) in a test.
- Install an extension zip through the administrator upload.
- Smoke-test the Web Services API.
- Decide on case-insensitive comparisons (MySQL) versus case-sensitive ones (PostgreSQL, current).

### Step 1b: spike MySQL emulation (Option C) · *1–2 days, parallel with 1a*

- Vendor `WordPress/sqlite-database-integration/packages/mysql-on-sqlite`.
- Write a minimal Joomla `MysqlDriver`-style subclass that uses `WP_MySQL_On_SQLite`. It inlines bound
  parameters and splits multi-statements.
- Try running the **MySQL** install SQL and the same smoke test.
- **Outcome:** pick A, C, or A for core plus C as a "compat mode" for third-party extensions.

**Done (2026-10-22).** Joomla runs on the emulator (`$dbtype = 'mysqlonsqlite'`) with its MySQL install SQL
unchanged.
- **Tests:** the full suite passes on both drivers, and CI runs both. A test component that ships only MySQL
  SQL works on C, while on A it installs without its tables.
- **What C needed:**
  - emulated prepared statements;
  - workarounds for 6 emulator gaps: `TIME_FORMAT`, `CONCAT_WS`, `SOUNDEX`, `GROUP_CONCAT … SEPARATOR`,
    `VARBINARY` equality, `SHOW STATUS`.
- **Cost:** C is 1.3–2.6× slower per page with native PHP (REPORT §10).
- **Decision postponed to step 2:** measure both drivers in `@php-wasm/node`. If C's overhead in WebAssembly is
  acceptable, C becomes the default and A the fast fallback.
- **Follow-up:** report the emulator gaps upstream (WordPress/sqlite-database-integration).

### Step 2: Joomla in `@php-wasm/node` · *1–2 days*

- A small Node script:
  - `loadNodeRuntime('8.4')`;
  - mount or unpack the pre-installed site;
  - `PHPRequestHandler` on localhost.
- Check:
  - available extensions (gd, intl, zip, sodium/compat, pdo_sqlite);
  - 32-bit integer issues;
  - `SCRIPT_NAME`/`REQUEST_URI` and SEF URLs;
  - sessions and cookies through the cookie store;
  - uploads.
- Run the CLI with `php.cli(['cli/joomla.php', …])`.
- Run both database drivers (`playgroundsqlite`, `mysqlonsqlite`) and compare page times in WebAssembly, so the
  default driver can be chosen (see step 1b).
- Set `live_site`: if php-wasm reports a SAPI name containing "cli", Joomla's `Uri::base()` takes the CLI
  branch, as it does with `php -S`.

**Done (2026-10-22).** `wasm/joomla-wasm.mjs` serves and runs the CLI of an installed site in `@php-wasm/node`.
- **Tests:** all 73 integration tests pass in WebAssembly with both drivers, and CI runs them.
- **Checks:** `PHP_SAPI` is `wasm`, so Joomla needs no `live_site`; integers are 64-bit; `intl` is opt-in and
  `sodium` is missing, which `sodium_compat` covers.
- **Speed:** WebAssembly costs 5–8×. The MySQL emulation adds only 1.2–1.5× on top (REPORT §11).
- **Decided:** `mysqlonsqlite` is the default driver, and `playgroundsqlite` stays as the fast fallback
  (`--driver=playgroundsqlite`).
- **For step 3:**
  - Find out why OPcache does not report itself active, and try JSPI builds; both are speed levers.
  - Load the site into MEMFS instead of NODEFS.

### Step 3: Joomla in the browser · *3–5 days*

**Done, first version (2026-10-22)** (REPORT §12).
- **What works:** `web/` runs Joomla in a browser tab. It is ready about 2 s after the page loads (locally) and
  logs in automatically. Each tab gets its own scope.
- **Build:** `bin/build-browser-bundle.php` builds the pre-installed bundle.
- **Tests:** browser tests in headless Chrome, which also run in CI.
- **Still open from the list below:**
  - ~~deployment~~ done: <https://hermanpeeren.github.io/joomla-playground/>, published by the GitHub Pages workflow (started by hand);
  - Firefox and Safari;
  - `php -w` and vendor stripping;
  - `cookie_path`, which the worker's cookie store makes unnecessary for now.


- Build script, version 1:
  - Full Package → remove `installation/` → strip `*.gz` and extra languages → `php -w` → split `media/`
    into a static folder → `joomla-6.2.zip` plus `assets/`.
- Static web page (Vite) with `@php-wasm/web`, the service worker, a worker and an iframe, using the scope
  `/scope:<id>/`.
- Boot:
  - fetch the zip and unpack it into MEMFS;
  - write `configuration.php` with `live_site` and `cookie_path` for the scope;
  - generate a random admin password and auto-login.
- The service worker serves `media/` statically and routes the rest to `index.php` (the `.htaccess`
  fallback).
- Disable the lazy scheduler, the update checks, the stats plugin and com_joomlaupdate in the snapshot.
- Deploy to Cloudflare Pages or GitHub Pages (HTTPS needed for the service worker).
- **Exit criterion:** the URL opens a working Joomla site and admin in Chrome, Firefox and Safari.
  - Measure download size and boot time; target under 15 s on desktop.

**PoC deliverable:** a public demo URL, a short write-up with numbers (size, boot time, what breaks), and
the list of core/framework issues. Good material for a JoomlaDay talk or Joomla Magazine article, and a
pitch to the Joomla production department.

## Phase 2: MVP (≈ 1–2 months, part-time)

- **Persistence:** save to OPFS ("My playgrounds"), export and import as a zip.
  - **Done (2026-10-22)** (REPORT §13): Save…, reopen with `?site=`, My sites, Export, Import, New; one tab
    per saved site.
  - **Done:** faster saving and reopening. A saved site is its starting zip plus a snapshot of the changed
    files, instead of ~8,600 files in OPFS. Saving takes 0.3 s instead of 13 s; reopening takes 3.0–4.7 s
    instead of 7.6 s, 1–2 s more than a new playground.
  - **Done:** renaming a saved site (REPORT §15).
- **Query API:**
  - `?joomla=6.2|5.4|nightly&php=8.3|8.4|8.5&language=nl-NL&login=yes`
  - `?extension=<url to zip>`
  - `?url=/administrator/…` (landing page)
  - **Done (2026-10-22)** (REPORT §14): `php`, `url`, `login`, `extension`, `language` (an installed language),
    `blueprint-url`. Next: `joomla` needs bundles of more versions (see the build pipeline).
- **Blueprint v0** (JSON in the URL fragment or `?blueprint-url=`). Steps:
  - `installExtension`, `enableExtension`, `login`, `setGlobalConfig`, `runPHP`, `runSql`, `writeFile`,
    `unzip`, `importSampleData`, `setSiteLanguage`.
  - Keep the schema close to WordPress Blueprints v2 where it makes sense.
  - **Done (2026-10-22)** (REPORT §14): all ten steps, in the shape of WordPress's Blueprints v1
    (`preferredVersions`, `landingPage`, `login`, `steps`).
- **CORS proxy:** a Cloudflare Worker or the reusable `php-cors-proxy`, with an allow-list
  (downloads.joomla.org, update.joomla.org, GitHub releases, JED download hosts) and rate limits.
  - **Written (2026-10-22)** (REPORT §16): `proxy/cors-proxy.js`, a Cloudflare Worker with tests; blueprints use
    it when the build sets `VITE_CORS_PROXY`. Next: deploy it (needs a Cloudflare account).
- **Mail capture:** an in-app inbox showing the mails Joomla tries to send.
  - **Done (2026-10-22)** (REPORT §15): PHP's sendmail is caught by the worker and shown under Mail.
- **Build pipeline in CI:** build bundles for each supported Joomla version on release.
- **UI:** a simple toolbar (version picker, reset, export, open admin).
  - **Done (2026-10-22)** (REPORT §17): PHP version picker, Start over; Export and Site/Administrator were
    already there. A Joomla version picker waits for bundles of more versions.

## Phase 3: ecosystem (later)

- **CLI:** `npx joomla-playground` with `@php-wasm/node`, mounting an extension folder for development.
- **joomla-cms PR previews:**
  - a GitHub Action that builds the PR package and posts a "Test in Playground" link;
  - this would lower the barrier for PR testers a lot.
- **Extension developers:**
  - a GitHub Action for extension PR previews;
  - a "Try it" button on the JED, together with the JED team;
  - blueprints in extension repos.
- **Nightly and `?core-pr=` builds** through `build/build.php` in CI.
- **Upstream work:**
  - Complete `SqliteQuery` in joomla-framework/database.
  - Official SQLite support in joomla-cms (installer, SQL folders, ChangeItem) as an RFC to the
    maintainers. It is useful beyond the playground: zero-config local development and tests.
- **Documentation and outreach:** docs site, Joomla Magazine article, JoomlaDay talk, and maybe a GSoC 2027
  project idea (e.g. blueprints or PR previews).

## Open questions

1. Personal or community project from the start? Should we contact the Joomla production department or
   maintainers (and/or the TYPO3 Playground people at Macopedia) early?
2. Does an SQLite dialect in core seem acceptable to the maintainers, or should the playground rely on
   MySQL emulation (Option C) so core never needs to know?
3. Hosting: GitHub Pages (simplest), Cloudflare Pages + Worker (proxy and headers), or a joomla.org
   subdomain later?
4. Which use cases come first: newcomers trying Joomla, PR testing for joomla-cms, or extension demos?
   That decides the MVP order.

## Risks to watch

| Risk | Mitigation |
|---|---|
| SQLite gaps deeper than expected | Step 1a first, Option C as fallback |
| `INSERT OR REPLACE` UPDATE…JOIN emulation corrupts data | Test batch copy and Finder explicitly; patch or override |
| Bundle too large or boot too slow | Minify aggressively, split media, ship a pre-installed DB |
| MySQL-only third-party extensions | Translate their SQL at install time (Option C components) |
| php-wasm upstream changes | Pin versions; the packages are stable and widely used |
| Browser storage evicted | Export/import early; label playgrounds as disposable |
