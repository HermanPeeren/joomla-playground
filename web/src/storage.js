// Saved playgrounds in the browser's origin private file system (OPFS), shared by the page and the PHP worker.
//
//   joomla-playground/bases/<sha-256>.zip           the zip a site started from: the bundle (joomla/site.zip) or
//                                                   an imported export; shared by the sites made from it
//   joomla-playground/sites/<slug>/meta.json        title, Super User password, Joomla version, base, dates
//   joomla-playground/sites/<slug>/snapshot.zip     the files that differ from the base, and the deleted paths
//
// A site is its base with the snapshot on top. The PHP worker rewrites the snapshot shortly after requests that
// changed files; a few hundred kilobytes instead of ~8,600 files.

const ROOT = 'joomla-playground';

async function playgroundDirectory() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
}

export async function sitesDirectory() {
  return (await playgroundDirectory()).getDirectoryHandle('sites', { create: true });
}

async function basesDirectory() {
  return (await playgroundDirectory()).getDirectoryHandle('bases', { create: true });
}

/**
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export async function siteDirectory(slug, { create = false } = {}) {
  try {
    return await (await sitesDirectory()).getDirectoryHandle(slug, { create });
  } catch (error) {
    if (error.name === 'NotFoundError') {
      return null;
    }

    throw error;
  }
}

/**
 * Writes a file in one go. createWritable() writes to a temporary file that replaces the old one only on close(),
 * so a crash or a closed tab in the middle leaves the previous version intact.
 */
async function writeFile(directory, name, bytes) {
  const writable = await (await directory.getFileHandle(name, { create: true })).createWritable();

  try {
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});

    throw error;
  }
}

/**
 * @returns {Promise<Uint8Array|null>}
 */
async function readFile(directory, name) {
  try {
    return new Uint8Array(await (await (await directory.getFileHandle(name)).getFile()).arrayBuffer());
  } catch (error) {
    if (error.name === 'NotFoundError') {
      return null;
    }

    throw error;
  }
}

export async function hasBase(id) {
  try {
    await (await basesDirectory()).getFileHandle(`${id}.zip`);

    return true;
  } catch {
    return false;
  }
}

export async function writeBase(id, bytes) {
  await writeFile(await basesDirectory(), `${id}.zip`, bytes);
}

export async function readBase(id) {
  return readFile(await basesDirectory(), `${id}.zip`);
}

export async function writeSnapshot(slug, bytes) {
  await writeFile(await siteDirectory(slug, { create: true }), 'snapshot.zip', bytes);
}

export async function readSnapshot(slug) {
  const site = await siteDirectory(slug);

  return site ? readFile(site, 'snapshot.zip') : null;
}

export async function readMeta(slug) {
  const site = await siteDirectory(slug);

  if (!site) {
    return null;
  }

  try {
    const file = await (await site.getFileHandle('meta.json')).getFile();

    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

export async function writeMeta(slug, meta) {
  const json = JSON.stringify({ ...meta, slug, updated: new Date().toISOString() }, null, 2);

  await writeFile(await siteDirectory(slug, { create: true }), 'meta.json', new TextEncoder().encode(json));
}

/**
 * @returns {Promise<Array<object>>} The saved sites, most recently updated first.
 */
export async function listSites() {
  const sites = [];

  for await (const [slug, handle] of (await sitesDirectory()).entries()) {
    if (handle.kind === 'directory') {
      const meta = await readMeta(slug);

      if (meta) {
        sites.push(meta);
      }
    }
  }

  return sites.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

export async function renameSite(slug, title) {
  const meta = await readMeta(slug);

  if (!meta) {
    throw new Error(`No saved site "${slug}"`);
  }

  await writeMeta(slug, { ...meta, title });
}

/**
 * Deletes a site, and the bases no other site uses. A base written in the last hour stays: another tab may be saving
 * a site from it that has no meta.json yet.
 */
export async function deleteSite(slug) {
  await (await sitesDirectory()).removeEntry(slug, { recursive: true });

  const used = new Set((await listSites()).map((site) => `${site.base}.zip`));
  const bases = await basesDirectory();

  for await (const [name, handle] of bases.entries()) {
    if (!used.has(name) && Date.now() - (await handle.getFile()).lastModified > 3600000) {
      await bases.removeEntry(name).catch(() => {});
    }
  }
}

/**
 * Whether a tab has the site open (it holds the site's Web Lock).
 */
export async function isSiteOpen(slug) {
  const { held } = await navigator.locks.query();

  return held.some((lock) => lock.name === siteLockName(slug));
}

export function siteLockName(slug) {
  return `joomla-playground-site-${slug}`;
}

export function slugify(title) {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  return slug || 'site';
}

/**
 * A slug that is not taken yet: "my-site", "my-site-2", ...
 */
export async function freeSlug(title) {
  const base = slugify(title);

  for (let number = 1; ; number++) {
    const slug = number === 1 ? base : `${base}-${number}`;

    if (!(await siteDirectory(slug))) {
      return slug;
    }
  }
}
