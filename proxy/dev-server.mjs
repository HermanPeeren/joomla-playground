// Runs the CORS proxy (cors-proxy.js) locally with Node, for development: npm run proxy:dev [-- --port=5480]
// Then build or serve the playground with VITE_CORS_PROXY=http://localhost:5480/

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import proxy from './cors-proxy.js';

const { values } = parseArgs({ options: { port: { type: 'string', default: '5480' } } });
const port = Number(values.port);

createServer(async (incoming, outgoing) => {
  try {
    const request = new Request(`http://localhost:${port}${incoming.url}`, {
      method: incoming.method,
      headers: Object.entries(incoming.headers).flatMap(([name, value]) => (Array.isArray(value) ? value.map((item) => [name, item]) : [[name, value]])),
    });
    const response = await proxy.fetch(request, process.env);

    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    response.body ? Readable.fromWeb(response.body).pipe(outgoing) : outgoing.end();
    console.log(response.status, incoming.method, incoming.url);
  } catch (error) {
    outgoing.writeHead(500, { 'content-type': 'text/plain' }).end(String(error));
  }
}).listen(port, () => console.log(`CORS proxy on http://localhost:${port}/`));
