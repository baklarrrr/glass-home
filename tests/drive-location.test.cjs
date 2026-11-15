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
  ['clearly future fix',fix(10,now+2001),'invalid',null],
  ['fix stamped two seconds ahead by the phone\'s clock',fix(10,now+2000),'live',36],
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
test('explicit enable creates one high accuracy watch with no cached fixes',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();assert.equal(h.watches.length,1);assert.deepEqual(h.watches[0].options,{enableHighAccuracy:true,maximumAge:0,timeout:30000});});
test('accepted fix expires at five seconds without incoming updates',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());h.advance(4999);assert.equal(h.feed.snapshot().speed,36);h.advance(1);assert.equal(h.feed.snapshot().status,'stale');assert.equal(h.feed.snapshot().speed,null);});
test('cached fix expires from acquisition rather than arrival',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix(10,now-4000));h.advance(1000);assert.equal(h.feed.snapshot().status,'stale');});
test('clock rollback cannot prolong a reading',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());h.advance(5000,0);assert.equal(h.feed.snapshot().speed,null);});
test('future wall clock invalidates a cached reading',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix());h.advance(0,-1500);assert.equal(h.feed.snapshot().speed,36,'a clock that steps back within the allowance changes nothing');h.advance(0,-502);assert.equal(h.feed.snapshot().speed,null);});
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
test('details do not turn malformed or future timestamps into an age',()=>{const h=harness();h.feed.setVisible(true);h.feed.enable();h.watches[0].ok(fix(10,now+2001));assert.equal(h.feed.details().lastFix.at,null);assert.equal(h.feed.details().lastFix.ageMs,null);assert.equal(h.feed.details().lastFix.status,'invalid');});
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

test('late one-shot can deliver a newly acquired fix in the same visit, never an old error or hidden fix',async()=>{
 const h=harness('granted'),probes=[];
 h.feed.geo.getCurrentPosition=(ok,fail,options)=>probes.push({ok,fail,options});
 h.feed.setVisible(true,{autoStart:true});await Promise.resolve();h.watches[0].fail({code:3});h.advance(0);
 assert.equal(probes.length,1);
 assert.equal(h.watches[0].options.timeout,30000);
 h.advance(RESPONSE_NOTICE_MS+1000);
 probes[0].ok({...fix(7,h.wall),coords:{speed:7,accuracy:4,latitude:43,longitude:-79}});
 assert.equal(h.feed.snapshot().status,'live');assert.equal(h.feed.report().positions,1);
 probes[0].fail({code:1});assert.equal(h.feed.snapshot().status,'live');
 h.advance(4000);assert.equal(probes.length,2);
 h.feed.setVisible(false);probes[1].ok(fix(12,h.wall));assert.equal(h.feed.snapshot().speed,null);
});

