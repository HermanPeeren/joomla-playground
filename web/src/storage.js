// Saved playgrounds in the browser's origin private file system (OPFS), shared by the page and the PHP worker.
//
//   joomla-playground/sites/<slug>/meta.json   title, Super User password, Joomla version, dates
//   joomla-playground/sites/<slug>/files/      the site (Joomla root), kept in sync by the PHP worker

const ROOT = 'joomla-playground';

export async function sitesDirectory() {
  const root = await navigator.storage.getDirectory();
  const playground = await root.getDirectoryHandle(ROOT, { create: true });

  return playground.getDirectoryHandle('sites', { create: true });
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

export async function filesDirectory(slug) {
  return (await siteDirectory(slug, { create: true })).getDirectoryHandle('files', { create: true });
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
  const site = await siteDirectory(slug, { create: true });
  const writable = await (await site.getFileHandle('meta.json', { create: true })).createWritable();

  await writable.write(JSON.stringify({ ...meta, slug, updated: new Date().toISOString() }, null, 2));
  await writable.close();
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

export async function deleteSite(slug) {
  await (await sitesDirectory()).removeEntry(slug, { recursive: true });
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
