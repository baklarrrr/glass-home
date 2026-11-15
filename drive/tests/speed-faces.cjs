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
      const words=async()=>standalone?(await page.locator('#status').innerText())+' / '+(await page.locator('#speedNext').innerText()):page.locator('#driveState').textContent();
      const pass=async ms=>{for(let t=0;t<ms;t+=1000)await page.clock.runFor(1000);};
      const shot=async name=>{if(out)await page.screenshot({path:path.join(out,(standalone?'drive-':'home-')+name+'.png')});};
      await pass(1000);
      assert.equal(await speed(),'—',face+': before any fix there is no number');

      // Home's Drive tab, no speed: the reason and the next step are two lines above the dash, and the dash is where the number will be.
      let dashTop=0;
      if(!standalone){
        const two=await page.evaluate(()=>{const r=e=>e.getBoundingClientRect(),w=document.querySelector('#driveState .why'),n=document.querySelector('#driveState .next'),d=document.getElementById('driveSpeed');
          return {text:document.getElementById('driveState').textContent,why:w.textContent,next:getComputedStyle(n,'::first-letter').textTransform,stacked:r(n).top>=r(w).bottom-1,above:r(n).bottom<=r(d).top+12,size:parseFloat(getComputedStyle(w).fontSize)>=21,top:Math.round(r(d).top)};});
        dashTop=two.top;delete two.top;
        assert.deepEqual(two,{text:'Waiting for location · it comes from your phone',why:'Waiting for location',next:'uppercase',stacked:true,above:true,size:true},'Home: two readable lines, the same words');
      }

      await page.evaluate(()=>play(0,0));
      assert.equal(await speed(),'0');
      if(!standalone)assert.equal(await page.evaluate(()=>Math.round(document.getElementById('driveSpeed').getBoundingClientRect().top)),dashTop,'Home: the number is exactly where the dash was');
      // A 0 is never "estimated": from five seconds it is standing still.
      await pass(6000);
      assert.match(await words(),/^Standing still/,face+': at six seconds a 0 says standing still, not estimated');
      await pass(36000);
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
      else {
        // Bakar Drive draws the same tape with the same code (DriveGuide.paintTape), in the same place under km/h.
        const tape=await page.evaluate(()=>{const t=document.getElementById('tape'),r=t.getBoundingClientRect(),u=document.querySelector('.unit').getBoundingClientRect();
          return {seen:t.style.visibility,label:t.getAttribute('aria-label'),read:t.querySelector('.readout')?.textContent,under:r.top>=u.bottom,inside:r.left>=0&&r.right<=600&&r.height===44};});
        assert.deepEqual(tape,{seen:'visible',label:'Compass: heading E, 90 degrees',read:'E 090°',under:true,inside:true},'Bakar Drive: the compass tape shows on foot');
      }
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

      // The speed never moves when a line under it comes or goes: the turn line (Home) and the tape keep their room.
      if(!standalone)assert.deepEqual(await page.evaluate(()=>{const t=document.getElementById('driveTurn');return [t.hidden,Math.round(t.getBoundingClientRect().height),getComputedStyle(t).visibility];}),[true,39,'hidden'],'Home: an empty turn line still takes its room');
      else {
        // A fixed camera on the road ahead takes the top line on Bakar Drive too (cameras.js, the shared module), amber over its limit.
        assert.equal(await page.evaluate(()=>document.getElementById('hud').dataset.camera),'none');
        await page.evaluate(()=>cams.load({made:new Date().toISOString().slice(0,10),region:'Test',items:[[10,10+6300/109639,'s',50]]}));
        for(let i=0;i<4;i++){await page.evaluate(i=>play(6000+i*20,20),i);await page.clock.runFor(1000);}
        assert.match(await page.locator('#camLine').innerText(),/^Speed camera · limit 50 · \d+ m$/,'Bakar Drive: the camera ahead is named with its limit and distance');
        assert.deepEqual(await page.evaluate(()=>{const c=document.getElementById('camLine'),r=c.getBoundingClientRect(),s=document.getElementById('speed').getBoundingClientRect();return [c.scrollWidth<=c.clientWidth,r.bottom<=s.top,r.left>=0&&r.right<=600];}),[true,true,true],'the whole camera line shows, above the number, not cut by the clock');
        assert.equal(await page.evaluate(()=>document.getElementById('hud').dataset.camera),'over','72 in a 50: the number goes amber');
        assert.equal(await page.evaluate(()=>getComputedStyle(document.getElementById('speed')).color),'rgb(255, 193, 94)');
        await shot('camera');
        await pass(6000);
        assert.equal(await page.evaluate(()=>document.getElementById('hud').dataset.camera),'none','no live reading, no camera line');
      }

      if(!standalone){
        // Speed details with no phone app linked: nothing to stop.
        await page.keyboard.press('Enter');await page.evaluate(()=>document.getElementById('driveInfoButton').click());
        assert.equal(await page.locator('#driveInfo').isVisible(),true);
        assert.equal(await page.locator('#drivePhoneToggle').isVisible(),false,'no Stop phone link button without a phone link');
        assert.equal(await page.locator('#drivePhoneState').innerText(),'No phone app is linked');
        // The words scroll and the Back button stays on screen, whatever the length.
        const box=await page.evaluate(()=>{const r=id=>document.getElementById(id).getBoundingClientRect();return {back:r('driveInfoClose').bottom<=600&&r('driveInfoClose').top>=0,head:r('driveInfo').top>=0,focus:document.activeElement.id};});
        assert.deepEqual(box,{back:true,head:true,focus:'driveInfoClose'},'details open with the heading and Back to speed both on screen');
        await page.keyboard.press('ArrowUp');
        assert.equal(await page.evaluate(()=>document.activeElement.id),'driveInfoBody','up from Back reaches the words');
        await page.keyboard.press('ArrowDown');await page.clock.runFor(600);
        await page.waitForFunction(()=>document.getElementById('driveInfoBody').scrollTop>0,null,{timeout:3000}).catch(()=>{});
        assert.ok(await page.evaluate(()=>document.getElementById('driveInfoBody').scrollTop)>0,'down scrolls the words');
        for(let i=0;i<20&&await page.evaluate(()=>document.activeElement.id)!=='driveInfoClose';i++){await page.keyboard.press('ArrowDown');await page.clock.runFor(600);await page.waitForTimeout(250);}
        assert.equal(await page.evaluate(()=>document.activeElement.id),'driveInfoClose','past the end of the words, down returns to Back to speed');
        assert.equal(await page.evaluate(()=>document.getElementById('driveInfoClose').getBoundingClientRect().bottom<=600),true);
        await shot('details-no-phone');
      }
      assert.deepEqual(errors,[]);
      await ctx.close();
    }
    console.log('PASS both Drive faces: standing still stays 0 with its age, a moving speed is dropped at 5 s, walking and sparse walking fixes, a phone clock 1.5 s ahead, no Stop phone link without a link.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
