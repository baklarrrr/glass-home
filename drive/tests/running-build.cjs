'use strict';
// Offline mixed-shell and encrypted-report test. No phone, broker or coordinates leave Chromium.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../..');
const version=require('../../release.json').build;
const origin='https://local.invalid',base=origin+'/glass-home/';
const media={'.css':'text/css','.js':'text/javascript','.json':'application/json','.html':'text/html','.svg':'image/svg+xml','.png':'image/png'};
async function run(){
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--disable-background-networking']});
 try{
  for(const size of [600,480]){
   const ctx=await browser.newContext({viewport:{width:600,height:size},serviceWorkers:'block'});
   let scriptBuild=version;
   await ctx.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.origin!==origin||!u.pathname.startsWith('/glass-home/'))return route.abort();
    const rel=u.pathname.slice(12)+(u.pathname.endsWith('/')?'index.html':'');
    try{
     let body=await fs.readFile(path.join(root,rel));
     if(/(?:^|\/)runtime\/[^/]+\.js$/.test(rel))body=body.toString().replace(/const APP_BUILD = \d+;/,'const APP_BUILD = '+scriptBuild+';');
     if(rel.endsWith('index.html'))body=body.toString().replace('</head>','<meta name="simulated-worker-version" content="999"></head>');
     await route.fulfill({body,contentType:media[path.extname(rel)]||'text/plain'});
    }catch{await route.abort();}
   });
   await ctx.routeWebSocket(/.*/,s=>s.close());
   await ctx.addInitScript(()=>{
    window.testLoc={};Object.defineProperty(navigator,'geolocation',{value:{watchPosition(ok,fail){testLoc.ok=ok;testLoc.fail=fail;return 1;},clearWatch(){}}});
    Object.defineProperty(navigator,'permissions',{value:{query:async()=>({state:'granted'})}});
   });
   const page=await ctx.newPage();
   for(const slug of ['','drive/']){
    scriptBuild=version;await page.goto(base+slug);
    const label=page.locator('#runningBuild');await label.waitFor();
    assert.equal(await label.innerText(),'v'+version);
    await page.reload();assert.equal(await label.innerText(),'v'+version);
    scriptBuild=version+1;await page.reload();assert.equal(await label.innerText(),'v'+(version+1));
    assert.ok(await label.isVisible());
    assert.equal(await page.locator('meta[name="simulated-worker-version"]').getAttribute('content'),'999');
    if(!slug){await page.click('#section-drive');await page.waitForSelector('#driveHud');}
    const box=await label.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.y+box.height<=size);
    if(process.env.BUILD_EVIDENCE){scriptBuild=version;await page.reload();if(!slug)await page.click('#section-drive');await page.screenshot({path:path.join(process.env.BUILD_EVIDENCE,(slug?'standalone':'home')+'-'+size+'.png')});}
   }
   scriptBuild=version;await page.goto(base);
   await page.waitForFunction(()=>document.getElementById('runningBuild')&&S.tab==='now');
   await page.evaluate(async()=>{
    const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    window.reports=[];S.topic='offline-test-topic';S.devPubB64='offline-test-client';S.kUp=key;S.paused=false;
    const link={connected:true,subscribe(){},end(){},on(){},publish:async(topic,body)=>{
      const raw=fromB64url(body.split('.')[2]);
      const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:raw.slice(0,12)},key,raw.slice(12));
      const msg=JSON.parse(new TextDecoder().decode(plain));if(msg.gps)reports.push(msg.gps);
    }};S.links=[link];window.offlineLink=link;
   });
   await page.click('#section-drive');
   await page.waitForFunction(v=>reports.some(g=>g.build===v&&g.positions===0),version);
   await page.evaluate(()=>testLoc.ok({timestamp:Date.now(),coords:{accuracy:3,latitude:12,longitude:12,speed:0,heading:null}}));
   await page.waitForFunction(()=>reports.some(g=>g.positions===1));
   await page.evaluate(()=>{for(let i=0;i<30;i++)paintDrive(driveFeed.snapshot());});
   let summaries=await page.evaluate(()=>reports);
   assert.ok(summaries.length<=3);
   assert.ok(summaries.every(g=>g.build===version&&g.speed===undefined&&g.latitude===undefined&&g.longitude===undefined));
   await page.evaluate(()=>{
    sleep('idle'); // Establish the next broker through the production wake/openLink path.
    window.mqtt={connect(){
      const handlers={}, next={...offlineLink,connected:false,on(event,fn){handlers[event]=fn;return next;}};
      queueMicrotask(()=>{next.connected=true;handlers.connect?.();});
      return next;
    }};
    driveFeed.stop();driveFeed.enable();testLoc.fail({code:3});
   });
   await page.waitForFunction(()=>reports.some(r=>r.status==='timeout'),{},{timeout:6000});
   assert.equal(await page.evaluate(()=>S.paused),false,'A meaningful update wakes an idle private connection');
   await ctx.close();
  }
  console.log('PASS: live JS build on mixed HTML/worker metadata, reload/update and both HUD sizes; encrypted Drive entry, first fix, timeout, idle reconnect and burst suppression.');
 }finally{await browser.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
