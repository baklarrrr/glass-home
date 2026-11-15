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
      assert.equal(new Set(paths).size,6);
      assert.equal(catalog.apps.some(app=>/studio-glass/.test(app.url)||app.name==='Bakar Studio'),false,'Bakar Studio is inside Bakar Home, not a separate app');
      assert.deepEqual(await page.locator('#appRows .group').allTextContents(),[...new Set(catalog.apps.map(app=>app.group))]);
      assert.equal(await page.locator('#appContext').innerText(),'Apps');
      for (const [index, app] of catalog.apps.entries()) {
        const button=page.locator('#appRows .row').nth(index);
        // One press per row: on Back the next swipe starts where the wearer left off.
        if (index===0) await button.focus(); else await page.keyboard.press('ArrowDown');
        assert.equal(await button.evaluate(el=>el===document.activeElement),true,app.name+' focus');
        if (process.env.MENU_EVIDENCE && !offlineCatalog && [0,3,5].includes(index)) {
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
        // The Studio pairing stays in Bakar Home (Review); no catalog app receives it.
        const expected=app.pass==='drive' ? {t:'route-topic',p:'route-public'} : {};
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
      const tidal=page.locator('#appRows .row').filter({has:page.getByText('TIDAL Glass',{exact:true})});
      await Promise.all([page.waitForURL(url=>url.pathname==='/tidal-glass/'),tidal.click()]);
      assert.deepEqual(Object.fromEntries(new URLSearchParams(new URL(page.url()).hash.slice(1))),
        {androidBridge:newBridge},'Only an explicitly provisioned future bridge is forwarded');
      await page.goto(home);
      assert.equal(await page.evaluate(()=>passPairing('tg')),null,'Explicit bridge is never restored');
      await page.click('#tab-games');
      assert.equal(await page.locator('#gameRows .row').count(),0);
      assert.equal(await page.locator('#appRows').isVisible(),false);
      // One menu, named by what each place does.
      assert.deepEqual(await page.locator('.sections button').allTextContents(),['Home','Review','Drive']);
      await page.click('#section-work');
      assert.deepEqual(await page.locator('.tab:visible').allTextContents(),['Now','Chats','Watch','Apps','Games']);
      assert.equal(await page.title(),'Bakar Home');
      await page.click('#section-review');
      assert.equal(await page.locator('#review').isVisible(),true);
      await page.click('#section-work');
      await page.click('#section-drive');
      assert.equal(await page.locator('#drive').isVisible(),true);
      assert.deepEqual(await page.locator('.tab:not([hidden])').allTextContents(),['Route','Drive']); // Drive starts quiet: its menu shows on Up
      assert.deepEqual(errors,[]);
      await context.close();
      console.log((offlineCatalog?'Bundled fallback':'Fetched catalog')+' passed 6 routes, address protection, D-pad, Back and section checks.');
    }
    await mergedStudio(browser);
  } finally {await browser.close();}
}
// What the separate Bakar Studio app did now lives in Review: Pictures, Feedback and Renders. The pairing it saved on
// the glasses (same origin, key sg.pair) is used without pairing again. Synthetic values only; no broker is reached.
async function mergedStudio(browser) {
  const key=Buffer.alloc(32,7).toString('base64url');
  const serve=async context=>{
    await context.routeWebSocket(/.*/, ws => ws.close());
    await context.route('**/*', async route => {
      const url=new URL(route.request().url());
      if (url.origin !== origin || !url.pathname.startsWith('/glass-home/')) return route.abort();
      const filename=path.join(root,url.pathname.slice('/glass-home/'.length) || 'index.html');
      try { return await route.fulfill({body:await fs.readFile(filename),contentType:types[path.extname(filename)] || 'text/plain'}); }
      catch {return route.abort();}
    });
  };
  const cases=[
    ['pairing saved by the old Bakar Studio app',home,()=>localStorage.setItem('sg.pair',JSON.stringify({t:'old-studio-topic',k:window.__k}))],
    ['old Bakar Studio address forwarded here',home+'#sg=old-studio-topic~'+key+'&tab=review&view=renders',()=>{}],
    ['Bakar Studio link opened on Bakar Home',home+'#t=old-studio-topic&k='+key,()=>{}],
  ];
  for (const [name,address,seed] of cases) {
    const context=await browser.newContext({viewport:{width:600,height:600},serviceWorkers:'block',reducedMotion:'reduce'});
    await serve(context);
    await context.addInitScript(k=>{window.__k=k;},key);
    await context.addInitScript(seed);
    const page=await context.newPage();
    const errors=[];
    page.on('pageerror',err=>errors.push(err.message));
    await page.goto(address);
    await page.waitForFunction(()=>typeof HomeShell==='object'&&document.getElementById('runningBuild'));
    assert.deepEqual(await page.evaluate(()=>{const p=passPairing('sg');return p&&[p.t,p.k.length];}),['old-studio-topic',43],name+': the Studio pairing is used');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('gh.pass')).sg.startsWith('old-studio-topic~')),true,name+': kept for next time');
    if (!address.includes('tab=review')) await page.click('#section-review');
    const frame=page.frameLocator('#reviewFrame');
    await page.waitForFunction(()=>!document.getElementById('reviewFrame').hidden);
    assert.equal(new URL(await page.locator('#reviewFrame').getAttribute('src')).search,'','pairing never goes in a query');
    assert.deepEqual(await frame.locator('#rootNavigation button').allTextContents(),['Pictures','Feedback','Renders']);
    if (address.includes('view=renders')) await page.waitForFunction(()=>document.getElementById('appContext').textContent==='Renders');
    else {
      assert.equal(await page.locator('#appContext').innerText(),'Pictures');
      // Swipes alone reach Renders: down from the menu into the frame, across its places, then press.
      // A swipe inside the frame reaches the one focus mover by a message, so each step is awaited, as a wearer would see it.
      await page.frame({url:/review\/index\.html/}).waitForFunction(()=>typeof review!=='undefined'&&!review.busy&&document.body.inert===false);
      const inFrame=id=>page.waitForFunction(id=>document.getElementById('reviewFrame').contentDocument.activeElement?.id===id,id);
      await page.locator('#section-review').focus();
      await page.keyboard.press('ArrowDown');await inFrame('picturesTab');
      await page.keyboard.press('ArrowRight');await inFrame('feedbackTab');
      await page.keyboard.press('ArrowRight');await inFrame('studioTab');
      await page.keyboard.press('Enter');
      await page.waitForFunction(()=>document.getElementById('appContext').textContent==='Renders');
    }
    assert.equal(await frame.locator('#headCard').isVisible(),true,name+': render progress shows');
    assert.equal(await frame.locator('#state').count(),1);
    assert.equal(await frame.locator('#pictureList').isVisible(),false);
    // Up from Renders leads back to the menu, and the menu still leaves the section.
    await frame.locator('#studioTab').focus();
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(()=>document.activeElement?.id==='section-review'); // Up returns to the menu
    await page.click('#section-work');
    assert.equal(await page.locator('#now').isVisible(),true);
    // A render card on Now opens render progress.
    await page.evaluate(()=>openStudio());
    await page.waitForFunction(()=>document.getElementById('appContext').textContent==='Renders'&&!document.getElementById('review').hidden);
    assert.deepEqual(errors,[]);
    await context.close();
    console.log('Merged Studio: '+name+' passed pairing reuse, Renders by arrows, way out and Now card.');
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
