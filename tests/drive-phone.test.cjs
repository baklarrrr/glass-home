'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Phone,FRESH_MS}=require('../drive-phone.js');
const L=require('../drive/link-core.js'),V=require('../drive/tests/vectors.json');
function harness(){
 let wall=1700000000000,mono=1,seq=0;const tasks=new Map(),storage=new Map(),db=new Map(),clients=[],states=[];
 const schedule=(fn,ms)=>{tasks.set(++seq,{fn,at:mono+ms});return seq;},cancel=id=>tasks.delete(id);
 const p=new Phone({core:L,crypto:globalThis.crypto,storage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
  store:async(op,k,v)=>op==='get'?db.get(k):(db.set(k,v),undefined),now:()=>wall,mono:()=>mono,schedule,cancel,change:s=>states.push(s),
  mqtt:()=>({connect(){const handlers={};const c={connected:false,events:handlers,on(k,f){handlers[k]=f;},subscribe(){},publish(){},end(){this.ended=true;},reconnect(){this.retried=true;}};clients.push(c);return c;}})});
 return {p,clients,db,storage,tasks,states,advance(ms){mono+=ms;wall+=ms;for(const [id,t]of [...tasks])if(t.at<=mono){tasks.delete(id);t.fn();}},now:()=>wall};
}
async function ready(h){
 await h.p.setup(new URLSearchParams({dt:V.t,dp:V.phone.pub}));h.p.setVisible(true);
 // Offline peer uses the qualified protocol's derived keys, not a production broker.
 const pub=L.fromB64url(h.p.link.pub),priv=await crypto.subtle.importKey('pkcs8',L.fromB64url(V.phone.pkcs8),{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
 const keys=await L.deriveKeys(crypto.subtle,priv,pub,V.t,h.p.link.devId,{up:['decrypt'],down:['encrypt']});
 h.p.hellos=['offlineHello1'];let seq=0;
 return async(gps,over={})=>{const m={m:'nav',sid:'offlineSession',seq:++seq,at:h.now(),re:'offlineHello1',nav:null,gps,...over};return '1.'+await L.seal(crypto.subtle,keys.down,m);};
}
test('PC t/p pairing is not mistaken for the phone link',async()=>{const h=harness();await h.p.setup(new URLSearchParams({t:V.t,p:V.phone.pub}));h.p.setVisible(true);assert.equal(h.p.snapshot().state,'unpaired');assert.equal(h.clients.length,0);});
test('fresh encrypted phone speed, measured zero and expiry; never stale speed or false zero',async()=>{
 const h=harness(),send=await ready(h);await h.p.receive(await send({kmh:119,hdg:0}));assert.deepEqual(h.p.snapshot().gps,{kmh:119,hdg:0});
 h.advance(FRESH_MS);assert.equal(h.p.snapshot().gps,null);assert.equal(h.p.snapshot().state,'stale');
 await h.p.receive(await send({kmh:0,hdg:null}));assert.equal(h.p.snapshot().gps.kmh,0);
 await h.p.receive(await send(null));assert.equal(h.p.snapshot().gps,null);assert.equal(h.p.snapshot().state,'no-sample');
});
test('malformed GPS does not become zero; replay cannot restore an old speed',async()=>{const h=harness(),send=await ready(h),valid=await send({kmh:30,hdg:90});await h.p.receive(valid);await h.p.receive(await send({kmh:-1,hdg:0}));assert.equal(h.p.snapshot().gps,null);await h.p.receive(valid);assert.equal(h.p.snapshot().gps,null);});
test('Work/Watch/Apps/Games exit closes every broker; return needs a fresh challenge and frame',async()=>{
 const h=harness(),send=await ready(h);await h.p.receive(await send({kmh:119,hdg:0}));const oldEpoch=h.p.epoch;
 h.p.setVisible(false);assert.equal(h.p.snapshot().gps,null);assert.ok(h.clients.every(c=>c.ended));assert.equal(h.tasks.size,0);
 h.p.setVisible(true);assert.equal(h.p.snapshot().gps,null);assert.equal(h.clients.length,6);
 await h.p.receive(await send({kmh:120,hdg:0}),oldEpoch);assert.equal(h.p.snapshot().gps,null);
 h.p.hellos=['offlineHello1'];await h.p.receive(await send({kmh:121,hdg:0}));assert.equal(h.p.snapshot().gps.kmh,121);
});
test('OFF survives re-entry and setup without opening any broker',async()=>{const h=harness();await ready(h);h.p.setEnabled(false);h.p.setVisible(false);h.p.setVisible(true);assert.equal(h.p.snapshot().state,'off');assert.equal(h.clients.length,3);assert.equal(h.storage.get('studio.drive.phone.off'),'1');});
test('same saved phone preserves its non-extractable device key and code',async()=>{const h=harness();await ready(h);const first=h.p.link.pub,code=h.p.link.code;h.p.close();await h.p.setup(new URLSearchParams());assert.equal(h.p.link.pub,first);assert.equal(h.p.link.code,code);assert.equal(h.p.link.keys.up.extractable,false);});
test('a different offered phone never replaces an existing one silently',async()=>{const h=harness();await ready(h);const a=h.p.link.addr;const other=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);const pub=L.toB64url(new Uint8Array(await crypto.subtle.exportKey('raw',other.publicKey)));await h.p.setup(new URLSearchParams({dt:V.t,dp:pub}));assert.deepEqual(h.p.link.addr,a);assert.equal(h.p.snapshot().offer,true);h.p.keepCurrent();assert.equal(h.p.snapshot().offer,false);});
test('old authenticated speed cannot be restamped as a live arrival',async()=>{const h=harness(),send=await ready(h);await h.p.receive(await send({kmh:119,hdg:0},{at:h.now()-60000}));assert.equal(h.p.snapshot().gps,null);assert.equal(h.p.snapshot().state,'stale');});
test('delivery delay counts against the freshness deadline',async()=>{const h=harness(),send=await ready(h);await h.p.receive(await send({kmh:119,hdg:0},{at:h.now()-2500}));assert.equal(h.p.snapshot().gps.kmh,119);h.advance(1000);assert.equal(h.p.snapshot().gps,null);});
test('future or rolled-back phone clocks cannot keep a number live',async()=>{const h=harness(),send=await ready(h);await h.p.receive(await send({kmh:119,hdg:0},{at:h.now()+1000}));assert.equal(h.p.snapshot().gps,null);});
test('Keep current cancels an offer while crypto is pending',async()=>{const h=harness();await ready(h);const old=h.p.link,kept=h.db.get('pairing');h.p.offer={t:'differentTopic123',p:V.phone.pub};let finish;h.p.keys=()=>new Promise(r=>finish=r);const accepting=h.p.acceptOffer();h.p.keepCurrent();finish({addr:{t:'differentTopic123',p:V.phone.pub}});assert.equal(await accepting,false);assert.equal(h.p.link,old);assert.deepEqual(h.db.get('pairing'),kept);});
test('next-turn text expires at its own four-second repaint deadline',async()=>{const h=harness(),send=await ready(h);await h.p.receive(await send({kmh:30,hdg:90},{nav:JSON.parse(V.nav.plain).nav}));assert.equal(h.p.snapshot().nav.turn,'TURN_RIGHT');h.advance(3501);assert.ok(h.p.snapshot().nav);h.advance(500);assert.equal(h.p.snapshot().nav,null);assert.equal(h.states.at(-1).nav,null);});
