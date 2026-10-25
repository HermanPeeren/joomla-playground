# Patches

`composer install` applies these patches to packages, with
[cweagans/composer-patches](https://github.com/cweagans/composer-patches) (configured under `extra.patches` in
`composer.json`, locked in `patches.lock.json`). The bundle build copies the patched package into every site.

A patch here is a fix that has been proposed upstream but is not in a release yet. When a release has it, update the
package in `composer.json`, delete the patch and its entry, and run `composer patches-relock`.

| Patch | Package | What it fixes |
|---|---|---|
| `mysql-on-sqlite-group-concat.patch` | `wordpress/mysql-on-sqlite` 3.1.1 | `GROUP_CONCAT()` with `SEPARATOR`, with `ORDER BY` (SQLite 3.44+), and with several expressions, which SQLite took as a separator. See [WordPress/sqlite-database-integration#70](https://github.com/WordPress/sqlite-database-integration/issues/70). |

After changing a patch: `composer patches-relock`, then `composer patches-repatch` to apply it to `vendor/`.