test('drive display accepts freshly sourced numeric speed only, prioritizes linked readings, and preserves zero',()=>{
 const {display}=require('../drive-location.js');
 const actual={status:'live',ageMs:20,speed:12,source:'reported'};
 assert.equal(display({kmh:0,ageMs:12},actual).source,'linked');
 assert.equal(display({kmh:0,ageMs:12},actual).kmh,0);
 for(const ageMs of [-1,3500,NaN,undefined])assert.equal(display({kmh:99,ageMs},actual).kmh,12);
 assert.equal(display(null,{...actual,source:'estimated'}).label,'Estimated speed');
 assert.equal(display(null,{...actual,speed:30,ageMs:5000}).kmh,null,'at 20 km/h and above five seconds is the limit');
 assert.equal(display(null,{...actual,speed:20,ageMs:5000}).kmh,null);
 assert.deepEqual([display(null,{...actual,ageMs:5000}).kmh,display(null,{...actual,ageMs:5000}).label,display(null,{...actual,ageMs:9999}).kmh,display(null,{...actual,ageMs:10000}).kmh],[12,'Estimated speed',12,null],'a slow speed may stay ten seconds, as an estimate');
 assert.equal(display(null,{...actual,ageMs:4999}).label,'Location speed');
 assert.equal(display({kmh:-1,ageMs:5},{status:'denied'}).kmh,null);
});
test('every state without a speed says one short reason and what happens next, and never names a phone app',()=>{
 const {display,NO_SPEED}=require('../drive-location.js');
 const all=['off','waiting','no-response','timeout','disconnected','error','stale','unavailable','inaccurate','invalid','denied','paused','unsupported'];
 for(const status of all){
  const d=display(null,{status,speed:null});
  assert.equal(d.kmh,null);assert.equal(d.source,'none');
  assert.ok(NO_SPEED[status],status+' has words');
  assert.ok(d.why&&d.why.length<=28,status+': the reason fits the top line of Bakar Drive ('+d.why+')');
  assert.ok(d.next&&d.next.length<=40,status+': the next step is one short line ('+d.next+')');
  assert.equal(d.label,d.why+' · '+d.next[0].toLowerCase()+d.next.slice(1));
  assert.ok(d.label.length<=62,status+': one line in Bakar Home ('+d.label+')');
  assert.doesNotMatch(d.label,/unavailable|Android|Journal|pair|parked/i,status);
 }
 assert.equal(display(null,{status:'waiting'}).label,'Waiting for location · it comes from your phone');
 assert.equal(display(null,{status:'denied'}).label,'Location not allowed · allow it for this app, then Start GPS');
 assert.equal(display(null,{status:'live',ageMs:5000,speed:40}).why,'No new location','an expired reading is old, not unexplained');
 assert.equal(display(null,{status:'live',ageMs:10000,speed:12}).why,'No new location');
 assert.equal(display(null,undefined).label,'Speed unavailable');assert.equal(display(null,{status:'new-state'}).next,'');
 assert.equal(display({kmh:40,ageMs:10},{status:'denied'}).label,'Linked speed','a fresh linked speed still wins');
});
test('a rough fix without a speed is rough, not a speed being worked out',()=>{
 assert.equal(reading({timestamp:now,coords:{speed:null,accuracy:80}},now).status,'inaccurate');
 assert.equal(reading({timestamp:now,coords:{speed:null,accuracy:50}},now).status,'unavailable');
 assert.equal(reading({timestamp:now,coords:{accuracy:3}},now).status,'unavailable');
});

