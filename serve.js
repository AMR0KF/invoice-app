const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5050;
const PUBLIC_DIR = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

const server = http.createServer((req, res) => {
  const parsedUrl = (req.url || '/').split('?')[0];

  // API: Supabase configuration
  if (parsedUrl === '/api/supabase-config') {
    let url = process.env.SUPABASE_URL || '';
    let anon_key = process.env.SUPABASE_ANON_KEY || '';
    try {
      const cfgPath = path.join(PUBLIC_DIR, 'data', 'supabase_config.json');
      if (fs.existsSync(cfgPath)) {
        const fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        url = url || fileCfg.url || '';
        anon_key = anon_key || fileCfg.anon_key || '';
      }
    } catch (e) {
      console.warn('Could not read data/supabase_config.json:', e.message);
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    });
    res.end(JSON.stringify({
      enabled: Boolean(url && anon_key),
      url,
      anon_key
    }));
    return;
  }

  // Normalize URL path
  let reqPath = decodeURI(parsedUrl);
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

  const fullPath = path.join(PUBLIC_DIR, reqPath);

  // Security: prevent path traversal outside app directory
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(fullPath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback for HTML5 client routing if necessary
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexPath, (readErr, content) => {
        if (readErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(fullPath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  Invoice Maker Web App`);
  console.log(`  Local: http://localhost:${PORT}/`);
  console.log(`========================================\n`);
});
