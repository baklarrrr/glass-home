'use strict';
// Bakar Home's link to the PC, and Review's, in a real browser with a played broker and a played PC: the connection is
// killed and restored, the PC goes quiet and comes back, the link library fails to load, and a message arrives that this
// build cannot draw. Every time there is one calm line, the list stays (marked old), and it recovers by itself.
// The broker and the PC are in this file. No outside network; the pairing is made here for this run and is never printed.
// Run: node tests/link-recovery.cjs [outDir]
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {webcrypto:wc}=require('node:crypto');
const root=path.resolve(__dirname,'..'),origin='https://link.test',out=process.argv[2]||'';
const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.png':'image/png','.webmanifest':'application/manifest+json'};
const b64=b=>Buffer.from(b).toString('base64url'),unb64=s=>new Uint8Array(Buffer.from(s,'base64url'));
// What vendor/mqtt.min.js is replaced with: brokers that connect, drop and refuse on command (window.top.__net).
const BROKER=`(() => {
  const net = (window.top.__net = window.top.__net || { up: true, clients: [], tries: [] });
  window.mqtt = { connect(url) {
    const h = {};
    const c = { url, connected: false, ended: false, subs: [], on(e, f) { (h[e] = h[e] || []).push(f); return c; },
      emit(e, ...a) { for (const f of h[e] || []) f(...a); },
      subscribe(t) { c.subs.push(...[].concat(t)); }, publish(t, p) { if (c.connected) window.__pcUp(t, String(p)); },
      end() { c.connected = false; c.ended = true; },
      reconnect() { net.tries.push([url, Date.now()]); c.dial(); },
      dial() { setTimeout(() => { if (c.ended) return; if (net.up) { c.connected = true; c.emit('connect'); } else { c.emit('error', new Error('refused')); c.emit('close'); } }, 40); },
      drop() { if (!c.connected) return; c.connected = false; c.emit('offline'); c.emit('close'); },
      deliver(t, text) { if (c.connected && c.subs.includes(t)) c.emit('message', t, new TextEncoder().encode(text)); } };
    net.clients.push(c); c.dial(); return c;
  } };
})();`;
function snap(at,title){
  const t=Math.floor(at/1000);
  return {t:'snap',at,n:{needs:1,work:1},can:{new:['c'],projects:[],receipts:1},more:0,
    rows:[{k:'g00000001',st:'needs',ti:title,why:'Asks: warm or cool?',p:'c',own:false,at:t-240},{k:'g00000002',st:'work',ti:'Poster contact sheet',why:'Rendering',p:'x',own:true,at:t-30}],
    g:{r:{state:'ok',run:0,checkedAt:t-10,validFor:90}}};
}
(async()=>{
  // The PC's side of Home's pairing, made for this run.
  const relay=await wc.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const topic='t'+b64(wc.getRandomValues(new Uint8Array(9))),relayPub=b64(await wc.subtle.exportKey('raw',relay.publicKey));
  const reviewKey=wc.getRandomValues(new Uint8Array(32)),reviewTopic='r'+b64(wc.getRandomValues(new Uint8Array(9)));
  const rk=await wc.subtle.importKey('raw',reviewKey,'AES-GCM',false,['encrypt','decrypt']);
  const pc={answer:true,hellos:[],seen:new Set(),keys:null,devId:'',title:'Harbour shot 12',reviewAnswer:true,reviewHellos:[]};
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--disable-background-networking']});
  try{
    const ctx=await browser.newContext({viewport:{width:600,height:600},serviceWorkers:'block'});
    let libraryFails=0;
    await ctx.route('**/*',async r=>{
      const u=new URL(r.request().url());if(u.origin!==origin||!u.pathname.startsWith('/glass-home/'))return r.abort();
      if(u.pathname.endsWith('/vendor/mqtt.min.js')){if(libraryFails>0){libraryFails--;return r.abort();}return r.fulfill({body:BROKER,contentType:'text/javascript'});}
      const f=path.join(root,u.pathname.slice(12),u.pathname.endsWith('/')?'index.html':'');
      try{await r.fulfill({body:await fs.readFile(f),contentType:mime[path.extname(f)]||'text/plain'});}catch{await r.abort();}
    });
    const page=await ctx.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(String(e)));
    const down=async(t,text)=>{for(const f of page.frames())await f.evaluate(([t,text])=>{for(const c of (window.top.__net?.clients||[]))if(c.subs&&c.deliver&&c.url&&window.mqtt&&c.on)c.deliver(t,text);},[t,text]).catch(()=>{});};
    const sealDown=async obj=>{const iv=wc.getRandomValues(new Uint8Array(12));const ct=new Uint8Array(await wc.subtle.encrypt({name:'AES-GCM',iv},pc.keys.down,Buffer.from(JSON.stringify(obj))));return '1.x.'+b64(Buffer.concat([iv,ct]));};
    const sendSnap=async(re,over={})=>{const t=await page.evaluate(()=>Date.now());await down(`bkr/${topic}/d/${pc.devId}/s`,await sealDown({...snap(t,pc.title),re,...over}));};
    await ctx.exposeBinding('__pcUp',async(_,t,payload)=>{
      try{
        if(t===`bkr/${topic}/u`){
          const [v,pub,sealed]=payload.split('.');if(v!=='1')return;
          if(!pc.keys){
            const raw=unb64(pub);pc.devId=b64(new Uint8Array(await wc.subtle.digest('SHA-256',raw))).slice(0,16);
            const dev=await wc.subtle.importKey('raw',raw,{name:'ECDH',namedCurve:'P-256'},false,[]);
            const ikm=await wc.subtle.importKey('raw',await wc.subtle.deriveBits({name:'ECDH',public:dev},relay.privateKey,256),'HKDF',false,['deriveKey']);
            const derive=(dir,use)=>wc.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:Buffer.from('glass-home v1'),info:Buffer.from(`${dir}|${pc.devId}|${topic}`)},ikm,{name:'AES-GCM',length:256},false,[use]);
            pc.keys={up:await derive('up','decrypt'),down:await derive('down','encrypt')};
          }
          const buf=unb64(sealed),m=JSON.parse(Buffer.from(await wc.subtle.decrypt({name:'AES-GCM',iv:buf.slice(0,12)},pc.keys.up,buf.slice(12))).toString());
          if(pc.seen.has(m.id))return;pc.seen.add(m.id);
          if(m.c==='hello'){pc.hellos.push(m.ts);if(pc.answer)await sendSnap(m.id);}
        }else if(t===`bkr/${reviewTopic}/c`){
          const buf=unb64(payload),m=JSON.parse(Buffer.from(await wc.subtle.decrypt({name:'AES-GCM',iv:buf.slice(0,12)},rk,buf.slice(12))).toString());
          if(m.c!=='hello'||pc.seen.has('r'+m.ts))return;pc.seen.add('r'+m.ts);pc.reviewHellos.push(m.ts);
          if(!pc.reviewAnswer)return;
          const iv=wc.getRandomValues(new Uint8Array(12)),body={t:'studio',at:m.ts,re:m.ts,jobs:[{ti:'harbour_shot12',st:'running',pct:42,since:m.ts-600000}]};
          await down(`bkr/${reviewTopic}/s`,b64(Buffer.concat([iv,new Uint8Array(await wc.subtle.encrypt({name:'AES-GCM',iv},rk,Buffer.from(JSON.stringify(body))))])));
        }
      }catch(e){errors.push('played PC: '+e.message);}
    });
    await page.clock.install();
    const pass=async ms=>{for(let t=0;t<ms;t+=500){await page.clock.runFor(500);await page.waitForTimeout(15);}};
    const state=()=>page.locator('#stateText').innerText();
    const rows=()=>page.locator('#nowRows .row').count();
    const shot=async name=>{if(out)await page.screenshot({path:path.join(out,name+'.png')});};
    const net=fn=>page.evaluate(fn);
    const touch=async()=>{await page.keyboard.press('ArrowDown');};   // any swipe keeps the page awake, as on the glasses

    // 1. The link library fails to load twelve times (more than the old limit of ten), then arrives: it never gives up.
    libraryFails=13;   // the page's own script tag, then twelve tries
    await page.goto(`${origin}/glass-home/#t=${topic}&p=${relayPub}&sg=${reviewTopic}~${b64(reviewKey)}`);
    await page.waitForFunction(()=>document.getElementById('runningBuild'));
    await pass(4000);
    assert.equal(await state(),'Connecting…','no library yet: one calm line');
    assert.equal(await page.locator('#nowLine').innerText(),'Connecting…');
    for(let i=0;i<40&&await state()==='Connecting…';i++){await pass(8000);await touch();}
    assert.match(await state(),/^Live · /,'the library arrived on a later try and the link came up by itself');
    assert.equal(libraryFails,0,'all twelve failed tries were made');
    const listed=await rows();assert.ok(listed>=2,'the list is on screen');
    await shot('01-live');

    // 2. Every broker drops and refuses: one calm line, the list stays and is marked old, tries back off.
    await net(()=>{__net.up=false;__net.tries.length=0;for(const c of __net.clients)c.drop();});
    assert.match(await state(),/^Reconnecting · /,'the moment the link drops the line says so, with the time of the list');
    assert.equal(await rows(),listed,'the list stays on screen');
    assert.equal(await page.evaluate(()=>document.body.classList.contains('stale-list')),true,'and is dimmed as old');
    await shot('02-reconnecting');
    for(let i=0;i<8;i++){await pass(10000);await touch();}
    const tries=await net(()=>__net.tries.filter(t=>t[0]===__net.tries[0][0]).map(t=>t[1]));
    const gaps=tries.slice(1).map((t,i)=>Math.round((t-tries[i])/1000));
    assert.ok(tries.length>=6&&tries.length<=12,'one broker was tried '+tries.length+' times in 80 s, not every second');
    assert.ok(gaps.slice(-2).every(g=>g>=8),'the wait between tries grows: '+gaps.join(' '));
    assert.match(await state(),/^Reconnecting · /);
    // 3. The network comes back: the next try connects, the PC is asked again and the list is live, with no press.
    const before=pc.hellos.length;
    await net(()=>{__net.up=true;});
    for(let i=0;i<10&&!/^Live/.test(await state());i++){await pass(5000);await touch();}
    assert.match(await state(),/^Live · /,'back by itself');
    assert.ok(pc.hellos.length>before,'the PC was asked again after the reconnect');
    assert.equal(await page.evaluate(()=>document.body.classList.contains('stale-list')),false);

    // 4. The PC stops answering (the brokers are fine): the line says so with the list's age, and it is asked again with backoff.
    pc.answer=false;const quietFrom=pc.hellos.length;
    await page.evaluate(()=>hello());
    await pass(13000);await touch();
    assert.match(await state(),/^PC quiet · /);
    assert.equal(await rows(),listed);
    for(let i=0;i<9;i++){await pass(10000);await touch();}
    const asked=pc.hellos.slice(quietFrom),waits=asked.slice(1).map((t,i)=>Math.round((t-asked[i])/1000));
    assert.ok(asked.length>=4&&asked.length<=7,'asked again by itself '+asked.length+' times in 103 s: '+waits.join(' '));
    assert.ok(waits[waits.length-1]>waits[0],'each wait is longer than the first: '+waits.join(' '));
    assert.match(await state(),/^PC quiet · \d+ min old$/,'an old list is labelled with its age, not shown as now: '+await state());
    await shot('03-pc-quiet');
    pc.answer=true;pc.title='Harbour shot 13';
    for(let i=0;i<8&&!/^Live/.test(await state());i++){await pass(10000);await touch();}
    assert.match(await state(),/^Live · /,'the PC answers again: live with no press');
    assert.equal(await page.locator('#nowRows .row .ti').first().innerText(),'Harbour shot 13','and the list is the new one');

    // 5. A list this build cannot draw: nothing throws, the list from before stays.
    await sendSnap(undefined,{at:await page.evaluate(()=>Date.now()+1000),rows:{not:'a list'},g:7,n:null});
    await sendSnap(undefined,{at:'yesterday'});
    await down(`bkr/${topic}/d/${pc.devId}/s`,'1.x.'+b64(wc.getRandomValues(new Uint8Array(60))));
    await down(`bkr/${topic}/d/${pc.devId}/s`,'not a message');
    await pass(1000);
    assert.equal(await rows(),listed,'the list is still there');
    assert.equal(await page.locator('#nowRows .row .ti').first().innerText(),'Harbour shot 13');
    assert.deepEqual(errors,[],'and nothing was thrown');

    // 6. No signal at all, with nothing listed yet (a fresh open): the waiting line says what is happening.
    await net(()=>{__net.up=false;for(const c of __net.clients)c.drop();S.snap=null;renderWork();renderState();});
    assert.equal(await page.locator('#nowLine').innerText(),'Connecting…');
    await ctx.setOffline(true);await page.evaluate(()=>{renderState();});
    assert.equal(await page.locator('#nowLine').innerText(),'No signal. It connects by itself when signal returns.');
    assert.equal(await state(),'No signal');
    await shot('04-no-signal');
    await ctx.setOffline(false);await net(()=>{__net.up=true;});
    for(let i=0;i<10&&!/^Live/.test(await state());i++){await pass(5000);await touch();}
    assert.match(await state(),/^Live · /,'signal back: live by itself');

    // 7. Review (the picture frame inside Home) on the same played brokers: drop, calm line, back by itself.
    await page.click('#section-review');
    const frame=()=>page.frames().find(f=>/review\/index\.html/.test(f.url()));
    for(let i=0;i<20&&!(frame()&&await frame().locator('#stateText').innerText().catch(()=>'')==='Live');i++)await pass(1000);
    const review=frame();
    assert.equal(await review.locator('#stateText').innerText(),'Live','Review is live on its own link');
    await net(()=>{__net.up=false;for(const c of __net.clients)c.drop();});
    await pass(7000);
    assert.equal(await review.locator('#stateText').innerText(),'Reconnecting…');
    assert.equal(await review.evaluate(()=>document.body.classList.contains('stale')),true,'Review dims what it shows as old');
    await shot('05-review-reconnecting');
    await net(()=>{__net.up=true;});
    for(let i=0;i<15&&await review.locator('#stateText').innerText()!=='Live';i++)await pass(2000);
    assert.equal(await review.locator('#stateText').innerText(),'Live','Review is back by itself');
    // The PC goes quiet for Review: it says so with the age, asks again by itself, and recovers.
    pc.reviewAnswer=false;const from=pc.reviewHellos.length;
    await review.evaluate(()=>hello());
    await pass(60000);
    assert.match(await review.locator('#stateText').innerText(),/^PC not answering · last update /);
    assert.ok(pc.reviewHellos.length-from>=3,'Review asked again by itself: '+(pc.reviewHellos.length-from));
    pc.reviewAnswer=true;
    for(let i=0;i<40&&await review.locator('#stateText').innerText()!=='Live';i++)await pass(2000);
    assert.equal(await review.locator('#stateText').innerText(),'Live');
    // A summary Review cannot draw, and bytes that are not a message: nothing throws, the screen stays.
    const iv=wc.getRandomValues(new Uint8Array(12)),bad={t:'studio',at:await page.evaluate(()=>Date.now()+5000),jobs:'none',re:1,gpu:[null],money:{a:{b:null}}};
    await down(`bkr/${reviewTopic}/s`,b64(Buffer.concat([iv,new Uint8Array(await wc.subtle.encrypt({name:'AES-GCM',iv},rk,Buffer.from(JSON.stringify(bad))))])));
    const iv2=wc.getRandomValues(new Uint8Array(12));
    await down(`bkr/${reviewTopic}/s`,b64(Buffer.concat([iv2,new Uint8Array(await wc.subtle.encrypt({name:'AES-GCM',iv:iv2},rk,Buffer.from('null')))])));
    await down(`bkr/${reviewTopic}/s`,'not a message');
    await pass(1000);
    assert.equal(await review.locator('#glance').isVisible(),true,'Review is still on screen');
    assert.deepEqual(errors,[],'nothing was thrown in Home or Review');
    await ctx.close();
    console.log('PASS link recovery: the library never gives up; a dropped link says Reconnecting, keeps the list marked old, backs off and returns by itself; a quiet PC is re-asked with backoff and its list is labelled with its age; bad messages change nothing; Review does the same.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
