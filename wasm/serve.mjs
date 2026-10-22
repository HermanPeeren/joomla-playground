// Serves an installed Joomla site with PHP in WebAssembly.
// Usage: node wasm/serve.mjs --site=<joomla root> [--port=8790] [--php=8.4] [--quiet]

import { parseArgs } from 'node:util';
import { serve } from './joomla-wasm.mjs';

const { values } = parseArgs({
  options: {
    site: { type: 'string' },
    port: { type: 'string', default: '8790' },
    php: { type: 'string', default: '8.4' },
    quiet: { type: 'boolean', default: false },
  },
});

if (!values.site) {
  console.error('Usage: node wasm/serve.mjs --site=<joomla root> [--port=8790] [--php=8.4] [--quiet]');
  process.exit(1);
}

const { url } = await serve({
  site: values.site,
  port: Number(values.port),
  phpVersion: values.php,
  log: values.quiet ? () => {} : (line) => console.log(line),
});

console.log(`Joomla in WebAssembly (PHP ${values.php}) at ${url}/ and ${url}/administrator/`);
