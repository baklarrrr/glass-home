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
for(const next of [null,-1])test('missing speed holds a valid fix only through its initial lifetime: '+next,()=>{
 const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());
 h.advance(3000);h.watches[0].ok(fix(next,now+3000));assert.equal(h.feed.snapshot().speed,36);assert.equal(h.feed.report().held,true);
 h.advance(2000);assert.equal(h.feed.snapshot().speed,null);
});
for(const [code,status] of [[1,'denied'],[2,'disconnected'],[3,'timeout']])test('error respects permission and original speed expiry: '+status,()=>{
 const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());h.watches[0].fail({code});
 if(code!==1){assert.equal(h.feed.snapshot().speed,36);h.advance(MAX_AGE_MS);}
 assert.equal(h.feed.snapshot().status,status);assert.equal(h.feed.snapshot().speed,null);assert.equal(h.tasks.size,0);
});
test('hidden cleanup clears watch zero exactly once, no late update',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.feed.setVisible(false);h.feed.setVisible(false);h.watches[0].ok(fix());assert.deepEqual(h.clears,[0]);assert.equal(h.feed.snapshot().status,'paused');assert.equal(h.tasks.size,0);});
test('resume uses existing grant and shows only the still-fresh prior speed',async()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());h.feed.setVisible(false);h.feed.setVisible(true);await Promise.resolve();assert.equal(h.watches.length,2);assert.equal(h.feed.snapshot().status,'live');assert.equal(h.feed.snapshot().speed,36);h.advance(MAX_AGE_MS);assert.equal(h.feed.snapshot().speed,null);});
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
test('a previously observed grant can resume with current permission reported unknown',async()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();await Promise.resolve();h.feed.setVisible(false);h.feed.permissions=null;h.feed.setVisible(true);await Promise.resolve();assert.equal(h.feed.details().permission,'unknown');assert.equal(h.feed.snapshot().status,'waiting');assert.equal(h.watches.length,2);});
test('permission query completion repaints details without a GPS callback',async()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();const before=h.states.length;await Promise.resolve();assert.ok(h.states.length>before);assert.equal(h.feed.details().permission,'granted');assert.equal(h.feed.details().fixes,0);});
test('timeout then denial updates current state and stops watch',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].fail({code:3});assert.equal(h.feed.details().status,'timeout');h.watches[0].fail({code:1});assert.equal(h.feed.snapshot().status,'denied');assert.equal(h.feed.details().status,'denied');assert.equal(h.feed.details().watchActive,false);assert.equal(h.feed.details().lastError.code,1);assert.deepEqual(h.clears,[0]);});
test('late timeout after denial cannot overwrite denied headline or error',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].fail({code:1});h.watches[0].fail({code:3});assert.equal(h.feed.snapshot().status,'denied');assert.equal(h.feed.details().lastError.code,1);});
test('new request exposes current waiting separately from historical denial',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].fail({code:1});h.feed.enable();assert.equal(h.feed.details().status,'waiting');assert.equal(h.feed.details().attempts,2);assert.equal(h.feed.details().lastError.attempt,1);});
test('Stop retains error history but current state is off',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].fail({code:3});h.feed.stop();assert.equal(h.feed.details().status,'off');assert.equal(h.feed.details().lastError.code,3);assert.equal(h.feed.details().watchActive,false);});
test('old permission callback after retry cannot revoke the new watch',async()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();await Promise.resolve();const old=h.p.onchange;h.feed.enable();await Promise.resolve();h.p.state='denied';old();assert.equal(h.feed.snapshot().status,'waiting');assert.equal(h.feed.enabled,true);assert.deepEqual(h.clears,[0]);});
test('old permission callback after Stop cannot change current off state',async()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();await Promise.resolve();const old=h.p.onchange;h.feed.stop();h.p.state='denied';old();assert.equal(h.feed.snapshot().status,'off');assert.equal(h.feed.details().watchActive,false);});

