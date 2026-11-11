'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const prefix = '/glass-home/';
const mime = { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png' };

async function serve(request, response) {
  const { pathname } = new URL(request.url, 'http://localhost');
  if (!pathname.startsWith(prefix)) return response.writeHead(404).end();
  const name = path.resolve(root, '.' + pathname.slice(prefix.length - 1),
    pathname.endsWith('/') ? 'index.html' : '');
  if (!name.startsWith(root + path.sep)) return response.writeHead(404).end();
  try {
    const bytes = await fs.readFile(name);
    response.writeHead(200, { 'Content-Type': mime[path.extname(name)] || 'application/octet-stream' }).end(bytes);
  } catch {
    response.writeHead(404).end();
  }
}

async function checkApp(browser, base, slug, name, cachePrefix) {
  const context = await browser.newContext({ viewport: { width: 600, height: 600 } });
  try {
    const page = await context.newPage();
    await page.goto(base + slug);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    const keys = await page.evaluate(() => caches.keys());
    const matching = keys.filter(key => key.startsWith(cachePrefix));
    assert.equal(matching.length, 1, name + ' must install exactly one current app cache');
    const version = /^v(\d+)(?:-|$)/.exec(matching[0].slice(cachePrefix.length));
    assert.ok(version, name + ' cache must carry a build number');
    const build = Number(version[1]);
    for (const mode of ['online', 'offline']) {
      if (mode === 'offline') await context.setOffline(true);
      await page.reload();
      const label = page.locator('#runningBuild');
      await label.waitFor({ state: 'visible', timeout: 8000 });
      assert.equal(await label.innerText(), 'v' + build,
        name + ' ' + mode + ' displayed build must match the installed release');
      assert.equal(await page.title(), name);
    }
    await context.setOffline(false);
    const manifestURL = new URL('.well-known/meta-wearables-manifest.json', base + slug);
    const response = await context.request.get(manifestURL.href);
    assert.ok(response.ok(), name + ' glasses manifest');
    const manifest = await response.json();
    assert.equal(manifest.name, name);
    const description = await page.locator('meta[name="description"]').getAttribute('content');
    assert.ok(description?.trim(), name + ' requires a description');
    assert.equal(manifest.description, description);
    assert.equal(manifest.appearance.icon.type, 'monochrome');
    const iconURL = new URL(manifest.appearance.icon.src, manifestURL);
    assert.equal(iconURL.origin, new URL(base).origin);
    const icon = await context.request.get(iconURL.href);
    assert.ok(icon.ok(), name + ' glasses icon must load');
    const artwork = await icon.text();
    assert.match(artwork, /<svg\b/);
    assert.match(artwork, /<(path|polygon|rect|circle|ellipse|line)\b/);
    console.log(name + ' v' + build + ': installed worker, visible label, offline reopen and launcher metadata passed.');
    return { build, artwork };
  } finally {
    await context.close();
  }
}

async function run() {
  const server = http.createServer(serve);
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH,
      args: ['--disable-background-networking'] });
    const base = 'http://127.0.0.1:' + server.address().port + prefix;
    const home = await checkApp(browser, base, '', 'Bakar Home', 'glass-home-');
    const drive = await checkApp(browser, base, 'drive/', 'Bakar Drive', 'bakar-drive-');
    assert.notEqual(home.artwork, drive.artwork, 'Home and Drive need distinct icons');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
