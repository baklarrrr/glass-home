'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {Feed,reading,MAX_AGE_MS,RESPONSE_NOTICE_MS}=require('../drive-location.js');
const now=1700000000000;
const fix=(speed=10,at=now,accuracy=5)=>({timestamp:at,coords:{speed,accuracy}});
for(const [name,input,status,speed] of [
  ['metres per second to km/h',fix(),'live',36],
  ['actual zero remains zero',fix(0),'live',0],
  ['null is unavailable',fix(null),'unavailable',null],
  ['negative speed',fix(-1),'invalid',null],
  ['infinite speed',fix(Infinity),'invalid',null],
  ['NaN speed',fix(NaN),'invalid',null],
  ['implausible road speed',fix(101),'invalid',null],
  ['numeric string',fix('10'),'invalid',null],
  ['old fix',fix(10,now-MAX_AGE_MS),'stale',null],
  ['future fix',fix(10,now+1),'invalid',null],
  ['zero timestamp',fix(10,0),'invalid',null],
  ['bad timestamp',fix(10,NaN),'invalid',null],
  ['weak location accuracy',fix(10,now,51),'inaccurate',null],
  ['unknown accuracy',fix(10,now,null),'inaccurate',null],
  ['negative accuracy',fix(10,now,-1),'inaccurate',null],
  ['boundary valid accuracy',fix(10,now,50),'live',36],
  ['missing position',null,'invalid',null]
])test(name,()=>{const r=reading(input,now);assert.equal(r.status,status);assert.equal(r.speed,speed);assert.equal('coords' in r,false);});
test('missing speed is never coerced to zero',()=>assert.equal(reading({timestamp:now,coords:{accuracy:3}},now).status,'unavailable'));
function harness(permission='granted') {
  let wall=now,mono=0,seq=0;const tasks=new Map(),watches=[],clears=[],states=[];
  const p={state:permission,onchange:null};
  const feed=new Feed({geo:{watchPosition(ok,fail,options){watches.push({ok,fail,options});return watches.length-1;},clearWatch(id){clears.push(id);}},
    permissions:{query:async()=>p},now:()=>wall,mono:()=>mono,
    schedule(fn,ms){tasks.set(++seq,{fn,at:mono+ms});return seq;},cancel:id=>tasks.delete(id),change:s=>states.push(s)});
  return {feed,p,watches,clears,states,tasks,advance(ms,wallMs=ms){mono+=ms;wall+=wallMs;for(const [id,t] of [...tasks])if(t.at<=mono){tasks.delete(id);t.fn();}},get wall(){return wall;}};
}
test('entry does not request location or prompt',()=>{const h=harness();h.feed.setVisible(true);assert.equal(h.watches.length,0);});
test('explicit enable creates one high accuracy watch with no cached fixes',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();assert.equal(h.watches.length,1);assert.deepEqual(h.watches[0].options,{enableHighAccuracy:true,maximumAge:0,timeout:10000});});
test('accepted fix expires at five seconds without incoming updates',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());h.advance(4999);assert.equal(h.feed.snapshot().speed,36);h.advance(1);assert.equal(h.feed.snapshot().status,'stale');assert.equal(h.feed.snapshot().speed,null);});
test('cached fix expires from acquisition rather than arrival',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix(10,now-4000));h.advance(1000);assert.equal(h.feed.snapshot().status,'stale');});
test('clock rollback cannot prolong a reading',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());h.advance(5000,0);assert.equal(h.feed.snapshot().speed,null);});
test('future wall clock invalidates a cached reading',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());h.advance(0,-1);assert.equal(h.feed.snapshot().speed,null);});
test('old callbacks do not overwrite newer fixes',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix(20));h.watches[0].ok(fix(30,now-1));assert.equal(h.feed.snapshot().speed,72);});
test('null speed clears preceding valid speed immediately',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());h.watches[0].ok(fix(null));assert.equal(h.feed.snapshot().speed,null);assert.equal(h.tasks.size,0);});
for(const [code,status] of [[1,'denied'],[2,'disconnected'],[3,'timeout']])test('error clears current speed: '+status,()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());h.watches[0].fail({code});assert.equal(h.feed.snapshot().status,status);assert.equal(h.feed.snapshot().speed,null);assert.equal(h.tasks.size,0);});
test('hidden cleanup clears watch zero exactly once, no late update',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.feed.setVisible(false);h.feed.setVisible(false);h.watches[0].ok(fix());assert.deepEqual(h.clears,[0]);assert.equal(h.feed.snapshot().status,'paused');assert.equal(h.tasks.size,0);});
test('resume uses existing grant and does not show cached speed',async()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());h.feed.setVisible(false);h.feed.setVisible(true);await Promise.resolve();assert.equal(h.watches.length,2);assert.equal(h.feed.snapshot().status,'waiting');assert.equal(h.feed.snapshot().speed,null);});
for(const permission of ['prompt','denied'])test('resume never prompts after grant '+permission,async()=>{const h=harness(permission);h.feed.setVisible(true);h.feed.enable();h.feed.setVisible(false);h.feed.setVisible(true);await Promise.resolve();assert.equal(h.watches.length,1);assert.equal(h.feed.enabled,false);});
test('permission query unavailable needs deliberate re-enable',async()=>{const h=harness();h.feed.permissions=null;h.feed.setVisible(true);h.feed.enable();h.feed.setVisible(false);h.feed.setVisible(true);await Promise.resolve();assert.equal(h.watches.length,1);assert.equal(h.feed.snapshot().status,'off');});
test('permission revoked clears watch and prevents resume',async()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();await Promise.resolve();h.p.state='denied';h.p.onchange();assert.deepEqual(h.clears,[0]);assert.equal(h.feed.enabled,false);assert.equal(h.feed.snapshot().status,'denied');});
test('stop while resume query pending cannot restart watch',async()=>{const h=harness();h.feed.enabled=true;h.feed.setVisible(true);h.feed.stop();await Promise.resolve();assert.equal(h.watches.length,0);});
test('missing API is explicit unsupported',()=>{const f=new Feed({geo:null});f.setVisible(true);f.enable();assert.equal(f.snapshot().status,'unsupported');});
test('no coordinates or raw error text in projected state',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok({...fix(),coords:{speed:10,accuracy:5,latitude:42,longitude:-70}});assert.equal(JSON.stringify(h.states).includes('latitude'),false);h.watches[0].fail({code:2,message:'sensitive test detail'});assert.equal(JSON.stringify(h.states).includes('sensitive'),false);});

