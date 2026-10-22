// Renders docs/*.md to docs/*.pdf with headless Chrome (or Edge).
// Usage: node scripts/build-docs.mjs [--copy-to <dir>]
//   --copy-to  also copies the .md and .pdf files to <dir>

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { marked } from 'marked';

const docsDir = resolve(import.meta.dirname, '..', 'docs');
const copyToIndex = process.argv.indexOf('--copy-to');
const copyTo = copyToIndex > -1 ? process.argv[copyToIndex + 1] : null;

const browserCandidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const browser = browserCandidates.find((path) => existsSync(path));

if (!browser) {
  console.error('No Chrome or Edge found; set CHROME_PATH.');
  process.exit(1);
}

const css = `
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: "Segoe UI", Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #1a1a1a; }
  h1 { font-size: 20pt; border-bottom: 2px solid #1a3e6e; padding-bottom: 4px; color: #1a3e6e; }
  h2 { font-size: 14pt; color: #1a3e6e; margin-top: 1.4em; break-after: avoid; }
  h3 { font-size: 12pt; break-after: avoid; }
  table { border-collapse: collapse; width: 100%; margin: 0.8em 0; font-size: 9pt; }
  th, td { border: 1px solid #c8ced6; padding: 4px 6px; vertical-align: top; text-align: left; }
  th { background: #eef2f7; }
  tr { break-inside: avoid; }
  code { font-family: Consolas, "Cascadia Mono", monospace; font-size: 9pt; background: #f3f4f6; padding: 0 2px; }
  pre { background: #f3f4f6; padding: 8px; font-size: 8pt; line-height: 1.2; overflow: hidden; break-inside: avoid; }
  pre code { background: none; padding: 0; }
  a { color: #1a5fb4; text-decoration: none; }
`;

const tempDir = mkdtempSync(join(tmpdir(), 'jpg-docs-'));

try {
  for (const file of readdirSync(docsDir).filter((name) => name.endsWith('.md'))) {
    const markdown = readFileSync(join(docsDir, file), 'utf8')
      // Links between the documents point to the PDF versions.
      .replace(/\]\(([A-Za-z0-9_-]+)\.md\)/g, ']($1.pdf)');
    const title = markdown.match(/^# (.+)$/m)?.[1] ?? file;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head>`
      + `<body>${marked.parse(markdown)}</body></html>`;
    const htmlPath = join(tempDir, file.replace(/\.md$/, '.html'));
    const pdfPath = join(docsDir, file.replace(/\.md$/, '.pdf'));

    writeFileSync(htmlPath, html);
    execFileSync(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--user-data-dir=${join(tempDir, 'profile')}`,
      `--print-to-pdf=${pdfPath}`,
      pathToFileURL(htmlPath).href,
    ], { stdio: 'ignore' });
    console.log(`docs/${file} -> docs/${file.replace(/\.md$/, '.pdf')}`);

    if (copyTo) {
      for (const [source, target] of [[join(docsDir, file), join(copyTo, file)], [pdfPath, join(copyTo, file.replace(/\.md$/, '.pdf'))]]) {
        try {
          copyFileSync(source, target);
        } catch (error) {
          // Typically a PDF that is open in a viewer.
          console.warn(`Could not copy to ${target}: ${error.code ?? error.message}`);
        }
      }
    }
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