// ---- keeps asking until the phone answers (build 49) ----
// The glasses have no GPS: the phone's Meta AI app hands location over, as one-shot answers. These play that provider.
function asking(permission='granted'){
  const h=harness(permission),probes=[];
  h.feed.geo.getCurrentPosition=(ok,fail,options)=>probes.push({ok,fail,options,at:h.wall});
  return {h,probes};
}
const place=(speed,at,accuracy=8)=>({timestamp:at,coords:{speed,accuracy,latitude:10,longitude:10,heading:null}});
test('keeps asking: a provider that never answers is asked again and again, slower each time, and the watch is reopened',async()=>{
  const {h,probes}=asking('granted');
  h.feed.setVisible(true,{autoStart:true});await Promise.resolve();
  for(let i=0;i<120;i++)h.advance(1000);   // two minutes of silence
  assert.ok(probes.length>=6&&probes.length<=12,'asked several times, not hammered: '+probes.length);
  const gaps=probes.slice(1).map((p,i)=>p.at-probes[i].at);
  assert.ok(gaps.every(g=>g>=RESPONSE_NOTICE_MS),'each unanswered request is given its time before the next');
  assert.ok(gaps.at(-1)<=RESPONSE_NOTICE_MS+15000,'never slower than 15 s after a request gives up');
  assert.ok(h.watches.length>=3,'a watch silent for 30 s is opened again: '+h.watches.length);
  assert.equal(h.feed.watch,h.watches.length-1);assert.equal(h.clears.length,h.watches.length-1,'the old watch is released each time');
  assert.equal(h.feed.snapshot().status,'no-response');
  assert.ok(probes.some(p=>p.options.enableHighAccuracy===false&&p.options.maximumAge===10000),'relaxed requests may use a recent position');
  assert.ok(probes.some(p=>p.options.enableHighAccuracy===true&&p.options.maximumAge===0),'precise requests ask for a new one');
  probes.at(-1).ok(place(3,h.wall));
  assert.equal(h.feed.snapshot().speed,10.8,'and the first answer shows at once');
});
test('keeps asking: a timeout with the permission not reported, then an answer to a relaxed request',()=>{
  const {h,probes}=asking();h.feed.permissions=null;
  h.feed.setVisible(true);h.feed.enable();
  assert.equal(probes.length,0,'nothing beside the watch while a permission question may be open');
  h.advance(RESPONSE_NOTICE_MS*3);assert.equal(probes.length,0,'silence alone is not proof');
  h.watches[0].fail({code:3});h.advance(0);
  assert.equal(h.feed.snapshot().status,'timeout');
  assert.equal(probes.length,1,'the returned error is proof: ask again at once');
  assert.deepEqual(probes[0].options,{enableHighAccuracy:false,maximumAge:10000,timeout:10000});
  probes[0].ok(place(5,h.wall-2000));
  assert.equal(h.feed.snapshot().status,'live');assert.equal(h.feed.snapshot().speed,18);
  assert.equal(h.feed.hadGrant,true);
  assert.equal(h.watches.length,2,'the watch had been silent for over 30 s, so it was opened again');
  const d=h.feed.details();assert.equal(d.asks,3);assert.equal(d.errors,1);assert.equal(d.fixes,1);assert.equal(d.lastError.code,3);
});
test('keeps asking: "no position" again and again, then it recovers',()=>{
  const {h,probes}=asking();h.feed.permissions=null;
  h.feed.setVisible(true);h.feed.enable();
  h.watches[0].fail({code:2});h.advance(0);
  const waits=[];
  for(let i=0;i<5;i++){
    assert.equal(probes.length,i+1);probes[i].fail({code:2});
    assert.equal(h.feed.snapshot().status,'disconnected');
    let waited=0;while(probes.length===i+1&&waited<20000){h.advance(500);waited+=500;}
    waits.push(waited);
  }
  assert.deepEqual(waits,[4000,6000,9000,13500,15000],'4 s, then slower, never slower than 15 s');
  assert.deepEqual(probes.slice(0,4).map(p=>p.options.enableHighAccuracy),[false,true,false,true],'relaxed and precise take turns');
  probes[5].ok(place(0,h.wall));
  assert.equal(h.feed.snapshot().status,'live');assert.equal(h.feed.snapshot().speed,0);
  h.advance(4000);assert.equal(probes.length,7,'and the next request is quick again');
});
test('keeps asking: a provider that only ever gives positions 8 s old says location was found, never a speed and never "no location"',()=>{
  const {h,probes}=asking();h.feed.permissions=null;
  h.feed.setVisible(true);h.feed.enable();
  h.watches[0].fail({code:3});h.advance(0);
  for(let i=0;i<6;i++){
    probes[i].ok(place(20,h.wall-8000));
    const s=h.feed.snapshot();
    assert.equal(s.status,'found');assert.equal(s.speed,null,'an old moving speed is never shown');
    assert.equal(h.feed.report().status,'stale','the PC keeps hearing the word it knows');
    if(i%2)h.watches.at(-1).fail({code:3});   // an error beside the answers does not turn it back into "no location"
    assert.equal(h.feed.snapshot().status,i%2?'timeout':'found');
    let waited=0;while(probes.length===i+1&&waited<20000){h.advance(500);waited+=500;}
    assert.equal(waited,4000,'answers keep the asking quick');
  }
  assert.equal(h.feed.hadGrant,true,'an old position still proves that location is allowed');
  assert.equal(h.feed.details().lastFix.status,'found');
});
test('keeps asking: never beside a permission question, and a remembered visit earns one request only',async()=>{
  const prompt=asking('prompt');
  prompt.h.feed.setVisible(true,{autoStart:true,worked:true});await Promise.resolve();
  prompt.h.advance(120000);assert.equal(prompt.probes.length,0,'permission "prompt": only the one watch');
  assert.equal(prompt.h.watches.length,1);
  const {h,probes}=asking();h.feed.permissions=null;
  h.feed.setVisible(true,{autoStart:true,worked:true});
  h.advance(4000);assert.equal(probes.length,1,'location answered here before: one request beside the watch');
  h.advance(120000);assert.equal(probes.length,1,'unanswered, it is not followed by another');
  assert.equal(h.watches.length,1);
  probes[0].ok(place(2,h.wall));assert.equal(h.feed.snapshot().status,'live');
  h.advance(9000);assert.ok(probes.length>=2,'an answer is proof, and the asking carries on');
});
test('no answer: the two lines say whose turn it is, by what the permission says',()=>{
  const {display}=require('../drive-location.js');
  for(const status of ['no-response','timeout','disconnected','error']){
    let d=display(null,{status});assert.deepEqual([d.why,d.next,d.kmh],['No location yet','Allow location for this app',null],status+', permission not reported');
    d=display(null,{status,permission:'unknown'});assert.deepEqual([d.why,d.next],['No location yet','Allow location for this app']);
    d=display(null,{status,permission:'granted'});assert.deepEqual([d.why,d.next],['No location from your phone','Set Meta AI location to Always']);
    d=display(null,{status,permission:'prompt'});assert.deepEqual([d.why,d.next],['Location not allowed yet','Press Start GPS, then say yes']);
  }
  for(const status of ['off','waiting'])assert.deepEqual([display(null,{status,permission:'prompt'}).why,display(null,{status,permission:'prompt'}).next],['Location not allowed yet','Press Start GPS, then say yes'],status);
  assert.equal(display(null,{status:'off'}).why,'GPS is off');assert.equal(display(null,{status:'waiting'}).why,'Waiting for location');
  assert.equal(display(null,{status:'denied',permission:'prompt'}).why,'Location not allowed','a refusal keeps its own words');
  assert.deepEqual([display(null,{status:'found'}).why,display(null,{status:'found'}).next],['Location found','Waiting for a newer fix']);
  for(const lines of Object.values(require('../drive-location.js').NO_SPEED).concat(Object.values(require('../drive-location.js').NO_ANSWER_LINES)))
    assert.ok(!/Open Meta AI/.test(lines.join(' ')),'no line tells the wearer to open Meta AI: '+lines.join(' / '));
});

