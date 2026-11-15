'use strict';
// Both Drive faces in a real browser where the glasses' permission question was never answered: Permissions.query says
// "prompt" and location never calls back (what the real glasses reported on 15 Nov 2026). The two lines ask for a press and a
// yes, the button offers Start GPS, every press makes the native request inside the press, and nothing asks by itself.
// Then: allowed but silent names the phone setting. No outside network.
// Run: node drive/tests/permission-faces.cjs [outDir]
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),origin='https://faces.test',out=process.argv[2]||'';
const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.png':'image/png'};
const GEO=()=>{
  const status={state:'prompt',onchange:null};
  window.__perm=status;window.__asks=0;window.__inPress=[];window.__pressing=false;
  Object.defineProperty(navigator,'permissions',{value:{query:async()=>status}});
  const note=()=>{++window.__asks;window.__inPress.push(window.__pressing);};
  Object.defineProperty(navigator,'geolocation',{value:{
    watchPosition(){note();return window.__asks;},clearWatch(){},getCurrentPosition(){note();}}});
  // A press is the only time a request may be made while the answer is open.
  // True from the first listener of a press event to the last one (window, capture → window, bubble): the event's own dispatch.
  for(const type of ['click','keydown']){window.addEventListener(type,()=>{window.__pressing=true;},true);window.addEventListener(type,()=>{window.__pressing=false;});}
};
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--disable-background-networking']});
  try{
    for(const standalone of [false,true]){
      const face=standalone?'Bakar Drive':'Home Drive tab';
      const ctx=await browser.newContext({viewport:{width:600,height:600},serviceWorkers:'block'});
      await ctx.route('**/*',async r=>{
        const u=new URL(r.request().url());if(u.origin!==origin||!u.pathname.startsWith('/glass-home/'))return r.abort();
        const f=path.join(root,u.pathname.slice(12),u.pathname.endsWith('/')?'index.html':'');
        try{await r.fulfill({body:await fs.readFile(f),contentType:mime[path.extname(f)]||'text/plain'});}catch{await r.abort();}
      });
      await ctx.routeWebSocket(/.*/,s=>s.close());
      await ctx.addInitScript(GEO);
      const page=await ctx.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(String(e)));
      await page.clock.install();
      await page.goto(origin+'/glass-home/'+(standalone?'drive/':'#tab=drive'));
      await page.waitForFunction(()=>document.getElementById('runningBuild'));
      const words=async()=>standalone?(await page.locator('#status').innerText())+' / '+(await page.locator('#speedNext').innerText()):page.locator('#driveState').textContent();
      const want=standalone?'Location not allowed yet / Press Start GPS, then say yes':'Location not allowed yet · press Start GPS, then say yes';
      const pass=async ms=>{for(let t=0;t<ms;t+=1000)await page.clock.runFor(1000);};
      const button=standalone?'#gpsBtn':'#driveGps';
      const shot=async name=>{if(out)await page.screenshot({path:path.join(out,(standalone?'drive-':'home-')+name+'.png')});};
      const asks=()=>page.evaluate(()=>window.__asks);
      await pass(3000);
      // Opening Drive with the question unanswered. A first entry may make its one request; after that nothing asks by itself.
      const opened=await asks();
      assert.ok(opened<=1,face+': opening Drive makes at most one request ('+opened+')');
      await pass(120000);
      assert.equal(await asks(),opened,face+': two minutes with the answer open, and no request was made by itself');
      assert.equal(await words(),want,face+': the lines say what to do');
      await shot('permission-prompt');
      // The controls, then Start GPS: each press asks, inside the press.
      await page.keyboard.press('Enter');
      await page.waitForFunction(b=>{const e=document.querySelector(b);return e&&e.getClientRects().length>0;},button);
      assert.equal(await page.locator(button).innerText(),'Start GPS',face+': the button offers Start GPS while the answer is open');
      for(let press=1;press<=3;press++){
        await page.locator(button).focus();
        await page.keyboard.press('Enter');
        assert.equal(await asks(),opened+press,face+': press '+press+' made one native request');
        assert.equal(await page.evaluate(()=>window.__inPress.at(-1)),true,face+': and made it inside the press itself');
        await pass(3000);
        assert.equal(await page.locator(button).innerText(),'Start GPS');
      }
      await pass(60000);
      assert.equal(await asks(),opened+3,face+': a minute later still nothing by itself');
      assert.equal(await words(),want);
      await shot('permission-prompt-controls');
      // The wearer says yes, and the phone still sends nothing: now it is the phone's setting.
      await page.evaluate(()=>{window.__perm.state='granted';window.__perm.onchange&&window.__perm.onchange();});
      await pass(20000);
      assert.equal(await words(),standalone?'No location from your phone / Set Meta AI location to Always':'No location from your phone · set Meta AI location to Always',face+': allowed and silent names the phone setting');
      assert.ok(await asks()>opened+3,face+': once allowed it keeps asking by itself');
      assert.equal(await page.locator(button).innerText(),'Stop GPS');
      await shot('allowed-silent');
      assert.ok(!/Open Meta AI/.test(await page.locator('body').innerText()),face+': nothing says to open Meta AI');
      assert.deepEqual(errors,[]);
      await ctx.close();
    }
    console.log('PASS both Drive faces with the permission unanswered: the lines ask for a press and a yes, each Start GPS press asks inside the press, nothing asks by itself, and allowed-but-silent names the phone setting.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