test('the reported sequence is an API timeout, not an expiry tick',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();assert.equal(h.feed.snapshot().status,'waiting');h.advance(10000);assert.equal(h.feed.snapshot().status,'waiting');h.watches[0].fail({code:3});assert.equal(h.feed.snapshot().status,'timeout');assert.equal(h.feed.details().lastError.code,3);assert.equal(h.feed.details().fixes,0);});
test('a timeout keeps exactly one watch and accepts a later fresh fix',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].fail({code:3});assert.equal(h.feed.enabled,true);assert.equal(h.feed.details().watchActive,true);assert.deepEqual(h.clears,[]);h.advance(20000);assert.equal(h.watches.length,1);h.watches[0].ok(fix(11,h.wall));assert.equal(h.feed.snapshot().status,'live');assert.equal(h.feed.snapshot().speed,39.6);});
test('no callback gives a distinct bounded notice, not a fabricated error code',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.advance(RESPONSE_NOTICE_MS-1);assert.equal(h.feed.snapshot().status,'waiting');h.advance(1);assert.equal(h.feed.snapshot().status,'no-response');assert.equal(h.feed.details().lastError,null);assert.equal(h.feed.details().watchActive,true);assert.equal(h.tasks.size,0);h.advance(60000);assert.equal(h.watches.length,1);});
test('late success recovers from the no-response notice',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.advance(RESPONSE_NOTICE_MS);h.watches[0].ok(fix(0,h.wall));assert.equal(h.feed.snapshot().status,'live');assert.equal(h.feed.snapshot().speed,0);});
test('null speed is a callback, never no-response or a zero speed',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix(null));h.advance(RESPONSE_NOTICE_MS);assert.equal(h.feed.snapshot().status,'unavailable');assert.equal(h.feed.details().fixes,1);assert.equal(h.feed.details().lastFix.speedPresent,false);assert.equal(h.feed.snapshot().speed,null);});
test('weak fix is a callback and retains only accuracy evidence',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix(15,now,80));h.advance(RESPONSE_NOTICE_MS);assert.equal(h.feed.snapshot().status,'inaccurate');assert.equal(h.feed.details().lastFix.accuracy,80);assert.equal(h.feed.details().lastFix.speedPresent,true);});
test('explicit retry replaces one watch and ignores previous callbacks',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].fail({code:3});h.feed.enable();assert.deepEqual(h.clears,[0]);assert.equal(h.watches.length,2);assert.equal(h.feed.snapshot().status,'waiting');h.watches[0].ok(fix());h.watches[0].fail({code:1});assert.equal(h.feed.snapshot().status,'waiting');assert.equal(h.feed.details().fixes,0);h.watches[1].ok(fix());assert.equal(h.feed.snapshot().status,'live');assert.equal(h.feed.details().attempts,2);});
test('permission restored requires deliberate retry and clears old watch once',async()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].fail({code:1});h.p.state='granted';h.feed.enable();await Promise.resolve();assert.deepEqual(h.clears,[0]);h.watches[1].ok(fix());assert.equal(h.feed.snapshot().status,'live');assert.equal(h.feed.details().permission,'granted');});
test('stop cancels the no-response notice and releases once',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.feed.stop();h.advance(RESPONSE_NOTICE_MS);assert.equal(h.feed.snapshot().status,'off');assert.deepEqual(h.clears,[0]);assert.equal(h.tasks.size,0);});
test('route exit cancels no-response and ignores a late timeout',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.feed.setVisible(false);h.advance(RESPONSE_NOTICE_MS);h.watches[0].fail({code:3});assert.equal(h.feed.snapshot().status,'paused');assert.equal(h.feed.details().lastError,null);assert.equal(h.feed.details().watchActive,false);});
test('details distinguish absent fixes from an old retained fix',()=>{const h=harness();assert.equal(h.feed.details().lastFix,null);h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());h.advance(7000);const d=h.feed.details();assert.equal(d.lastFix.ageMs,7000);assert.equal(d.fixes,1);assert.equal(h.feed.snapshot().status,'stale');});
test('details do not turn malformed or future timestamps into an age',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix(10,now+100));assert.equal(h.feed.details().lastFix.at,null);assert.equal(h.feed.details().lastFix.ageMs,null);assert.equal(h.feed.details().lastFix.status,'invalid');});
test('details are bounded to one fix and one sanitized error',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();for(let i=0;i<30;i++)h.watches[0].ok({...fix(i),coords:{speed:i,accuracy:5,latitude:40+i,longitude:70,deviceId:'private'}});h.watches[0].fail({code:3,message:'private raw error'});const text=JSON.stringify(h.feed.details());assert.equal(h.feed.details().fixes,30);assert.equal(text.includes('latitude'),false);assert.equal(text.includes('longitude'),false);assert.equal(text.includes('private'),false);assert.equal(text.includes('receivedMono'),false);assert.ok(text.length<500);});
test('details are copies, not mutable feed records',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());h.watches[0].fail({code:3});const d=h.feed.details();d.lastFix.at=0;d.lastError.code=1;assert.equal(h.feed.details().lastFix.at,now);assert.equal(h.feed.details().lastError.code,3);});
test('permission revoked while hidden is not reported as an old grant',async()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();await Promise.resolve();assert.equal(h.feed.details().permission,'granted');h.feed.setVisible(false);h.p.state='denied';h.feed.setVisible(true);await Promise.resolve();assert.equal(h.feed.details().permission,'denied');assert.equal(h.feed.snapshot().status,'denied');assert.equal(h.watches.length,1);});
test('unavailable resume permission query clears the old permission claim',async()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();await Promise.resolve();h.feed.setVisible(false);h.feed.permissions=null;h.feed.setVisible(true);await Promise.resolve();assert.equal(h.feed.details().permission,'unknown');assert.equal(h.feed.snapshot().status,'off');});
test('permission query completion repaints details without a GPS callback',async()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();const before=h.states.length;await Promise.resolve();assert.ok(h.states.length>before);assert.equal(h.feed.details().permission,'granted');assert.equal(h.feed.details().fixes,0);});
