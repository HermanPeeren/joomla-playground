# Draft upstream issues: WordPress/sqlite-database-integration

Drafts for reporting the gaps found while running Joomla 6.2 on `WP_MySQL_On_SQLite`
(see [REPORT.md §10](../REPORT.md)). **Nothing here has been posted.** Herman decides what to post.

- Repository: <https://github.com/WordPress/sqlite-database-integration/issues>
- Package: `wordpress/mysql-on-sqlite` 3.1.1 (the latest release, 2026-10-21). Its `src` folder is identical to
  `trunk` at `b5dc0cc` (checked on 2026-10-22), so every gap below is still present on trunk.
- The repository has no issue templates. The drafts follow the structure of recent issues there (for example
  #538 and #546): a short problem statement, a minimal reproduction, expected and actual results, the environment,
  and why it matters. Their AGENTS.md asks for "clear, concise, and human-readable prose in plain English".

## Existing upstream issues and PRs

Checked on 2026-10-22 with `gh issue list` / `gh pr list --state all` (189 issues, all PRs).

| Upstream | State | Relation to our gaps |
|---|---|---|
| [#70 Support GROUP_CONCAT](https://github.com/WordPress/sqlite-database-integration/issues/70) | open (2024, from the legacy translator era) | Gap 3. Add a comment instead of a new issue. |
| [#456 Charset and collation support](https://github.com/WordPress/sqlite-database-integration/issues/456) | open, design issue by a maintainer | Gap 2. Its plan already maps `_bin` collations to `RTRIM`/`BINARY` ("Until then, all text columns keep using `COLLATE NOCASE`"). Add a comment with a real-world case instead of a new issue. |
| [#538 UNHEX() binary UUID comparisons silently return no rows](https://github.com/WordPress/sqlite-database-integration/issues/538) | open | Gap 1 has the same root cause (BLOB vs TEXT storage class in comparisons); #538 itself notes that `UNHEX('4142') = 'AB'` needs MySQL-style coercion. Gap 1 is the plainer and more common case, so a separate issue that links #538. |
| [#546 ALTER TABLE fails when legacy BLOB columns contain TEXT values](https://github.com/WordPress/sqlite-database-integration/issues/546) | open | Related to gap 1 (BLOB storage class), not the same bug. |
| [#284 Wordfence … undefined method WP_SQLite_Driver::prepare](https://github.com/WordPress/sqlite-database-integration/issues/284) | open | About `$wpdb->dbh` in Wordfence, not PDO `prepare()`. No issue exists for prepared statements in `WP_MySQL_On_SQLite`. |
| [#178 SHOW TABLE STATUS support in Site Health](https://github.com/WordPress/sqlite-database-integration/issues/178), [#75](https://github.com/WordPress/sqlite-database-integration/issues/75) / [PR #77](https://github.com/WordPress/sqlite-database-integration/pull/77) | open / closed | `SHOW TABLE STATUS`, not `SHOW STATUS` (gap 6). No issue exists for `SHOW [SESSION\|GLOBAL] STATUS`. |
| [PR #508 Fix `DATE_FORMAT` formatting and numeric comparisons](https://github.com/WordPress/sqlite-database-integration/pull/508) | open | Not one of our gaps, but see the side finding below. A `TIME_FORMAT()` implementation could share its code. |

No existing issue or PR covers `TIME_FORMAT()`, `CONCAT_WS()`, `SOUNDEX()` or `SHOW STATUS`.

**Side finding (no draft):** `DATE_FORMAT('2026-10-22 07:05:09', '%H:%i:%s')` returns `07:05:1792652709` on 3.1.1:
`%s` gives the Unix timestamp instead of the seconds. Open PR #508 ("Format dates correctly, including names,
seconds, …") appears to fix it, so no issue is needed. Joomla uses `DATE_FORMAT` with `%Y-%m-%d %H:00:00` and `%e`
in its install SQL, which are not affected.

## Reproductions

All reproductions were run on Windows with PHP 8.3.6 and SQLite 3.40.0, against `wordpress/mysql-on-sqlite` 3.1.1
installed with Composer, without any Joomla code (the Joomla driver's workarounds are not loaded). Each one is a
standalone script:

```php
<?php
require __DIR__ . '/vendor/autoload.php'; // composer require wordpress/mysql-on-sqlite:3.1.1

$db = new WP_MySQL_On_SQLite(
	'mysql-on-sqlite:path=:memory:;dbname=test',
	null,
	null,
	array( PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION )
);
```

The issue drafts below repeat this setup, so each can be posted on its own.

---

## 1. New issue: String comparisons with `VARBINARY` columns never match

**Title:** `VARBINARY` and `BINARY` columns never equal a string literal

**Body:**

> ### Description
>
> **A `VARBINARY` (or `BINARY`, `BLOB`) column never equals a string literal**, even when the stored bytes are the
> same. `SELECT`, `UPDATE` and `DELETE` with `WHERE binary_column = 'abc'` silently match no rows. MySQL matches.
>
> The column is created as `BLOB` in a `STRICT` table, so the inserted string is stored with SQLite's BLOB storage
> class. The literal `'abc'` is TEXT, and in SQLite a TEXT value never equals a BLOB value. Only a hex literal
> (`X'616263'`) matches.
>
> ### Reproduction
>
> ```php
> <?php
> require __DIR__ . '/vendor/autoload.php';
>
> $db = new WP_MySQL_On_SQLite(
> 	'mysql-on-sqlite:path=:memory:;dbname=test',
> 	null,
> 	null,
> 	array( PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION )
> );
>
> $db->query( 'CREATE TABLE t (id VARBINARY(192) NOT NULL PRIMARY KEY)' );
> $db->query( "INSERT INTO t (id) VALUES ('abc')" );
>
> var_dump( $db->query( "SELECT COUNT(*) FROM t WHERE id = 'abc'" )->fetchColumn() );
> var_dump( $db->query( "SELECT COUNT(*) FROM t WHERE id = X'616263'" )->fetchColumn() );
>
> $db->query( "DELETE FROM t WHERE id = 'abc'" );
> var_dump( $db->query( 'SELECT COUNT(*) FROM t' )->fetchColumn() );
> ```
>
> **Expected (MySQL):** `1`, `1`, and `0` (the row is deleted).
>
> **Actual:** `0`, `1`, and `1` (the `DELETE` silently does nothing).
>
> The same happens with `'abc' = id`, `id IN ('abc')`, `id = BINARY 'abc'`, and with `BINARY(3)` and `BLOB`
> columns. The SQLite table is:
>
> ```sql
> CREATE TABLE `t` (
>   `id` BLOB NOT NULL,
>   PRIMARY KEY (`id`)
> ) STRICT
> ```
>
> and `typeof(id)` is `blob`.
>
> ### Why it matters
>
> Applications use `VARBINARY` for byte-exact, case-sensitive identifiers that are plain ASCII strings, such as
> session IDs and tokens, and query them with ordinary string literals or bound string parameters. For example,
> Joomla's `#__session.session_id` is `VARBINARY(192)`. With this emulator, Joomla finds no session after it has
> written one, so no user can log in. Rows with such keys also cannot be updated or deleted.
>
> This looks like the same root cause as #538, where `UNHEX(...)` (TEXT) never equals a BLOB column. That issue
> already notes that `UNHEX('4142') = 'AB'` must also return `1`, which needs MySQL's binary/character comparison
> rules. This issue is the plainer case: a string literal compared with a binary column.
>
> In MySQL, comparing a binary string with a character string compares them as binary strings, byte by byte.
> A possible direction is to cast the non-binary side to BLOB (or both sides to TEXT with `COLLATE BINARY`) when
> one operand is a binary column, for `=`, `<>`, `IN`, and joins.
>
> ### Environment
>
> - `wordpress/mysql-on-sqlite` 3.1.1 (same code as `trunk` at `b5dc0cc`).
> - PHP 8.3.6, SQLite 3.40.0, Windows.
> - Found while running Joomla 6.2 on the emulator.

---

## 2. Comment on #456: `utf8mb4_bin` columns compare case-insensitively

**Where:** comment on [#456](https://github.com/WordPress/sqlite-database-integration/issues/456). The issue
already plans this mapping, so a new issue would duplicate it. The comment adds a real-world case and a
reproduction.

**Comment:**

> A data point for the collation part of this issue: **a column declared `COLLATE utf8mb4_bin` still compares
> case-insensitively.** The collation is recorded in `information_schema.columns`, but the SQLite column is
> `TEXT COLLATE NOCASE`.
>
> ```php
> <?php
> require __DIR__ . '/vendor/autoload.php';
>
> $db = new WP_MySQL_On_SQLite(
> 	'mysql-on-sqlite:path=:memory:;dbname=test',
> 	null,
> 	null,
> 	array( PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION )
> );
>
> $db->query( 'CREATE TABLE t (name VARCHAR(50) COLLATE utf8mb4_bin NOT NULL)' );
> $db->query( "INSERT INTO t (name) VALUES ('Ab')" );
>
> var_dump( $db->query( "SELECT COUNT(*) FROM t WHERE name = 'ab'" )->fetchColumn() );
> var_dump( $db->query( "SELECT COLLATION_NAME FROM information_schema.columns WHERE table_name = 't'" )->fetchColumn() );
> ```
>
> **Expected (MySQL):** `0` and `utf8mb4_bin`.
>
> **Actual:** `1` and `utf8mb4_bin`. The SQLite table is `` CREATE TABLE `t` (`name` TEXT COLLATE NOCASE NOT NULL) STRICT ``.
>
> Applications declare `_bin` columns where case matters: tokens, hashes, case-sensitive keys and unique indexes
> (with `NOCASE`, a unique index on such a column also rejects `'Ab'` next to `'ab'`). We hit this while running
> Joomla on the emulator. Joomla core did not depend on it so far, but extensions do use `utf8mb4_bin`.
>
> The `_bin` → `RTRIM`/`BINARY` mapping planned above would solve it. Since `_bin` is exact for Unicode charsets,
> could it perhaps land before the rest of the collation work?
>
> (`wordpress/mysql-on-sqlite` 3.1.1, PHP 8.3.6, SQLite 3.40.0.)

---

## 3. Comment on #70: `GROUP_CONCAT` with `SEPARATOR`, `ORDER BY`, `DISTINCT`

**Where:** comment on [#70](https://github.com/WordPress/sqlite-database-integration/issues/70), which asks for
exactly this (`SEPARATOR` translation). It predates the AST driver, so the comment confirms that the gap is still
there in 3.1.1 and adds `ORDER BY`.

**Comment:**

> This is still the case with the AST driver in 3.1.1 (`WP_MySQL_On_SQLite`). **Plain `GROUP_CONCAT(x)` works,
> but `SEPARATOR` and `ORDER BY` are passed to SQLite as they are**, which fails with a syntax error:
>
> ```php
> <?php
> require __DIR__ . '/vendor/autoload.php';
>
> $db = new WP_MySQL_On_SQLite(
> 	'mysql-on-sqlite:path=:memory:;dbname=test',
> 	null,
> 	null,
> 	array( PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION )
> );
>
> $db->query( 'CREATE TABLE t (x VARCHAR(10))' );
> $db->query( "INSERT INTO t VALUES ('b'), ('a'), ('b')" );
>
> foreach ( array(
> 	'SELECT GROUP_CONCAT(x) FROM t',
> 	"SELECT GROUP_CONCAT(x SEPARATOR ';') FROM t",
> 	'SELECT GROUP_CONCAT(x ORDER BY x) FROM t',
> 	"SELECT GROUP_CONCAT(DISTINCT x ORDER BY x SEPARATOR ';') FROM t",
> ) as $sql ) {
> 	try {
> 		var_dump( $db->query( $sql )->fetchColumn() );
> 	} catch ( PDOException $e ) {
> 		echo $e->getMessage(), "\n";
> 	}
> }
> ```
>
> **Expected (MySQL):** `b,a,b`, `b;a;b`, `a,b,b`, `a;b`.
>
> **Actual:**
>
> ```text
> string(5) "b,a,b"
> SQLSTATE[HY000]: General error: 1 near "SEPARATOR": syntax error
> SQLSTATE[HY000]: General error: 1 near "ORDER": syntax error
> SQLSTATE[HY000]: General error: 1 near "ORDER": syntax error
> ```
>
> A possible translation:
>
> - `SEPARATOR s` becomes the second argument: `GROUP_CONCAT(x, s)`.
> - `ORDER BY` inside an aggregate is native since SQLite 3.44.0 (`GROUP_CONCAT(x, s ORDER BY x)`). For older
>   versions, an ordered subquery is a common fallback, although SQLite does not guarantee that order.
> - `DISTINCT` with a custom separator is not allowed in SQLite (`DISTINCT` aggregates take one argument), so
>   `GROUP_CONCAT(DISTINCT x SEPARATOR ';')` needs e.g. a `DISTINCT` subquery or a `REPLACE()` on the default
>   separator.
> - MySQL also truncates the result at `@@group_concat_max_len` (default 1024), which may matter for exact
>   emulation.
>
> Joomla's MySQL query builder always generates `GROUP_CONCAT(expr SEPARATOR ',')`, so this breaks Joomla on
> the emulator (for example `user:list` in the CLI) unless the query is changed.
>
> (`wordpress/mysql-on-sqlite` 3.1.1, PHP 8.3.6, SQLite 3.40.0.)

---

## 4. New issue: `TIME_FORMAT()` is not supported

**Title:** Support `TIME_FORMAT()`

**Body:**

> ### Description
>
> **`TIME_FORMAT()` fails with "no such function"**, while `DATE_FORMAT()` is supported.
>
> ### Reproduction
>
> ```php
> <?php
> require __DIR__ . '/vendor/autoload.php';
>
> $db = new WP_MySQL_On_SQLite(
> 	'mysql-on-sqlite:path=:memory:;dbname=test',
> 	null,
> 	null,
> 	array( PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION )
> );
>
> foreach ( array(
> 	"SELECT TIME_FORMAT('07:05:09', '%H:%i')",
> 	"SELECT TIME_FORMAT('2026-10-22 07:05:09', '%H:00')",
> ) as $sql ) {
> 	try {
> 		var_dump( $db->query( $sql )->fetchColumn() );
> 	} catch ( PDOException $e ) {
> 		echo $e->getMessage(), "
";
> 	}
> }
> ```
>
> **Expected (MySQL):** `07:05` and `07:00`.
>
> **Actual:**
>
> ```text
> SQLSTATE[HY000]: General error: 1 no such function: TIME_FORMAT
> SQLSTATE[HY000]: General error: 1 no such function: TIME_FORMAT
> ```
>
> ### Notes
>
> `TIME_FORMAT(time, format)` is like `DATE_FORMAT()`, with some differences:
>
> - Only the time specifiers are allowed (`%f`, `%H`, `%h`, `%I`, `%i`, `%k`, `%l`, `%p`, `%r`, `%S`, `%s`, `%T`);
>   date specifiers return `NULL` or `0`.
> - The argument is a `TIME`, so hours can exceed 23 or be negative: `TIME_FORMAT('100:00:00', '%H %k %h')` is
>   `100 100 04`.
>
> It could probably share the formatting code with `DATE_FORMAT()` (see also PR #508).
>
> ### Why it matters
>
> Joomla's install SQL uses `TIME_FORMAT(NOW(), '%H:00')` to seed its scheduled tasks, so a Joomla install on the
> emulator fails without a user-defined function.
>
> ### Environment
>
> - `wordpress/mysql-on-sqlite` 3.1.1 (same code as `trunk` at `b5dc0cc`).
> - PHP 8.3.6, SQLite 3.40.0, Windows.

---

## 5. New issue: `CONCAT_WS()` and `SOUNDEX()` are not available

**Title:** Provide `CONCAT_WS()` and `SOUNDEX()` on all SQLite versions

**Body:**

> ### Description
>
> **`CONCAT_WS()` and `SOUNDEX()` fail with "no such function"** on common SQLite builds:
>
> - `CONCAT_WS()` is native only since SQLite 3.44.0, while the emulator supports SQLite 3.37.0 and newer.
> - `SOUNDEX()` exists only when SQLite is compiled with `SQLITE_SOUNDEX`, which most builds (including PHP's
>   bundled SQLite) leave out.
>
> ### Reproduction
>
> ```php
> <?php
> require __DIR__ . '/vendor/autoload.php';
>
> $db = new WP_MySQL_On_SQLite(
> 	'mysql-on-sqlite:path=:memory:;dbname=test',
> 	null,
> 	null,
> 	array( PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION )
> );
>
> foreach ( array(
> 	"SELECT CONCAT_WS(',', 'a', NULL, 'b')",
> 	"SELECT SOUNDEX('Robert')",
> ) as $sql ) {
> 	try {
> 		var_dump( $db->query( $sql )->fetchColumn() );
> 	} catch ( PDOException $e ) {
> 		echo $e->getMessage(), "
";
> 	}
> }
> ```
>
> **Expected (MySQL):** `a,b` and `R163`.
>
> **Actual (SQLite 3.40.0):**
>
> ```text
> SQLSTATE[HY000]: General error: 1 no such function: CONCAT_WS
> SQLSTATE[HY000]: General error: 1 no such function: SOUNDEX
> ```
>
> ### Notes
>
> Both could be user-defined functions in `WP_SQLite_PDO_User_Defined_Functions`, registered when SQLite does not
> provide them:
>
> - `CONCAT_WS(sep, ...)` skips `NULL` arguments and returns `NULL` only when the separator is `NULL`.
> - MySQL's `SOUNDEX()` differs from SQLite's and PHP's `soundex()`: the result is not limited to 4 characters
>   (`SOUNDEX('Quadratically')` is `Q36324`), and non-alphabetic characters are ignored. Where the native SQLite
>   function exists, it returns the standard 4-character code, so a user-defined function may be preferable on all
>   versions.
>
> ### Why it matters
>
> Joomla's MySQL query builder generates `CONCAT_WS()` for `$query->concatenate()` with a separator, which is used
> when saving articles and categories. Joomla's Smart Search indexes terms with `SOUNDEX()` whenever content is
> saved. Both fail on the emulator without user-defined functions.
>
> ### Environment
>
> - `wordpress/mysql-on-sqlite` 3.1.1 (same code as `trunk` at `b5dc0cc`).
> - PHP 8.3.6, SQLite 3.40.0, Windows.

---

## 6. New issue: `SHOW STATUS` is not supported

**Title:** Support `SHOW [SESSION | GLOBAL] STATUS`

**Body:**

> ### Description
>
> **`SHOW STATUS` throws "MySQL query not supported"**, in every form (`SHOW STATUS`, `SHOW SESSION STATUS`,
> `SHOW GLOBAL STATUS`, with `LIKE` or `WHERE`).
>
> ### Reproduction
>
> ```php
> <?php
> require __DIR__ . '/vendor/autoload.php';
>
> $db = new WP_MySQL_On_SQLite(
> 	'mysql-on-sqlite:path=:memory:;dbname=test',
> 	null,
> 	null,
> 	array( PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION )
> );
>
> $stmt = $db->query( "SHOW SESSION STATUS WHERE `Variable_name` IN ('Ssl_version', 'Ssl_cipher')" );
> var_dump( $stmt->fetchAll( PDO::FETCH_ASSOC ) );
> ```
>
> **Expected (MySQL):** two rows with the columns `Variable_name` and `Value`; on a connection without TLS both
> values are empty strings.
>
> **Actual:**
>
> ```text
> MySQL query not supported. Cause: statement type: "showStatement" > "STATUS"
> ```
>
> ### Notes
>
> A minimal version could return the `Variable_name`/`Value` result shape with `LIKE` and `WHERE` filtering, over
> a small set of status variables with sensible values (for example `Ssl_version` and `Ssl_cipher` as empty
> strings, and `Uptime` and `Threads_connected`). Unknown variables can simply be absent, as filtering for a name
> that does not exist returns no rows in MySQL too. `performance_schema.session_status` and `global_status` could
> use the same data.
>
> ### Why it matters
>
> Joomla's MySQL drivers run this query to report whether the database connection uses TLS (System Information).
> With an exception instead of an empty result, the caller
> has to special-case the emulator.
>
> ### Environment
>
> - `wordpress/mysql-on-sqlite` 3.1.1 (same code as `trunk` at `b5dc0cc`).
> - PHP 8.3.6, SQLite 3.40.0, Windows.

---

## 7. New issue (context, not a bug): prepared statements, as emulated by a Joomla driver

The README says that prepared statements and parameter binding "are not yet supported", so this is a known
limitation, not a bug. The draft offers it as context for that planned work. It could also be left out, or posted
as a comment once an issue for prepared statements exists.

**Title:** Prepared statements: how a Joomla driver emulates them on `WP_MySQL_On_SQLite`

**Body:**

> The README notes that prepared statements and parameter binding are not supported yet; `prepare()` throws
> `SQLSTATE[IM001]: Driver does not support this function: driver does not support prepared statements`.
> This is not a bug report, just context that may help when this is implemented.
>
> We are running Joomla 6.2 on `WP_MySQL_On_SQLite` 3.1.1 (to run Joomla in the browser with php-wasm, as
> WordPress Playground does). Joomla prepares every query, with named (`:name`) and positional (`?`)
> placeholders. Our driver emulates `prepare()` the way PDO MySQL does with `PDO::ATTR_EMULATE_PREPARES`, which
> Joomla's MySQL driver turns on anyway:
>
> - It finds the placeholders outside string literals, quoted identifiers and comments.
> - It inlines each bound value: `NULL`, integers and booleans as numbers, everything else as a string quoted
>   with `WP_MySQL_On_SQLite::quote()` (MySQL escaping rules).
> - It runs the result with `query()`.
>
> With that, Joomla's whole test suite passes on the emulator. Things that would let us drop this, roughly in
> order of value:
>
> 1. **`prepare()` with `bindValue()`/`bindParam()`/`execute(array)`**, even if it is emulated internally in the
>    same way. The lexer already knows where literals and comments are, so placeholders could be found safely
>    there, and values could be bound to SQLite parameters instead of being inlined.
> 2. **Binary values:** a value bound as `PDO::PARAM_LOB`, or a string compared with a binary column, should behave
>    like in MySQL (see the `VARBINARY` comparison issue).
> 3. **`rowCount()` for `SELECT`:** PDO MySQL returns the number of rows for buffered queries; the emulator returns
>    `0`, like PDO SQLite. Joomla's `getNumRows()` relies on it in a few places.
>
> Our implementation is in [`EmulatedPreparedStatement`](https://github.com/HermanPeeren/joomla-playground/blob/spike/mysql-on-sqlite/src/Database/MysqlOnSqlite/EmulatedPreparedStatement.php),
> in case it is useful.

**Before posting 7:** the link points to the `spike/mysql-on-sqlite` branch, which must be pushed for it to work.
