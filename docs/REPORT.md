# Joomla Playground — Phase 1 exploration report

*Date: 2026-10-22 · Status: exploration only, nothing built · Reference release: Joomla 6.2.0*

*File and line references point into joomla-cms tag 6.2.0 and wordpress-playground trunk (2026-10-22). The
`research/…` paths are local shallow clones and are not part of this repository.*

## 1. Summary

A Joomla Playground (Joomla running fully in the browser, instantly, anonymously and disposably, like
[WordPress Playground](https://wordpress.org/playground/)) is **feasible**. Most of the hard work has
already been done by the WordPress Playground team and can be reused.

- **The PHP-in-WebAssembly runtime is CMS-agnostic and reusable as-is.** `@php-wasm/web`, `@php-wasm/node`
  and `@php-wasm/universal` are published on npm (v3.1.60, GPL-2.0-or-later, PHP 7.4–8.5). TYPO3's
  playground and a Laravel IDE (Liminal) already use them. That is years of work we don't have to repeat.
- **The real problem is the database.** Joomla supports only MySQL/MariaDB and PostgreSQL, and neither
  runs in a browser through php-wasm. WordPress solved this with a MySQL-to-SQLite translation layer.
  For Joomla there are three routes (§4). The most promising is **native SQLite**:
  - The Joomla Framework that Joomla 6.2 already ships contains an `SqliteDriver`.
  - The CMS has no runtime allow-list of database types.
  - Core SQL is nearly dialect-clean, because it must also run on PostgreSQL.
- **No core changes are needed for a proof of concept.** A PoC can be done with packaging, configuration
  and a few overridden classes. Official, maintained SQLite support would need core and framework PRs,
  listed in §6.
- **Nobody has built this yet.** No Joomla WASM attempt exists on GitHub, the forum or in GSoC ideas.
  - The only "try Joomla" offer is [launch.joomla.org](https://launch.joomla.org/). It is server-hosted,
    needs an account and is upsell-driven.
  - The closest precedents are the
    [TYPO3 One-Click Playground](https://news.typo3.com/archive/budget-idea-report-one-click-typo3-playground)
    (2025, also a non-SQLite-native CMS) and [Drupal's wasm trial](https://github.com/mglaman/wasm-drupal).
- **A quick proof of concept is realistic.** The database question can even be tested with native PHP on
  the desktop before touching WASM. See [PLAN.md](PLAN.md).
- **Update, 2026-10-22: step 1a is done.** Joomla 6.2.0 runs on SQLite with native PHP and no core changes,
  covered by 112 automated tests. See §9.
- **Update, 2026-10-22: step 1b is done.** Joomla also runs on WordPress's MySQL emulation for SQLite (Option C),
  with Joomla's MySQL SQL unchanged. Third-party MySQL-only extension SQL works there, and comparisons follow
  MySQL. It is slower and needed workarounds for 6 emulator gaps. See §10.
- **Update, 2026-10-22: step 2 is done.** Joomla runs in WebAssembly (`@php-wasm/node`) with both drivers, and
  the full test suite passes there. WebAssembly costs 5–8× natively; the MySQL emulation adds 1.2–1.5× on top.
  See §11.
- **Update, 2026-10-22: step 3 is done (first version).** Joomla runs in a browser tab: no server-side PHP, and
  it is ready about 2 s after the page loads (locally). The administrator is logged in automatically. The site,
  the administrator, forms, AJAX and static media work, and Chrome browser tests cover them. See §12.
- **Public playground:** <https://hermanpeeren.github.io/joomla-playground/> (GitHub Pages). It is ready about 6 s after the page loads, downloads included.
- **Update, 2026-10-22: phase 2, part 2.** A link sets up a new playground: PHP version (8.3, 8.4, 8.5),
  landing page, login, extensions to install, or a whole blueprint with steps such as sample data, global
  configuration and SQL. See §14.
- **Update, 2026-10-22: phase 2, part 1.** Playgrounds can be saved in the browser (OPFS), reopened after a
  reload, listed under "My sites", exported as a zip and imported again. A saved site is stored as its starting
  zip plus a snapshot of its changes: saving takes 0.3 s instead of 13 s, and reopening takes 1–2 s more than a
  new playground instead of 5 s more. See §13.

## 2. How WordPress Playground works, and what is reusable

```
 Browser tab
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Main page (UI, blueprint handling)                                       │
 │  └─ <iframe src="/scope:abc/…">  ◄── the CMS pages render here           │
 │        │ fetch()                                                         │
 │        ▼                                                                 │
 │  Service Worker ── intercepts same-origin requests ──► BroadcastChannel  │
 │        ▼                                                                 │
 │  Web Worker:  PHP.wasm (Emscripten)  +  PHPRequestHandler                │
 │                 │  rewrite rules / static file / .php                    │
 │                 ▼                                                        │
 │               MEMFS (in-memory files)  ◄─ persist ─► OPFS / IndexedDB    │
 │               SQLite database file in MEMFS                              │
 │               outbound HTTP: tcp-over-fetch ─► CORS proxy ─► internet    │
 └──────────────────────────────────────────────────────────────────────────┘
```

| Layer | WordPress Playground | Reusable for Joomla? |
|---|---|---|
| PHP compiled to WASM (8.5–7.4; JSPI + Asyncify builds; ~20 MB per version) | `@php-wasm/web-8-x`, `@php-wasm/node-8-x` | **Yes, unchanged** from npm. Joomla 6.2 needs PHP ≥ 8.3: fine. |
| PHP API, request handler, cookie store, process manager | `@php-wasm/universal` | **Yes, unchanged.** |
| Service worker, scopes (`/scope:<id>/`), worker comms | `@php-wasm/web-service-worker`, `@php-wasm/scopes` | **Yes.** |
| Outbound HTTP (curl/streams over fetch, TLS terminated in JS) | `@php-wasm/web` + `php-cors-proxy` | **Yes.** The proxy (PHP script) is reusable too. |
| Persistence (OPFS, fs-journal) | `@php-wasm/fs-journal`, website code | Yes, adapt the website code. |
| CMS boot: config, install, rewrite rules, environment patches | `@wp-playground/wordpress` (`boot.ts`, `wp-config.ts`, `platform-mu-plugins.ts`) | **No. Write a `joomla` equivalent** (core of our work). |
| Remote/client (iframe app, `startPlaygroundWeb()`) | `@wp-playground/remote`, `/client` | Fork and strip the WordPress parts. |
| Database | SQLite + `sqlite-database-integration` (MySQL→SQLite AST translator) | Partly. See §4. |
| Minified CMS builds (70 MB → 10 MB; static assets split out) | `@wp-playground/wordpress-builds` | Recipe reusable, write a Joomla build script. |
| Blueprints (JSON steps: install plugin, login, runPHP, …) | `@wp-playground/blueprints`, PHP runner in `WordPress/php-toolkit` | Concept reusable, Joomla-specific steps needed. |
| CLI / Node runner (`@wp-playground/cli`, wp-now) | npm | Pattern reusable via `@php-wasm/node`. |
| PR-preview GitHub Action, plugin-directory "Live preview", VS Code ext., Studio | playground-tools etc. | Later phases. |

**License:** every package is GPL-2.0-or-later, which is compatible with Joomla's GPL-2.0+. A distributed
bundle stays GPL.

**Things WordPress had to work around, which Joomla will hit as well:**
- `set_time_limit()` isn't supported.
- `gethostbyname` returns private IPs.
- Networking during install made it take 60–300 s, so networking is switched off then.
- `target="_top"` links and popups escape the iframe.
- Mail is captured in an in-app inbox, not sent.
- `exec`/`proc_open` are sandboxed.
- Memory is limited (64 MB initial, growable).
- Boot takes 5–10 s for a fresh site.

**Effort reference:** Playground started as a PoC by Adam Zieliński (Automattic) in 2022 and has grown to
~4,900 commits and ~160 contributors. Most of that effort went into the runtime (browser I/O, networking,
Asyncify, JSPI, binary size). We inherit that runtime; the CMS-specific layer is a much smaller job.

## 3. Joomla: what works out of the box

Based on a code analysis of tag 6.2.0 (clone in `research/joomla-cms`).

| Area | Finding | Consequence |
|---|---|---|
| **Paths** | All `JPATH_*` come from `dirname(__DIR__)` (`includes/defines.php`). | MEMFS paths work. |
| **Installation** | CLI installer `installation/joomla.php install` with `--db-type`, `--admin-*`, etc. `includes/framework.php:19-37` only needs a valid `configuration.php` and no `installation/` folder. | **Pre-install offline** and ship a DB snapshot + `configuration.php`. That is faster than WordPress, which installs at every boot. |
| **Sessions** | Handlers: database, filesystem, apcu, memcached, redis (`SessionFactory.php`). | Use `database`. |
| **Cookies** | `cookie_path` / `cookie_domain` configurable. | Use php-wasm's cookie store and the scope path. |
| **URLs / SEF** | `Uri::base()` uses `live_site` or `SCRIPT_NAME`. `sef_rewrite=0` gives `/index.php/alias` with no server rules. | Works. The service worker can also do the `.htaccess` fallback, so even `sef_rewrite=1` works. |
| **Uploads / extension install from zip** | `File::upload` + `Joomla\Archive` (ext-zip, or zlib-only fallback). | Should work (WordPress media uploads work in php-wasm). |
| **Processes** | `exec`/`pcntl`/`posix` only in `DaemonApplication` (unused on the web). No `proc_open`, `shell_exec`, `popen` or sockets. | Nothing blocks. |
| **Network on boot** | No outbound HTTP during a normal page load. Update checks run as AJAX after load. | Boot is not blocked. |
| **PHP extensions** | json, simplexml, dom, gd, xml, zlib, openssl, mbstring, iconv, hash, ctype, filter, sodium (or polyfill), intl (recommended). | All available in `@php-wasm` builds. `intl` is opt-in, sodium is polyfilled by `sodium_compat`. Verify per build. |
| **Database type at runtime** | No allow-list. `DatabaseFactory::getDriver()` builds `Joomla\Database\{Name}\{Name}Driver`. | `dbtype='sqlite'` works, and **any custom driver can be plugged in through the autoloader, without a core change.** |
| **SQL file selection** | Install, schema-update and extension SQL are all chosen by `getServerType()`. | An `sql/sqlite` folder would be picked up automatically. |

## 4. The database: the crux

Joomla 6.2's `installation/sql` has only `mysql` and `postgresql`. php-wasm has `pdo_sqlite`, and (in
the browser) no TCP, so no real MySQL or PostgreSQL server. No usable MySQL/MariaDB build for the browser
exists.

### Option A: native SQLite with the framework's SqliteDriver (recommended main route)

- `joomla/database` 4.0.0 (locked in 6.2.0) ships `Sqlite/SqliteDriver.php` and `SqliteQuery.php`.
  - They are unused by the CMS and untested in CMS CI.
- Core PHP is almost free of MySQL-isms, because of PostgreSQL support:
  - **Zero** `ON DUPLICATE KEY`, `INSERT IGNORE`, `REPLACE INTO`, `FIND_IN_SET` or `MATCH…AGAINST`.
  - Only **15 raw SQL literals**, all inside mysql/pgsql branches.
  - **26 `getServerType()` calls in 17 files.**
- **Gaps in `SqliteQuery`:** these methods fall back to MySQL syntax or empty output.
  - `dateAdd`: 8 callers, including com_content and privacy.
  - `year` / `month` / `day`: archive model and module.
  - `rand`: produces an empty `ORDER BY` (random modules, banners).
  - `regexp`: banners.
  - `currentTimestamp`.
- **Install SQL:** derive `sqlite/{base,extensions,supports}.sql` (~3k lines, 76 tables) from the
  **PostgreSQL** files, which are the easier source (separate `CREATE INDEX`, no inline KEYs).
- **Server-type branches to handle:**
  - Finder `Indexer.php` (`OPTIMIZE`/`VACUUM`, engine switching, UPDATE…JOIN).
  - `AdminModel.php:523` (UPDATE…JOIN for batch copy).
  - `com_admin/script.php`.
  - Schema ChangeItem: needs a `SqliteChangeItem`, otherwise Database Check throws.
  - Debug plugin.
- **Risks:**
  - `SqliteQuery` emulates UPDATE…JOIN as `INSERT OR REPLACE`. **This may wipe columns that aren't in the
    SELECT** and must be tested.
  - String comparison is case-sensitive (as on PostgreSQL).
  - The `ROW_NUMBER` UDF shadows the native window function.
  - Third-party extensions that ship only MySQL SQL are **silently skipped** by `Installer.php:1100`, so
    they install without tables.
- **Effort:** PoC without core PRs in ~1–2 weeks (ship an extended driver/query class through the
  autoloader). Official support: roughly 1–2k LOC of core/framework changes plus an SQL dialect to
  maintain per release.

### Option C: MySQL emulation on SQLite (WordPress's translator). Spike in parallel.

- [`WordPress/sqlite-database-integration`](https://github.com/WordPress/sqlite-database-integration)
  now has a standalone package, `packages/mysql-on-sqlite`.
  - `WP_MySQL_On_SQLite` is described as a "PDO MySQL drop-in for running MySQL-based PHP applications on
    SQLite".
  - It is AST-based, emulates MySQL 8.0 including INFORMATION_SCHEMA and SHOW, and is pure PHP, GPL-2.0+.
  - Latest release v3.1.1 (2026-10-21). Not on Packagist, so vendor it from git.
- Joomla would then run its **MySQL code paths and MySQL install SQL unchanged**, through a small custom
  `MysqlDriver` subclass. Zero core changes, and the **best compatibility with MySQL-only third-party
  extensions**.
- **Caveat:** its README says **prepared statements / parameter binding and multi-statement queries are
  "not yet supported"**. Joomla uses `->bind()` everywhere. The driver wrapper would have to inline bound
  values and split statements (feasible, but extra work), or we contribute that upstream.
- Each query is parsed in PHP, so it is slower. A native parser extension exists but requires JSPI.

### Option B: PostgreSQL in WASM (PGlite). Only as an experiment.

- Joomla's PostgreSQL support is first-class and CI-tested, so **no dialect work at all**.
- **No PHP bridge in `@php-wasm`.**
  - Only Sean Morris' separate php-wasm runtime has a [`pdo-pglite`](https://github.com/seanmorris/pdo-pglite)
    driver. It registers the DSN prefix `pgsql:`, so Joomla's `PgsqlDriver` *might* work unmodified.
  - That driver is a small project (v0.2.0, few users), and its async bridge, memory use and extra
    download add risk.
- TYPO3's playground tried PGlite first, then switched to SQLite.
- MySQL-only extensions still fail.

### Verdict

**Build the PoC on Option A (native SQLite) with `@php-wasm`, and spike Option C alongside** (a day or two)
to see whether the MySQL emulator can run Joomla's MySQL install. Option C would mean zero core work and
better extension compatibility. Run Option B as a 1-day curiosity at most.

**Shortcut:** the database question **doesn't need WASM to be answered.** Native PHP 8.3+ with
`pdo_sqlite` on the desktop (e.g. WAMP) runs the same `SqliteDriver`. Get Joomla working on SQLite
natively first, then move it into php-wasm.

## 5. Other limitations and hurdles

| Hurdle | Notes / mitigation |
|---|---|
| **Bundle size** | Full Package zip 33.3 MB; unpacked ~90–110 MB (estimate). Strip `installation/`, the `.gz` media duplicates (only used with Apache rules), extra languages and unused vendor parts. Run `php -w` and split `media/` out as static files served by the web server (as WordPress does with `wp-X.Y/`). Target: a few MB compressed. TYPO3's 100+ MB zip made its first load slow. |
| **The repo isn't runnable** | `includes/app.php:23` needs `libraries/vendor` and built `media/vendor`. Start from the release Full Package, or run `build/build.php` (composer + npm) for nightly or PR builds. |
| **Scope URLs** | `REQUEST_URI`, `SCRIPT_NAME` and `SCRIPT_FILENAME` must agree under `/scope:xyz/`. `SiteRouter.php:151` compares `realpath(SCRIPT_FILENAME)` with `JPATH_PUBLIC`. Set `live_site` and `cookie_path`. TYPO3 had the same issue. |
| **Iframe** | Joomla links with `target="_top"`, `window.top` references in admin JS, and TinyMCE iframes may escape the service worker. Needs testing (WordPress needed a TinyMCE fix). |
| **Outbound network** | CORS blocks the update server, JED/web installer (`appscdn.joomla.org`), install-from-URL and language packs. Use php-wasm's tcp-over-fetch + a **CORS proxy** (Cloudflare Worker or the reusable PHP proxy), or disable these. |
| **Single-threaded requests** | The lazy scheduler (on by default, 300 s) and the `update.notification` task can block the UI for up to 20 s. Disable them in the snapshot. |
| **Mail** | Set `mailonline=0`, or capture `mail()` into an in-app inbox as WordPress does. |
| **Not usable in the browser** | `com_joomlaupdate` (self-update), public-folder symlinks, the stats plugin. Disable or hide them in the snapshot. |
| **32-bit WASM integers** | ~~`PHP_INT_SIZE` is 4 on wasm32.~~ Not an issue: step 2 measured `PHP_INT_SIZE` = 8 in `@php-wasm` 3.1.60 (§11). |
| **Performance** | Expect 5–15 s boot and a sluggish admin on mobile. Fine for demos, trials and PR previews, not for daily development (Automattic's Studio moved to native PHP for that reason). |
| **Persistence** | Browser storage can be evicted. Offer export/import (zip) early. |
| **Extensions with MySQL-only SQL** | Under Option A they install without tables. Mitigate with a system plugin that translates MySQL install SQL on install, or by choosing Option C. |
| **Browser support** | JSPI ships in Chrome/Edge 137+, Firefox ~153+ and Safari 27. Keep the Asyncify builds as a fallback (`@php-wasm/web` picks one automatically). |

## 6. Required adaptations: outside core vs. core

**Outside core (enough for a PoC and even a first public playground):**
- Build script:
  - Start from the Full Package.
  - Pre-install on SQLite.
  - Remove `installation/`.
  - Strip `.gz` files and languages.
  - Split `media/` out as static assets.
  - Run `php -w`.
  - Pack as `.zip`/`.tar.zst`.
- `configuration.php` template:
  - `dbtype` sqlite (or a custom driver), `db` path.
  - `session_handler=database`, `cache_handler=file`, `caching=0`, `gzip=0`.
  - `mailonline=0`.
  - `live_site` and `cookie_path` for the scope.
  - Absolute `tmp_path` / `log_path`.
- Extended `SqliteQuery`/`SqliteDriver` (`dateAdd`, `year`/`month`/`day`, `rand→RANDOM()`, `regexp`,
  `currentTimestamp`, plus REGEXP/date UDFs), loaded through the autoloader as a custom driver type.
- In the snapshot, disable the stats plugin, web installer, update quickicons, lazy scheduler (or the
  update task) and com_joomlaupdate.
- JS boot layer (equivalent to `@wp-playground/wordpress`): unpack, write config, rewrite rules, environment
  patches, and a login helper. Admin auto-login and a password per session.
- Optional: a system plugin that translates MySQL extension SQL at install time.

**Core patches for the PoC:** none turned out to be needed (§9).
- Finder's `optimize()` statements are rewritten by the driver.
- UPDATE…JOIN (Finder, `AdminModel` batch copy) is rendered as `UPDATE … FROM` by the query builder.

**Core PRs, needed only for *official* SQLite support in Joomla:**
- Installer allow-list (`installation/forms/setup.xml:63`).
- `DatabaseHelper` checks for host/user/minimum version.
- `installation/sql/sqlite/*` and `com_admin/sql/updates/sqlite/*`.
- `Schema/ChangeItem/SqliteChangeItem.php`.
- Fall back to MySQL in `Installer.php` driver matching.
- The `BannersModel:200` regex.

**Framework PR (joomla-framework/database):**
- Complete `SqliteQuery`.
- Revisit the ROW_NUMBER UDF and the UPDATE…JOIN emulation.

Official SQLite support would benefit Joomla beyond the playground: zero-config local dev, CI, tests and
tiny sites. It needs a decision by the Joomla maintainers and CMS release team, so it is a separate track
from the playground.

## 7. What a Joomla Playground could offer (feature parity map)

| WordPress Playground feature | Joomla equivalent | Phase |
|---|---|---|
| Instant site in the browser | Joomla 6.x on SQLite in php-wasm | PoC |
| `?php=8.4&wp=6.8` query API | `?php=8.4&joomla=6.2` | MVP |
| Blueprints (JSON steps) | "Joomla Blueprints": installExtension (URL / JED / zip), login, setGlobalConfig, runPHP, runSql, writeFile, importContent, setLanguage | MVP → v1 |
| `?plugin=slug` from wordpress.org | `?extension=<url>` (JED has no uniform download API; needs a CORS proxy) | v1 |
| Save in browser (OPFS), export/import zip | Same, through fs-journal / OPFS | MVP |
| Playground CLI / wp-now | `npx joomla-playground` with `@php-wasm/node`, mounting an extension folder | v1 |
| PR previews (GitHub Action) | "Preview this joomla-cms PR / extension PR": very valuable for joomla-cms testers (the PR testing workflow) | v1–v2 |
| Plugin directory "Live preview" | JED "Try it" button (needs JED cooperation) | v2 |
| Nightly / core PR builds (`?core-pr=`) | Nightly and PR builds (needs `build/build.php` in CI) | v2 |
| Multisite, WP-CLI | Joomla CLI (`cli/joomla.php`) via `php.cli()`, multilingual sites | v2 |

## 8. Can we make a quick proof of concept?

**Yes.** The fastest credible PoC, in three short steps (details in [PLAN.md](PLAN.md)):

1. **Joomla on SQLite, natively** (no WASM). Native PHP + pdo_sqlite, Full Package 6.2.0, a translated
   SQLite schema, `configuration.php` with `dbtype=sqlite` and the extended driver. Goal: front-end and
   admin work, and an article can be created. *About 2–5 days.* In parallel, spike Option C.
2. **Joomla in `@php-wasm/node`** (Node, no browser). Mount the pre-installed site and serve it with
   `PHPRequestHandler`. That shows the WASM build works (extensions, 32-bit, paths). *About 1–2 days.*
3. **Joomla in the browser.** A minimal static page: `@php-wasm/web` + service worker + iframe, loading
   the pre-installed zip into MEMFS. No persistence, no blueprints yet. *About 3–5 days.*

So a demo "Joomla in a browser tab" is about **2–3 weeks** of focused work, with the database layer as the
main uncertainty. Step 1 resolves most of that risk cheaply.

## 9. Step 1a result: Joomla on SQLite, natively (2026-10-22)

Joomla 6.2.0 (Full Package) runs on SQLite with PHP 8.3 and `pdo_sqlite`, with **no change to any Joomla core
file**. The code is in this repository:
- `src/`: driver, query builder, SQL functions, schema converter;
- `overlay/`: autoloader hooks;
- `extensions/plg_system_playground`: system plugin;
- `bin/install-sqlite-site.php`: installer.

**How it plugs in**
- Joomla includes a root `defines.php` (and `administrator/defines.php`, `api/defines.php`) before anything
  else. Our versions only register an autoloader.
- `DatabaseFactory` derives the driver class from `$dbtype`, so `$dbtype = 'playgroundsqlite'` loads our driver.
  That driver extends the Joomla Framework's `SqliteDriver`.
- Our driver reports server type `sqlite`, so Joomla takes its non-MySQL code paths, the ones written for
  PostgreSQL.
- Installation reuses Joomla's own installation models:
  - `DatabaseHelper::getDbo()` keeps its first connection, so the models run on our driver.
  - `ConfigurationModel::setup()` writes configuration.php, the schema version, the manifest caches and the
    Super User.
- The schema is converted automatically from `installation/sql/postgresql`: 76 tables and 343 statements, with
  no hand-written SQL.

**What had to be solved.** Each item is covered by a test.

| Problem | Where | Solution |
|---|---|---|
| Backslash escapes in the PostgreSQL SQL (Joomla runs it with `standard_conforming_strings = off`) | install SQL | Converter decodes literals |
| `setval()` sequence positions; `#__` is not replaced inside quoted strings | install SQL | Converter returns them; installer writes `sqlite_sequence` |
| PL/pgSQL `soundex()` function; PostgreSQL date expressions in scheduler tasks | install SQL | Dropped / translated; `SOUNDEX()` as a PHP function |
| `getNumRows()` is 0 for every SELECT (PDO `rowCount()` on SQLite) | every grouped list count (`_getListCount()`), e.g. Smart Search said "no results" | Driver counts by fetching |
| `insertObject()` with id 0 stored 0 instead of a new id (MySQL generates one) | every new item: articles got id 0 | Driver leaves key 0 out, like the PostgreSQL driver |
| Column defaults reported with SQL quotes (`''`) | `Table::reset()` | Driver unquotes |
| Framework emulates UPDATE…JOIN with `INSERT OR REPLACE` (deletes/re-inserts rows, loses columns) | Smart Search, batch copy | Query builder uses `UPDATE … FROM` (SQLite 3.33+) |
| `DATE_ADD`, `YEAR()`…, `RAND()`, `REGEXP`, `CURRENT_TIMESTAMP()` fall back to MySQL syntax | content filters, random modules, banners, privacy, tasks | Query builder overrides |
| `VACUUM table` / `REINDEX TABLE table` | Smart Search optimize | Driver rewrites them |
| `CONCAT()` missing before SQLite 3.44 | Smart Search, install SQL | PHP function |
| Global Configuration: Database Type list has only framework drivers; Database Username is required | saving Global Configuration failed | `plg_system_playground` replaces the field; installer writes a placeholder user |
| `php -S` reports SAPI `cli-server`; `Uri::base()` treats it as CLI | wrong asset URLs in the administrator | `$live_site` (`--live-site`). **Relevant for WASM too:** set `live_site` in the playground. |

**Tests.** 40 unit tests and 72 integration tests. The integration tests install a fresh 6.2.0 site, serve it
with `php -S` and exercise it over HTTP:
- 48 administrator views and the Database check;
- the article life cycle (create, view on the site, edit with versions, batch copy, trash, delete);
- nested categories and menu items, with a nested-set consistency check;
- user creation;
- site login;
- Smart Search indexing (CLI) and searching;
- the scheduler;
- CLI commands;
- saving Global Configuration.

**Still open**
- Semantics follow PostgreSQL rather than MySQL. String comparison is case-sensitive, for example on usernames
  at login.
- Third-party extensions ship MySQL/PostgreSQL SQL, which is skipped on SQLite (Option C or a translation step).
- There are no `updates/sqlite` files (an empty placeholder sets the schema version), so updating a site to a
  later Joomla version is not supported. Not needed for a playground.
- Not yet tested: multilingual sites, workflows enabled, banners with keywords, the Web Services API.

## 10. Step 1b result: MySQL emulated on SQLite (2026-10-22)

The second database strategy (Option C) also works. Joomla 6.2.0 runs on WordPress's MySQL emulation for SQLite
(`wordpress/mysql-on-sqlite` 3.1.1, `WP_MySQL_On_SQLite`), with no Joomla core changes.
- **Setup:** `$dbtype = 'mysqlonsqlite'` loads `MysqlOnSqliteDriver`, a subclass of Joomla's own
  `Joomla\Database\Mysql\MysqlDriver`.
- **Joomla sees MySQL:** server type `mysql`, MySQL code paths, and **its MySQL install SQL as it is**, run
  through Joomla's own `DatabaseModel::populateDatabase()`.
- **No conversion needed:** no schema converter, no sequence handling, no placeholder update files. The MySQL
  update SQL exists, so the Database check works normally.
- **Same test suite:** the installer (`--driver=mysqlonsqlite`) and the whole test suite run with either driver.
  CI runs both.

**What the driver adds**
- **Emulated prepared statements.** The emulator has no `prepare()` or parameter binding yet, and Joomla
  prepares every query. `EmulatedPreparedStatement` inlines bound values, quoted by the emulator with MySQL's
  escaping rules, outside string literals, quoted identifiers and comments. This is how PDO's
  `ATTR_EMULATE_PREPARES` works too, and Joomla's MySQL driver turns that on as well.
- **Workarounds for gaps in the emulator 3.1.1.** Each one is worth reporting upstream:

| Gap | Hit by | Workaround |
|---|---|---|
| `TIME_FORMAT()` not supported | install SQL (scheduler tasks) | PHP function on the SQLite connection |
| `CONCAT_WS()` missing (SQLite < 3.44) | saving articles and categories | PHP function |
| `SOUNDEX()` missing | Smart Search indexing on save | PHP function |
| `GROUP_CONCAT(… SEPARATOR …)` / `ORDER BY` passed to SQLite untranslated | CLI `user:list` | Query builder leaves out the default `SEPARATOR ','` |
| `VARBINARY` is stored as BLOB and never equals a string, so `WHERE session_id = '…'` finds nothing | **every login** (`#__session.session_id`) | Installer maps `varbinary(n)` to `varchar(n)` |
| `COLLATE utf8mb4_bin` columns still compare case-insensitively | (not hit in core so far) | none |
| `SHOW SESSION STATUS` not supported | System Information | Driver reports no TLS |
| `rowCount()` is 0 for SELECT (as with PDO SQLite) | grouped list counts | Same `getNumRows()` fix as the SQLite driver |

**Comparison.** Same machine, PHP 8.3 with `php -S`, median of 8 requests.

| | playgroundsqlite (A) | mysqlonsqlite (C) |
|---|---|---|
| Install from the Full Package | 6.1 s | 6.7 s |
| Database size after install | 1.6 MB | 2.0 MB |
| Site home / category page | 48 / 52 ms | 64 / 136 ms |
| Admin dashboard / articles / menu items | 79 / 58 / 67 ms | 129 / 107 / 148 ms |
| Admin extensions list | 492 ms | 793 ms |
| Extra code | converter + driver | driver + emulator (~870 KB PHP) |
| Semantics | PostgreSQL: case-sensitive (`ADMIN` cannot log in as `admin`) | MySQL: case-insensitive (`ADMIN` logs in) |
| Extension with MySQL-only install SQL | installs "successfully" **without its tables** | works |
| Per Joomla release | re-run the converter; there is no SQLite update SQL | nothing: Joomla's MySQL SQL is used as it is |
| Maturity | our code, 112 tests | emulator is built for WordPress; Joomla's SQL found 6 gaps in a day |

All of these are covered by tests:
- **Unit:** 54 tests, including 14 for the emulator driver and the placeholder inlining.
- **Integration:** 73 tests per driver, including `ExtensionSqlTest`, which installs a component that ships only
  MySQL SQL.

**Assessment**
- **C is the better fit for a playground** that should also demo extensions:
  - real MySQL semantics, which is what Joomla and extension developers test against;
  - extension SQL works;
  - no schema conversion to maintain.
- **Its costs:**
  - pages are 1.3–2.6× slower natively, because every query goes through a PHP lexer and parser, and under
    WebAssembly this will be slower still;
  - the gaps found, which upstream fixes would solve (the project is active, with 3 releases in October 2026).
- **A is faster and simpler, but:**
  - it needs a translation step for extension SQL;
  - it behaves like PostgreSQL.

**Recommendation**
- Keep both drivers behind the same installer.
- Decide in step 2 (`@php-wasm/node`), where the emulator's overhead can be measured in WebAssembly.
- If that overhead is acceptable, make C the default and keep A as the fast fallback.
- Report the gaps to WordPress/sqlite-database-integration.

## 11. Step 2 result: Joomla in WebAssembly, in Node (2026-10-22)

Joomla 6.2.0 runs on PHP 8.4 compiled to WebAssembly (`@php-wasm/node` 3.1.60, the runtime WordPress Playground
uses) with **both** database drivers. There are no Joomla core changes, and no changes to `@php-wasm`.

**How it runs** (`wasm/joomla-wasm.mjs`)
- The site folder is mounted into PHP's virtual filesystem at `/var/www/html` (NODEFS).
- `PHPRequestHandler` serves it behind a plain Node HTTP server (`npm run wasm:serve -- --site=…`).
- Unknown site paths go to `index.php` (SEF URLs), as Joomla's `.htaccess` does.
- The browser keeps the cookies.
- The Joomla CLI runs through `php.cli()` (`npm run wasm:cli -- --site=… -- user:list`).
- The runner points `tmp_path`, `log_path` and `live_site` in `configuration.php` at the virtual filesystem and
  the served URL.

**Tests:** all 73 integration tests pass in WebAssembly with both drivers (`JOOMLA_TEST_RUNTIME=wasm`), the CLI
tests included. CI runs WebAssembly jobs next to the native ones.

**What the plan asked to check**

| Check | Result |
|---|---|
| PHP extensions | pdo_sqlite (SQLite **3.51**), gd, zip, mbstring, openssl, dom, simplexml, curl, fileinfo, … are present. `intl` is opt-in (`withIntl`); `sodium` is missing, but Joomla ships `sodium_compat`. |
| 32-bit integers | Not an issue: `PHP_INT_SIZE` is **8**. |
| `SCRIPT_NAME` / `REQUEST_URI` / SEF URLs | Work. `PHP_SAPI` is `wasm`, not `cli`, so Joomla finds its URLs **even without `live_site`** (checked), unlike with `php -S`. |
| Sessions and cookies | Work (logins, CSRF tokens, the whole admin suite). |
| Uploads / install from folder | Work (extension install from a folder in the virtual filesystem). |
| CLI | Works: `user:list`, `extension:list`, `finder:index`, `scheduler:run`. |
| Node version | `@php-wasm/node` declares Node ≥ 24.18, but runs on Node 20 with the Asyncify build. CI uses Node 24. One option has to be passed: `processId`. |

**Speed.** Same site and machine, median of 6 warm requests. A = `playgroundsqlite`, C = `mysqlonsqlite`.

| Page | native A | native C | wasm A | wasm C |
|---|---|---|---|---|
| Site home | 40 ms | 58 ms | 306 ms | 376 ms |
| Site category | 57 ms | 112 ms | 326 ms | 504 ms |
| Admin dashboard | 59 ms | 110 ms | 501 ms | 727 ms |
| Admin articles | 70 ms | 130 ms | 370 ms | 565 ms |
| Admin menu items | 70 ms | 171 ms | 410 ms | 589 ms |
| Admin extensions | 388 ms | 504 ms | 521 ms | 627 ms |

- WebAssembly itself costs 5–8× (Asyncify build, files read from the host through NODEFS). The first request
  takes about 2 s (warm-up).
- **In WebAssembly the MySQL emulation adds only 1.2–1.5×**, against up to 2.6× natively. PHP execution
  dominates, so the emulator's share shrinks.
- OPcache is switched on in the ini, but `opcache_get_status()` does not report it as active. If every request
  recompiles Joomla's code, that is the biggest lever for speed. Worth investigating in step 3, together with
  JSPI builds.

**Driver decision (from step 1b).** C's overhead under WebAssembly is moderate: 70–230 ms per page on top of
300–500 ms. That makes C the recommended default for the playground:
- MySQL semantics;
- third-party MySQL install SQL works;
- no schema maintenance per Joomla release.

A stays available as the fast fallback.

**Decided (2026-10-22):** `mysqlonsqlite` is now the installer's default driver; `--driver=playgroundsqlite`
selects A.

## 12. Step 3 result: Joomla in the browser (2026-10-22)

The playground (`web/`) runs Joomla 6.2.0 entirely in the browser:
- PHP 8.4 in WebAssembly (`@php-wasm/web` 3.1.60);
- the `mysqlonsqlite` driver;
- a pre-installed site, unpacked into PHP's in-memory filesystem.

A static web server is enough: there is no PHP on the server.

**How it works**

```
 Browser tab  (index.html + main.js: toolbar, status, iframe)
   iframe -> <playground>/scope-<id>/administrator/...
       | fetch
       v
 Service worker (sw.js)
   |- /scope-<id>/media/...  -> served directly from the static bundle (joomla/media/)
   '- everything else        -> BroadcastChannel -> PHP worker of the tab that owns scope-<id>
                                                    PHPRequestHandler + PHP 8.4 (WebAssembly)
                                                    site in MEMFS (/var/www/html), SQLite database
                                                    cookie store: the session stays in the worker
```

- **Build** (`bin/build-browser-bundle.php`):
  - installs the Full Package with the default driver and applies playground settings: no update checks, no
    statistics prompt, no lazy scheduler, no mail;
  - removes build sources (`.gz`, `.scss`, `.ts`, `.map`) and caches;
  - packs the PHP part as `site.zip` and copies `media/` as static files.
- **Media placeholders:** Joomla checks with `is_file()` that media files exist before it links them, so
  `site.zip` contains empty placeholders for them, plus the real `.json` asset definitions.
- **Boot** (`php-worker.js`):
  1. Load PHP.
  2. Download and unpack `site.zip`.
  3. Set `live_site` to the tab's scope URL, and the paths to the virtual filesystem.
  4. Set a new random Super User password.
  5. Log in through the request handler, so the administrator opens already logged in.
- **Scopes:** every tab gets its own scope (`scope-<id>`), so tabs run independent sites.

**Size and speed**
- **On the server:** `web/dist` is 133 MB. That includes PHP's WebAssembly binary in two variants (JSPI and
  Asyncify, 20 MB each) and the `intl` data (38 MB), which is only loaded when `intl` is enabled.
- **A visitor downloads:**
  - one PHP binary (20 MB, 7.7 MB gzipped);
  - `site.zip` (17.8 MB);
  - the media files that the pages use (31.7 MB in total).
- **Boot,** measured in Chrome against a local server, so without network time:

| PHP loaded | site.zip downloaded | unpacked | configured | logged in (ready) |
|---|---|---|---|---|
| 0.2 s | 0.3 s | 1.1 s | 1.4 s | 2.0 s |

- **Pages:** like `@php-wasm/node` in step 2, a few hundred ms per page. Creating an article through the
  administrator form takes about 3 s in the browser test, including loading the form and the article list.

**What had to be solved**

| Problem | Solution |
|---|---|
| A single PHP instance rejects a request that arrives while another one runs (`SinglePHPInstanceManager`), so the dashboard's simultaneous AJAX calls got HTTP 500 | Queue the requests in the worker (and in the Node runner), as `php -S` does |
| Chrome rejects a constructed 3xx `Response` for a page navigation (`ERR_ABORTED`) | The service worker answers redirects with `Response.redirect()` |
| `administrator/cache/autoload_psr4.php` (Joomla's namespace map) holds absolute build paths: "class does not exist" | The build empties Joomla's caches; Joomla rebuilds them in the browser |
| Without network, the "Automated Update" dashboard widget blocks PHP for 20 s per call, and the queued requests behind it | `plg_quickicon_autoupdate` is disabled in the bundle, like the other update checks |
| Joomla only links media files that exist | Empty placeholders in `site.zip`; the service worker serves the real files |
| Cookies cannot be set by a service worker response | The worker's cookie store (`HttpCookieStore`) keeps the session; the service worker drops `Set-Cookie` |
| Vite: `@php-wasm/universal` must be pre-bundled (CommonJS dependency `ini`); all PHP versions would be shipped | Only `@php-wasm/web` is excluded from pre-bundling; PHP versions other than 8.4 are aliased to a stub |

**Tests:** `tests/browser/playground.test.mjs` runs the production build in headless Chrome. It covers:
- boot and auto-login;
- media served directly with the right content type;
- saving an article through the administrator form;
- the article on the site;
- a second tab getting its own site and database.

CI runs it in a separate job. The Claude desktop app's built-in browser pane does not allow service workers;
real Chrome does.

**Not yet**
- **Persistence:** reloading the page starts a new, empty playground.
- **Outbound network:** no extension installs from a URL, no update checks. This needs `@php-wasm`'s
  TCP-over-fetch and a CORS proxy.
- **Speed:** OPcache and JSPI.
- **Smaller downloads:** strip `libraries/vendor`; `php -w`.
- **Browser coverage:** Firefox and Safari are untested.
- ~~A public URL~~ Done: <https://hermanpeeren.github.io/joomla-playground/>.
  - It is published to GitHub Pages by `.github/workflows/pages.yml`, started by hand.
  - In headless Chrome it was ready in 5.9 s, downloads included: PHP after 1.9 s, Joomla downloaded by 3.9 s,
    logged in at 5.9 s.
- **Blueprints and the query API.**

## 13. Phase 2, part 1: saving, export and import (2026-10-22)

A playground can now outlive the tab.
- **Save…** keeps the running site in the browser, in the **Origin Private File System** (OPFS).
  - OPFS is storage that browsers give each website: a private file system that only that site can read and
    write ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system),
    [web.dev](https://web.dev/articles/origin-private-file-system)).
  - The page URL becomes `?site=<name>`.
  - The playground asks the browser for persistent storage, so the site is not evicted when storage runs low.
- **Reopening** `?site=<name>`, also after a reload or a browser restart, unpacks the saved site from OPFS into
  PHP's memory instead of downloading the bundle. Each saved site keeps its Super User password.
- **My sites** lists the saved sites, which can be opened or deleted.
- **Export** downloads the whole site as a zip, without caches, logs or temporary files. The zip comment
  records the Joomla version and driver.
- **Import** starts a new, temporary playground from such a zip; it can then be saved again. Importing an
  export of another Joomla version gives a warning, because the media files come from the playground's own
  bundle.
- **New** starts a new temporary playground.

**How it works**
- A saved site is stored as two zips, not as its ~8,600 files:
  - the **base**: the zip the site started from (the bundle's `site.zip`, or an imported export), stored once
    and shared by every site made from it;
  - a **snapshot**: the files that differ from the base, plus a list of the paths deleted from it.
- **Change tracking:** `journalFSEvents()` from `@php-wasm/fs-journal` (the journal WordPress Playground uses)
  notes every path below the document root that PHP writes, creates, deletes or renames. The set of changed paths
  grows for the lifetime of the site; a reopened site starts with the paths in its snapshot.
- **When a snapshot is written** (PHP zips the changed paths with `ZipArchive`; the worker writes the zip to OPFS):
  - when the site is saved;
  - after a form submission (any request but GET and HEAD) that changed files, before the next request runs: a
    page that shows "Article saved." comes after the snapshot with the article;
  - after other requests that changed files (sessions in the database, caches): 0.5 s after the last one, at most
    5 s after the first;
  - when the page is hidden or closed (`visibilitychange`, `pagehide`).
  Snapshots run in the PHP request queue, so no request changes files while one is taken.
- **Crash safety:** `createWritable()` writes to a temporary file that replaces the old snapshot only when it is
  complete. A crash or a closed tab mid-write leaves the previous snapshot. On saving, the base and the first
  snapshot are written before `meta.json`; a site without `meta.json` is not listed.
- **Reopening** reads the base and the snapshot from OPFS while PHP loads, unpacks the base, then removes the
  deleted paths and writes the changed files.
- **Storage layout** (`web/src/storage.js`):
  - `joomla-playground/bases/<sha-256>.zip`;
  - `joomla-playground/sites/<slug>/snapshot.zip`;
  - `joomla-playground/sites/<slug>/meta.json`: title, password, Joomla version, base and dates.
  Deleting a site also deletes the bases that no other site uses.
- **First version (before snapshots):** `@php-wasm/web` mounted an OPFS folder with all files of the site at the
  document root (`createDirectoryHandleMountHandler`), with an initial copy and a journal written after every
  request. With ~8,600 files, saving took 13 s and reopening 7.6 s.
- **One tab per saved site:** two PHP workers writing the same files would overwrite each other. A Web Lock
  (`navigator.locks`) per site enforces this. A second tab gets a message. After a reload, the new page waits up
  to 5 s for the previous page's worker to let go.
- **Page and worker** talk through a small request/response protocol (boot, save, export).

**Measured** (headless Chrome, local server; three runs of the browser tests, the last one while another build
ran on the same machine):

| Action | First version (all files in OPFS) | Snapshots |
|---|---|---|
| New playground from the bundle (ready) | 2.3 s | 2.0–3.7 s |
| Save | 13 s | 0.26–0.34 s |
| Snapshot after a change (~156 KB zip) | (journal after every request) | 50–115 ms |
| Reopen a saved site (ready) | 7.6 s, of which copying OPFS → memory is 5.4 s | 3.0–4.7 s: 1–2 s more than a new playground in the same run |
| Export | 17.8 MB zip | 17.8 MB zip |
| Import (ready) | 1.9 s | 2.2–3.0 s |

Reopening now costs about what a new playground costs: reading the base from OPFS (0.1–0.8 s) replaces the
download, and restoring the snapshot takes about 15 ms. Unpacking the base after a reload took 1.2–2.0 s, against
0.8–1.4 s for a new playground; probably because the worker of the previous page is still shutting down. Most of
the snapshot is the SQLite database (2 MB, 0.15 MB compressed).

**Tests:** the browser suite (10 tests) adds:
- save, reload and check that the article is still there;
- write a second article after saving, reload at once: it is still there;
- the site under "My sites";
- a second tab refused for the same saved site;
- export, a new empty playground, then import: the article is back.

**Not yet:**
- renaming a saved site;
- sharing a playground through a URL (that needs a server or a blueprint);
- Safari: its OPFS supports `createWritable()` only in recent versions; untested.

## 14. Phase 2, part 2: blueprints and the query API (2026-10-22)

A link can now set up a new playground.
- **Query API:** `?php=8.3|8.4|8.5`, `?url=<path>` (landing page), `?login=no`, `?extension=<zip URL>`
  (repeatable), `?language=<tag>`, `?blueprint-url=<URL>`. `?joomla=<version>` is checked against the bundle:
  only one Joomla version is built so far.
- **Blueprint v0:** a JSON object in the URL fragment or at `?blueprint-url=`. It has `preferredVersions`,
  `landingPage`, `login` and `steps`, close to WordPress Playground's Blueprints (v1 shape). The query parameters
  are shortcuts added on top of it.
- **Steps:** `installExtension`, `enableExtension`, `importSampleData`, `setGlobalConfig`, `setSiteLanguage`,
  `runSql`, `runPHP`, `writeFile`, `unzip`, `login`.
- A saved site opens as it was; a blueprint applies only to a new playground. A saved site remembers its PHP
  version.

**How the steps work**
- They run in the PHP worker after login, before the page shows the site.
- **Extensions** are installed the way a user does it: the worker posts the package to Joomla's installer
  (**Upload Package File**), as `multipart/form-data` encoded by the browser's `FormData`. Then it reads the
  messages Joomla queued; in Joomla 6 a successful install is a `success` message.
- **Sample data** is installed like the Sample Data module does: `com_ajax` requests for step 1, 2, … of the
  sample data plugin, until it has no further step. The blog sample data takes about 9 s.
- `runSql`, `enableExtension` and `setSiteLanguage` boot Joomla's framework in a PHP script and use its database
  driver. SQL is therefore MySQL syntax, with `#__` as the table prefix, whichever driver the site uses.
- **Downloads** need CORS headers from the host. Without them, the worker can retry through a CORS proxy set at
  build time (`VITE_CORS_PROXY`); none is deployed yet.
- A failing step stops the blueprint; the playground still starts, and the toolbar shows which step failed and
  why.

**Found and fixed:** the MySQL emulation answers `SHOW VARIABLES LIKE 'max_heap_table_size'` with no rows. Smart
Search reads that value when content is saved and printed a PHP warning. In an AJAX response, such as the
sample data steps, the warning made the JSON unreadable. The `mysqlonsqlite` driver now answers
`max_heap_table_size` and `max_allowed_packet` with MySQL's defaults.

**PHP versions:** 8.3, 8.4 and 8.5 are built in. Each adds about 40 MB of WebAssembly to the static site
(two builds per version, JSPI and Asyncify); a browser downloads only the one it uses.

**Measured** (headless Chrome, local server): a blueprint with an extension install, sample data and five
other steps on PHP 8.3 was ready in 12.8 s, of which the steps took 10.5 s.

**Tests:** the browser suite (12 tests) adds:
- a blueprint with all step types on PHP 8.3, logged out, landing on the front end;
- a wrong blueprint gives an error.

## 15. Phase 2, part 3: mail capture and renaming (2026-10-22)

- **Mail capture:** the mails a playground sends appear under **Mail** in the toolbar, with a count. A dialog
  lists them and shows the selected one: headers, and the text, or the HTML in a sandboxed frame without
  scripts.
  - PHP sends mail by starting `sendmail` (PHP's `mail()`, and Joomla's mailer set to `sendmail`).
    `@php-wasm/universal` lets the host handle a spawned program: `setCommandSpawnHandler('sendmail', …)`. The PHP
    worker reads the message from its stdin and passes it to the page.
  - At every boot, the worker sets `mailonline` to on and the mailer to `sendmail` in `configuration.php`, and
    `sendmail_path` in `php.ini`.
  - The page decodes the mail: multipart, quoted-printable, base64, encoded words in headers.
  - The mails live in the page's memory only; a reload empties the inbox.
- **Rename:** **My sites** has a Rename button per saved site. The title changes; the address (`?site=<slug>`)
  stays.
- **Tests** (13): Global Configuration's Send Test Mail shows up under Mail; renaming a saved site.
- The browser tests now pick a free port. With a fixed port, a run could silently test the preview server of
  another checkout.

## 16. Phase 2, part 4: a CORS proxy (2026-10-22)

Browsers only download from hosts that send CORS headers. GitHub Pages and raw.githubusercontent.com do;
downloads.joomla.org, update.joomla.org and GitHub release assets do not. `proxy/cors-proxy.js` is a Cloudflare
Worker that fetches such a file and returns it with CORS headers, like WordPress Playground's `php-cors-proxy`.
- **Limits:** only GET and HEAD, only https, only allowed hosts (Joomla's download, update and extension hosts,
  GitHub and its download hosts). It follows redirects itself, so every hop is checked. At most 50 MB, also when
  the upstream sends no length. `ALLOWED_ORIGINS` limits which sites may use it. A Cloudflare rate limiting
  binding allows 60 requests per minute per IP.
- **Use:** blueprint downloads try the host directly first, then the proxy, when the playground was built with
  `VITE_CORS_PROXY`. The Pages workflow takes it from the repository variable `CORS_PROXY`.
- **Tests:** seven unit tests with a fake upstream (`npm run test:proxy`), in CI.
- **Not done:** deploying it needs a Cloudflare account; the rate limit configuration is untested. PHP's own
  outgoing requests (update checks, installing from within Joomla) do not use it yet.

## 17. Sources

- WordPress Playground: [site](https://wordpress.org/playground/) · [docs](https://developer.wordpress.org/playground/) · [developer docs](https://developer.wordpress.org/playground/developers/) · [repo](https://github.com/WordPress/wordpress-playground) (clone in `research/wordpress-playground`) · [tools](https://github.com/WordPress/playground-tools) · [binary-size post, 2026-03](https://make.wordpress.org/playground/2026/03/11/how-wordpress-playground-cut-php-wasm-binary-sizes-by-122-mb/) · [web.dev article](https://web.dev/articles/wordpress-playground) · [self-hosting](https://developer.wordpress.org/playground/developers/architecture/host-your-own-playground/)
- SQLite translator: [sqlite-database-integration](https://github.com/WordPress/sqlite-database-integration) · [new AST driver, 2025-06](https://make.wordpress.org/playground/2025/06/13/introducing-a-new-sqlite-driver-for-wordpress/)
- Blueprints v2 PHP runner: [WordPress/php-toolkit](https://github.com/WordPress/php-toolkit)
- Joomla: [joomla-cms](https://github.com/joomla/joomla-cms) 6.2.0 (clone in `research/joomla-cms`) · [joomla-framework/database](https://github.com/joomla-framework/database) 4.0.0 · [launch.joomla.org](https://launch.joomla.org/)
- Precedents: [TYPO3 Playground report](https://news.typo3.com/archive/budget-idea-report-one-click-typo3-playground) · [macopedia/typo3-wasm-playground](https://github.com/macopedia/typo3-wasm-playground) · [mglaman/wasm-drupal](https://github.com/mglaman/wasm-drupal) · [aschmelyun/liminal](https://github.com/aschmelyun/liminal) (Laravel on `@php-wasm`)
- Alternative runtime / Postgres: [seanmorris/php-wasm](https://github.com/seanmorris/php-wasm) · [pdo-pglite](https://github.com/seanmorris/pdo-pglite) · [PGlite](https://pglite.dev/)

*Unverified items:*
- Whether `pdo-pglite` really registers as `pgsql` for Joomla.
- The exact unpacked size of the Full Package.
- Firefox's JSPI release version.
- How `mysql-on-sqlite` behaves on Joomla's queries.
