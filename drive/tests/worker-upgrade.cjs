'use strict';
// First reproduce a real installed v41, then serve this checkout. Uses loopback only.
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'../..'),prior='56523c9',version=require('../../release.json').build;
const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json'};
async function run(){
 let old=true;
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/outside')return res.end('outside');
  if(!url.pathname.startsWith('/glass-home/'))return res.writeHead(404).end();
  const file=url.pathname.slice(12)+(url.pathname.endsWith('/')?'index.html':'');
  try{
   const bytes=old?execFileSync('git',['show',prior+':'+file],{cwd:root,stdio:['ignore','pipe','ignore']}):await fs.readFile(path.join(root,file));
   res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'text/plain','Cache-Control':'no-cache'}).end(bytes);
  }catch{res.writeHead(404).end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
 try{
  for(const [slug,cache] of [['','glass-home-v'],['drive/','bakar-drive-v']]){
   for(const active of [true,false]){
    old=true;
    const ctx=await browser.newContext({viewport:{width:600,height:600}});
    await ctx.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
    await ctx.routeWebSocket(/.*/,s=>s.close());
    await ctx.addInitScript(()=>{
     window.documentMarker=crypto.randomUUID();
     if(location.pathname.startsWith('/glass-home/'))sessionStorage.loads=String(Number(sessionStorage.loads||0)+1);
    });
    const pg=await ctx.newPage();pg.setDefaultTimeout(16000);
    const url=origin+'/glass-home/'+slug+(slug?'':'#tab=drive');
    await pg.goto(url);await pg.evaluate(()=>navigator.serviceWorker.ready.then(()=>true));await pg.reload();
    await pg.waitForFunction(()=>navigator.serviceWorker.controller);
    assert.equal(await pg.locator('#runningBuild').count(),0);
    await pg.evaluate(()=>{localStorage.setItem('fixture-preserved','yes');});
    const marker=await pg.evaluate(()=>documentMarker);
    if(!active)await pg.goto(origin+'/outside');
    old=false;
    if(active){
     // Simulate the browser's background update check arriving during the old Drive HUD.
     await pg.evaluate(async()=>{const reg=await navigator.serviceWorker.ready;await reg.update();});
     await pg.waitForFunction(async name=>(await caches.keys()).includes(name),cache+version);
     await pg.evaluate(()=>{window.dispatchEvent(new Event('pagehide'));window.dispatchEvent(new Event('pageshow'));});
     assert.equal(await pg.evaluate(()=>documentMarker),marker);
     assert.equal(await pg.locator('#runningBuild').count(),0,'Never relabel or reload already executing v41');
     await pg.goto(origin+'/outside');
    }
    await pg.goto(url);
    await pg.waitForFunction(build=>document.getElementById('runningBuild')?.textContent==='v'+build,version);
    await pg.waitForFunction(async name=>(await caches.keys()).includes(name),cache+version);
    const nav=await pg.evaluate(()=>sessionStorage.loads);
    await pg.evaluate(()=>{for(let i=0;i<3;i++){window.dispatchEvent(new Event('pageshow'));document.dispatchEvent(new Event('visibilitychange'));}});
    await pg.waitForTimeout(150);assert.equal(await pg.evaluate(()=>sessionStorage.loads),nav,'No reload loop on resume');
    await pg.goto(origin+'/outside');await ctx.setOffline(true);await pg.goto(url);
    await pg.waitForFunction(build=>document.getElementById('runningBuild')?.textContent==='v'+build,version);
    assert.equal(await pg.evaluate(()=>localStorage.getItem('fixture-preserved')),'yes');
    console.log('PASS',slug||'Home',active?'update during HUD':'ordinary reopen','→ v'+version+' online and offline; no forced reload or storage loss.');
    await ctx.close();
   }
  }
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
