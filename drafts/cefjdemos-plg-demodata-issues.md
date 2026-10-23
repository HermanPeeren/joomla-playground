# Draft issues for ceford/cefjdemos-plg-demodata

Drafts only: nothing has been posted. Found while running the **heritage** dataset (version 0.3.1, commit
`bf24a79` of 2026-10-21) in the Joomla Playground, with the languages en-GB, nl-NL, de-DE, fr-FR and es-ES. Line
numbers refer to `features101/src/Extension/Features101.php` at that commit.

Each issue below can be posted on its own. The first is the most serious. Issues 1–5 happen on a normal Linux
server with MySQL too; they are not specific to the playground.

Until they are fixed, the playground installs a patched copy of the plugin (`web/public/blueprints/assets.json`
in the joomla-playground repository); each patch switches itself off when the original text is gone.

---

## 1. Heritage: the Special view level gets invalid rules, and the administrator menu disappears

**What happens.** After installing the heritage data, the administrator's left menu is empty, and the
Multilingual Status and User Menu buttons are gone from the top bar.

**Why.** `doSpecialAccess()` (line 858) adds the id of the user group "Oddjob" to the rules of the Special view
level. The heritage dataset has no "Oddjob" group, so `$oddjob_id` is `null`, and:

```php
$replacement = str_replace(']', ',' . $oddjob_id . ']', $current);   // "[6,3,8]" becomes "[6,3,8,]"
```

`[6,3,8,]` is not valid JSON. Joomla then cannot work out a user's authorised view levels, and leaves out every
administrator menu item.

**To reproduce.** Install the heritage dataset; open the administrator. In the database,
`SELECT rules FROM #__viewlevels WHERE title = 'Special'` gives `[6,3,8,]`.

**Suggested fix.** Skip it when the group does not exist (and the same when uninstalling):

```php
$oddjob_id = $db->loadResult();

if (!$oddjob_id) {
    return;
}
```

A sturdier way to change the rules is to decode, change and encode them:
`json_encode(array_values(array_unique([...json_decode($current), (int) $oddjob_id])))`.

---

## 2. Heritage: step 3 (users) fails, because the group "Magazine Reviewers" does not exist

**What happens.** Step 3 stops with `COM_USERS_USERS_ERROR_CANNOT_SAVE_ACCOUNT_WITHOUT_GROUPS`, and the
installation does not continue.

**Why.** In `datasets/heritage/en-gb/elements/users.json`, user "maggie" is in the group "Magazine Reviewers".
`usergroups.json` of the heritage dataset only creates "Committee", "Chair" and "Secretary". `installUsers()`
looks the group up by title (line 499); for a missing group it gets `null`, so `(array) null` is an empty list of
groups.

**Suggested fix.** Add "Magazine Reviewers" to `heritage/en-gb/elements/usergroups.json` (e.g. with parent
"Registered"), or put maggie in an existing group. A check in `installUsers()` would also help: when a group title
is not found, report which one instead of saving a user without groups.

---

## 3. `createModel('NewsFeed')` finds no model on Linux, so step 11 (newsfeeds) fails

**What happens.** Step 11 stops with "Call to a member function save() on null".

**Why.** Line 2240:

```php
$newsfeedModel = $mvcFactory->createModel('NewsFeed', 'Administrator', ['ignore_request' => true]);
```

The class is `NewsfeedModel` (`administrator/components/com_newsfeeds/src/Model/NewsfeedModel.php`). On a
case-insensitive file system (Windows, macOS) the autoloader still finds the file; on Linux, the usual hosting
platform, it does not, and `createModel()` returns `null`. The uninstall code (line 3104) already uses
`'Newsfeed'`.

**Suggested fix.** `createModel('Newsfeed', 'Administrator', ...)`.

---

## 4. Completion step: invalid SQL when the users "superman" and "playwright" do not exist

**What happens.** Step 16 (completion) fails with an SQL syntax error, so `is_installed` is not set: the module
keeps showing **Install** although the data is installed.

**Why.** `doPrivateMessages()` (line 899) sends a private message from "superman" to "playwright". Neither user is
in the heritage dataset, so both ids are `null`, and the query becomes

