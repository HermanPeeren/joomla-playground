// Runs Joomla's CLI with PHP in WebAssembly.
// Usage: node wasm/cli.mjs --site=<joomla root> [--php=8.4] -- <joomla.php arguments>

import { parseArgs } from 'node:util';
import { runCli } from './joomla-wasm.mjs';

const { values, positionals } = parseArgs({
  options: {
    site: { type: 'string' },
    php: { type: 'string', default: '8.4' },
  },
  allowPositionals: true,
});

if (!values.site) {
  console.error('Usage: node wasm/cli.mjs --site=<joomla root> [--php=8.4] -- <joomla.php arguments>');
  process.exit(1);
}

const { exitCode, output } = await runCli({ site: values.site, args: positionals, phpVersion: values.php });

process.stdout.write(output);
process.exit(exitCode);
