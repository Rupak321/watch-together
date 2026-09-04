#!/usr/bin/env node
/**
 * Serve a folder of films straight off this machine, over a public HTTPS URL.
 *
 *   npm run share -- "D:\Movies"
 *
 * Beats uploading for the usual case: nothing is copied anywhere, so a four
 * gigabyte film is ready in seconds rather than fifty minutes, there is no
 * storage limit, and no account is needed. The link it prints goes straight
 * into the room's Link box.
 *
 * The trade is that this machine is the server — it has to stay awake, and
 * every viewer streams from its upload.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, statSync, existsSync, readdirSync } from 'node:fs';
import { join, extname, resolve, basename } from 'node:path';

const dir = resolve(process.argv[2] || process.cwd());
const PORT = Number(process.env.PORT || 8099);

const TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg'
};

if (!existsSync(dir)) {
  console.error(`No such folder: ${dir}`);
  process.exit(1);
}

const server = createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');

  if (!name) {
    const files = readdirSync(dir).filter((f) => TYPES[extname(f).toLowerCase()]);
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(files.length ? files.join('\n') : 'No playable files in this folder.');
  }

  // Refuse anything trying to climb out of the shared folder.
  const file = join(dir, basename(name));
  if (!existsSync(file)) {
    res.writeHead(404);
    return res.end('Not found');
  }

  const { size } = statSync(file);
  const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;

  // Range is what makes seeking work. Python's http.server does not implement
  // it, which is why that common suggestion gives an unseekable film.
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Number(m[2]) : size - 1;
    if (start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, {
      'content-type': type,
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      'access-control-allow-origin': '*'
    });
    return createReadStream(file, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': size,
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*'
  });
  createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Serving ${dir} on http://localhost:${PORT}`);
  console.log('Opening a public tunnel…\n');

  const cf = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32'
  });

  const watch = (chunk) => {
    const text = chunk.toString();
    const url = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0];
    if (!url) return;

    const files = readdirSync(dir).filter((f) => TYPES[extname(f).toLowerCase()]);
    console.log('\n  Paste one of these into the room\'s Link box:\n');
    for (const f of files) console.log(`    ${url}/${encodeURIComponent(f)}`);
    if (!files.length) console.log(`    (no playable files found — put an .mp4 in ${dir})`);
    console.log('\n  Keep this window open. Ctrl+C ends it.\n');
  };

  cf.stdout.on('data', watch);
  cf.stderr.on('data', watch); // cloudflared prints the URL to stderr

  cf.on('error', () => {
    console.error('\ncloudflared is not installed. On Windows:');
    console.error('  winget install --id Cloudflare.cloudflared\n');
    process.exit(1);
  });

  process.on('SIGINT', () => {
    cf.kill();
    server.close();
    process.exit(0);
  });
});
