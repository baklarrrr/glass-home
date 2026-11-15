'use strict';
// Bakar Home's own screens at 600x600 in a real browser, with a made-up list: the top never wraps or cuts the link state
// (even with both batteries and the longest state), a chat with a question keeps its reply buttons on screen on one line
// each, no doubled dots, no lone dot, and a quiet card's second line runs to the edge. No outside network.
// Run: node tests/home-layout.cjs [outDir]
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const root=path.resolve(__dirname,'..'),origin='https://layout.test',out=process.argv[2]||'';
const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.png':'image/png'};
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--disable-background-networking']});
  try{
    for(const height of [600,480]){
      const ctx=await browser.newContext({viewport:{width:600,height},serviceWorkers:'block'});
      await ctx.route('**/*',async r=>{
        const u=new URL(r.request().url());if(u.origin!==origin||!u.pathname.startsWith('/glass-home/'))return r.abort();
        const f=path.join(root,u.pathname.slice(12),u.pathname.endsWith('/')?'index.html':'');
        try{await r.fulfill({body:await fs.readFile(f),contentType:mime[path.extname(f)]||'text/plain'});}catch{await r.abort();}
      });
      const page=await ctx.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(String(e)));
      await page.goto(origin+'/glass-home/');
      await page.waitForFunction(()=>document.getElementById('runningBuild'));
      const shot=async name=>{if(out)await page.screenshot({path:path.join(out,name+'-'+height+'.png')});};
      // A paired page without a PC: a real key so anything sent encrypts, and a link that says it is connected.
      await page.evaluate(async()=>{
        const t=Math.floor(Date.now()/1000);
        S.kUp=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);S.topic='made-up';S.devPubB64='made-up';
        S.paused=false;S.links=[{connected:true,subscribe(){},end(){},on(){},publish(){}}];
        S.snap={t:'snap',at:Date.now(),n:{needs:1,work:2,done:3,stop:1},can:{new:['c','x'],projects:[],receipts:1},more:0,
          rows:[{k:'g00000001',st:'needs',ti:'Harbour shot 12 lighting pass',why:'Asks: keep the warm key or go cooler?',p:'c',own:false,at:t-240},
            {k:'g00000002',st:'work',ti:'Poster contact sheet',why:'Rendering six variants',p:'x',own:true,at:t-30}],
          g:{r:{state:'ok',run:0,checkedAt:t-10,validFor:90},gc:{open:3,up:t-3600,top:'Footer link colour is too dim on the contact page',pg:'contact'}}};
        S.askedAt=1;S.heardAt=2;S.pcAt=1;renderWork();renderState();
      });
      const top=()=>page.evaluate(()=>{const r=e=>e.getBoundingClientRect(),t=document.querySelector('.top'),s=document.getElementById('stateText'),m=document.querySelector('.sections');
        return {height:Math.round(r(t).height),cut:s.scrollWidth>s.clientWidth+1,sameRow:Math.abs((r(s).top+r(s).bottom)/2-(r(m).top+r(m).bottom)/2)<12,inside:r(s).right<=600&&r(s).left>=r(m).right,text:s.textContent};});
      const live=await top();
      assert.deepEqual([live.cut,live.sameRow,live.inside],[false,true,true],'Live sits beside the menu, whole: '+JSON.stringify(live));
      // The longest state, with both batteries showing: still whole, still on the menu's row, and the page has not moved.
      await page.evaluate(()=>{
        for(const [id,t] of [['gbat','gbatText'],['bbat','bbatText']]){document.getElementById(id).hidden=false;document.getElementById(t).textContent='100%';}
        S.snap.at=Date.now()-11*3600000;S.links=[];renderState();
      });
      const down=await top();
      assert.equal(down.text,'Reconnecting · 11 h old');
      assert.deepEqual([down.cut,down.sameRow,down.inside,down.height],[false,true,true,live.height],'the longest state with both batteries is whole and the top keeps its height: '+JSON.stringify(down));
      assert.equal(await page.evaluate(()=>{const b=document.getElementById('bbat').getBoundingClientRect();return b.right<=600&&b.width>0;}),true,'and the batteries are still shown');
      await shot('top-longest-state');
      // A quiet card's second line runs under its tag to the edge.
      const why=await page.evaluate(()=>{const row=[...document.querySelectorAll('#nowRows .row:not(.hero)')].find(r=>/site notes/.test(r.textContent));const w=row.querySelector('.why').getBoundingClientRect(),g=row.querySelector('.tag').getBoundingClientRect();return {under:w.top>=g.bottom-2,reaches:w.right>=g.left+40};});
      assert.deepEqual(why,{under:true,reaches:true},'the second line is not stopped where the tag starts');
      // No words, no lone dot.
      assert.equal(await page.evaluate(()=>{const keep=S.kUp;S.kUp=null;renderState();const hidden=document.getElementById('dot').hidden;S.kUp=keep;S.links=[{connected:true,subscribe(){},end(){},on(){},publish(){}}];S.snap.at=Date.now();renderState();return hidden;}),true);
      // A chat with a question and no project name: reply buttons on screen, one line each, no doubled dot.
      await page.evaluate(()=>{
        S.details.g00000001={t:'det',k:'g00000001',at:Date.now(),ti:'Harbour shot 12 lighting pass',p:'c',pr:'',st:'needs',own:false,acts:['say','answer'],asked:'Do a lighting pass on shot 12',
          q:{text:'Keep the warm key light or go cooler for the night look?',opts:['Keep warm','Go cooler'],safe:true},res:'I compared the two looks on frames 40, 120 and 200. Both renders are in the review folder. '.repeat(6)};
        selectTab('work');openDetail('g00000001');
      });
      await page.waitForTimeout(150);
      const chat=await page.evaluate(h=>{const r=e=>e.getBoundingClientRect();
        const acts=[...document.querySelectorAll('#dActions .btn')].map(b=>({text:b.textContent,on:r(b).bottom<=h&&r(b).top>=0&&r(b).right<=600,oneLine:r(b).height<70}));
        const first=document.querySelector('#dOptions .btn');
        return {acts,meta:document.getElementById('dMeta').textContent,menus:getComputedStyle(document.querySelector('.sections')).display,result:Math.round(r(document.getElementById('dResult')).height),
          option:r(first).top>=0&&r(first).bottom<=h,focus:document.activeElement===first};},height);
      assert.ok(chat.acts.length>=2&&chat.acts.every(a=>a.on&&a.oneLine),'every reply button is on screen on one line: '+JSON.stringify(chat.acts));
      assert.equal(chat.meta,'Claude · Needs you','an empty project leaves no doubled dot');
      assert.equal(chat.menus,'none','inside a chat the menus give their rows to the words');
      assert.ok(chat.result>=40,'the report keeps at least a line: '+chat.result);
      assert.deepEqual([chat.option,chat.focus],[true,true],'the first answer is on screen and focused');
      await shot('chat-question');
      // The long report still scrolls inside its room; a short one is only as tall as its words (its focus mark does not run down an empty screen), and a long one after it scrolls again.
      const report=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const r=document.getElementById('dResult'),w=r.parentElement;done({scrolls:w.classList.contains('scrolls'),inside:r.getBoundingClientRect().bottom<=w.getBoundingClientRect().bottom+1,more:r.scrollHeight>r.clientHeight+4,tall:Math.round(r.getBoundingClientRect().height)});}))));
      const long=await report();
      assert.deepEqual([long.scrolls,long.inside,long.more],[true,true,true],'a long report scrolls inside its room: '+JSON.stringify(long));
      await page.evaluate(()=>{const d=S.details.g00000001;d.keep=d.res;d.res='';d.st='work';d.q=null;renderDetail();});
      const short=await report();
      assert.equal(await page.locator('#dResult').innerText(),'Nothing to report yet.');
      assert.ok(!short.scrolls&&short.tall<=60,'a short report is as tall as its words: '+JSON.stringify(short));
      await shot('chat-short-report');
      await page.evaluate(()=>{const d=S.details.g00000001;d.res=d.keep;renderDetail();});
      const again=await report();
      assert.deepEqual([again.scrolls,again.inside,again.more],[true,true,true],'and scrolls again when a long report arrives: '+JSON.stringify(again));
      // Back: the menus return.
      await page.evaluate(()=>history.back());await page.waitForTimeout(150);
      assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.sections')).display),'flex');
      // Review with no link to the PC: the words, and no button that leads nowhere.
      await page.evaluate(()=>selectTab('review'));await page.waitForTimeout(150);
      assert.match(await page.locator('#reviewState').innerText(),/^Review is not linked to your studio PC yet\./);
      assert.equal(await page.locator('#reviewEnter').isVisible(),false,'not linked: no Open Review button');
      // Review linked (a made-up link, no PC): its three places keep their row whichever one is open.
      const linked=await ctx.newPage();
      linked.on('pageerror',e=>errors.push(String(e)));
      await linked.goto(origin+'/glass-home/#sg=made-up~'+Buffer.alloc(32,7).toString('base64url'));
      await linked.waitForFunction(()=>document.getElementById('runningBuild'));
      await linked.click('#section-review');
      await linked.waitForFunction(()=>!document.getElementById('reviewFrame').hidden,null,{timeout:8000});
      const frame=linked.frames().find(f=>/review\/index\.html/.test(f.url()));
      const navTop=()=>frame.evaluate(()=>Math.round(document.getElementById('rootNavigation').getBoundingClientRect().top));
      const inPictures=await navTop();
      await linked.evaluate(()=>HomeShell.openRenders());
      await frame.waitForFunction(()=>document.body.classList.contains('renders-place'),null,{timeout:5000});
      assert.equal(await navTop(),inPictures,'Pictures, Feedback, Renders stay where they are when Renders opens');
      assert.equal(await frame.evaluate(()=>{const n=document.getElementById('rootNavigation').getBoundingClientRect(),t=document.querySelector('.topline').getBoundingClientRect();return t.top>=n.bottom-1;}),true,'the link state sits under them');
      if(out)await linked.screenshot({path:path.join(out,'review-renders-'+height+'.png')});
      assert.deepEqual(errors,[]);
      await ctx.close();
    }
    console.log('PASS Home layout at 600 and 480: the top never wraps or cuts the link state, a chat with a question keeps its reply buttons on screen, no doubled or lone dots.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
