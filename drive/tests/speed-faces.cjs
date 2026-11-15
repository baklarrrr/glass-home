'use strict';
// Both Drive faces in a real browser with a played location feed and a played clock: standing still stays 0, a moving speed
// is never held, walking pace shows, a phone clock a little ahead still gives a speed, and Speed details has no button for
// a phone link that does not exist. No outside network, no coordinates of a real place.
// Run: node drive/tests/speed-faces.cjs [outDir]
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),origin='https://faces.test',out=process.argv[2]||'';
const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.png':'image/png'};
const GEO=()=>{
  const watchers=new Map();let n=0;
  Object.defineProperty(navigator,'permissions',{value:{query:async()=>({state:'granted'})}});
  Object.defineProperty(navigator,'geolocation',{value:{
    watchPosition(ok,fail){const id=++n;watchers.set(id,{ok,fail});return id;},clearWatch(id){watchers.delete(id);},
    getCurrentPosition(){/* the played provider answers its watch only */}}});
  // Metres east of a made-up spot (10 N, 10 E), with or without a speed from the device.
  window.play=(east,speed,ahead=0)=>{for(const w of [...watchers.values()])w.ok({timestamp:Date.now()+ahead,coords:{speed,heading:null,accuracy:8,latitude:10,longitude:10+east/109639}});};
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
      const speed=()=>page.locator(standalone?'#speed':'#driveSpeed').innerText();
      const words=async()=>standalone?(await page.locator('#status').innerText())+' / '+(await page.locator('#speedNext').innerText()):page.locator('#driveState').innerText();
      const pass=async ms=>{for(let t=0;t<ms;t+=1000)await page.clock.runFor(1000);};
      const shot=async name=>{if(out)await page.screenshot({path:path.join(out,(standalone?'drive-':'home-')+name+'.png')});};
      await pass(1000);
      assert.equal(await speed(),'—',face+': before any fix there is no number');

      // Standing still: the device says 0, then the phone sends nothing more.
      await page.evaluate(()=>play(0,0));
      assert.equal(await speed(),'0');
      await pass(42000);
      assert.equal(await speed(),'0',face+': 0 stays 0 while fixes are quiet');
      assert.equal(await words(),standalone?'Standing still / Last location 40 s ago':'Standing still · last location 40 s ago',face+': and says how old the last fix is');
      await shot('standing-still');
      // A fix that shows movement replaces it at once.
      await page.evaluate(()=>play(50,9));
      assert.equal(await speed(),'32');
      // Moving, then quiet: the old speed goes after five seconds, with the reason.
      await pass(5200);
      assert.equal(await speed(),'—',face+': a moving speed is never held');
      assert.equal(await words(),standalone?'No new location / Waiting for your phone':'No new location · waiting for your phone');

      // On foot: no speed from the device, a fix a second, 1.4 m/s (5 km/h) for 40 s.
      let east=100;
      for(let i=0;i<40;i++){east+=1.4;await page.evaluate(e=>play(e,null),east);await page.clock.runFor(1000);}
      const walking=Number(await speed());
      assert.ok(walking>=4&&walking<=6,face+': walking pace reads '+walking+' km/h');
      assert.match(await words(),/^Estimated speed/);
      if(!standalone)assert.equal(await page.evaluate(()=>document.getElementById('driveTape').style.visibility),'visible','Home: the compass has a course on foot');
      else assert.equal(await page.locator('#heading').innerText(),'E','Bakar Drive: the heading shows on foot');
      await shot('walking');
      // The walker stops: fixes keep coming from the same place.
      for(let i=0;i<14;i++){await page.evaluate(e=>play(e,null),east+(i%2));await page.clock.runFor(1000);}
      assert.equal(await speed(),'0',face+': standing after a walk is 0');
      // Sparse fixes on foot: one every 7 s. The slow speed is held between them instead of flashing a dash.
      for(let i=0;i<20;i++){east+=1.4;await page.evaluate(e=>play(e,null),east);await page.clock.runFor(1000);}
      let seen=new Set();
      for(let i=0;i<4;i++){east+=9.8;await page.evaluate(e=>play(e,null),east);for(let t=0;t<7;t++){await page.clock.runFor(1000);seen.add(await speed());}}
      assert.ok(!seen.has('—'),face+': no dash between sparse walking fixes ('+[...seen].join(' ')+')');
      assert.ok([...seen].every(v=>Number(v)>=3&&Number(v)<=7),face+': and the held speed is a walking one ('+[...seen].join(' ')+')');

      // The phone's clock runs 1.5 s ahead of the glasses'.
      await pass(12000);assert.equal(await speed(),'—');
      await page.evaluate(()=>play(5000,20,1500));
      assert.equal(await speed(),'72',face+': a fix stamped 1.5 s ahead still gives a speed');
      await pass(6000);
      await page.evaluate(()=>play(5200,20,60000));
      assert.equal(await speed(),'—',face+': a fix stamped a minute ahead does not');

      if(!standalone){
        // Speed details with no phone app linked: nothing to stop.
        await page.keyboard.press('Enter');await page.evaluate(()=>document.getElementById('driveInfoButton').click());
        assert.equal(await page.locator('#driveInfo').isVisible(),true);
        assert.equal(await page.locator('#drivePhoneToggle').isVisible(),false,'no Stop phone link button without a phone link');
        assert.equal(await page.locator('#drivePhoneState').innerText(),'No phone app is linked');
        await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(()=>document.activeElement.id),'driveInfoClose','focus stays on a control that exists');
        await shot('details-no-phone');
      }
      assert.deepEqual(errors,[]);
      await ctx.close();
    }
    console.log('PASS both Drive faces: standing still stays 0 with its age, a moving speed is dropped at 5 s, walking and sparse walking fixes, a phone clock 1.5 s ahead, no Stop phone link without a link.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