test('return from Work/Watch resumes an already working watch when the host lacks Permissions.query',async()=>{
 const h=harness();h.feed.permissions=null;h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());
 h.feed.setVisible(false);assert.equal(h.feed.snapshot().speed,null);
 h.feed.setVisible(true);await Promise.resolve();assert.equal(h.watches.length,2);
 assert.equal(h.feed.snapshot().status,'live');assert.equal(h.feed.details().permission,'unknown');
 h.watches[0].ok(fix(30));assert.equal(h.feed.snapshot().speed,36);
 h.watches[1].ok(fix(12));assert.equal(h.feed.snapshot().speed,43.2);
});
test('a real permission denial still prevents automatic re-entry after a working fix',async()=>{
 const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());h.watches[0].fail({code:1});
 h.feed.permissions=null;h.feed.setVisible(false);h.feed.setVisible(true);await Promise.resolve();
 assert.equal(h.watches.length,1);assert.equal(h.feed.enabled,false);assert.equal(h.feed.snapshot().speed,null);
});
test('a successful watch never overrides an explicit prompt state on resume',async()=>{
 const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());h.feed.setVisible(false);h.p.state='prompt';
 h.feed.setVisible(true);await Promise.resolve();assert.equal(h.watches.length,1);assert.equal(h.feed.enabled,false);
});

test('one-shot-only wearable uses real fresh positions, estimates missing Apple speed and ignores hidden callbacks',async()=>{
 const h=harness(),requests=[];
 const {Guide}=require('../drive/guide.js');
 const guide=new Guide({now:h.feed.now});
 h.feed.transform=p=>{guide.fix(p);return guide.fill(p);};
 h.feed.geo={getCurrentPosition(ok,fail,options){requests.push({ok,fail,options});}};
 h.feed.setVisible(true,{autoStart:true});
 assert.equal(requests.length,1);assert.equal(h.feed.snapshot().status,'waiting');
 const first=h.feed.now(),position=(at,x,speed)=>({timestamp:at,coords:{latitude:43,longitude:x,accuracy:4,speed,heading:null}});
 requests[0].ok(position(first,-79,-1));await Promise.resolve();
 assert.equal(h.feed.report().positions,1);assert.equal(h.feed.snapshot().speed,null);
 h.advance(4000);assert.equal(requests.length,2);
 requests[1].ok(position(h.feed.now(),-78.9994,-1));
 assert.equal(h.feed.snapshot().source,'estimated');assert.ok(h.feed.snapshot().speed>20);
 const summary=h.feed.report();
 assert.equal(summary.reason,'positions-estimate');
 assert.deepEqual(Object.keys(summary).sort(),'accurate callbacks coordinates error fresh held observation permission positions reason source status version'.split(' '));
 h.advance(4000);assert.equal(requests.length,3);
 h.feed.setVisible(false);requests[2].ok(position(h.feed.now(),-78.98,22));assert.equal(h.feed.snapshot().speed,null);
});
test('repeat timestamps and poor accuracy cannot move the original speed expiry',()=>{
 const h=harness();h.feed.setVisible(true);h.feed.enable();
 h.watches[0].ok(fix(10,now));h.advance(3000,0);
 h.watches[0].ok(fix(10,now));h.watches[0].ok(fix(18,now,400));
 assert.equal(h.feed.snapshot().speed,36);
 h.advance(2000,0);assert.equal(h.feed.snapshot().speed,null);
});

