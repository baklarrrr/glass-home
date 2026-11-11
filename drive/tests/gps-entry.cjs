'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.png':'image/png'};
const server = http.createServer(async (req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if (!url.pathname.startsWith('/glass-home/')) return res.writeHead(404).end();
  const file=path.join(root,url.pathname.slice(12),url.pathname.endsWith('/')?'index.html':'');
  try {const bytes=await fs.readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'}).end(bytes);}
  catch {res.writeHead(404).end();}
});
async function fixture(context) {
  await context.addInitScript(()=>{
    const watchers=new Map(), perm={state:'prompt',onchange:null};
    window.gpsTest={count:0,clears:0,perm,watchers,pressCount:0,insideClick:false,gesture:false};
    window.addEventListener('click',e=>{gpsTest.insideClick=e.isTrusted;},{capture:true});
    window.addEventListener('click',()=>{gpsTest.insideClick=false;});
    const fake={
      watchPosition(ok,fail){gpsTest.gesture=gpsTest.insideClick;const id=++gpsTest.count;watchers.set(id,{ok,fail});return id;},
      clearWatch(id){watchers.delete(id);gpsTest.clears++;},
    };
    Object.defineProperty(navigator,'geolocation',{value:fake});
    Object.defineProperty(navigator,'permissions',{value:{query:async()=>perm}});
    gpsTest.fix=()=>{perm.state='granted';perm.onchange?.();for(const w of watchers.values())w.ok({timestamp:Date.now(),coords:{latitude:43.67,longitude:-79.42,heading:90,speed:10,accuracy:5}});};
    gpsTest.error=(code)=>{for(const w of [...watchers.values()])w.fail({code});};
  });
}
async function run(){
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--disable-background-networking']});
 try{
  for(const route of ['home','standalone','home-link','home-previously-asked']){
   const ctx=await browser.newContext({viewport:{width:600,height:600},serviceWorkers:'block'});
   await ctx.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
   await ctx.routeWebSocket(/.*/,s=>s.close());await fixture(ctx);
   const page=await ctx.newPage();
   const home=route!=='standalone',url=origin+'/glass-home/'+(home?(route==='home-link'?'#tab=drive':''):'drive/');
   await page.goto(url);
   if(route==='home-previously-asked'){
    await page.evaluate(()=>{localStorage.setItem('bakar.drive.gps','asked');selectTab('drive');});
    await page.waitForFunction(()=>driveFeed.facts.permission==='prompt');
    assert.equal(await page.evaluate(()=>gpsTest.count),0,'Restoring a previous request does not prompt');
    await page.evaluate(()=>selectTab('work'));
    await page.click('#section-drive');
    assert.equal(await page.evaluate(()=>gpsTest.gesture),true,'A real Drive selection requests location in the same gesture');
   }
   if(route==='home'){
    await page.click('#section-work');
    assert.equal(await page.evaluate(()=>gpsTest.count),0,'Opening Work must not request location');
    await page.click('#section-drive');
   }
   const speed=page.locator(home?'#driveSpeed':'#speed'),status=page.locator(home?'#driveState':'#status');
   await status.waitFor({state:'visible'});
   const save=async stage=>{if(process.env.DRIVE_ENTRY_EVIDENCE)await page.screenshot({path:path.join(process.env.DRIVE_ENTRY_EVIDENCE,route+'-'+stage+'.png')});};
   await page.waitForTimeout(80);
   await save('entry');
   console.log(route,await status.innerText(),'watches',await page.evaluate(()=>gpsTest.count));
   assert.equal(await page.evaluate(()=>gpsTest.count),1,'Entering Drive requests GPS once');
   assert.equal(await speed.innerText(),'—');
   await page.evaluate(()=>gpsTest.error(3));
   await page.waitForFunction(home=> (home?driveFeed:feed).snapshot().status==='timeout',home);
   await page.evaluate(()=>gpsTest.fix());
   await page.waitForFunction(id=>document.getElementById(id).textContent==='36',home?'driveSpeed':'speed');await save('fix');
   if(home){await page.evaluate(()=>selectTab('drive'));assert.equal(await page.evaluate(()=>gpsTest.count),1,'No restart on the current Drive view');}
   await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
   assert.equal(await page.evaluate(()=>gpsTest.watchers.size),0);
   await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));
   await page.waitForFunction(()=>gpsTest.watchers.size===1);
   await page.evaluate(()=>gpsTest.error(1));
   await page.waitForFunction(home=>(home?driveFeed:feed).snapshot().status==='denied',home);
   await save('denied');
   const before=await page.evaluate(()=>gpsTest.count);
   await page.evaluate(()=>{window.dispatchEvent(new Event('pagehide'));window.dispatchEvent(new Event('pageshow'));});
   if(route==='home'){await page.evaluate(()=>selectTab('work'));await page.click('#section-drive');}
   assert.equal(await page.evaluate(()=>gpsTest.count),before,'Returning after denial must not ask again');
   await ctx.close();
  }
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
run().catch(err=>{console.error(err);process.exitCode=1;});
