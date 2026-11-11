'use strict';
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),origin='https://speed.test';
const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.png':'image/png'};
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--disable-background-networking']});
 try{
  for(const height of [480,600]){
   const ctx=await browser.newContext({viewport:{width:600,height},serviceWorkers:'block'});
   await ctx.route('**/*',async r=>{
    const u=new URL(r.request().url());if(u.origin!==origin||!u.pathname.startsWith('/glass-home/'))return r.abort();
    const f=path.join(root,u.pathname.slice(12),u.pathname.endsWith('/')?'index.html':'');
    try{await r.fulfill({body:await fs.readFile(f),contentType:mime[path.extname(f)]||'text/plain'});}catch{await r.abort();}
   });
   await ctx.routeWebSocket(/.*/,s=>s.close());
   await ctx.addInitScript(()=>{
    Object.defineProperty(navigator,'permissions',{value:{query:async()=>({state:'granted'})}});
    Object.defineProperty(navigator,'geolocation',{value:{watchPosition(ok,fail){window.gpsOk=ok;window.gpsFail=fail;return 1;},clearWatch(){}}});
   });
   const page=await ctx.newPage();
   for(const standalone of [false,true]){
    const url=origin+'/glass-home/'+(standalone?'drive/':'#tab=drive');
    await page.goto(url);
    const label=page.locator(standalone?'#status':'#driveState'),value=page.locator(standalone?'#speed':'#driveSpeed');
    await page.waitForFunction(()=>typeof window.gpsOk==='function');
    assert.equal(await label.innerText(),'Speed unavailable');assert.equal(await value.innerText(),'—');
    await page.evaluate(()=>gpsFail({code:3}));
    assert.equal(await label.innerText(),'Speed unavailable');
    if(!standalone){
     await page.evaluate(()=>{showPairing('fixture');showPush({id:'fixture',ti:'Example PC notification',tx:'test'});renderState();});
     assert.equal(await page.locator('#drive').isVisible(),true);
     assert.equal(await page.locator('#pair').isVisible(),false);
     assert.equal(await page.locator('#push').isVisible(),false);
     assert.equal(await page.locator('#stateText').textContent(),'');
    }
    await page.evaluate(()=>gpsOk({timestamp:Date.now(),coords:{speed:10,accuracy:3,latitude:43,longitude:-79,heading:90}}));
    assert.equal(await label.innerText(),'Location speed');assert.equal(await value.innerText(),'36');
    if(process.env.QUIET_HUD_EVIDENCE)await page.screenshot({path:path.join(process.env.QUIET_HUD_EVIDENCE,(standalone?'standalone':'home')+'-moving-'+height+'.png')});
    if(standalone){
     await page.evaluate(()=>{S.phone='ready';S.addr={t:'synthetic'};S.code='123456';S.net='up';gpsFail({code:1});openPanel();});
     assert.equal(await page.locator('#panelTitle').innerText(),'Drive details');
     assert.equal(await page.locator('#panelCode').isVisible(),false);
     assert.ok(!(await page.locator('#panelHelp').innerText()).includes("phone’s GPS"));
     if(process.env.QUIET_HUD_EVIDENCE)await page.screenshot({path:path.join(process.env.QUIET_HUD_EVIDENCE,'details-'+height+'.png')});
    }
   }
   await ctx.close();
  }
  console.log('PASS quiet 600/480 HUD, legitimate zero/missing speed paths, details, and PC recovery without covering Drive');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
