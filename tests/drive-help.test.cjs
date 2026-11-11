'use strict';
// Actual shell/feed/render functions in a minimal DOM, with disposable in-memory
// clocks and geolocation. No browser, network, filesystem writes or device access.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {Feed}=require('../drive-location.js');
const {Phone}=require('../drive-phone.js');
const SpeedCheck=require('../drive/speed-check.js');
function harness(permission='granted',opts={}) {
  let clock=0,seq=0;const timers=new Map(),elements=new Map(),docEvents=new Map(),winEvents=new Map(),watches=[],clears=[];
  const document={hidden:false,activeElement:null,permissionsPolicy:{allowsFeature:()=>true}};
  const emit=(events,type,e={})=>(events.get(type)||[]).forEach(fn=>fn(e));
  const add=(events,type,fn)=>{if(!events.has(type))events.set(type,[]);events.get(type).push(fn);};
  function element(id) {
    if(elements.has(id))return elements.get(id);
    const classes=new Set(),events=new Map();
    const e={id,hidden:['driveInfo','reviewFrame','reviewState','driveRetry'].includes(id),disabled:false,dataset:{},textContent:'',inert:false,
      classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle(x,on){if(on===undefined)on=!classes.has(x);on?classes.add(x):classes.delete(x);}},
      focus(){document.activeElement=e;},addEventListener:(type,fn)=>add(events,type,fn),
      click(){emit(docEvents,'click',{isTrusted:true,target:e});emit(events,'click',{isTrusted:true,target:e});},
      setAttribute(k,v){if(k==='data-details')e.dataset.details=v;},removeAttribute(k){if(k==='data-details')delete e.dataset.details;},
      getAttribute:()=>null,contentWindow:{postMessage(){}},closest:()=>null};
    elements.set(id,e);return e;
  }
  Object.assign(document,{body:element('body'),getElementById:element,querySelectorAll:()=>[],querySelector:()=>element('tabs'),addEventListener:(t,f)=>add(docEvents,t,f)});
  const schedule=(fn,ms)=>{timers.set(++seq,{fn,at:clock+ms});return seq;},cancel=id=>timers.delete(id);
  const p={state:permission,onchange:null};
  class FixtureFeed extends Feed {constructor(opts){super({...opts,now:()=>1700000000000+clock,mono:()=>clock,schedule,cancel});}}
  const context={document,Date,URL,URLSearchParams,console,S:{tab:'drive',view:'list'},isSecureContext:true,
    setTimeout:schedule,clearTimeout:cancel,location:{origin:'https://fixture.invalid',href:'https://fixture.invalid/'},
    navigator:{geolocation:{watchPosition(ok,fail){watches.push({ok,fail});return watches.length-1;},clearWatch:id=>clears.push(id)},permissions:{query:async()=>p}},
    StudioDrivePhone:{Phone},...(opts.noCheck?{}:{SpeedCheck}),StudioDriveLocation:{Feed:FixtureFeed},StudioParked:{confirmed:()=>true,controlsAllowed:()=>true,isOpen:()=>false,request(){},revoke(){emit(docEvents,'studio-parked-change');}},
    stopReading(){},passPairing:()=>null,reviewKey(){},selectTab(){},$:element,
    addEventListener:(t,f)=>add(winEvents,t,f)};
  context.window=context;vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../home-shell.js'),'utf8'),context);
  const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
  vm.runInContext(app.slice(app.indexOf('const DRIVE_PHONE_LABELS='),app.indexOf('// Light: the display')),context);
  vm.runInContext("HomeShell.init();HomeShell.onPane('drive','now');driveFeed.setVisible(true);paintDrive(driveFeed.snapshot());",context);
  const feed=vm.runInContext('driveFeed',context);
  function advance(ms){const end=clock+ms;while(true){const due=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;clock=due[1].at;timers.delete(due[0]);due[1].fn();}clock=end;}
  function key(key){context.HomeShell.handleKey({key,isTrusted:true,repeat:false,preventDefault(){},stopImmediatePropagation(){}});}
  // The phone link needs a pairing and brokers; these tests only need the state it would report.
  function phone(state,over={}){
    context.__phone={state,configured:true,enabled:true,gps:null,nav:null,offer:false,code:'123456',problem:'',...over};
    vm.runInContext("drivePhone.snapshot=()=>__phone;paintDrive(driveFeed.snapshot());",context);
  }
  return {context,document,feed,p,watches,clears,element,advance,key,phone,
    reveal:()=>element('driveReveal').click(),details:()=>element('driveInfoButton').click(),
    emitDoc:t=>emit(docEvents,t),emitWindow:t=>emit(winEvents,t),
    fix:(speed=10)=>watches.at(-1).ok({timestamp:1700000000000+clock,coords:{speed,accuracy:5}}),
    error:code=>watches.at(-1).fail({code})};
}
test('ordinary controls still hide at eight seconds',()=>{const h=harness();h.reveal();h.advance(7999);assert.equal(h.element('drive').dataset.controls,'open');h.advance(1);assert.equal(h.element('drive').dataset.controls,'quiet');});
test('GPS help stays open indefinitely without moving focus',()=>{const h=harness();h.reveal();h.details();h.advance(120000);assert.equal(h.element('driveInfo').hidden,false);assert.equal(h.document.activeElement.id,'driveInfoClose');});
test('repeated reading keys do not arm a details dismissal timer',()=>{const h=harness();h.reveal();h.details();for(let i=0;i<5;i++){h.key('ArrowDown');h.advance(9000);}assert.equal(h.element('driveInfo').hidden,false);});
test('explicit Back button restores focus and ordinary idle hide',()=>{const h=harness();h.reveal();h.details();h.element('driveInfoClose').click();assert.equal(h.element('driveInfo').hidden,true);assert.equal(h.document.activeElement.id,'driveInfoButton');h.advance(8000);assert.equal(h.element('drive').dataset.controls,'quiet');});
test('Escape dismisses details explicitly before quieting controls',()=>{const h=harness();h.reveal();h.details();h.key('Escape');assert.equal(h.element('driveInfo').hidden,true);assert.equal(h.element('drive').dataset.controls,'open');assert.equal(h.document.activeElement.id,'driveInfoButton');h.key('Escape');assert.equal(h.element('drive').dataset.controls,'quiet');});
test('timeout then denial updates headline and open details together',()=>{const h=harness();h.reveal();h.feed.enable();h.error(3);assert.equal(h.element('driveState').textContent,'GPS timed out\nPair your phone');h.details();h.error(1);assert.equal(h.element('driveState').textContent,'Glasses location not allowed\nPair your phone');assert.match(h.element('driveFacts').textContent,/Now: Location permission not granted/);assert.match(h.element('driveFacts').textContent,/watch stopped/);h.advance(20000);assert.equal(h.element('driveInfo').hidden,false);assert.equal(h.document.activeElement.id,'driveInfoClose');});
test('unresolved permission pauses ordinary hide, observed grant resumes it',async()=>{const h=harness('prompt');h.reveal();h.feed.enable();await Promise.resolve();h.advance(30000);assert.equal(h.element('drive').dataset.controls,'open');assert.equal(h.feed.snapshot().status,'no-response');h.p.state='granted';h.p.onchange();h.advance(8000);assert.equal(h.element('drive').dataset.controls,'quiet');});
test('page visibility changes preserve details and release location watch',async()=>{const h=harness();h.reveal();h.feed.enable();await Promise.resolve();h.details();h.document.hidden=true;h.emitDoc('visibilitychange');assert.equal(h.element('driveInfo').hidden,false);assert.equal(h.feed.details().watchActive,false);h.document.hidden=false;h.emitDoc('visibilitychange');await Promise.resolve();h.advance(9000);assert.equal(h.element('driveInfo').hidden,false);});
test('pagehide preserves help while stopping the active watch',()=>{const h=harness();h.reveal();h.feed.enable();h.details();h.emitWindow('pagehide');assert.equal(h.element('driveInfo').hidden,false);assert.equal(h.feed.details().watchActive,false);});
test('navigation explicitly closes details',()=>{const h=harness();h.reveal();h.details();h.context.S.tab='now';h.context.HomeShell.onPane('now','drive');assert.equal(h.element('driveInfo').hidden,true);});
test('last fix uses fixed acquisition time after expiry, not frozen age',()=>{const h=harness();h.reveal();h.feed.enable();h.fix();h.details();h.advance(60000);assert.match(h.element('driveFacts').textContent,/Now: GPS reading expired/);assert.doesNotMatch(h.element('driveFacts').textContent,/\d+ s old/);assert.match(h.element('driveFacts').textContent,/Last fix: (?!none|time unknown)/);});
test('new request shows waiting separately from an earlier denied error',()=>{const h=harness();h.reveal();h.feed.enable();h.error(1);h.feed.enable();h.details();assert.match(h.element('driveFacts').textContent,/Now: Waiting for phone GPS/);assert.match(h.element('driveFacts').textContent,/Last API error: Denied.*\(#1\)/);assert.match(h.element('driveFacts').textContent,/starts: 2/);});

// ---- speed self-check on the Drive headline (drive/speed-check.js) ----
test('no phone set up and location refused: plain amber warning, exact status kept in the details',()=>{
  const h=harness();h.reveal();h.feed.enable();h.error(1);h.details();
  assert.equal(h.element('driveState').textContent,'Glasses location not allowed\nPair your phone');
  assert.equal(h.element('driveHud').dataset.level,'warn');
  assert.equal(h.element('driveSpeed').textContent,'—');
  assert.match(h.element('driveFacts').textContent,/Now: Location permission not granted/);
  assert.match(h.element('driveFacts').textContent,/Last API error: Denied/);
});
test('calm states are not warnings: GPS never started, still asking',()=>{
  const h=harness();h.reveal();
  assert.equal(h.element('driveState').textContent,'GPS not started in this app');assert.equal(h.element('driveHud').dataset.level,'ok');
  h.feed.enable();assert.equal(h.element('driveHud').dataset.level,'ok');
  assert.equal(h.element('driveState').textContent,'Waiting for phone GPS');
});
test('a healthy phone link keeps its own calm words even though the glasses location is refused',()=>{
  const h=harness();h.reveal();h.feed.enable();h.error(1);
  h.phone('ready');assert.equal(h.element('driveState').textContent,'Phone linked · waiting for GPS');assert.equal(h.element('driveHud').dataset.level,'ok');
  h.phone('waiting');assert.equal(h.element('driveState').textContent,'Waiting for your phone');assert.equal(h.element('driveHud').dataset.level,'ok');
  h.phone('no-sample');assert.equal(h.element('driveState').textContent,'Phone linked · no fresh GPS speed');assert.equal(h.element('driveHud').dataset.level,'ok');
});
test('refused location and a phone that is not answering: both named, amber',()=>{
  const h=harness();h.reveal();h.feed.enable();h.error(1);
  h.phone('offline');assert.equal(h.element('driveState').textContent,'Glasses location not allowed\nNo signal to phone');assert.equal(h.element('driveHud').dataset.level,'warn');
  h.phone('unavailable',{problem:'x'});assert.equal(h.element('driveState').textContent,'Glasses location not allowed\nPhone link unavailable');
  h.phone('off',{enabled:false});assert.equal(h.element('driveState').textContent,'Glasses location not allowed\nResume the phone link');
  h.phone('pairing');assert.equal(h.element('driveState').textContent,'Glasses location not allowed\nCompare the code on your phone');
});
test('a phone link that cannot run in this app is not told to pair',()=>{
  const h=harness();h.reveal();h.feed.enable();h.error(1);
  h.phone('unavailable',{configured:false,problem:'Secure phone link unavailable in this app'});
  assert.equal(h.element('driveState').textContent,'Glasses location not allowed\nPhone link unavailable');assert.equal(h.element('driveHud').dataset.level,'warn');
});
test('a phone problem alone is amber with the phone words; a phone speed that went dead says so',()=>{
  const h=harness();h.reveal();
  h.phone('stale');assert.equal(h.element('driveState').textContent,'Phone speed expired');assert.equal(h.element('driveHud').dataset.level,'warn');assert.equal(h.element('driveSpeed').textContent,'—');
  h.phone('offline');assert.equal(h.element('driveState').textContent,'Phone link unavailable');assert.equal(h.element('driveHud').dataset.level,'warn');
  h.phone('ready');assert.equal(h.element('driveHud').dataset.level,'ok');
});
test('a reading that is rough or has no speed keeps its calm words: that happens parked and just after Start',()=>{
  const h=harness();h.reveal();h.feed.enable();
  h.watches.at(-1).ok({timestamp:1700000000000,coords:{speed:10,accuracy:500}});
  assert.equal(h.element('driveState').textContent,'GPS signal too weak');assert.equal(h.element('driveHud').dataset.level,'ok');
  h.watches.at(-1).ok({timestamp:1700000000000,coords:{speed:null,accuracy:5}});
  assert.equal(h.element('driveState').textContent,'GPS has no speed reading');assert.equal(h.element('driveHud').dataset.level,'ok');
  h.watches.at(-1).ok({timestamp:1700000000000,coords:{speed:NaN,accuracy:5}});
  assert.equal(h.element('driveHud').dataset.level,'ok');
});
test('a fresh phone speed shows with no warning, even with the glasses location refused',()=>{
  const h=harness();h.reveal();h.feed.enable();h.error(1);
  h.phone('live',{gps:{kmh:62,hdg:90}});
  assert.equal(h.element('driveSpeed').textContent,'62');assert.equal(h.element('driveState').textContent,'Phone link · GPS estimate');assert.equal(h.element('driveHud').dataset.level,'ok');
});
test('the glasses speed shows with no warning when the phone has none',()=>{
  const h=harness();h.reveal();h.feed.enable();h.fix(10);
  assert.equal(h.element('driveSpeed').textContent,'36');assert.equal(h.element('driveState').textContent,'App location · GPS estimate');assert.equal(h.element('driveHud').dataset.level,'ok');
});
test('speed that goes dead is shown as a dash and a warning, never an old number',()=>{
  const h=harness();h.reveal();h.feed.enable();h.fix(10);assert.equal(h.element('driveSpeed').textContent,'36');
  h.advance(5200);
  assert.equal(h.element('driveSpeed').textContent,'—');assert.equal(h.element('driveState').textContent,'GPS speed lost\nPair your phone');assert.equal(h.element('driveHud').dataset.level,'warn');
  h.fix(10);assert.equal(h.element('driveSpeed').textContent,'36');assert.equal(h.element('driveHud').dataset.level,'ok');
});
test('without the self-check module the old wording stays and nothing breaks',()=>{
  const h=harness('granted',{noCheck:true});h.reveal();h.feed.enable();h.error(1);
  assert.equal(h.element('driveState').textContent,'Location permission not granted');assert.equal(h.element('driveHud').dataset.level,'ok');
});