// ---- standing still stays 0, and slow speeds are held a little longer (build 50) ----
// Bakar, 15 Nov 2026: "Make sure the speed is always available, even if we're at 0 km/h, for the drive app."
const {display:show,SLOW_AGE_MS}=require('../drive-location.js');
const started=(permission)=>{const h=harness(permission);h.feed.setVisible(true);h.feed.enable();return h;};
test('standing still: a 0 stays 0 when fixes go quiet, with the age of the last fix beside it',()=>{
  const h=started();h.watches[0].ok(fix(0));
  assert.equal(show(null,h.feed.snapshot()).label,'Location speed');
  const wait=ms=>{for(let t=0;t<ms;t+=1000)h.advance(1000);};
  wait(SLOW_AGE_MS);
  let s=h.feed.snapshot();assert.equal(s.status,'standing');assert.equal(s.speed,0);
  let d=show(null,s);assert.deepEqual([d.kmh,d.source,d.why,d.next,d.label],[0,'standing','Standing still','Last location 10 s ago','Standing still · last location 10 s ago']);
  wait(50000);d=show(null,h.feed.snapshot());assert.equal(d.kmh,0);assert.equal(d.next,'Last location 1 min ago');
  wait(10*60000);assert.equal(show(null,h.feed.snapshot()).label,'Standing still · last location 11 min ago');
  const told=h.states.filter(x=>x.status==='standing').length;assert.ok(told>=100&&told<=140,'the age is repainted every five seconds, not every second: '+told);
  assert.equal(h.feed.report().status,'stale','the PC hears the word it already knows');assert.equal(h.feed.report().source,'none');
});
test('standing still: a fix that shows movement replaces the 0 at once',()=>{
  const h=started();h.watches[0].ok(fix(0));h.advance(60000);assert.equal(h.feed.snapshot().speed,0);
  h.watches[0].ok(fix(8,h.wall));
  const s=h.feed.snapshot();assert.equal(s.status,'live');assert.equal(s.speed,28.8);assert.equal(show(null,s).label,'Location speed');
});
test('moving, then fixes stop: an old moving speed is never held past its limit',()=>{
  const fast=started();fast.watches[0].ok(fix(16.7));fast.advance(MAX_AGE_MS);     // 60 km/h
  assert.equal(fast.feed.snapshot().status,'stale');assert.equal(show(null,fast.feed.snapshot()).kmh,null);
  fast.advance(120000);assert.equal(fast.feed.snapshot().speed,null,'and it never turns into a 0');
  const slow=started();slow.watches[0].ok(fix(1.4));                              // walking, 5 km/h
  slow.advance(MAX_AGE_MS);let d=show(null,slow.feed.snapshot());assert.deepEqual([d.kmh,d.label,d.source],[5,'Estimated speed','estimated'],'under 20 km/h it may stay up to ten seconds, as an estimate');
  slow.advance(SLOW_AGE_MS-MAX_AGE_MS-1);assert.equal(show(null,slow.feed.snapshot()).kmh,5);
  slow.advance(1);d=show(null,slow.feed.snapshot());assert.equal(d.kmh,null);assert.equal(d.why,'No new location');
  slow.advance(120000);assert.equal(slow.feed.snapshot().speed,null,'a walking speed does not turn into standing still either');
  const edge=started();edge.watches[0].ok(fix(5.56));edge.advance(MAX_AGE_MS);assert.equal(edge.feed.snapshot().speed,null,'20 km/h and above keeps the five second rule');
});
test('standing still: errors and silence keep the 0; a fix that cannot say still, a refusal, Stop or hiding end it',()=>{
  for(const code of [2,3]){const h=started();h.watches[0].ok(fix(0));h.advance(20000);h.watches[0].fail({code});assert.equal(h.feed.snapshot().status,'standing','error '+code);assert.equal(h.feed.snapshot().speed,0);}
  const old=started();old.watches[0].ok(fix(0));old.advance(20000);old.watches[0].ok({timestamp:old.wall-8000,coords:{speed:9,accuracy:5,latitude:1,longitude:1}});
  assert.equal(old.feed.snapshot().status,'standing','an old cached position shows no movement');
  const rough=started();rough.watches[0].ok(fix(0));rough.advance(20000);rough.watches[0].ok(fix(0,rough.wall,400));assert.equal(rough.feed.snapshot().status,'standing');
  const unsure=started();unsure.watches[0].ok(fix(0));unsure.advance(20000);unsure.watches[0].ok(fix(null,unsure.wall));
  assert.equal(unsure.feed.snapshot().status,'unavailable','a new fix with no speed and nothing to compare with: the 0 is not kept on trust');
  const denied=started();denied.watches[0].ok(fix(0));denied.advance(20000);denied.watches[0].fail({code:1});assert.equal(denied.feed.snapshot().status,'denied');
  const stopped=started();stopped.watches[0].ok(fix(0));stopped.advance(20000);stopped.feed.stop();assert.equal(stopped.feed.snapshot().status,'off');
  const retried=started();retried.watches[0].ok(fix(0));retried.advance(20000);retried.feed.enable();assert.equal(retried.feed.snapshot().speed,0,'Retry keeps the 0 while it asks again');
});
test('standing still: hidden and shown again, the 0 from before is not carried over',async()=>{
  const h=started();h.watches[0].ok(fix(0));h.advance(20000);assert.equal(h.feed.snapshot().speed,0);
  h.feed.setVisible(false);assert.equal(h.feed.snapshot().status,'paused');
  h.feed.setVisible(true);await Promise.resolve();
  assert.equal(h.feed.snapshot().status,'waiting','the car may have moved off while the display slept');assert.equal(h.feed.snapshot().speed,null);
  h.watches.at(-1).ok(fix(0,h.wall));assert.equal(h.feed.snapshot().speed,0);
});
test('before any fix nothing is invented: waiting, refused, off and unsupported keep their reasons',()=>{
  const h=started();assert.equal(show(null,h.feed.snapshot()).kmh,null);assert.equal(show(null,h.feed.snapshot()).why,'Waiting for location');
  h.advance(600000);assert.equal(show(null,h.feed.snapshot()).kmh,null);
  h.watches[0].fail({code:1});assert.equal(show(null,h.feed.snapshot()).why,'Location not allowed');
  h.feed.stop();assert.equal(show(null,h.feed.snapshot()).why,'GPS is off');
  const none=new Feed({geo:null});none.setVisible(true);none.enable();assert.equal(show(null,none.snapshot()).kmh,null);
  assert.equal(show({kmh:33,ageMs:100},{status:'standing',speed:0,sinceMs:20000}).label,'Linked speed','a fresh linked speed still wins');
});
test('no speed from the device and no movement: 0 from the second fix, kept while quiet, and again after a long gap',()=>{
  // The real pairing: the feed with drive/guide.js filling in a speed where the device reports none.
  const G=require('../drive/guide.js'),h=harness();
  const g=new G.Guide({now:()=>h.wall});h.feed.transform=p=>{g.fix(p);return g.fill(p);};
  const at=(east,over={})=>({timestamp:h.wall,coords:{speed:null,heading:null,accuracy:8,latitude:10,longitude:10+east/109000,...over}});
  h.feed.setVisible(true);h.feed.enable();
  h.watches[0].ok(at(0));assert.equal(show(null,h.feed.snapshot()).why,'Location found','one fix: nothing to compare with yet');
  h.advance(2000);h.watches[0].ok(at(1));
  let d=show(null,h.feed.snapshot());assert.deepEqual([d.kmh,d.label],[0,'Estimated speed'],'the second fix in the same place is 0 straight away');
  h.advance(90000);d=show(null,h.feed.snapshot());assert.deepEqual([d.kmh,d.why],[0,'Standing still']);
  h.watches[0].ok(at(2));d=show(null,h.feed.snapshot());assert.deepEqual([d.kmh,d.label],[0,'Estimated speed'],'a fix after the gap, same place: 0 at once');
  h.advance(90000);h.watches[0].ok(at(500));
  assert.equal(show(null,h.feed.snapshot()).kmh,null,'a fix after the gap, 500 m away: moved, speed not known, so no 0 and no guess');
  h.advance(2000);h.watches[0].ok(at(528));assert.ok(Math.abs(show(null,h.feed.snapshot()).kmh-50)<=2,'the next fix gives the speed');
});
test('a fix stamped a little ahead of the glasses\' clock gives a speed; one clearly in the future does not',()=>{
  const near=started();near.watches[0].ok(fix(10,now+1900));assert.equal(near.feed.snapshot().speed,36);assert.equal(near.feed.snapshot().ageMs,0);
  near.advance(MAX_AGE_MS-1);assert.equal(near.feed.snapshot().speed,36);near.advance(1);assert.equal(near.feed.snapshot().speed,null,'still five seconds on the glasses\' own clock');
  assert.equal(near.feed.details().lastFix.at,now+1900);
  const far=started();far.watches[0].ok(fix(10,now+2500));assert.equal(far.feed.snapshot().status,'invalid');assert.equal(far.feed.report().positions,0);
});

