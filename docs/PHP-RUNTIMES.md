# PHP in WebAssembly: which runtime for the Joomla Playground?

*28 October 2026. Prompted by Llewellyn van der Merwe's work on a MariaDB extension for Sean Morris's php-wasm
([joomengine/php-wasm](https://github.com/joomengine/php-wasm),
[joomengine/mariadb-wasm-bridge](https://github.com/joomengine/mariadb-wasm-bridge)).*

## Question

The playground runs PHP with `@php-wasm` 3.1.60 from WordPress Playground. Would
[seanmorris/php-wasm](https://github.com/seanmorris/php-wasm) be better for a Joomla Playground? And does WordPress
need a different runtime because it still supports old PHP, while Joomla 5 needs PHP 8.1+ and Joomla 6 PHP 8.3+?

## Conclusion

**Keep `@php-wasm`.** For this playground, Sean Morris's php-wasm is slower, ships old PHP patch releases, has
32-bit integers, and lacks things the playground relies on: outgoing HTTP from PHP, the filesystem journal that
saving builds on, and a request handler for the service worker. Switching would cost a rewrite of the PHP worker
and remove features, for nothing in return that the playground needs.

**The PHP-version argument does not hold.** `@php-wasm` is not tied to old PHP: it ships PHP 7.4 to 8.5 (and 5.2)
as separate packages, in the same release, and the playground offers 8.3, 8.4 and 8.5. Both runtimes cover the
versions Joomla 5 and 6 need equally well.

**What is worth following is the database, not the runtime.** Llewellyn's bridge runs *real* MariaDB in the
browser ([shyim/lite4mariadb](https://github.com/shyim/lite4mariadb), MariaDB with InnoDB compiled to WebAssembly).
That would remove the MySQL-on-SQLite emulation and its gaps (missing functions, `GROUP_CONCAT`, MySQL-only
extension SQL). It is days old and has heavy requirements (threads, cross-origin isolation); a separate evaluation
is proposed at the end. Such a database can probably be connected to `@php-wasm` as well (not tested yet), so it
should not require changing the PHP runtime.

## The candidates

| | `@php-wasm` (WordPress Playground) | seanmorris/php-wasm | joomengine/php-wasm |
|---|---|---|---|
| Version used here | 3.1.60 (20 Oct 2026) | 0.2.0 (1 Oct 2026) | 0.1.0 (26 Oct 2026) |
| PHP versions | 5.2, 7.4–8.5 | 8.0–8.5 | 8.3–8.5 |
| PHP 8.4 patch release | 8.4.25 ([update to 8.4.27](https://github.com/WordPress/wordpress-playground/pull/4487) pending) | **8.4.1** (Nov 2024); 8.3.11, 8.5.2 | 8.4.27 (with the PHP2Shell fixes) |
| Integers | 64-bit (`PHP_INT_MAX` 9.2·10¹⁸) | **32-bit** (`PHP_INT_MAX` 2,147,483,647) | **32-bit** |
| How PHP waits for JavaScript | JSPI in Chrome, Asyncify elsewhere | Asyncify | Asyncify |
| Extensions | Built in: curl, mysqli, pdo_mysql, pdo_sqlite, gd, imagick, mbstring, dom, zip, openssl, soap … (no intl) | Loaded at runtime as separate `.so` packages (sqlite, mbstring, xml/dom, zip, intl, openssl …) | Built in: DOM/XML, mbstring, intl, zip, OpenSSL, GD, PDO, MariaDB PDO driver |
| Outgoing HTTP from PHP | Yes: TLS and TCP over `fetch()` (`tcpOverFetch`), used for Install Languages, Patch Tester, install from URL | No (only JavaScript calls through Vrzno) | No |
| Request handling | `PHPRequestHandler`: requests, cookies, a fresh request per call | `php-cgi-wasm` in a service worker | `request()` with CLI and HTTP modes |
| Persistence | Filesystem journal (`fs-journal`), used for the playground's saved sites in OPFS | IDBFS | IndexedDB, opt-in |
| Maintainers | WordPress/Automattic team; weekly releases | Sean Morris alone; releases months apart | Llewellyn; two days old |
| Used by | WordPress Playground, Liminal (Laravel), the TYPO3 playground (a fork) | wasm-drupal (an 0.0.9 alpha) | the planned joomengine/playground (now only a README) |
| Licence | GPL-2.0 | Apache-2.0 or GPL-2.0 | Apache-2.0 |

Other WebAssembly builds of PHP were considered and left out: [oraoto/pib](https://github.com/oraoto/pib), the
original that Sean's project was forked from, has had no changes since 2022; Wasmer's PHP and VMware's
[webassembly-language-runtimes](https://github.com/vmware-labs/webassembly-language-runtimes) target WASI on servers
and edge platforms, not a page in a browser.

## Speed

Same machine, same PHP code, PHP 8.4 in both. Five rounds after a warm-up round; the median is shown.

**Workloads.** `bench.php`: PHP's own benchmark (`Zend/bench.php`, computation only). SQLite: 20,000 inserts in a
transaction, 2,000 indexed lookups and a grouped query, through PDO. Strings: JSON encoding and decoding of 20,000
records and regular expressions on 120 KB of HTML. Joomla: rendering the front page of the playground's own Joomla
6.2.0 site (SQLite through the MySQL emulation), with the site mounted from disk and a fresh PHP instance per round.

**Node.js 20** (both runtimes use Asyncify here):

| | seanmorris/php-wasm 0.2.0 | `@php-wasm` 3.1.60 | `@php-wasm` faster by |
|---|---|---|---|
| `bench.php` | 2.58 s | 1.23 s | 2.1× |
| SQLite | 270 ms | 156 ms | 1.7× |
| Strings, JSON, regex | 536 ms | 245 ms | 2.2× |
| **Joomla front page** | **1,019 ms** | **444 ms** | **2.3×** |

**Chrome** (`@php-wasm` with JSPI, run inside the playground; Sean's runtime on a plain page):

| | seanmorris/php-wasm 0.2.0 | `@php-wasm` 3.1.60 |
|---|---|---|
| `bench.php` | 2.41 s | 1.51 s |
| SQLite | 152 ms | 198 ms |
| Strings, JSON, regex | 392 ms | 355 ms |
| Start of a PHP instance | 216 ms | 283 ms (the playground's "php" step) |

The computation benchmark shows the same picture as Node. The SQLite and strings numbers are close, and not fully
comparable: `@php-wasm` ran them inside the playground, with Joomla loaded and the filesystem journal active, Sean's
runtime on an empty page. A Joomla page could not be timed in Sean's runtime in the browser without first building
a service-worker setup for it.

The likely cause of the difference is how Sean's runtime is built: as an Emscripten main module with dynamically
loaded extensions (`MAIN_MODULE=1`) and Asyncify, which makes function calls more expensive. `@php-wasm` links its
extensions statically and, in Chrome, uses JSPI instead of Asyncify.

**Observed while measuring** (Sean's runtime): consecutive `run()` calls share one PHP request, so functions
declared in one run still exist in the next; after `refresh()` the dynamically loaded extensions were missing
(`Class "Pdo\Sqlite" not found`); and output bypassed `ob_start()`.

## What switching would cost

The playground's PHP worker (`web/src/php-worker.js`) is built on `@php-wasm` APIs. With Sean's runtime, these would
have to be rebuilt or would be lost:

- **Saving and reopening sites:** base zip plus snapshot, using `@php-wasm/fs-journal` to know which files changed.
- **Outgoing requests:** Install Languages, extension updates, the Patch Tester's GitHub requests and installing
  from a URL all use PHP's curl or streams, which `@php-wasm` turns into `fetch()` with its own CA.
- **Mail:** the playground catches mail through `@php-wasm`'s process-spawn handler for sendmail.
- **Requests:** the service worker hands requests to `PHPRequestHandler`, which sets up `$_SERVER`, cookies and
  uploads.
- **PHP updates:** `@php-wasm` follows PHP's patch releases, and Dependabot now proposes each new release. Sean's
  runtime is at PHP 8.4.1, from November 2024.

The 32-bit integers are a risk of their own: timestamps after 2038 in integer arithmetic, database IDs above
2,147,483,647, and `filesize()` above 2 GB. Joomla rendered its front page fine, but this was not tested further.

## What would change this advice

- `@php-wasm` stops being maintained, or stops following PHP releases.
- A runtime appears that is clearly faster for Joomla pages *and* has outgoing HTTP and a request handler.
- Real MariaDB turns out to be impossible to connect to `@php-wasm`, while the MariaDB route proves worth it (see
  below).

## Proposed instead: evaluate real MariaDB

Llewellyn's actual contribution is the database. Real MariaDB in the browser would make the playground's database
behave exactly like Joomla's own: every MySQL function, `GROUP_CONCAT` in all its forms, MySQL-only SQL in
extensions, Joomla's Database check. But it comes with costs that need to be measured first:

- **Cross-origin isolation:** MariaDB needs threads and `SharedArrayBuffer`, so every page needs the
  `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers. GitHub Pages cannot send them; the
  playground's service worker would have to add them. `require-corp` also restricts what a Joomla page may load from
  other sites (images, fonts, embedded videos).
- **Size and memory:** the MariaDB module is about 17 MB, on top of PHP; each open database has a pool of 16 threads.
- **Saving:** the playground saves files; MariaDB keeps its own data directory (`dumpDataDir()`/`loadDataDir()` as
  tarballs). Saving, exporting and importing sites would have to include it.
- **Maturity:** lite4mariadb was published in September 2026 (version 0.1.2); the bridge and joomengine/php-wasm
  are two days old.

A possible evaluation, in steps, each with a go/no-go:

1. **Measure MariaDB alone** in Chrome: start time, memory, and the SQL workload above against SQLite with the
   MySQL emulation. (Small: a test page, as for the measurements above.)
2. **Connect it to `@php-wasm`.** `@php-wasm` already has `pdo_mysql` and `mysqli`, which speak the MySQL protocol
   over a socket, and it already hands PHP's socket traffic to JavaScript (that is how `tcpOverFetch` works). Two
   possible ways, both untested: a MySQL-protocol adapter in JavaScript between PHP's socket and MariaDB's embedded
   API, or a PDO driver like Llewellyn's, compiled into a custom `@php-wasm` build. To be worked out with Llewellyn;
   his `mariadb.v1` protocol may fit the first.
3. **Cross-origin isolation in the playground:** the service worker adds the headers; check the administrator,
   the front end, the heritage demo, and extension installs.
4. **Joomla on MariaDB:** install a site with Joomla's own MySQL schema, run the integration and browser tests, and
   compare page times with the current driver.
5. **Saving, export and import** with the MariaDB data directory.
6. **Decide:** MariaDB as the default, as an option (`?db=mariadb`), or not.

Building any of this waits for a decision.

## Sources

- [seanmorris/php-wasm](https://github.com/seanmorris/php-wasm): README, CHANGELOG (v0.2.0), `Makefile` (PHP versions
  and build flags); npm packages `php-wasm`, `php-cgi-wasm`, `php-wasm-sqlite` 0.2.0
- [joomengine/php-wasm](https://github.com/joomengine/php-wasm) (README, `versions.json`),
  [joomengine/mariadb-wasm-bridge](https://github.com/joomengine/mariadb-wasm-bridge),
  [joomengine/playground](https://github.com/joomengine/playground)
- [shyim/lite4mariadb](https://github.com/shyim/lite4mariadb)
- [WordPress/wordpress-playground](https://github.com/WordPress/wordpress-playground), npm `@php-wasm/*` 3.1.60,
  [PR #4487](https://github.com/WordPress/wordpress-playground/pull/4487) (PHP 8.4.27)
- [mglaman/wasm-drupal](https://github.com/mglaman/wasm-drupal), [aschmelyun/liminal](https://github.com/aschmelyun/liminal),
  [macopedia/typo3-wasm-playground](https://github.com/macopedia/typo3-wasm-playground)
- Measurements: Windows 11, Node.js 20.18, Chrome (Playwright), 28 October 2026
