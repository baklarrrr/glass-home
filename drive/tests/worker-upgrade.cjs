'use strict';
// First reproduce a real installed v41, then serve this checkout. Uses loopback only.
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'../..'),version=require('../../release.json').build;
const os=require('node:os');
const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json'};
async function activated(page,expected){
 await page.evaluate(async()=>{const reg=await navigator.serviceWorker.ready;await reg.update();});
 await page.waitForFunction(async name=>{
  const reg=await navigator.serviceWorker.getRegistration();
  if(!reg?.active||reg.active.state!=='activated')return false;
  const channel=new MessageChannel();
  return new Promise(resolve=>{
   const done=value=>{channel.port1.close();resolve(value);};
   const timer=setTimeout(()=>done(false),375);
   channel.port1.onmessage=e=>{clearTimeout(timer);done(e.data===name);};
   reg.active.postMessage('running-shell',[channel.port2]);
  });
 },expected,{timeout:45000,polling:100});
}
async function run(){
 let old=true,priorDir;
 const baseline=await fs.mkdtemp(path.join(os.tmpdir(),'drive-upgrade-'));
 for(const ref of ['56523c9','74bbe03']){
  const dir=path.join(baseline,ref);await fs.mkdir(dir);
  const archive=execFileSync('git',['archive',ref],{cwd:root,maxBuffer:32*1024*1024});
  execFileSync('tar',['-x','-C',dir],{input:archive});
 }
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/outside')return res.end('outside');
  if(!url.pathname.startsWith('/glass-home/'))return res.writeHead(404).end();
  const file=url.pathname.slice(12)+(url.pathname.endsWith('/')?'index.html':'');
  try{
   const bytes=await fs.readFile(path.join(old?priorDir:root,file));
   res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'text/plain','Cache-Control':'no-cache'}).end(bytes);
  }catch{res.writeHead(404).end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
 try{
  for(const [slug,cache] of [['','glass-home-v'],['drive/','bakar-drive-v']]){
   for(const [ref,priorBuild] of [['56523c9',null],['74bbe03',44]])for(const active of [true,false]){
    old=true;priorDir=path.join(baseline,ref);
    const ctx=await browser.newContext({viewport:{width:600,height:600}});
    await ctx.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
    await ctx.routeWebSocket(/.*/,s=>s.close());
    await ctx.addInitScript(()=>{
     window.documentMarker=crypto.randomUUID();
     if(location.pathname.startsWith('/glass-home/'))sessionStorage.loads=String(Number(sessionStorage.loads||0)+1);
    });
    const pg=await ctx.newPage();pg.setDefaultTimeout(45000);pg.setDefaultNavigationTimeout(60000);
    const go=target=>pg.goto(target,{waitUntil:'domcontentloaded'});
    const url=origin+'/glass-home/'+slug+(slug?'':'#tab=drive');
    await go(url);await pg.evaluate(()=>navigator.serviceWorker.ready.then(()=>true));await pg.reload({waitUntil:'domcontentloaded'});
    await pg.waitForFunction(()=>navigator.serviceWorker.controller);
    assert.equal(await pg.evaluate(()=>document.getElementById('runningBuild')?.textContent||null),priorBuild?'v'+priorBuild:null);
    await pg.evaluate(()=>{localStorage.setItem('fixture-preserved','yes');});
    const marker=await pg.evaluate(()=>documentMarker);
    if(!active)await go(origin+'/outside');
    old=false;
    if(active){
     // Simulate the browser's background update check arriving during the old Drive HUD.
     await activated(pg,cache+version);
     await pg.evaluate(()=>{window.dispatchEvent(new Event('pagehide'));window.dispatchEvent(new Event('pageshow'));});
     assert.equal(await pg.evaluate(()=>documentMarker),marker);
     assert.equal(await pg.evaluate(()=>document.getElementById('runningBuild')?.textContent||null),priorBuild?'v'+priorBuild:null,'Never relabel or reload the active HUD');
     await go(origin+'/outside');
    }
    await go(url);
    // Creating a cache precedes installation/activation. A cached-first old
    // worker can serve its coherent prior document on this first navigation.
    await activated(pg,cache+version);
    if(await pg.locator('#runningBuild').textContent({timeout:1500}).catch(()=>null)!=='v'+version){
      const before=await pg.evaluate(()=>documentMarker);
      await go(origin+'/outside');await go(url);
      assert.notEqual(await pg.evaluate(()=>documentMarker),before);
    }
    await pg.waitForFunction(build=>document.getElementById('runningBuild')?.textContent==='v'+build,version);
    const nav=await pg.evaluate(()=>sessionStorage.loads);
    await pg.evaluate(()=>{for(let i=0;i<3;i++){window.dispatchEvent(new Event('pageshow'));document.dispatchEvent(new Event('visibilitychange'));}});
    await pg.waitForTimeout(150);assert.equal(await pg.evaluate(()=>sessionStorage.loads),nav,'No reload loop on resume');
    await go(origin+'/outside');await ctx.setOffline(true);await go(url);
    await pg.waitForFunction(build=>document.getElementById('runningBuild')?.textContent==='v'+build,version);
    assert.equal(await pg.evaluate(()=>localStorage.getItem('fixture-preserved')),'yes');
    console.log('PASS',slug||'Home','from',ref,active?'update during HUD':'ordinary reopen','→ v'+version+' online and offline; no forced reload or storage loss.');
    await ctx.close();
   }
  }
 }finally{await browser.close();await new Promise(r=>server.close(r));await fs.rm(baseline,{recursive:true,force:true});}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