test('standing still: a 0 is never shown as an estimate; from five seconds it is standing still',()=>{
  const h=started();h.watches[0].ok(fix(0));
  h.advance(MAX_AGE_MS-1);assert.equal(show(null,h.feed.snapshot()).label,'Location speed');
  h.advance(1);const s=h.feed.snapshot();assert.equal(s.status,'standing');
  assert.deepEqual([show(null,s).kmh,show(null,s).source],[0,'standing']);
});

// ---- the permission question was never answered (real reports from the glasses, 15 Nov 2026: 70 reports, 0 callbacks, "prompt") ----
const lines=h=>{const d=show(null,h.feed.snapshot());return d.why+' / '+d.next;};
test('permission prompt on entry: nothing is requested, and the lines ask for a press and a yes',async()=>{
  const h=harness('prompt');h.feed.setVisible(true,{autoStart:true,resumeOnly:true});await Promise.resolve();await Promise.resolve();
  assert.equal(h.watches.length,0,'opening Drive never asks while the answer is still open');
  assert.equal(h.feed.snapshot().status,'off');assert.equal(h.feed.snapshot().permission,'prompt');
  assert.equal(lines(h),'Location not allowed yet / Press Start GPS, then say yes');
  assert.equal(h.feed.needsPress,true);
});
test('permission prompt: every press asks the runtime again inside the press; a timer never does',async()=>{
  const h=harness('prompt');h.feed.setVisible(true,{autoStart:true,resumeOnly:true});await Promise.resolve();await Promise.resolve();
  h.feed.enable();assert.equal(h.watches.length,1,'the native request is made before enable() returns: inside the press');
  await Promise.resolve();await Promise.resolve();
  for(let t=0;t<120;t++)h.advance(1000);
  assert.equal(h.watches.length,1,'two minutes of silence: no second request by itself');
  assert.equal(h.feed.details().asks,1);
  assert.equal(h.feed.snapshot().status,'no-response');assert.equal(lines(h),'Location not allowed yet / Press Start GPS, then say yes');
  assert.equal(h.feed.needsPress,true,'the button still offers Start GPS');
  h.feed.enable();assert.equal(h.watches.length,2,'the second press asks again');
  await Promise.resolve();await Promise.resolve();
  h.feed.enable();assert.equal(h.watches.length,3,'and the third');
  await Promise.resolve();await Promise.resolve();
  h.watches[2].fail({code:3});
  assert.equal(h.feed.snapshot().status,'timeout');assert.equal(lines(h),'Location not allowed yet / Press Start GPS, then say yes','a timeout while it reads prompt is still the unanswered question');
  for(let t=0;t<60;t++)h.advance(1000);
  assert.equal(h.feed.details().asks,3,'and a timeout does not start polling while it reads prompt');
});
test('permission prompt answered yes: the feed runs, polls as in build 49, and the lines move on',async()=>{
  const h=harness('prompt');h.feed.setVisible(true);h.feed.enable();await Promise.resolve();await Promise.resolve();
  h.advance(RESPONSE_NOTICE_MS+1);assert.equal(lines(h),'Location not allowed yet / Press Start GPS, then say yes');
  h.p.state='granted';h.p.onchange();
  assert.equal(h.feed.needsPress,false);
  h.advance(RESPONSE_NOTICE_MS+1);assert.equal(lines(h),'No location from your phone / Set Meta AI location to Always','allowed, and still nothing: now it is the phone');
  h.watches[0].ok(fix(12,h.wall));assert.equal(h.feed.snapshot().status,'live');assert.equal(h.feed.snapshot().permission,undefined);
});
test('granted and silent: the phone is named, with the setting to change; it keeps asking',async()=>{
  const h=started();await Promise.resolve();await Promise.resolve();
  h.advance(RESPONSE_NOTICE_MS+1);assert.equal(h.feed.snapshot().status,'no-response');
  assert.equal(lines(h),'No location from your phone / Set Meta AI location to Always');
  h.watches[0].fail({code:3});assert.equal(lines(h),'No location from your phone / Set Meta AI location to Always');
  assert.equal(h.feed.needsPress,false);
});
test('permission not reported and silent: allow location for this app; after any answer it is the phone',async()=>{
  const h=harness();h.feed.permissions=undefined;h.feed.setVisible(true);h.feed.enable();
  h.advance(RESPONSE_NOTICE_MS+1);assert.equal(lines(h),'No location yet / Allow location for this app');
  h.watches[0].fail({code:3});assert.equal(lines(h),'No location yet / Allow location for this app');
  h.watches[0].ok(fix(10,h.wall));h.advance(6000);h.watches[0].fail({code:3});
  assert.equal(lines(h),'No location from your phone / Set Meta AI location to Always','a position did come once, so location is allowed: the phone went quiet');
});
