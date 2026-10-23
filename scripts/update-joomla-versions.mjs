// Keeps the Joomla versions of the playground up to date with the stable releases of joomla/joomla-cms.
//
// For every major version in joomla-versions.json, it takes the newest stable release of that major; the default
// becomes the release GitHub marks as Latest. The Joomla version of the integration tests (JOOMLA_VERSION in
// phpunit.xml.dist and the CI workflow) follows the default.
//
// Usage: node scripts/update-joomla-versions.mjs [--check]
//   --check  only says what would change; exit code 1 if anything would
// Prints "changed=true|false" and a summary; GITHUB_TOKEN, if set, raises GitHub's rate limit.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {{default: string, versions: string[]}} current
 * @param {Array<{tag_name: string, prerelease: boolean, draft: boolean}>} releases
 * @param {string} latest The tag GitHub marks as Latest
 * @returns {{default: string, versions: string[]}}
 */
export function pickVersions(current, releases, latest) {
  const stable = releases
    .filter((release) => !release.prerelease && !release.draft && /^\d+\.\d+\.\d+$/.test(release.tag_name))
    .map((release) => release.tag_name)
    .sort(compareVersions)
    .reverse();
  const newestOfMajor = (version) => stable.find((tag) => tag.split('.')[0] === version.split('.')[0]) ?? version;
  const versions = [...new Set(current.versions.map(newestOfMajor))];
  const latestStable = stable.includes(latest) ? latest : newestOfMajor(current.default);

  if (!versions.includes(latestStable)) {
    versions.unshift(latestStable);
  }

  return { default: latestStable, versions: versions.sort(compareVersions).reverse() };
}

export function compareVersions(a, b) {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));

  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

async function github(path) {
  const response = await fetch(`https://api.github.com/repos/joomla/joomla-cms/${path}`, {
    headers: { accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${path}: HTTP ${response.status}`);
  }

  return response.json();
}

async function main() {
  const check = process.argv.includes('--check');
  const file = `${root}/joomla-versions.json`;
  const current = JSON.parse(readFileSync(file, 'utf8'));
  const [releases, latest] = await Promise.all([github('releases?per_page=100'), github('releases/latest')]);
  const next = pickVersions(current, releases, latest.tag_name);
  const changed = JSON.stringify(next) !== JSON.stringify({ default: current.default, versions: current.versions });

  console.log(`changed=${changed}`);
  console.log(`Joomla versions: ${current.versions.join(', ')} (default ${current.default}) -> ${next.versions.join(', ')} (default ${next.default})`);

  if (!changed || check) {
    process.exit(check && changed ? 1 : 0);
  }

  writeFileSync(file, JSON.stringify({ ...current, ...next }, null, 2) + '\n');

  // The integration tests install the default version.
  const replacements = [
    [`${root}/phpunit.xml.dist`, /(<env name="JOOMLA_VERSION" value=")[^"]+("\/>)/],
    [`${root}/.github/workflows/ci.yml`, /(\n {2}JOOMLA_VERSION: )\S+()/],
  ];

  for (const [path, pattern] of replacements) {
    const text = readFileSync(path, 'utf8');

    if (!pattern.test(text)) {
      throw new Error(`No JOOMLA_VERSION found in ${path}`);
    }

    writeFileSync(path, text.replace(pattern, `$1${next.default}$2`));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(2);
  });
}
