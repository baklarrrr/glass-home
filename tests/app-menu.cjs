// Offline real-browser test. Install Playwright and run: node tests/app-menu.cjs
// CHROME_PATH can select a locally installed Chromium.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const origin = 'https://baklarrrr.github.io';
const home = origin + '/glass-home/';
const catalog = require('../apps.json');
const paths = catalog.apps.map(app => new URL(app.url).pathname);
const types = { '.html':'text/html', '.css':'text/css', '.svg':'image/svg+xml', '.js':'text/javascript', '.json':'application/json' };

async function run() {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--disable-background-networking']});
  try {
    for (const offlineCatalog of [false,true]) {
      const context=await browser.newContext({viewport:{width:600,height:600},serviceWorkers:'block',reducedMotion:'reduce'});
      const connections=[];
      await context.routeWebSocket(/.*/, ws => {connections.push(ws.url());ws.close();});
      await context.route('**/*', async route => {
        const url=new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (paths.includes(url.pathname)) return route.fulfill({contentType:'text/html',body:'<title>Destination</title>Opened'});
        if (offlineCatalog && url.pathname === '/glass-home/apps.json') return route.abort();
        const relative=url.pathname.slice('/glass-home/'.length) || 'index.html';
        const filename=url.pathname.startsWith('/glass-home/') ? path.join(root,relative) :
          process.env.MENU_RELEASE_ROOT && path.join(process.env.MENU_RELEASE_ROOT,url.pathname.slice(1));
        if (!filename) return route.abort();
        try { return await route.fulfill({body:await fs.readFile(filename),contentType:types[path.extname(filename)] || 'text/plain'}); }
        catch {return route.abort();}
      });
      const oldPhoneKey = Buffer.alloc(32, 9).toString('base64url');
      await context.addInitScript(key=>{
        localStorage.setItem('tg.pair', JSON.stringify({t:'old-shared', k:key}));
        localStorage.setItem('gh.pass', JSON.stringify({tg:'old-saved~'+key}));
      },oldPhoneKey);
      const page=await context.newPage();
      const errors=[];
      page.on('pageerror',err=>errors.push(err.message));
      await page.goto(home+'#sg=studio-topic~studio-key&tg=old-installed~'+oldPhoneKey);
      assert.equal(await page.evaluate(()=>Boolean(passPairing('tg'))), false,
        'An old install, saved Home pairing or shared phone key cannot select Android');
      await page.click('#tab-apps');
      await page.locator('#appRows .row').first().waitFor();
      assert.deepEqual(await page.locator('#appRows .ti').allTextContents(),catalog.apps.map(app=>app.name));
      assert.equal(new Set(paths).size,7);
      assert.deepEqual(await page.locator('#appRows .group').allTextContents(),[...new Set(catalog.apps.map(app=>app.group))]);
      assert.equal(await page.locator('#appContext').innerText(),'Apps');
      for (const [index, app] of catalog.apps.entries()) {
        const button=page.locator('#appRows .row').nth(index);
        // One press per row: on Back the next swipe starts where the wearer left off.
        if (index===0) await button.focus(); else await page.keyboard.press('ArrowDown');
        assert.equal(await button.evaluate(el=>el===document.activeElement),true,app.name+' focus');
        if (process.env.MENU_EVIDENCE && !offlineCatalog && [0,3,6].includes(index)) {
          await page.waitForTimeout(250);
          await page.screenshot({path:path.join(process.env.MENU_EVIDENCE,'menu-'+index+'.png')});
        }
        if (app.pass==='drive') {
          // Simulate the separately accepted Drive link, never Studio Home's t/p or a pending offer.
          await page.evaluate(()=>{drivePhone.link={addr:{t:'route-topic',p:'route-public',extra:'omit'}};});
        }
        await Promise.all([page.waitForURL(url=>url.pathname===new URL(app.url).pathname),page.keyboard.press('Enter')]);
        const url=new URL(page.url());
        assert.equal(url.search,'');
        const expected=app.pass==='drive' ? {t:'route-topic',p:'route-public'} :
          app.pass==='sg' ? {t:'studio-topic',k:'studio-key'} : {};
        assert.deepEqual(Object.fromEntries(new URLSearchParams(url.hash.slice(1))),expected);
        await page.goBack();
        await page.waitForFunction(url=>document.activeElement?.dataset.appUrl===url,app.url);
        assert.equal(await page.locator('#tab-apps').getAttribute('aria-selected'),'true');
      }
      assert.equal(await page.evaluate(()=>S.tg), null, 'No Android bridge was opened');
      assert.deepEqual(connections, [], 'A legacy Android pairing never opens a socket');
      const newBridge='future-topic~'+oldPhoneKey;
      await page.goto(home+'#androidBridge='+encodeURIComponent(newBridge));
      await page.click('#tab-apps');
      const tidal=page.locator('#appRows .row').filter({has:page.getByText('Tidal',{exact:true})});
      await Promise.all([page.waitForURL(url=>url.pathname==='/tidal-glass/'),tidal.click()]);
      assert.deepEqual(Object.fromEntries(new URLSearchParams(new URL(page.url()).hash.slice(1))),
        {androidBridge:newBridge},'Only an explicitly provisioned future bridge is forwarded');
      await page.goto(home);
      assert.equal(await page.evaluate(()=>passPairing('tg')),null,'Explicit bridge is never restored');
      await page.click('#tab-games');
      assert.equal(await page.locator('#gameRows .row').count(),0);
      assert.equal(await page.locator('#appRows').isVisible(),false);
      await page.click('#section-review');
      assert.equal(await page.locator('#review').isVisible(),true);
      await page.click('#section-work');
      await page.click('#section-drive');
      assert.equal(await page.locator('#drive').isVisible(),true);
      assert.deepEqual(errors,[]);
      await context.close();
      console.log((offlineCatalog?'Bundled fallback':'Fetched catalog')+' passed 7 routes, address protection, D-pad, Back and section checks.');
    }
  } finally {await browser.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
