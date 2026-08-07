import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(dir, '..', 'app');
const port = process.env.PORT || 4443;
const host = process.env.HOST || 'localhost';
const useHttps = process.env.HTTPS === '1' || process.env.LIPSYNC_HTTPS === '1';
const liveReload = process.env.LIVE_RELOAD === '1' || process.argv.includes('--local');
const keyFile = path.join(appDir, 'localhost.key');
const certFile = path.join(appDir, 'localhost.crt');

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'serial=(self), usb=(self)',
};

// HSTS never makes sense over plain HTTP, and dev certs are regenerated
// machine-locally, so scope it tightly — short TTL, no includeSubDomains.
const HSTS_HEADERS = useHttps ? { 'Strict-Transport-Security': 'max-age=300' } : {};

// Build a response header map: base headers first, security headers last so
// they always win, plus HSTS when serving HTTPS.
const withSecurity = (base = {}) => ({ ...base, ...SECURITY_HEADERS, ...HSTS_HEADERS });

const TEXT_HEADERS = withSecurity({ 'Content-Type': 'text/plain; charset=utf-8' });
const BLOCKED_FILE_NAMES = new Set([
  'eslint.config.js',
  'localhost.crt',
  'localhost.key',
  'package-lock.json',
  'package.json',
  'server.js',
  'tsconfig.json',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
};

// --- Live reload (dev:local only) -------------------------------------------
// Watches app/ and tells connected browsers to reload over a Server-Sent
// Events stream. The served HTML gets a <script src> tag injected that points
// at an external client file (/__dev_reload.js) — never inline — so the strict
// app CSP (script-src 'self') stays satisfied and unchanged. The reload is a
// full navigation; CSS/JS edits should not require touching the device.
const RELOAD_CLIENT_JS = "const es = new EventSource('/__dev_reload');\n" + 'es.onmessage = () => location.reload();\n';
const RELOAD_SNIPPET = '<script src="/__dev_reload.js" defer></script>';
const reloadClients = new Set();

function broadcastReload() {
  for (const res of reloadClients) {
    try {
      res.write('data: reload\n\n');
    } catch {}
  }
}

if (liveReload) {
  let timer = null;
  try {
    fs.watch(appDir, { recursive: true }, (_event, filename) => {
      if (!filename || filename.startsWith('.')) return;
      clearTimeout(timer);
      // Debounce bursts of change events into one reload.
      timer = setTimeout(broadcastReload, 100);
    });
  } catch {
    console.error('Live reload unavailable: could not watch app/');
  }
}

if (useHttps && (!fs.existsSync(keyFile) || !fs.existsSync(certFile))) {
  try {
    execSync(
      'openssl req -x509 -nodes -days 3650 -newkey rsa:2048 ' +
        `-keyout '${keyFile}' -out '${certFile}' ` +
        '-subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"',
      { stdio: 'ignore' },
    );
    console.log('Generated localhost.key + localhost.crt');
    fs.chmodSync(keyFile, 0o600);
  } catch {
    console.error(
      'Missing TLS certificate files and openssl is not available.\n' +
        '  Install openssl or place localhost.key + localhost.crt in app/\n' +
        '  On macOS: brew install openssl',
    );
    process.exit(1);
  }
}

if (fs.existsSync(keyFile)) {
  try {
    fs.chmodSync(keyFile, 0o600);
  } catch {}
}

function isBlockedFile(filePath) {
  const relative = path.relative(appDir, filePath);
  const parts = relative.split(path.sep);
  return (
    parts.includes('node_modules') ||
    parts.some((part) => part.startsWith('.')) ||
    BLOCKED_FILE_NAMES.has(path.basename(filePath))
  );
}

function handleRequest(req, res) {
  let file;
  try {
    const parsedUrl = new URL(req.url, `${useHttps ? 'https' : 'http'}://${req.headers.host || 'localhost'}`);
    file = decodeURIComponent(parsedUrl.pathname);
    if (file === '/' || file === '') file = '/index.html';
  } catch {
    res.writeHead(400, TEXT_HEADERS);
    res.end('Bad request');
    return;
  }
  if (file.includes('\0')) {
    res.writeHead(400, TEXT_HEADERS);
    res.end('Bad request');
    return;
  }
  const filePath = path.resolve(appDir, '.' + file);

  // Live-reload SSE stream — never read from disk.
  if (liveReload && file === '/__dev_reload') {
    res.writeHead(
      200,
      withSecurity({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      }),
    );
    res.write(': connected\n\n');
    reloadClients.add(res);
    req.on('close', () => reloadClients.delete(res));
    return;
  }

  // Live-reload client — external file so CSP script-src 'self' allows it.
  if (liveReload && file === '/__dev_reload.js') {
    res.writeHead(
      200,
      withSecurity({
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
      }),
    );
    res.end(RELOAD_CLIENT_JS);
    return;
  }

  if ((!filePath.startsWith(appDir + path.sep) && filePath !== appDir) || isBlockedFile(filePath)) {
    res.writeHead(403, TEXT_HEADERS);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, TEXT_HEADERS);
      res.end('Not found');
      return;
    }
    const ext = path.extname(file);
    const headers = withSecurity({ 'Content-Type': MIME[ext] || 'application/octet-stream' });
    let body = data;
    if (liveReload && ext === '.html') {
      // Inject the reload client into served HTML without touching app/ on disk.
      const html = data.toString('utf8');
      body = html.includes('</body>') ? html.replace('</body>', RELOAD_SNIPPET + '</body>') : html + RELOAD_SNIPPET;
    }
    res.writeHead(200, headers);
    res.end(body);
  });
}

const server = useHttps
  ? https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, handleRequest)
  : http.createServer(handleRequest);

server.on('clientError', (_err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${port} is already in use on ${host}.\n` +
        '  Another instance of this server is probably still running.\n' +
        `  Stop it (lsof -i :${port} | grep LISTEN) or run with PORT=<free-port>.`,
    );
  } else if (err.code === 'EACCES') {
    console.error(`Port ${port} requires elevated privileges. Run as a privileged user or use PORT>=1024.`);
  } else if (err.code === 'EADDRNOTAVAIL') {
    console.error(
      `Cannot bind ${host}:${port} — that address is not available on this machine. Check the HOST env var.`,
    );
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`${useHttps ? 'https' : 'http'}://${host}:${port}`);
});