test('a working watch starts on entry even if one-shots never answer and permission is unavailable',async()=>{
  const h=harness(),probes=[];
  h.feed.permissions=null;
  h.feed.geo.getCurrentPosition=ok=>probes.push(ok);
  h.feed.setVisible(true,{autoStart:true});
  assert.equal(h.watches.length,1);
  assert.equal(probes.length,0);
  h.watches[0].ok(fix(10));
  h.advance(3500);
  h.watches[0].ok(fix(11,h.wall));
  h.advance(3500);
  assert.equal(h.feed.snapshot().speed,39.6);
  assert.equal(probes.length,0);
  h.feed.setVisible(false);
  h.feed.setVisible(true,{autoStart:true,resumeOnly:true});
  await Promise.resolve();
  assert.equal(h.watches.length,2);
  assert.equal(probes.length,0);
});
test('a silent watch leaves a pending permission prompt alone and a later grant enables fallback',async()=>{
  const h=harness('prompt'),probes=[];
  h.feed.geo.getCurrentPosition=(ok,fail)=>probes.push({ok,fail});
  h.feed.setVisible(true,{autoStart:true});
  await Promise.resolve();
  assert.equal(h.watches.length,1);
  h.advance(RESPONSE_NOTICE_MS*2);
  assert.equal(probes.length,0);
  assert.equal(h.feed.snapshot().status,'no-response');
  h.p.state='granted';
  h.p.onchange();
  h.advance(0);
  assert.equal(h.watches.length,1);
  assert.equal(probes.length,1);
  probes[0].ok(fix(10,h.wall));
  assert.equal(h.feed.snapshot().speed,36);
  h.feed.setVisible(false);
  assert.deepEqual(h.clears,[0]);
  h.advance(RESPONSE_NOTICE_MS*2);
  assert.equal(probes.length,1);
});
test('an initially silent one-shot-only host recovers when the first permission query resolves late',async()=>{
  const h=harness(),probes=[];
  let resolvePermission;
  h.feed.permissions={query:()=>new Promise(resolve=>{resolvePermission=resolve;})};
  h.feed.geo={getCurrentPosition:(ok,fail)=>probes.push({ok,fail})};
  h.feed.setVisible(true,{autoStart:true});
  h.advance(RESPONSE_NOTICE_MS*2);
  assert.equal(probes.length,1);
  assert.equal(h.feed.snapshot().status,'no-response');
  resolvePermission(h.p);
  await Promise.resolve();
  h.advance(0);
  assert.equal(probes.length,2);
  probes[0].fail({code:1});
  probes[1].ok(fix(9,h.wall));
  assert.equal(h.feed.snapshot().speed,32.4);
  h.advance(MAX_AGE_MS);
  assert.equal(h.feed.snapshot().speed,null);
});
test('resume-only entry never starts without a grant; a real permission transition resumes once',async()=>{
  const h=harness('prompt');
  h.feed.setVisible(true,{autoStart:true,resumeOnly:true});
  await Promise.resolve();
  assert.equal(h.watches.length,0);
  assert.equal(h.feed.enabled,false);
  assert.equal(typeof h.p.onchange,'function');
  h.p.state='granted';
  h.p.onchange();
  await Promise.resolve();
  assert.equal(h.watches.length,1);
  h.watches[0].ok(fix());
  assert.equal(h.feed.snapshot().status,'live');
});

test('an unknown cold reopen with no observed permission or prior fix never prompts',async()=>{
  const h=harness();
  h.feed.permissions=undefined;
  h.feed.setVisible(true,{autoStart:true,resumeOnly:true});
  await Promise.resolve();
  assert.equal(h.watches.length,0);
  assert.equal(h.feed.snapshot().status,'off');
  assert.equal(h.feed.details().permission,'unknown');
});
test('a late grant on a silent watch permits one fallback without adding a second watch',async()=>{
  const h=harness(),probes=[];
  let resolvePermission;
  h.feed.permissions={query:()=>new Promise(resolve=>{resolvePermission=resolve;})};
  h.feed.geo.getCurrentPosition=(ok,fail)=>probes.push({ok,fail});
  h.feed.setVisible(true,{autoStart:true});
  h.advance(RESPONSE_NOTICE_MS);
  assert.equal(h.watches.length,1);
  assert.equal(probes.length,0);
  resolvePermission(h.p);
  await Promise.resolve();
  h.advance(0);
  assert.equal(probes.length,1);
  h.p.onchange();h.advance(0);
  assert.equal(probes.length,1);
  h.watches[0].ok(fix(10,h.wall));
  probes[0].fail({code:3});
  assert.equal(h.feed.snapshot().status,'live');
  assert.equal(h.watches.length,1);
});
test('when watch registration throws, first visible gesture falls back to one current-position request',async()=>{
  const h=harness('prompt'),probes=[];
  h.feed.geo={watchPosition(){throw new TypeError('unsupported');},getCurrentPosition:ok=>probes.push(ok)};
  h.feed.setVisible(true,{autoStart:true});
  await Promise.resolve();
  h.advance(RESPONSE_NOTICE_MS*2);
  assert.equal(probes.length,1);
  probes[0](fix(9,h.wall));
  assert.equal(h.feed.snapshot().speed,32.4);
  h.advance(MAX_AGE_MS);
  assert.equal(probes.length,1);
  assert.equal(h.feed.snapshot().speed,null);
});