```sql
INSERT INTO #__messages SET user_id_from = , user_id_to = , ...
```

**Suggested fix.** Return early when one of the two users is missing:

```php
if (!$superman_id || !$playwright_id) {
    return;
}
```

(Binding the ids as integers would also have shown this as a clear error instead of invalid SQL.)

---

## 5. Completion step: a privacy consent for the missing user "johndoe"

**What happens.** With MySQL's strict mode (which Joomla's MySQL driver sets) the insert fails:
`''` is not a valid integer for `#__privacy_consents.user_id`.

**Why.** `doPrivacyConsents()` (line 705) stores a consent for user "johndoe", who is not in the heritage dataset.
`$db->quote($johndoe_id)` of `null` gives `''`.

`doPrivacyRequests()` (line 671) has the same pattern with johndoe's e-mail address; it does not fail, but it
stores a privacy request with an empty e-mail address.

**Suggested fix.** Return early in both when johndoe is not found.

---

## 6. Heritage: the Blog workflow's transitions name stages that do not exist

**What happens.** PHP warnings in step 1 (`Undefined array key "Published"` at line 2611, and `-1`), and
transitions without a stage. On a server that shows PHP warnings, the warnings come before the JSON answer, and
the module reports "Response is invalid".

**Why.** In `heritage/en-gb/elements/workflows.json`, the "Blog Workflow" has the stages Idea, Copywriting,
Graphic Design, Fact Check, Content Review, **Article published!**, On Hold, Trashed and Unpublished. Its
transitions use `"Published"` (for example "Publish and Feature" and "Publish again") and `"Not accepted"`, which
are not stage titles. The other two workflows are consistent.

**Suggested fix.** Use the stage titles in the transitions ("Article published!", and "Trashed" instead of
"Not accepted"?), or rename the stages. A check in `installWorkflows()` for unknown stage names would catch this.

---

## 7. Language strings missing for the error messages

**What happens.** When a step fails, the message shows the language key only, e.g.
`PLG_DEMODATA_USER_STEP_FAILED`, without the step and the reason. (That made issue 2 hard to find.)

**Why.** These keys are used with `Text::sprintf()` but are not in `language/en-GB/plg_demodata_features101.ini`:

`PLG_DEMODATA_ARTICLES_STEP_FAILED`, `PLG_DEMODATA_ASSOCIATIONS_STEP_FAILED`,
`PLG_DEMODATA_BANNERS_CLIENTS_STEP_FAILED`, `PLG_DEMODATA_BANNERS_STEP_FAILED`,
`PLG_DEMODATA_CATEGORIES_STEP_FAILED`, `PLG_DEMODATA_CONTACTS_STEP_FAILED`,
`PLG_DEMODATA_FIELDGROUPS_STEP_FAILED`, `PLG_DEMODATA_FIELDS_STEP_FAILED`, `PLG_DEMODATA_MENUITEMS_STEP_FAILED`,
`PLG_DEMODATA_MENUS_STEP_FAILED`, `PLG_DEMODATA_NEWSFEED_STEP_FAILED`, `PLG_DEMODATA_PARENT_TAG_STEP_FAILED`,
`PLG_DEMODATA_USERGROUPS_STEP_FAILED`, `PLG_DEMODATA_USER_STEP_FAILED`, and `PLG_SAMPLEDATA_MODULES_STEP_FAILED`
(probably meant as `PLG_DEMODATA_MODULES_STEP_FAILED`).

The workflow step also uses `PLG_DEMODATA_USER_STEP_FAILED` (line 2573) where a workflow message is meant.

**Suggested fix.** Add them, e.g.
`PLG_DEMODATA_USER_STEP_FAILED="Step %1$s failed: %2$s"`.

---

## Possibly useful for testing

The Joomla Playground can run the whole setup in a browser, without a server:
<https://hermanpeeren.github.io/joomla-playground/?blueprint=heritage-demo&fresh=1>. The blueprint
(`web/public/blueprints/heritage-demo.json`) follows the setup of the plugin's README. On a plain playground,
installing the module and plugin by hand now works too: the module's JavaScript file was not served before, which
was a playground bug, now fixed.
