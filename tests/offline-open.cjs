'use strict';
// Both apps with their real service workers on a loopback server: installed once, they open with the network off and on
// a network that answers after five seconds, with the compass styles, the camera list and the Battery logger all there.
// A missing Battery logger never stops an app installing or opening. Loopback only.
// Run: node tests/offline-open.cjs
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),build=require('../release.json').build;
const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json'};
(async()=>{
  const net={delay:0,logger:true,seen:[]};
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');net.seen.push(url.pathname);
    if(net.delay)await new Promise(r=>setTimeout(r,net.delay));
    if(url.pathname==='/battery-glass/battery-log.js'){
      if(!net.logger)return res.writeHead(404).end();
      return res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-cache'}).end('window.__logger=document.currentScript.getAttribute("data-app");');
    }
    if(!url.pathname.startsWith('/glass-home/'))return res.writeHead(404).end();
    const file=url.pathname.slice(12)+(url.pathname.endsWith('/')?'index.html':'');
    try{res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'text/plain','Cache-Control':'no-cache'}).end(await fs.readFile(path.join(root,file)));}
    catch{res.writeHead(404).end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=127.0.0.1;localhost']});
  try{
    for(const logger of [true,false]){
      for(const [name,url,cache,app] of [['Bakar Home',origin+'/glass-home/#tab=drive','glass-home-v'+build,'Bakar Home'],['Bakar Drive',origin+'/glass-home/drive/','bakar-drive-v'+build,'Bakar Drive']]){
        net.logger=logger;net.delay=0;
        const ctx=await browser.newContext({viewport:{width:600,height:600}});
        const page=await ctx.newPage(),errors=[];
        page.on('pageerror',e=>errors.push(String(e)));
        await page.goto(url);
        await page.waitForFunction(async name=>{const reg=await navigator.serviceWorker.getRegistration();return reg?.active?.state==='activated'&&(await caches.keys()).includes(name);},cache,{timeout:45000,polling:100});
        assert.ok(true,name+': installs'+(logger?'':' although the Battery logger is missing'));
        // A second visit is controlled by the worker: it keeps the logger for later.
        await page.evaluate(()=>navigator.serviceWorker.ready.then(()=>true));
        await page.reload({waitUntil:'domcontentloaded'});
        await page.waitForFunction(()=>document.getElementById('runningBuild')&&navigator.serviceWorker.controller,null,{timeout:20000});
        await page.waitForLoadState('load');await page.waitForTimeout(600);
        if(logger)assert.equal(await page.evaluate(()=>window.__logger),app,name+': the Battery logger ran with its app name');
        const looks=()=>page.evaluate(()=>{
          const tape=document.querySelector('.gps-tape');
          return {build:document.getElementById('runningBuild').textContent,tape:getComputedStyle(tape).width,body:getComputedStyle(document.body).backgroundColor};});
        const cameras=()=>page.evaluate(()=>{try{return (typeof driveCams!=='undefined'?driveCams:cams).count;}catch(e){return -1;}});
        // The network goes: the app opens all the same, whole.
        await ctx.setOffline(true);
        await page.reload();await page.waitForFunction(()=>document.getElementById('runningBuild'),null,{timeout:8000});
        assert.deepEqual(await looks(),{build:'v'+build,tape:'320px',body:'rgb(0, 0, 0)'},name+': opens with no network, with its styles and the compass styles');
        await page.waitForFunction(()=>{try{return (typeof driveCams!=='undefined'?driveCams:cams).count>0;}catch(e){return false;}},null,{timeout:8000}).catch(()=>{});
        assert.ok(await cameras()>0,name+': the camera list is there with no network ('+await cameras()+')');
        if(logger)assert.equal(await page.evaluate(()=>window.__logger),app,name+': the Battery logger is kept and runs with no network');
        else assert.equal(await page.evaluate(()=>window.__logger),undefined);
        assert.deepEqual(errors,[],name+': nothing thrown offline');
        // A network that takes five seconds to answer anything: the app is on screen long before.
        await ctx.setOffline(false);net.delay=5000;
        const started=Date.now();
        // "On screen" is measured from the page itself, not from the load event: a late logger must not hold the picture.
        await page.reload({waitUntil:'commit'});await page.waitForFunction(b=>document.getElementById('runningBuild')?.textContent==='v'+b&&getComputedStyle(document.querySelector('.gps-tape')).width==='320px',build,{timeout:8000,polling:50});
        const took=Date.now()-started;
        assert.ok(took<2500,name+': on a five-second network it is on screen in '+took+' ms');
        net.delay=0;
        assert.deepEqual(errors,[],name+': nothing thrown on a slow network');
        await ctx.close();
      }
    }
    console.log('PASS offline open: Bakar Home and Bakar Drive open from their service workers with no network and on a five-second network, with styles, compass, camera list and the Battery logger; a missing logger stops nothing.');
  }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
