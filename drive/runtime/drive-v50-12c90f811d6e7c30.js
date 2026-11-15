// ../drive-location.js
'use strict';
// Phone-reported GPS ground speed. No coordinates are retained, sent or inferred.
// Product policy: at most 5 s old, <=50 m position uncertainty, <=100 m/s. Two owner exceptions (15 Nov 2026, DRIVE.md):
// a speed under 20 km/h may stay up to 10 s, and a reading of standing still stays 0 until a fix shows movement.
// These are conservative display filters, not a guarantee of speed accuracy.
// The W3C API does not report speed uncertainty or whether a fix is mocked.
(function (root) {
  const MAX_AGE_MS = 5000, MAX_ACCURACY_M = 50, MAX_SPEED_MPS = 100, RESPONSE_NOTICE_MS = 12000;
  const FOUND_AGE_MS = 60000;                 // a position this recent, though too old for a speed, still shows that location works
  const FUTURE_MS = 2000;                     // the phone's clock may run a little ahead of the glasses': a fix stamped this far ahead is still now
  const SLOW_KMH = 20, SLOW_AGE_MS = 10000;   // on foot fixes are sparse: a speed under 20 km/h may be held this long. Faster, 5 s stands.
  const STILL_KMH = 1;                        // a reading under this is standing still
  // While standing still is on screen, these say only that nothing new came: they never show movement, so the 0 stays.
  const QUIET = new Set(['waiting','no-response','timeout','disconnected','error','stale','found','inaccurate','invalid']);
  const holdLimit=kmh=>kmh>=STILL_KMH&&kmh<SLOW_KMH?SLOW_AGE_MS:MAX_AGE_MS;   // a 0 is not "estimated" past 5 s: it becomes Standing still
  // How long ago, in the steps a glance can take: 5 s steps under a minute, then whole minutes.
  const since=ms=>ms<60000?Math.max(5,Math.floor(ms/5000)*5)+' s':Math.floor(ms/60000)+' min';
  const PROBE_MIN_MS = 4000, PROBE_MAX_MS = 15000, RELAXED_AGE_MS = 10000, WATCH_SILENT_MS = 30000;
  const placed=c=>Boolean(c)&&Number.isFinite(c.latitude)&&Math.abs(c.latitude)<=90&&Number.isFinite(c.longitude)&&Math.abs(c.longitude)<=180;
  function reading(position, now) {
    const c = position?.coords, at = position?.timestamp;
    if (!Number.isFinite(at) || at <= 0 || at > now + FUTURE_MS) return {status:'invalid', speed:null};
    // An older position (a cached one, say) is not a speed, but it proves location reaches this app: say found, not lost.
    if (now - at >= MAX_AGE_MS) return {status:now-at<FOUND_AGE_MS&&placed(c)?'found':'stale', speed:null, at};
    // A fix too rough to use cannot give a speed from positions either: say rough, not "working out speed".
    if (c && c.speed == null && Number.isFinite(c.accuracy) && c.accuracy > MAX_ACCURACY_M) return {status:'inaccurate', speed:null, at};
    if (!c || c.speed == null) return {status:'unavailable', speed:null, at};
    if (!Number.isFinite(c.speed) || c.speed < 0 || c.speed > MAX_SPEED_MPS)
      return {status:'invalid', speed:null, at};
    if (!Number.isFinite(c.accuracy) || c.accuracy < 0 || c.accuracy > MAX_ACCURACY_M)
      return {status:'inaccurate', speed:null, at};
    const heading=c.speed>=2&&Number.isFinite(c.heading)&&c.heading>=0&&c.heading<360?c.heading:null;
    return {status:'live', speed:c.speed * 3.6, heading, at};
  }
  class Feed {
    constructor({geo, permissions, transform=p=>p, now=Date.now, mono=()=>performance.now(),
      schedule=(fn,ms)=>setTimeout(fn,ms), cancel=id=>clearTimeout(id), change=()=>{}}) {
      Object.assign(this,{geo,permissions,transform,now,mono,schedule,cancel,change});
      this.probeTimer=null;this.probeDeadline=null;this.probeId=0;this.denied=false;this.gestureTried=false;this.positionFacts=null;this.lastGood=null;this.pendingState=null;this.observed='off';this.restOk=false;
      this.hadGrant=false; this.worked=false; this.enabled=false; this.visible=false; this.watch=null; this.timer=null; this.epoch=0;
      this.state={status:geo?'off':'unsupported',speed:null}; this.permission=null;
      // Page-local facts only: never copy the position object or its coordinates.
      this.facts={attempts:0,asks:0,errors:0,fixes:0,positionFixes:0,lastFix:null,lastError:null,permission:'unknown'};
    }
    publish(state) { this.state=state; this.change(this.snapshot()); }
    snapshot() {
      const s={...this.state};
      if (s.status==='live') {
        const elapsed=this.mono()-s.receivedMono, age=Math.max(this.now()-s.at,s.initialAge+elapsed);
        const sane=Number.isFinite(age)&&elapsed>=0&&this.now()>=s.at-FUTURE_MS;
        if (!sane||age>=holdLimit(s.speed)) {
          // Standing still, and nothing since has shown movement: the speed is still 0, said with the age of the last fix.
          if (sane&&this.restOk&&s.speed<STILL_KMH&&(!this.pendingState||QUIET.has(this.pendingState.status)))
            return {status:'standing',speed:0,at:s.at,sinceMs:age,source:s.source};
          return this.pendingState?{...this.pendingState}:{status:'stale',speed:null,at:s.at};
        }
        s.ageMs=Math.max(0,age);
      }
      delete s.receivedMono; delete s.initialAge;
      return s;
    }
    details() {
      const f=this.facts,last=f.lastFix;
      const age=last?.at===null?NaN:last?Math.max(0,this.now()-last.at,last.initialAge+this.mono()-last.receivedMono):NaN;
      return {status:this.snapshot().status,attempts:f.attempts,asks:f.asks,errors:f.errors,fixes:f.fixes,positionFixes:f.positionFixes,watchActive:this.watch!==null,
        visible:this.visible,enabled:this.enabled,permission:f.permission,
        lastFix:last?{at:last.at,ageMs:Number.isFinite(age)&&age>=0&&this.now()>=last.at-FUTURE_MS?age:null,
          accuracy:last.accuracy,speedPresent:last.speedPresent,status:last.status}:null,
        lastError:f.lastError?{...f.lastError}:null};
    }
    report() {
      const state=this.snapshot();
      const f=this.positionFacts;
      return {version:1,status:state.status==='found'||state.status==='standing'?'stale':state.status,permission:this.facts.permission,
        callbacks:this.facts.fixes,positions:this.facts.positionFixes,
        coordinates:f?.coordinates===true,fresh:Boolean(f?.at>0&&this.now()>=f.at-FUTURE_MS&&this.now()-f.at<MAX_AGE_MS),
        accurate:f?.accurate===true,source:state.status==='live'?(state.source||'reported'):'none',
        reason:f?.reason||'no-callback',error:this.facts.lastError?.code||0,observation:this.observed,held:state.status==='live'&&this.observed!=='live'};
    }
    observe(next) {
      this.observed=next.status;
      // Keep a usable reading only for its original freshness interval. An error
      // or incomplete fix can change what follows it, never its timestamp.
      const shown=this.snapshot().status;
      if(next.status!=='live'&&(shown==='live'||(shown==='standing'&&QUIET.has(next.status)))) {
        this.pendingState=next;this.change(this.snapshot());return false;
      }
      this.pendingState=null;
      if(next.status==='live')this.lastGood=next;
      this.publish(next);return true;
    }
    clear() {
      ++this.epoch;
      ++this.probeId;
      if(this.probeTimer!==null)this.cancel(this.probeTimer);
      if(this.probeDeadline!==null)this.cancel(this.probeDeadline);
      this.probeTimer=null;this.probeDeadline=null;
      if(this.timer!==null){this.cancel(this.timer);this.timer=null;}
      if(this.watch!==null){this.geo.clearWatch?.(this.watch);this.watch=null;}
      if(this.permission){this.permission.onchange=null;this.permission=null;}
    }
    tick() {
      this.timer=null; const s=this.snapshot();
      // Standing still: the state is kept (a fix that shows movement replaces it) and only the age said beside the 0 moves on.
      if(s.status==='standing') { this.change(s); this.timer=this.schedule(()=>this.tick(),5000); return; }
      if(s.status!=='live') { this.publish(s); return; }
      this.change(s);
      this.timer=this.schedule(()=>this.tick(),Math.max(1,Math.min(1000,holdLimit(s.speed)-s.ageMs)));
    }
    // Explicit Start or Retry replaces the watch. Entering the same visible view keeps it.
    enable() { this.denied=false;this.enabled=true; if(this.visible)this.start(true); }
    stop() { this.observed='off';this.restOk=false;this.lastGood=null;this.pendingState=null;this.hadGrant=false;this.enabled=false;this.clear();this.publish({status:this.geo?'off':'unsupported',speed:null}); }
    setVisible(visible, {autoStart=false, resumeOnly=false, gesture=false, worked=false}={}) {
      // worked: location answered here on an earlier visit (the app remembers that), on a host that cannot report the permission.
      if(visible)this.worked=Boolean(worked);
      if(this.visible===visible){
        if(visible&&gesture&&!this.denied&&!this.hadGrant&&!this.gestureTried&&
          (!this.enabled||['timeout','no-response'].includes(this.state.status))){
          this.gestureTried=true;this.enable();
        }
        return;
      }
      this.visible=visible;
      // Hidden, the car may have moved off: a 0 from before is not carried over. The first fix after says what is true.
      if(!visible){this.restOk=false;this.clear();this.publish({status:this.enabled?'paused':this.geo?'off':'unsupported',speed:null});}
      else if(autoStart && this.denied){this.publish({status:'denied',speed:null});}
      else if(autoStart){
        this.enabled=true;
        // First entry in Drive is the permission gesture. Waking/re-entering later only resumes a grant.
        const request=gesture&&!this.gestureTried&&!this.denied;
        if(request)this.gestureTried=true;
        this.start(request||(!resumeOnly&&this.facts.attempts===0));
      } else if(this.enabled)this.start();
    }
    async start(deliberate=false) {
      this.clear();
      this.facts.permission='unknown';
      if(!this.visible||!this.enabled)return;
      if(!this.geo?.watchPosition&&!this.geo?.getCurrentPosition){this.enabled=false;this.publish({status:'unsupported',speed:null});return;}
      const epoch=this.epoch;
      // Resume only with an existing grant. Never surprise a returning wearer
      // with a permission prompt after waking a sleeping page.
      let permission;
      if(!deliberate){
        // The feed is visible again. Recheck the current grant without re-prompting.
        this.observe({status:'waiting',speed:null});
        try { permission=await this.permissions?.query({name:'geolocation'}); } catch(_) {}
        if(epoch!==this.epoch||!this.visible||!this.enabled)return;
        this.facts.permission=['granted','denied','prompt'].includes(permission?.state)?permission.state:'unknown';
        // An earlier granted status or real success callback on this page
        // permits resuming on hosts without Permissions.query. A current
        // prompt or denial always wins over that historical observation.
        const known=['granted','denied','prompt'].includes(permission?.state);
        if(permission?.state!=='granted'&&(known||!this.hadGrant)){
          this.hadGrant=false;
          this.enabled=false;
          this.denied=permission?.state==='denied';
          this.lastGood=null;this.pendingState=null;
          this.publish({status:this.denied?'denied':'off',speed:null});
          if(permission?.state==='prompt') {
            // Just observe. Waking the app cannot launch a permission sheet.
            this.permission=permission;
            permission.onchange=()=>{
              if(epoch!==this.epoch||!this.visible)return;
              this.facts.permission=permission.state;
              if(permission.state==='granted'){
                this.hadGrant=true;this.enabled=true;this.start(true);
              } else if(permission.state==='denied'){
                this.denied=true;this.clear();this.publish({status:'denied',speed:null});
              }
            };
          }
          return;
        }
      }
      ++this.facts.attempts;
      this.pendingState=null;
      if(this.lastGood){
        this.state=this.lastGood;
        if(this.snapshot().status!=='live')this.lastGood=null;
      }
      if(this.lastGood){
        this.observed='waiting';this.pendingState={status:'stale',speed:null,at:this.lastGood.at};
        this.change(this.snapshot());
        this.timer=this.schedule(()=>this.tick(),Math.min(1000,Math.max(1,MAX_AGE_MS-this.snapshot().ageMs)));
      }else this.observe({status:'waiting',speed:null});
      // Some hosts return neither callback. This notice is NOT a synthetic API timeout.
      // Keep the watch alive for a later fix; never repeatedly request permission.
      if(!this.lastGood)this.timer=this.schedule(()=>{
        this.timer=null;
        if(epoch===this.epoch&&this.visible&&this.enabled&&this.state.status==='waiting')
          this.observe({status:'no-response',speed:null});
      },RESPONSE_NOTICE_MS);
      // One native request for this visible visit. An incoming status or repaint cannot start another.
      const options={enableHighAccuracy:true,maximumAge:0,timeout:30000};
      const startedAt=this.mono();
      let lastWatchFix=-Infinity, probeExpired=false;
      // sawError: the provider itself answered "timed out" or "no position". That answer proves no permission sheet is open,
      // so asking again cannot stack one. lastAnswer: when any position last came back, usable for a speed or not.
      let sawError=false, lastAnswer=-Infinity, watchSince=startedAt, probeFails=0;
      const active=()=>epoch===this.epoch&&this.visible&&this.enabled;
      const accept=(position,fromWatch)=>{
        if(!active())return;
        const now=this.now(),at=position?.timestamp,raw=position?.coords;
        const fresh=Number.isFinite(at)&&at>0&&now>=at-FUTURE_MS&&now-at<MAX_AGE_MS;
        const coordinates=Number.isFinite(raw?.latitude)&&Math.abs(raw.latitude)<=90&&
          Number.isFinite(raw?.longitude)&&Math.abs(raw.longitude)<=180;
        const accurate=Number.isFinite(raw?.accuracy)&&raw.accuracy>=0&&raw.accuracy<=MAX_ACCURACY_M;
        const hasPosition=fresh&&coordinates;
        ++this.facts.fixes;lastAnswer=this.mono();
        if(this.positionFacts?.at && at<this.positionFacts.at)return;
        if(hasPosition&&at!==this.positionFacts?.at)++this.facts.positionFixes;
        const next=reading(this.transform(position),now);
        const reported=Number.isFinite(raw?.speed)&&raw.speed>=0;
        if(next.status==='live')next.source=reported?'reported':'estimated';
        const reason=!fresh?'invalid-time':!coordinates?'missing-coordinates':!accurate?'low-accuracy':
          next.status==='live'?(reported?'reported-speed':'positions-estimate'):'need-speed-fixes';
        this.positionFacts={at:Number.isFinite(at)&&at>0&&at<=now+FUTURE_MS?at:null,coordinates,accurate,reason};
        if(fromWatch && fresh && (hasPosition||next.status==='live'))lastWatchFix=this.mono();
        if(raw&&Number.isFinite(at)&&at>0)this.hadGrant=true;
        this.facts.lastFix={at:Number.isFinite(at)&&at>0&&at<=now+FUTURE_MS?at:null,
          receivedMono:this.mono(),initialAge:Number.isFinite(at)&&at>0&&at<=now+FUTURE_MS?Math.max(0,now-at):null,
          accuracy:Number.isFinite(raw?.accuracy)&&raw.accuracy>=0?raw.accuracy:null,
          speedPresent:Number.isFinite(raw?.speed)&&raw.speed>=0,status:next.status};
        if(next.status==='live'){
          const previous=this.lastGood?.at===next.at?this.lastGood:null;
          Object.assign(next,{receivedMono:previous?.receivedMono??this.mono(),initialAge:previous?.initialAge??Math.max(0,now-next.at)});
          this.restOk=true;
        }
        if(!this.observe(next))return;
        if(this.timer!==null){this.cancel(this.timer);this.timer=null;}
        if(next.status==='live')this.timer=this.schedule(()=>this.tick(),Math.max(1,Math.min(1000,MAX_AGE_MS-(now-next.at))));
      };
      const fail=error=>{
        if(!active())return;
        const code=[1,2,3].includes(error?.code)?error.code:null;
        this.facts.lastError={code,at:this.now(),attempt:this.facts.attempts};++this.facts.errors;
        if(code!==1)sawError=true;
        if(code===1){
          this.lastGood=null;this.pendingState=null;this.restOk=false;this.denied=true;this.hadGrant=false;this.enabled=false;this.clear();
          this.observed='denied';this.publish({status:'denied',speed:null});return;
        }
        if(!this.observe({status:code===3?'timeout':code===2?'disconnected':'error',speed:null}))return;
        if(this.timer!==null){this.cancel(this.timer);this.timer=null;}
      };
      // A second API call while the first prompt is open can stack permission
      // sheets. Poll only after evidence of permission; leave a silent watch alive.
      const mayPoll=()=>this.facts.permission==='granted'||
        (this.facts.permission==='unknown'&&(this.hadGrant||sawError||this.worked));
      // Proof, not memory: only this lets a request that got no answer at all be followed by another.
      const sure=()=>this.facts.permission==='granted'||(this.facts.permission==='unknown'&&(this.hadGrant||sawError));
      // Each request that brings nothing waits a little longer before the next: 4 s, 4 s, 6 s, 9 s, 13 s, then every 15 s.
      const backoff=()=>Math.min(PROBE_MAX_MS,Math.round(PROBE_MIN_MS*1.5**Math.max(0,probeFails-1)));
      const scheduleProbe=(delay=backoff())=>{
        if(!this.geo.getCurrentPosition||!active()||!mayPoll()||this.probeDeadline!==null)return;
        if(this.probeTimer!==null)this.cancel(this.probeTimer);
        this.probeTimer=this.schedule(()=>{this.probeTimer=null;if(mayPoll())probe();},delay);   // the permission may have turned out to be a question since this was set
      };
      let probeNumber=0;
      const probe=()=>{
        if(!active()||!this.geo.getCurrentPosition||this.probeDeadline!==null)return;
        if(this.probeTimer!==null){this.cancel(this.probeTimer);this.probeTimer=null;}
        const watchAge=this.mono()-lastWatchFix;
        if(watchAge<MAX_AGE_MS){scheduleProbe(MAX_AGE_MS-watchAge);return;}
        // A watch that has given nothing for half a minute is opened again: some hosts answer a watch only once.
        if(this.watch!==null&&this.mono()-Math.max(watchSince,lastWatchFix)>=WATCH_SILENT_MS)openWatch();
        const id=++this.probeId;
        const finish=callback=>{
          if(!active()||id!==this.probeId)return;
          ++this.probeId;
          this.cancel(this.probeDeadline);this.probeDeadline=null;probeExpired=false;
          callback();scheduleProbe();
        };
        this.probeDeadline=this.schedule(()=>{
          if(!active()||id!==this.probeId)return;
          ++probeFails;
          if(this.mono()-lastWatchFix>=MAX_AGE_MS&&this.mono()-lastAnswer>=PROBE_MAX_MS)this.observe({status:'no-response',speed:null});
          if(sure())finish(()=>{});
          else probeExpired=true; // A pending prompt can still produce a valid first callback.
        },RESPONSE_NOTICE_MS);
        let nativeDone=false;
        const success=p=>{
          if(!active()||nativeDone)return;
          nativeDone=true;probeFails=0;
          if(id===this.probeId){finish(()=>accept(p,false));return;}
          // A timeout retires the request, not a freshly acquired sample from
          // this still-visible visit. Never let an old request revoke permission.
          const age=this.now()-p?.timestamp;
          if(Number.isFinite(age)&&age>=0&&age<MAX_AGE_MS)accept(p,false);
        };
        try {
          // Take turns: a relaxed request may be answered from a position the phone already has (up to 10 s old), which
          // is the only kind some hosts give; a precise one asks for a new fix.
          const precise=(++probeNumber+(this.watch===null?1:0))%2===0;
          ++this.facts.asks;
          this.geo.getCurrentPosition(success,e=>{
            if(nativeDone)return;
            nativeDone=true;++probeFails;if(e?.code!==1)sawError=true;finish(()=>{
              // A position came back a moment ago: one failed request beside it is not "no location".
              if(e?.code===1||(this.mono()-lastWatchFix>=MAX_AGE_MS&&this.mono()-lastAnswer>=PROBE_MAX_MS))fail(e);
            });
          },{...options,enableHighAccuracy:precise,maximumAge:precise?0:RELAXED_AGE_MS,timeout:10000});
        }catch(e){finish(()=>{if(this.watch===null)fail(e);});}
      };
      const granted=()=>{
        this.hadGrant=true;
        if(probeExpired){
          // A real grant arrived after the host ignored the first one-shot.
          // Replace its expired generation. Late replies cannot revoke a new visit.
          ++this.probeId;
          this.cancel(this.probeDeadline);this.probeDeadline=null;probeExpired=false;
        }
        scheduleProbe(Math.max(0,4000-(this.mono()-startedAt)));
      };
      const observePermission=p=>{
        if(!p||!active())return;
        this.permission=p;
        const update=(initial=false)=>{
          if(!active())return;
          const state=p.state;
          this.facts.permission=['granted','denied','prompt'].includes(state)?state:'unknown';
          if(state==='granted')granted();
          else if(state==='denied'||(!initial&&state==='prompt')){
            this.denied=state==='denied';this.restOk=false;this.lastGood=null;this.pendingState=null;
            this.hadGrant=false;this.enabled=false;this.clear();
            this.observed=this.denied?'denied':'off';
            this.publish({status:this.observed,speed:null});return;
          }
          this.change(this.snapshot());
        };
        p.onchange=()=>update();
        update(true);
      };
      // Register one stream immediately; a silent getCurrentPosition must not
      // keep a working watch from receiving its first fix. Hosts with only
      // one-shot location still receive one request on the entry gesture.
      const watchOk=p=>{accept(p,true);if(this.probeTimer===null)scheduleProbe();};
      const watchFail=e=>{fail(e);scheduleProbe(sawError&&probeNumber?backoff():0);};
      const openWatch=()=>{
        try{
          const old=this.watch;this.watch=null;if(old!==null)this.geo.clearWatch?.(old);
          ++this.facts.asks;watchSince=this.mono();
          this.watch=this.geo.watchPosition(watchOk,watchFail,options);
        }catch(_){ /* the one-shot requests carry on */ }
      };
      if(typeof this.geo.watchPosition==='function'){
        try{
          ++this.facts.asks;
          const watch=this.geo.watchPosition(watchOk,watchFail,options);
          if(!active()){this.geo.clearWatch?.(watch);return;}
          this.watch=watch;
          if(this.hadGrant||this.worked)scheduleProbe();
        }catch(e){
          if(e?.code===1){fail(e);return;}
          if(this.geo.getCurrentPosition)probe();
          else{this.enabled=false;this.clear();this.publish({status:'unsupported',speed:null});return;}
        }
      }else probe();
      if(permission)observePermission(permission);
      else if(deliberate&&active()&&this.permissions?.query){
        try{this.permissions.query({name:'geolocation'}).then(observePermission).catch(()=>{});}
        catch{ /* Some hosts expose this method without implementing it. */ }
      }
    }
  }
  // Why the speed is a dash, and what happens next: two short plain lines for every state without a speed.
  // Location reaches the glasses through the paired phone, whatever phone that is, so nothing here names an app.
  const NO_SPEED=Object.freeze({
    waiting:['Waiting for location','It comes from your phone'],
    // The glasses have no GPS of their own: the Meta AI app on the phone hands location over, and only while it runs.
    'no-response':['No location from your phone','Open Meta AI on your phone'],
    timeout:['No location from your phone','Open Meta AI on your phone'],
    disconnected:['No location from your phone','Open Meta AI on your phone'],
    error:['No location from your phone','Open Meta AI on your phone'],
    found:['Location found','Waiting for a newer fix'],
    stale:['No new location','Waiting for your phone'],
    unavailable:['Location found','Working out speed'],
    inaccurate:['Location too rough','Waiting for a better fix'],
    invalid:['Location not usable','Waiting for the next fix'],
    denied:['Location not allowed','Allow it for this app, then Start GPS'],
    off:['GPS is off','Press Start GPS'],
    paused:['GPS paused','It starts when Drive is open'],
    unsupported:['No location in this app','Speed cannot show here'],
  });
  // Each producer expires its own samples using both its sampling time and its
  // arrival clock. A linked reading carries no authenticated wheel/vehicle provenance.
  function display(linked,location){
    if(linked && Number.isFinite(linked.ageMs) && linked.ageMs>=0 && linked.ageMs<3500 &&
      Number.isFinite(linked.kmh) && linked.kmh>=0 && linked.kmh<=360)
      return {source:'linked',kmh:Math.round(linked.kmh),label:'Linked speed'};
    if(location?.status==='live' && Number.isFinite(location.ageMs) && location.ageMs>=0 &&
      Number.isFinite(location.speed) && location.speed>=0 && location.speed<=360 && location.ageMs<holdLimit(location.speed)) {
      // A slow speed kept past five seconds is no longer a measurement of now: it is shown as an estimate.
      const estimated=location.source==='estimated'||location.ageMs>=MAX_AGE_MS;
      return {source:estimated?'estimated':'location',kmh:Math.round(location.speed),label:estimated?'Estimated speed':'Location speed'};
    }
    if(location?.status==='standing' && Number.isFinite(location.sinceMs) && location.sinceMs>=0) {
      const next='Last location '+since(location.sinceMs)+' ago';
      return {source:'standing',kmh:0,why:'Standing still',next,label:'Standing still · last location '+since(location.sinceMs)+' ago'};
    }
    const [why,next]=NO_SPEED[location?.status==='live'?'stale':location?.status]||['Speed unavailable',''];
    return {source:'none',kmh:null,why,next,label:next?why+' · '+next[0].toLowerCase()+next.slice(1):why};
  }

  const api=Object.freeze({Feed,reading,display,NO_SPEED,FUTURE_MS,SLOW_KMH,SLOW_AGE_MS,STILL_KMH,MAX_AGE_MS,MAX_ACCURACY_M,MAX_SPEED_MPS,RESPONSE_NOTICE_MS});
  if(typeof module!=='undefined'&&module.exports)module.exports=api; else root.StudioDriveLocation=api;
})(globalThis);
;

// link-core.js
'use strict';
// Bakar Drive link v1, the glasses half: keys, sealing and checks on what the phone sends. See LINK.md.
// No network here and no DOM, so Node runs the same code in tests/link-core.test.cjs.
(function (root) {
  const SALT = 'bakar-drive v1', PAIR_LABEL = 'bakar-drive pair v1|';
  const TOPIC_RE = /^[A-Za-z0-9_-]{16,64}$/, KEY_RE = /^[A-Za-z0-9_-]{87}$/, ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
  const STATES = Object.freeze(['NoValidRoute', 'RouteBuilding', 'RouteNotStarted', 'OnRoute', 'RouteNeedsRebuild',
    'RouteFinished', 'RouteNoFollowing', 'RouteRebuilding', 'OffRoute']);
  const TURNS = Object.freeze(['NO_TURN', 'GO_STRAIGHT', 'TURN_RIGHT', 'TURN_SHARP_RIGHT', 'TURN_SLIGHT_RIGHT',
    'TURN_LEFT', 'TURN_SHARP_LEFT', 'TURN_SLIGHT_LEFT', 'U_TURN_LEFT', 'U_TURN_RIGHT', 'ENTER_ROUND_ABOUT',
    'LEAVE_ROUND_ABOUT', 'STAY_ON_ROUND_ABOUT', 'START_AT_THE_END_OF_STREET', 'REACHED_YOUR_DESTINATION',
    'EXIT_HIGHWAY_TO_LEFT', 'EXIT_HIGHWAY_TO_RIGHT']);
  const CLOCK_WINDOW_MS = 120000, MAX_TEXT = 60, MAX_DIST = 16, MAX_SECS = 360000;
  const MAX_KMH = 360;              // 100 m/s, the same ceiling as the glasses' own GPS filter
  const MAX_DOWN = 5600;            // characters in one phone → glasses payload; a sealed body is at most 4096 bytes
  const SID_SLIP_MS = 5000;         // a new sender session may start this far behind the last frame (a clock step)
  const GONE_MAX = 8;               // ended sender sessions remembered, so their frames can't come back
  const enc = (s) => new TextEncoder().encode(s);

  function fromB64url(s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
    let t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    const bin = atob(t), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toB64url(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // The address: ?t=…&p=… (or the same in the fragment). Only the shape is checked here; a key that isn't
  // a real P-256 point fails later, at import.
  function readAddress(search, hash) {
    const q = new URLSearchParams(search || '');
    for (const [k, v] of new URLSearchParams(String(hash || '').replace(/^#/, ''))) q.set(k, v);
    const t = q.get('t'), p = q.get('p');
    if (!t || !p || !TOPIC_RE.test(t) || !KEY_RE.test(p)) return null;
    try { if (fromB64url(p)[0] !== 4) return null; } catch (e) { return null; }
    return { t, p };
  }

  async function deviceId(subtle, devPub) {
    return toB64url(new Uint8Array(await subtle.digest('SHA-256', devPub))).slice(0, 16);
  }

  async function pairCode(subtle, devPub) {
    const label = enc(PAIR_LABEL), data = new Uint8Array(label.length + devPub.length);
    data.set(label, 0); data.set(devPub, label.length);
    const h = new Uint8Array(await subtle.digest('SHA-256', data));
    const n = ((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3];
    return String(n % 1000000).padStart(6, '0');
  }

  // up: glasses → phone (encrypt here), down: phone → glasses (decrypt here).
  async function deriveKeys(subtle, devPriv, phonePubRaw, t, devId, uses = { up: ['encrypt'], down: ['decrypt'] }) {
    const phone = await subtle.importKey('raw', phonePubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await subtle.deriveBits({ name: 'ECDH', public: phone }, devPriv, 256);
    const ikm = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const derive = (dir) => subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc(SALT), info: enc(`${dir}|${devId}|${t}`) },
      ikm, { name: 'AES-GCM', length: 256 }, false, uses[dir]);
    return { up: await derive('up'), down: await derive('down') };
  }

  async function seal(subtle, key, obj, iv) {
    const nonce = iv || crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, enc(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length);
    out.set(nonce, 0); out.set(ct, 12);
    return toB64url(out);
  }

  async function open(subtle, key, sealed) {
    const raw = fromB64url(sealed);
    if (raw.length < 12 + 16 + 2 || raw.length > 4096) return null;
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    const obj = JSON.parse(new TextDecoder().decode(plain));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  }

  // phone → glasses payload: "1.<sealed>". Anything else, or a failed tag, is null.
  async function openDown(subtle, key, text) {
    if (typeof text !== 'string' || text.length > MAX_DOWN) return null;
    const parts = text.trim().split('.');
    if (parts.length !== 2 || parts[0] !== '1' || !parts[1]) return null;
    try { return await open(subtle, key, parts[1]); } catch (e) { return null; }
  }

  async function sealUp(subtle, key, devPubB64, obj, iv) {
    return `1.${devPubB64}.${await seal(subtle, key, obj, iv)}`;
  }

  const clean = (s, max) => typeof s === 'string'
    ? s.replace(/[​-‏‪-‮⁠-⁩﻿]/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/[^\S ]+/g, ' ').trim().slice(0, max)
    : '';

  // The phone's own GPS speed and heading (LINK.md, "Speed and heading"): whole km/h 0 to 360 and a heading 0 to
  // 359 or null. Anything else is dropped as a whole, never repaired. It never holds a position.
  function cleanGps(g) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
    if (!Number.isSafeInteger(g.kmh) || g.kmh < 0 || g.kmh > MAX_KMH) return null;
    return { kmh: g.kmh, hdg: Number.isSafeInteger(g.hdg) && g.hdg >= 0 && g.hdg < 360 ? g.hdg : null };
  }

  // A directions frame, checked field by field. Returns {ok:false, why} or {ok:true, frame, last}.
  // last: {sid, seq, at, gone} after the newest accepted frame, or null; keep r.last for the next call.
  // hellos: the ids of this page's recent hellos. A frame must name one (re), so frames recorded before
  // the page opened can't be played back to it.
  function checkNav(m, now, last, hellos) {
    if (!m || m.m !== 'nav') return { ok: false, why: 'type' };
    if (typeof m.sid !== 'string' || !ID_RE.test(m.sid)) return { ok: false, why: 'sid' };
    if (!Number.isSafeInteger(m.seq) || m.seq < 0) return { ok: false, why: 'seq' };
    if (!Number.isFinite(m.at) || Math.abs(now - m.at) > CLOCK_WINDOW_MS) return { ok: false, why: 'clock' };
    if (typeof m.re !== 'string' || !Array.isArray(hellos) || !hellos.includes(m.re)) return { ok: false, why: 're' };
    let gone = last && Array.isArray(last.gone) ? last.gone : [];
    if (last) {
      if (m.sid === last.sid) {
        if (m.seq <= last.seq) return { ok: false, why: 'old' };
      } else {
        if (gone.includes(m.sid) || m.at < last.at - SID_SLIP_MS) return { ok: false, why: 'old' };
        gone = gone.concat(last.sid).slice(-GONE_MAX);
      }
    }
    const next = { sid: m.sid, seq: m.seq, at: m.at, gone };
    const gps = cleanGps(m.gps);   // a bad gps never costs the directions
    if (m.nav === null) return { ok: true, frame: { sid: m.sid, seq: m.seq, at: m.at, nav: null, gps }, last: next };
    const n = m.nav;
    if (!n || typeof n !== 'object' || Array.isArray(n)) return { ok: false, why: 'nav' };
    if (!STATES.includes(n.ss)) return { ok: false, why: 'state' };
    const secs = Number.isSafeInteger(n.secs) && n.secs >= 0 && n.secs <= MAX_SECS ? n.secs : null;
    const pct = Number.isFinite(n.pct) && n.pct >= 0 && n.pct <= 100 ? n.pct : null;
    const exit = Number.isSafeInteger(n.exit) && n.exit >= 0 && n.exit <= 20 ? n.exit : 0;
    return {
      ok: true,
      frame: {
        sid: m.sid, seq: m.seq, at: m.at,
        nav: {
          ss: n.ss, turn: TURNS.includes(n.turn) ? n.turn : null, exit,
          toTurn: clean(n.toTurn, MAX_DIST), left: clean(n.left, MAX_DIST),
          next: clean(n.next, MAX_TEXT), street: clean(n.street, MAX_TEXT),
          secs, pct, sim: n.sim === true,
        },
        gps,
      },
      last: next,
    };
  }

  // A pair reply always names the hello it answers (re); the page drops one that names none of its own.
  function checkPair(m) {
    if (!m || m.m !== 'pair' || typeof m.ok !== 'boolean') return null;
    if (typeof m.code !== 'string' || !/^\d{6}$/.test(m.code)) return null;
    if (typeof m.re !== 'string' || !ID_RE.test(m.re)) return null;
    return { ok: m.ok, code: m.code, re: m.re };
  }

  // What the screen should say about a route state.
  function phase(ss) {
    if (['OnRoute', 'OffRoute', 'RouteRebuilding', 'RouteNeedsRebuild'].includes(ss)) return 'guide';
    if (ss === 'RouteNotStarted') return 'ready';
    if (ss === 'RouteFinished') return 'arrived';
    if (ss === 'RouteBuilding') return 'building';
    return 'none';
  }

  const api = Object.freeze({
    SALT, PAIR_LABEL, STATES, TURNS, CLOCK_WINDOW_MS, MAX_DOWN,
    fromB64url, toB64url, readAddress, deviceId, pairCode, deriveKeys, seal, open, openDown, sealUp, checkNav,
    checkPair, phase, clean, cleanGps,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DriveLinkCore = api;
})(globalThis);
;

// speed-check.js
'use strict';
// Speed self-check for the Drive screens. No DOM and no timers here, so Node runs this same code in
// drive/tests/speed-check.test.cjs. It answers one thing: where does the speed on screen come from, and when there is
// none, is there a definite fault with nothing healthy behind it, and what is the plain line for that?
//
// A speed that is not live from a source is never shown, and this never invents one. It only explains the dash, in
// words a wearer can read at a glance, and names what backs the glasses' own location up: the phone's GPS through the
// link. It starts nothing, retries nothing and asks for no permission.
(function (root) {
  // Phone link, in the words both screens share:
  //   live / ready      the phone answered; its speed arrives by itself once the car moves
  //   waiting / connecting   still looking for the phone (or opening the link): normal for a moment, so no warning on top
  //   none              no phone set up on these glasses
  //   pairing           the phone has not accepted these glasses yet
  //   stopped           the wearer stopped the phone link in this app
  //   unavailable       this app cannot run the secure link
  //   paused            the phone was found, the glasses can reach the brokers, and the phone has gone quiet
  //   nosignal          the glasses cannot reach the brokers at all: that is the story, not the phone
  const ALL = Object.freeze(['live', 'ready', 'waiting', 'connecting', 'none', 'pairing', 'stopped', 'unavailable', 'paused', 'nosignal']);
  // With these the phone is, or is about to be, the speed source: the glasses' own location problem is noise.
  const HEALTHY = Object.freeze(['live', 'ready', 'waiting', 'connecting']);

  // What backs the glasses' own GPS up, in words. "Compare", not "accept": the wearer taps Yes on the phone only when the
  // number it asks about is the one the glasses show (the Journal's own rule), and Studio Drive already says it this way.
  function backup(link,gpsStatus) {
    switch (link) {
      case 'live': case 'ready': case 'waiting': case 'connecting': return 'phone speed once you move';
      case 'none': return gpsStatus==='denied'?'allow location for this app':
        gpsStatus==='unsupported'?'location API unavailable':
        gpsStatus==='stale'?'waiting for a new fix':'open Meta AI on your phone';   // the same words as the face (drive-location.js NO_SPEED)
      case 'pairing': return 'compare the code on your phone';
      case 'stopped': return 'resume the phone link';
      case 'unavailable': return 'phone link unavailable';
      case 'nosignal': return 'no signal to phone';
      default: return 'phone not answering';
    }
  }

  // The hard faults of the glasses' own location, by status: [the line for a whole screen, the line for the small corner].
  // These stay put until something is done or the signal comes back, so they are worth an amber line. A reading that is
  // merely rough, without a speed or unusable (inaccurate, unavailable, invalid) comes and goes by itself, often while
  // parked or just after Start, so it keeps each screen's own calm words, and so does any status this does not know.
  // The corner beside turn-by-turn directions is about 250 px wide, so its first line stays at 20 characters or fewer; the
  // second line there is always "Phone not answering" or "No signal to phone" (directions are on screen only while the link is live or paused).
  const FAULTS = Object.freeze({
    denied: ['Glasses location not allowed', 'Glasses GPS refused'],
    unsupported: ['This app gets no location', 'No GPS in this app'],
    stale: ['GPS speed lost'],
    timeout: ['No location from your phone', 'No phone location'],
    disconnected: ['No location from your phone', 'No phone location'],
  });

  // The state of Studio Drive's phone link (drive-phone.js snapshot) in the shared words.
  function fromStudio(phone) {
    if (!phone) return 'none';
    if (phone.state === 'unavailable') return 'unavailable';   // this app cannot run the secure link, paired or not: nothing to pair
    if (!phone.configured) return 'none';
    if (!phone.enabled || phone.state === 'off') return 'stopped';
    switch (phone.state) {
      case 'live': case 'ready': case 'no-sample': case 'stale': return 'live';
      case 'pairing': case 'waiting': case 'connecting': return phone.state;
      case 'offline': return 'nosignal';
      default: return 'connecting';   // paused (the Drive tab is not on screen) or a state this does not know: not a fault
    }
  }

  // The plain line for "no speed from the glasses' own location", given the phone link.
  // level: 'ok' (live) | 'wait' (nothing is wrong, or the phone is expected to supply the speed) | 'warn' (a definite
  // fault and nothing healthy behind it). text is '' unless level is 'warn': calm states keep each screen's own words.
  // short is the same two lines for the small corner (see FAULTS).
  function line(gpsStatus, link) {
    const quiet = { level: gpsStatus === 'live' ? 'ok' : 'wait', text: '', short: '' };
    if (!Object.prototype.hasOwnProperty.call(FAULTS, gpsStatus) || HEALTHY.includes(link)) return quiet;
    const fault = FAULTS[gpsStatus];
    const way = backup(link,gpsStatus);
    const then = `${way[0].toUpperCase()}${way.slice(1)}`;
    // two short lines: what is wrong, then what to do
    return { level: 'warn', text: `${fault[0]}\n${then}`, short: `${fault[1] || fault[0]}\n${then}` };
  }

  // i: { phoneFresh, gpsStatus, link }
  //   phoneFresh: the phone sent its own speed within the last few seconds
  //   gpsStatus:  the glasses' own location feed (live, denied, off, waiting, no-response, stale, ...)
  //   link:       one of ALL
  // Returns { source: 'phone' | 'glasses' | 'none', level: 'ok' | 'wait' | 'warn', text, short, code }.
  function check(i) {
    if (i.phoneFresh) return { source: 'phone', level: 'ok', text: '', short: '', code: 'phone' };
    if (i.gpsStatus === 'live') return { source: 'glasses', level: 'ok', text: '', short: '', code: 'glasses' };
    const l = line(i.gpsStatus, i.link);
    return { source: 'none', level: l.level, text: l.text, short: l.short, code: i.gpsStatus };
  }

  const api = Object.freeze({ check, line, backup, fromStudio, ALL, HEALTHY });
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SpeedCheck = api;
})(globalThis);
;

// guide.js
'use strict';
// Compass tape and saved-route guidance for the Drive screens. No timers and no network here, so Node runs this same
// code in drive/tests/guide.test.cjs. The one piece that touches the page is paintTape, which draws into an SVG it is
// handed: both Drive faces (Bakar Home's Drive tab and Bakar Drive) call it, so the compass is one piece of code.
//
// Compass: the GPS course over the ground as a sliding tape. It is the way the car is moving, not the way the wearer
// looks. There is no course below about 7 km/h (the feed leaves it out), and then there is no tape: never an old one.
//
// Guidance: the next turn along the route the PC saved (relay/route.py), worked out on the glasses from their own
// location. It is a saved route: no traffic, no rerouting. Only numbers derived from a fix are kept (how far along the
// route, how far off it), in page memory; the position itself is not stored and nothing is sent anywhere.
(function (root) {
  const POINTS = Object.freeze(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
  const FIX_MAX_AGE_MS = 5000;       // the same age limit as the speed (drive-location.js)
  const FIX_MAX_ACCURACY_M = 50;     // and the same accuracy limit
  const FUTURE_MS = 2000;            // and the same allowance for a phone clock that runs a little ahead of the glasses'
  const TRAIL_MS = 20000;            // how long fixes are kept for working out a speed: long enough for walking pace
  const LONG_MS = 12000;             // on foot a few seconds of movement is smaller than GPS scatter, so look back this far
  const SLOW_MPS = 20 / 3.6;         // under this the estimate is smoothed a little, so it does not jump between 0 and 7
  const WALK_MPS = 0.5;              // slower than this is standing: no course
  const SLOW_COURSE_MS = 12000;      // on foot the course between fixes is kept this long (12 m takes a walker about 9 s)
  const ROUTE_MAX_AGE_S = 18 * 3600; // a route saved for an earlier day does not start guiding by itself
  const OFF_BASE_M = 70;             // road width, GPS scatter and the thinned outline together
  const OFF_FIXES = 3;               // this many fixes in a row off the line before the screen says so
  const GIVE_UP_M = 2500;            // this far off, or
  const GIVE_UP_MS = 5 * 60 * 1000;  // this long off: the wearer is going somewhere else, so guidance stops quietly
  const ARRIVE_M = 40;
  const JOIN_FIXES = 3;              // this many fixes in a row on the line and going its way before guidance starts
  const WITH_DEG = 60;               // "going its way": the GPS course within this of the road's direction there
  const AGAINST_DEG = 120;           // and this far from it is going the other way
  const AGAINST_FIXES = 3;           // that many in a row: the wearer is on the way back, so guidance stops
  const ARRIVED_SHOW_MS = 2 * 60 * 1000;   // "Arrived" is said for this long, or
  const ARRIVED_LEAVE_M = 150;       // until the wearer is this far from the end
  const PASSED_M = 15;               // a turn this close behind or ahead counts as being made now
  const LOOK_BACK_M = 200, LOOK_AHEAD_M = 2000;   // where the next fix is expected, so a route that crosses itself keeps its place

  const finite = Number.isFinite;
  const norm = (deg) => ((deg % 360) + 360) % 360;

  // What the tape draws for a course: ticks every 15 degrees inside the window, placed from -1 (left edge) to 1 (right
  // edge), with a letter on the eight compass points. Null when there is no usable course.
  function tape(course, halfSpan = 50) {
    if (!finite(course) || course < 0 || course >= 360) return null;
    const ticks = [];
    const first = Math.ceil((course - halfSpan) / 15) * 15;
    for (let d = first; d <= course + halfSpan; d += 15) {
      const at = norm(d);
      ticks.push({ x: (d - course) / halfSpan, label: at % 45 === 0 ? POINTS[at / 45] : '', major: at % 45 === 0, north: at === 0 });
    }
    const shown = Math.round(course) % 360;
    const point = POINTS[Math.round(course / 45) % 8];
    return { deg: shown, text: String(shown).padStart(3, '0') + '°', point, readout: `${point} ${String(shown).padStart(3, '0')}°`, ticks };
  }

  // Draws the tape into an <svg viewBox="-160 0 320 44">, or hides it (keeping its room) when there is no course. Redraws
  // only when the course moved half a degree. Styling is drive/tape.css, shared by both faces.
  const painted = new WeakMap();
  function paintTape(svg, course) {
    if (!svg || !svg.style) return;
    const t = tape(finite(course) ? course : NaN), key = t ? String(Math.round(course * 2) / 2) : '';
    svg.style.visibility = t ? 'visible' : 'hidden';
    svg.setAttribute('aria-label', t ? `Compass: heading ${t.point}, ${t.deg} degrees` : 'Compass: no heading while stopped');
    if (painted.get(svg) === key) return;
    painted.set(svg, key); svg.textContent = '';
    if (!t) return;
    const make = (name, attrs, text) => { const n = (svg.ownerDocument || document).createElementNS('http://www.w3.org/2000/svg', name); for (const k in attrs) n.setAttribute(k, attrs[k]); if (text) n.textContent = text; svg.append(n); };
    for (const k of t.ticks) {
      const x = (k.x * 150).toFixed(1), fade = k.north ? 1 : (1 - Math.abs(k.x) * .35).toFixed(2);   // the edges dim a little; north never does
      make('line', { x1: x, x2: x, y1: 9, y2: k.major ? 19 : 15, class: k.north ? 'major north' : k.major ? 'major' : '', opacity: fade });
      if (k.label && Math.abs(k.x) > .36) make('text', { x, y: 40, class: k.north ? 'north' : '', opacity: fade }, k.label);   // the middle belongs to the readout
    }
    make('path', { d: 'M-6 0H6L0 8Z', class: 'needle' });
    make('text', { x: 0, y: 41, class: 'readout' }, t.readout);
  }

  // Metres on the ground between two latitude/longitude pairs, flat-earth around the first: exact enough for the few
  // kilometres this is used over.
  function flat(lat0, lon0, lat, lon) {
    return [(lon - lon0) * Math.cos(lat0 * Math.PI / 180) * 111320, (lat - lat0) * 110540];
  }

  // Words cut to a length without cutting inside a word: "Rd 124" must never become "Rd 12". The cut is marked.
  function clip(text, max) {
    if (text.length <= max) return text;
    const cut = text.slice(0, max + 1), space = cut.lastIndexOf(' ');
    return (space > max / 2 ? cut.slice(0, space) : text.slice(0, max)).replace(/[\s·,]+$/, '') + '…';
  }

  // A route from the PC, checked. `gl` is the outline as [latitude, longitude] pairs; `gs` the turns as
  // [metres from the start, words]. Anything malformed gives null and the screen simply has no guidance.
  function prepare(route, nowS) {
    if (!route || typeof route.id !== 'string' || !Array.isArray(route.gl) || !Array.isArray(route.gs)) return null;
    if (route.gl.length < 2 || route.gl.length > 2000 || route.gs.length > 400) return null;
    if (finite(nowS) && (!finite(route.at) || nowS - route.at > ROUTE_MAX_AGE_S || route.at - nowS > 600)) return null;
    const line = [];
    let total = 0;
    for (let i = 0; i < route.gl.length; i++) {
      const p = route.gl[i];
      if (!Array.isArray(p) || !finite(p[0]) || !finite(p[1]) || Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180) return null;
      if (i) { const [dx, dy] = flat(line[i - 1].lat, line[i - 1].lon, p[0], p[1]); total += Math.hypot(dx, dy); }
      line.push({ lat: p[0], lon: p[1], s: total });
    }
    if (!(total > 0)) return null;
    // The PC measures turns along the full road; the outline here is thinned, so slightly shorter. Scale to match.
    const said = finite(route.gm) && route.gm > 0 ? route.gm : total;
    const steps = [];
    for (const g of route.gs) {
      if (!Array.isArray(g) || !finite(g[0]) || g[0] < 0 || typeof g[1] !== 'string') return null;
      steps.push({ s: Math.min(total, g[0] * total / said), t: clip(g[1], 80) });
    }
    steps.sort((a, b) => a.s - b.s);
    return { id: route.id, ti: typeof route.ti === 'string' ? route.ti.slice(0, 40) : '', line, total, steps };
  }

  // Where a fix sits on the outline: metres along it and metres away from it. `near` (metres along) keeps the answer
  // close to where the last fix was when the route passes the same place twice.
  function project(r, lat, lon, near, heading, limit) {
    let best = null, local = null, agree = null;
    for (let i = 1; i < r.line.length; i++) {
      const a = r.line[i - 1], b = r.line[i];
      const [ax, ay] = flat(lat, lon, a.lat, a.lon), [bx, by] = flat(lat, lon, b.lat, b.lon);
      const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2)) : 0;
      const hit = { s: a.s + t * (b.s - a.s), away: Math.hypot(ax + t * vx, ay + t * vy), bearing: norm(Math.atan2(vx, vy) * 180 / Math.PI) };
      if (!best || hit.away < best.away) best = hit;
      if (finite(near) && hit.s >= near - LOOK_BACK_M && hit.s <= near + LOOK_AHEAD_M && (!local || hit.away < local.away)) local = hit;
      // On the line here and running the way the car moves: the leg the car is really on. Where two legs share a road
      // (out and back), the one nearest ahead of the last place wins.
      if (finite(heading) && hit.away <= limit && Math.abs(((heading - hit.bearing + 540) % 360) - 180) <= WITH_DEG) {
        const gap = finite(near) ? (hit.s >= near - LOOK_BACK_M ? hit.s - near : Infinity) : hit.away;
        if (gap !== Infinity && (!agree || gap < agree.gap)) agree = { ...hit, gap };
      }
    }
    return { best, local, agree };
  }

  class Guide {
    constructor({ now = Date.now } = {}) { this.now = now; this.route = null; this.anchor = null; this.moved = null; this.trail = []; this.reset(); }
    clearMotion() { this.trail=[];this.anchor=null;this.moved=null;this.rest=null;this.est=null;this.miss=0; }
    // The way the car is moving, for a runtime whose location gives no heading: the bearing between two fixes at least
    // 12 m apart (more when the fix is rough). The earlier fix is held in page memory for this only and replaced as the car
    // moves; a reported heading always wins. Nothing here needs a route.
    track(c, at) {
      // A few seconds of fixes, for a speed where the device reports none (see estimate). Page memory only.
      const before = this.trail[this.trail.length - 1];
      this.trail = this.trail.filter((p) => at - p.at <= TRAIL_MS && at > p.at);
      // Fixes went quiet for longer than the trail keeps: the last one stays, to tell standing still from having moved.
      if (!this.trail.length && before) this.rest = before;
      this.trail.push({ lat: c.latitude, lon: c.longitude, at, acc: c.accuracy });
      const a = this.anchor;
      if (a && at - a.at <= 30000 && at >= a.at) {
        const [dx, dy] = flat(a.lat, a.lon, c.latitude, c.longitude), far = Math.hypot(dx, dy);
        if (far < Math.max(12, c.accuracy)) return;
        if (far < 400) this.moved = { deg: norm(Math.atan2(dx, dy) * 180 / Math.PI), at, slow: far / Math.max(1, (at - a.at) / 1000) < SLOW_MPS };
      }
      this.anchor = { lat: c.latitude, lon: c.longitude, at };
    }
    // Ground speed in metres a second from the last few fixes, for a runtime whose location reports no speed: the distance
    // from a fix 1.5 to 6 seconds back (up to 12 seconds for sparse one-shot callbacks), over the time between. Movement smaller than the fixes' own scatter counts as
    // standing still. Null until there are two usable fixes. An estimate from positions, labelled as GPS on screen.
    // Walking and running (15 Nov 2026): a few seconds of walking is smaller than the scatter of the fixes, so two fixes
    // cannot tell it from standing. Under 20 km/h the speed is the slope of a straight line fitted through the last 12
    // seconds of fixes, which averages the scatter out. It counts only when the last 6 seconds show movement too: a car that
    // has just stopped, or a walker who has, is standing still, not a leftover speed. Moving estimates under 20 km/h are
    // blended a little with the one before. After fixes went quiet for longer than the trail, the last fix before the gap
    // tells standing still (0) from having moved (no number: the next fix gives one).
    estimate() {
      const t = this.trail, last = t[t.length - 1];
      if (!last || this.now() - last.at >= FIX_MAX_AGE_MS) return null;
      if (this.est && this.est.at === last.at) return this.est.out;
      const gap = (p) => last.at - p.at, scatter = (p) => Math.max(p.acc, last.acc);
      const far = (p) => { const [dx, dy] = flat(p.lat, p.lon, last.lat, last.lon); return Math.hypot(dx, dy); };
      const back = (ms) => { for (let i = t.length - 2; i >= 0; i--) if (gap(t[i]) >= ms) return t[i]; return null; };
      // Metres a second and metres covered, from a line fitted through the fixes of the last `ms`; null with too few of them.
      const fit = (ms, least) => {
        const pts = t.filter((p) => gap(p) <= ms), span = pts.length ? gap(pts[0]) / 1000 : 0;
        if (pts.length < 2 || span < least) return null;
        const xy = pts.map((p) => flat(last.lat, last.lon, p.lat, p.lon)), ts = pts.map((p) => -gap(p) / 1000);
        const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, tm = mean(ts), xm = mean(xy.map((q) => q[0])), ym = mean(xy.map((q) => q[1]));
        let stt = 0, stx = 0, sty = 0;
        ts.forEach((v, k) => { stt += (v - tm) ** 2; stx += (v - tm) * (xy[k][0] - xm); sty += (v - tm) * (xy[k][1] - ym); });
        const speed = Math.hypot(stx / stt, sty / stt);
        return { speed, span, moved: speed * span, acc: Math.max(...pts.map((p) => p.acc)) };
      };
      const near = t.find((p) => gap(p) >= 1500 && gap(p) <= 6000) || back(1500);
      let speed = null, fitted = false;
      if (near) {
        let two = far(near) >= Math.max(5, 0.6 * scatter(near)) ? far(near) / (gap(near) / 1000) : 0;
        // Pulling away, the last two seconds say more than the last six: a clear difference there wins.
        const quick = back(1500);
        if (quick && quick !== near) {
          const q = far(quick) >= Math.max(20, 2 * scatter(quick)) ? far(quick) / (gap(quick) / 1000) : 0;   // 20 m in two seconds: a car
          if (q > 0 && Math.abs(q - two) > 0.3 * Math.max(q, two)) two = q;
        }
        const whole = fit(LONG_MS, 6), recent = fit(LONG_MS / 2, 3);
        if (two >= SLOW_MPS || !whole || !recent) speed = two;          // a car, or too few fixes for a line: two fixes, as before
        else {
          const steady = whole.moved >= Math.max(6, 0.5 * whole.acc), lately = recent.moved >= Math.max(4, 0.4 * recent.acc);
          // One doubtful look at the last few seconds does not drop a walker to 0: the third in a row does.
          this.miss = steady && !lately ? (this.miss || 0) + 1 : 0;
          speed = steady && (lately || (this.miss < 3 && this.est && this.est.fitted)) ? whole.speed : 0;
          fitted = speed > 0;
        }
        // Braking hard or stopped: anything faster than a walk must show in the last four seconds too. If they show less
        // than half of it, they alone are the speed, and 0 once they show no movement beyond the scatter.
        const brief = fit(4000, 2);
        if (speed >= 2.5 && brief && brief.moved < 0.5 * speed * brief.span) { speed = brief.moved >= Math.max(5, 0.6 * brief.acc) ? brief.speed : 0; fitted = false; }
      } else if (this.rest && gap(this.rest) >= 1500 && far(this.rest) < Math.max(8, 0.75 * scatter(this.rest))) speed = 0;
      if (speed === null) return null;
      const prev = this.est;
      // Standing still is said at once; only one moving estimate after another is blended.
      if (prev && last.at - prev.at <= 12000 && speed > 0 && speed < SLOW_MPS && prev.speed > 0 && prev.speed < SLOW_MPS) speed = 0.6 * speed + 0.4 * prev.speed;
      const out = { speed, heading: speed >= 2 ? this.course() : null };
      this.est = { at: last.at, speed, out, fitted };
      return out;
    }
    // The fix as the speed feed should see it: unchanged when the device reports a speed, otherwise with the estimate
    // filled in. Never a made-up number: with no estimate the fix goes through as it came.
    fill(position) {
      const c = position && position.coords;
      if (!c || (finite(c.speed) && c.speed >= 0)) return position;
      const e = this.estimate();
      if (!e || !finite(e.speed) || this.trail.length === 0 || this.trail[this.trail.length - 1].at !== position.timestamp) {
        if(c.speed!==-1)return position;
        return {timestamp:position.timestamp,coords:{latitude:c.latitude,longitude:c.longitude,accuracy:c.accuracy,speed:null,heading:null}};
      }
      return { timestamp: position.timestamp, coords: { latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy, speed: e.speed, heading: e.heading } };
    }
    // The course to show or steer by right now, or null: reported by the device, else worked out from movement, and
    // never older than the speed's own limit.
    course(c) {
      if (c && finite(c.heading) && c.heading >= 0 && c.heading < 360 && finite(c.speed) && c.speed >= 2) return c.heading;
      if (c && finite(c.speed) && c.speed >= 0 && c.speed < WALK_MPS) return null;            // the device says stopped
      // At walking pace a reported heading is noise, so the bearing between fixes is used, and kept longer than in a car.
      const m = this.moved;
      return m && this.now() - m.at < (m.slow ? SLOW_COURSE_MS : FIX_MAX_AGE_MS) && this.now() >= m.at - FUTURE_MS ? m.deg : null;
    }
    reset() { this.joined = false; this.s = null; this.away = null; this.at = 0; this.offCount = 0; this.offSince = 0; this.done = false; this.doneAt = 0;
      this.onCount = 0; this.againstCount = 0; }
    // Stop for good on this route: arrived and left, or driving it backwards. A new route starts fresh.
    end() { this.reset(); this.over = true; }
    // Give it the snapshot's route (or nothing). The same route again changes nothing, so a repaint does not lose the place.
    setRoute(route) {
      const id = route && route.id;
      if (this.route && id === this.route.id) return;
      this.route = prepare(route, this.now() / 1000);
      this.savedAt = this.route ? route.at : 0;
      this.reset(); this.over = false;
    }
    // One location fix, straight from the browser. Only numbers derived from it are kept.
    fix(position) {
      const r = this.route, c = position && position.coords, at = position && position.timestamp, now = this.now();
      if (!c || !finite(at) || at > now + FUTURE_MS || now - at >= FIX_MAX_AGE_MS) return;
      if (!finite(c.latitude) || !finite(c.longitude) || !finite(c.accuracy) || c.accuracy < 0 || c.accuracy > FIX_MAX_ACCURACY_M) return;
      if(Math.abs(c.latitude)>90||Math.abs(c.longitude)>180)return;
      const previous=this.trail[this.trail.length-1];
      if(previous&&at<=previous.at)return;
      this.track(c, at);
      if (!r || this.over) return;
      const limit = OFF_BASE_M + c.accuracy;
      // The way the car is moving. No course (slow or stopped) says nothing either way.
      const heading = this.course(c), moving = heading !== null;
      const { best, local, agree } = project(r, c.latitude, c.longitude, this.joined ? this.s : NaN, moving ? heading : NaN, limit);
      const hit = agree || (local && local.away <= limit ? local : best);
      if (this.done) {                                // arrived: said for a while, gone once the wearer leaves
        const end = r.line[r.line.length - 1], [ex, ey] = flat(c.latitude, c.longitude, end.lat, end.lon);
        if (Math.hypot(ex, ey) > ARRIVED_LEAVE_M) this.end();
        return;
      }
      const turn = moving ? Math.abs(((heading - hit.bearing + 540) % 360) - 180) : NaN;
      if (!this.joined) {
        // Not guiding yet. Crossing the route, or driving it the other way, must not start it: only several fixes in a
        // row on the line and going its way do.
        if (hit.away > limit || !(turn <= WITH_DEG)) { this.onCount = 0; return; }
        if (++this.onCount < JOIN_FIXES) return;
        this.joined = true;
      }
      if (hit.away <= limit && turn >= AGAINST_DEG) { if (++this.againstCount >= AGAINST_FIXES) { this.end(); return; } }
      else if (moving) this.againstCount = 0;
      this.at = at; this.away = hit.away;
      if (hit.away <= limit) { this.s = hit.s; this.offCount = 0; this.offSince = 0; }
      else {
        if (!this.offCount++) this.offSince = now;
        if (hit.away > GIVE_UP_M || now - this.offSince > GIVE_UP_MS) { this.reset(); return; }
      }
      if (r.total - this.s <= ARRIVE_M && hit.away <= limit) { this.done = true; this.doneAt = now; }
    }
    // What the screen may say right now. `state`: none (no usable route, or not on it), paused (on it, but the last fix
    // is too old to point anywhere), on, off, arrived.
    snapshot() {
      const r = this.route;
      if (!r || !this.joined || this.over) return { state: 'none' };
      if (this.now() / 1000 - this.savedAt > ROUTE_MAX_AGE_S) return { state: 'none' };      // the route has gone old while open
      if (this.done) return this.now() - this.doneAt < ARRIVED_SHOW_MS ? { state: 'arrived', title: r.ti } : { state: 'none' };
      if (this.now() - this.at >= FIX_MAX_AGE_MS || this.now() < this.at - FUTURE_MS) return { state: 'paused', title: r.ti };
      if (this.offCount >= OFF_FIXES) return { state: 'off', title: r.ti, away: this.away };
      const next = r.steps.find((st) => st.s > this.s + PASSED_M) || null;
      const last = !next || next.t === 'Arrive';      // the PC's last turn is the arrival
      return { state: 'on', title: r.ti, left: r.total - this.s, toTurn: next ? next.s - this.s : r.total - this.s,
        turn: last ? (r.ti ? `Arrive at ${r.ti}` : 'Destination') : next.t.replace(' onto ', ' · ') };
    }
  }

  // Distances as a driver reads them: 10 m steps under 200 m, 50 m steps under a kilometre, then kilometres.
  function metres(m) {
    if (!finite(m) || m < 0) return '';
    if (m < 195) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
    if (m < 975) return `${Math.round(m / 50) * 50} m`;
    if (m < 9950) return `${(m / 1000).toFixed(1)} km`;
    return `${Math.round(m / 1000)} km`;
  }

  // The two short lines for the screen: the turn, and under it what this guidance is.
  function words(snap) {
    switch (snap && snap.state) {
      // "not live": this route was worked out earlier. It knows nothing of traffic and does not reroute.
      case 'on': return { dist: metres(snap.toTurn), near: snap.toTurn < 300, turn: `${metres(snap.toTurn)} · ${snap.turn}`, note: `Saved route · not live · ${metres(snap.left)} to go`, level: 'ok' };
      case 'off': return { dist: '', near: false, turn: 'Off the saved route', note: `${metres(snap.away)} from it · no rerouting`, level: 'warn' };
      case 'paused': return { dist: '', near: false, turn: 'Saved route paused', note: 'Waiting for location', level: 'ok' };
      case 'arrived': return { dist: '', near: false, turn: snap.title ? `Arrived · ${snap.title}` : 'Arrived', note: '', level: 'ok' };
      default: return { dist: '', near: false, turn: '', note: '', level: 'ok' };
    }
  }

  const api = Object.freeze({ tape, paintTape, prepare, project, clip, Guide, metres, words, POINTS,
    FIX_MAX_AGE_MS, FIX_MAX_ACCURACY_M, ROUTE_MAX_AGE_S, OFF_BASE_M, OFF_FIXES, GIVE_UP_M, GIVE_UP_MS, ARRIVE_M,
    JOIN_FIXES, AGAINST_FIXES, ARRIVED_SHOW_MS, ARRIVED_LEAVE_M });
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DriveGuide = api;
})(globalThis);
;

// cameras.js
'use strict';
// Fixed-camera warning for the Drive screens: a red light or speed camera on the road ahead, and how far. No DOM, no
// timers and no network here, so Node runs this same code in drive/tests/cameras.test.cjs.
//
// The list is public data built by tools/build-cameras.cjs (drive/cameras.json): Toronto's own red light cameras and
// the cameras mapped in OpenStreetMap for Canada. It is fixed sites only. It knows nothing about mobile radar, police
// or temporary cameras, and a camera nobody mapped is not in it: a quiet screen is not a promise.
//
// Everything is worked out on the glasses from their own location. Only the camera being warned about and the last
// distance to it are kept, in page memory; the position is not stored and nothing is sent.
(function (root) {
  const FIX_MAX_AGE_MS = 5000, FIX_MAX_ACCURACY_M = 50;   // the same limits as the speed (drive-location.js)
  const FUTURE_MS = 2000;           // and the same allowance for a phone clock that runs a little ahead
  const LOOK_S = 25;                // warn this many seconds ahead at the current speed,
  const NEAR_M = 400, FAR_M = 1000; // but never nearer than this or farther than that
  const LANE_M = 60;                // how far to the side of the line of travel still counts as this road
  const PASSED_M = 25;              // a camera this close, not already being warned about, is too late to start on
  const BEHIND_M = 15;              // the camera being warned about stays until it is this far behind: through the stop line and the junction
  const ACCURACY_CAP_M = 15;        // how much of the fix's own doubt may widen the lane
  const MOTORWAY_MPS = 70 / 3.6;    // a camera marked as beside a motorway warns only below this speed: it is on the street, not the motorway
  const OLD_DAYS = 14, STALE_DAYS = 30;   // the list's age: said in details after the first, on the Drive face after the second
  const HOLD_M = 40;                // stopped, or no course: keep the warning unless the camera is this much farther than it was
  const CELL = 0.02;                // grid cell in degrees (about 2 km), for a quick look-up
  const KINDS = Object.freeze({ r: 'Red light camera', s: 'Speed camera' });

  const finite = Number.isFinite;
  const cell = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;

  // The list from drive/cameras.json, checked and put on a grid. Anything malformed gives an empty, harmless index.
  function index(file) {
    const grid = new Map();
    let count = 0;
    const items = file && Array.isArray(file.items) ? file.items : [];
    for (const it of items) {
      if (!Array.isArray(it) || !finite(it[0]) || !finite(it[1]) || Math.abs(it[0]) > 90 || Math.abs(it[1]) > 180 || !KINDS[it[2]]) continue;
      const cam = { lat: it[0], lon: it[1], kind: it[2], limit: finite(it[3]) && it[3] >= 10 && it[3] <= 150 ? it[3] : 0,
        motorway: it[4] === 1 && it[2] === 'r', street: typeof it[5] === 'string' ? it[5].slice(0, 18) : '' };
      const key = cell(cam.lat, cam.lon);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(cam); count++;
    }
    const made = file && typeof file.made === 'string' && /^\d{4}-\d{2}-\d{2}/.test(file.made) ? file.made.slice(0, 10) : '';
    return { grid, count, made, region: file && typeof file.region === 'string' ? file.region.slice(0, 24) : '',
      redLightOnly: file && Array.isArray(file.redLightOnly) ? file.redLightOnly.filter((x) => typeof x === 'string').slice(0, 6) : [] };
  }

  // The cameras in the cells around a place.
  function around(ix, lat, lon) {
    const out = [], a = Math.floor(lat / CELL), b = Math.floor(lon / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const list = ix.grid.get(`${a + i}:${b + j}`); if (list) out.push(...list); }
    return out;
  }

  // A camera seen from a place and a course: metres to it, metres ahead along the line of travel, metres to the side.
  function seen(lat, lon, course, cam) {
    const dx = (cam.lon - lon) * Math.cos(lat * Math.PI / 180) * 111320, dy = (cam.lat - lat) * 110540;
    const dist = Math.hypot(dx, dy);
    if (!finite(course)) return { dist, ahead: NaN, side: NaN };
    const c = course * Math.PI / 180, ahead = dx * Math.sin(c) + dy * Math.cos(c);
    return { dist, ahead, side: Math.abs(dx * Math.cos(c) - dy * Math.sin(c)) };
  }

  class Watch {
    constructor({ now = Date.now } = {}) { this.now = now; this.ix = index(null); this.target = null; this.dist = NaN; this.at = 0; }
    load(file) { this.ix = index(file); this.target = null; }
    get count() { return this.ix.count; }
    get made() { return this.ix.made; }
    // How many whole days old the list is, or null when it has no date.
    ageDays() { const t = Date.parse(this.ix.made + 'T00:00:00Z'); return this.ix.made && finite(t) ? Math.max(0, Math.floor((this.now() - t) / 86400000)) : null; }
    // What the list covers, for the details panel, and the one line for the Drive face once it is too old to trust quietly.
    about() {
      if (!this.ix.count) return 'Cameras: list not loaded';
      const age = this.ageDays(), only = this.ix.redLightOnly;
      return `Cameras: ${this.ix.count} fixed sites, ${this.ix.region || 'region unknown'} only` + (only.length ? `. ${only.join(' and ')}: red light cameras only` : '') +
        `. List of ${this.ix.made || 'unknown date'}` + (age !== null && age > OLD_DAYS ? `, ${age} days old` : '') + '. No mobile radar or police.';
    }
    // What a Drive face must admit about the list, or '': it could not be loaded, or it is more than 30 days old.
    faceNote(failed) { return failed && !this.ix.count ? 'no camera list' : this.staleNote().replace(/^C/, 'c'); }
    staleNote() { const age = this.ageDays(); return this.ix.count && age !== null && age > STALE_DAYS ? `Camera list ${age} days old` : ''; }
    // One location fix, with the course of travel in degrees (or null: stopped, or unknown) and the speed in metres a second.
    fix(position, course, speed) {
      const c = position && position.coords, at = position && position.timestamp, now = this.now();
      if (!c || !finite(at) || at > now + FUTURE_MS || now - at >= FIX_MAX_AGE_MS) return;
      if (!finite(c.latitude) || !finite(c.longitude) || !finite(c.accuracy) || c.accuracy < 0 || c.accuracy > FIX_MAX_ACCURACY_M) return;
      this.at = at;
      if (!finite(course)) {
        // Stopped at the light, or no course yet: the camera already warned about stays while it is not falling behind.
        if (!this.target) return;
        const d = seen(c.latitude, c.longitude, NaN, this.target).dist;
        if (d > this.dist + HOLD_M) this.target = null; else this.dist = Math.min(this.dist, d), this.shown = d;
        return;
      }
      const reach = Math.max(NEAR_M, Math.min(FAR_M, (finite(speed) && speed > 0 ? speed : 0) * LOOK_S));
      const lane = LANE_M + Math.min(ACCURACY_CAP_M, c.accuracy);
      // A camera marked as beside a motorway is on the street next to it or under it. At motorway speed the car is on the motorway.
      const onStreet = (cam) => !cam.motorway || !(speed >= MOTORWAY_MPS);
      let best = null;
      for (const cam of around(this.ix, c.latitude, c.longitude)) {
        const s = seen(c.latitude, c.longitude, course, cam);
        // Ahead on this road: in front, within reach, and no farther to the side than a road is wide (plus a little of the
        // fix's own doubt). The camera already being warned about is followed through the stop line and the junction until
        // it is behind; a new one must still be properly ahead. The nearest that qualifies is the one shown, so a nearer
        // camera takes over and turning off the road drops the old one.
        const held = cam === this.target;
        if (s.ahead <= (held ? -BEHIND_M : PASSED_M) || s.dist > (held ? Math.max(reach, this.dist + HOLD_M) : reach) || s.side > lane || !onStreet(cam)) continue;
        if (!best || s.dist < best.dist) best = { cam, dist: s.dist };
      }
      this.target = best ? best.cam : null;
      this.dist = this.shown = best ? best.dist : NaN;
    }
    // What the screen may say right now: null, or the kind, the distance and the posted limit when the map has one.
    snapshot() {
      if (!this.target || this.now() - this.at >= FIX_MAX_AGE_MS || this.now() < this.at - FUTURE_MS) return null;
      return { kind: this.target.kind, dist: this.shown, limit: this.target.limit, street: this.target.motorway ? this.target.street : '' };
    }
  }

  // Distance as a driver reads it, in 50 m steps (10 m steps under 200 m).
  function metres(m) {
    if (!finite(m) || m < 0) return '';
    if (m < 195) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
    return m < 975 ? `${Math.round(m / 50) * 50} m` : `${(m / 1000).toFixed(1)} km`;
  }

  // The one line for the screen. `over` is true when it is a speed camera with a known limit and the speed shown is above it.
  function words(snap, kmh) {
    if (!snap) return null;
    const limit = snap.kind === 's' && snap.limit ? snap.limit : 0;
    // Beside a motorway the street is named, so a driver on the other road knows it is not theirs.
    return { text: `${KINDS[snap.kind]}${snap.street ? ` on ${snap.street}` : ''}${limit ? ` · limit ${limit}` : ''} · ${metres(snap.dist)}`, kind: snap.kind, limit,
      over: Boolean(limit && finite(kmh) && Math.round(kmh) > limit) };
  }

  const api = Object.freeze({ index, around, seen, Watch, metres, words, KINDS, FIX_MAX_AGE_MS, NEAR_M, FAR_M, LANE_M, LOOK_S, PASSED_M, BEHIND_M, HOLD_M, ACCURACY_CAP_M, MOTORWAY_MPS, OLD_DAYS, STALE_DAYS });
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DriveCameras = api;
})(globalThis);
;

// app.js
'use strict';
const APP_BUILD = 50; // Identity of this executing entry script, including offline launches.
// Bakar Drive on the glasses.
//
// Three sources, all optional:
// - Phone GPS, through the glasses' web runtime (../drive-location.js, shared with Bakar Home's Drive tab): speed and
//   heading. Nothing about the position is kept or sent.
// - Bakar Drive on the phone: the next turn, the next street and the arrival time, sent encrypted by the phone's
//   glasses link (LINK.md). It needs the address the phone app gives (?t=…&p=…). Without it the page runs on GPS alone.
// - The same link also carries the phone's own GPS speed and heading (LINK.md, "Speed and heading"). While it is fresh
//   it is the speed on screen, so the speedometer works even when the glasses' own location is not allowed.
//
// Battery: nothing runs while the page is hidden. On screen, one connection per broker, a hello every 20 s, and the
// screen repaints only when something changes (and once a minute for the clock).

const BROKERS = [
  { url: 'wss://broker.emqx.io:8084/mqtt' },
  { url: 'wss://broker.hivemq.com:8884/mqtt' },
  { url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public' },
];
const HELLO_MS = 20000;
const FRAME_FRESH_MS = 4000;      // a turn older than this dims and the top line says directions are paused
const FRAME_DROP_MS = 30000;      // a turn older than this is taken off the screen
const PHONE_WAIT_MS = 8000;       // linked to a broker but nothing from the phone for this long
const CONTROLS_MS = 8000;
const HEADING_MIN_MPS = 2;        // GPS course is noise below about 7 km/h
const PHONE_GPS_FRESH_MS = 3500;  // the phone sends its speed about once a second while it has a reading under 3 s old
const LIGHTS = ['auto', 'day', 'dusk', 'night'];
const L = DriveLinkCore;
const SC = typeof SpeedCheck !== 'undefined' ? SpeedCheck : null;   // the speed self-check; the page still runs without it
const $ = (id) => document.getElementById(id);
const subtle = window.crypto && crypto.subtle;

const S = {
  addr: null, devId: '', devPubB64: '', code: '', keys: null,
  links: [], linkId: '', mqttTries: 0, mqttLoading: false, recent: [], hellos: [], helloTimer: 0, waitTimer: 0,
  // net: the brokers (none = no phone link set up). phone: what the phone last said. Kept apart, so a dropped
  // connection never hides what the phone said a moment ago, and an old turn still goes stale on time.
  net: 'none', phone: 'unknown', heardAt: 0, last: null, frame: null, frameAt: 0, staleTimers: [],
  heading: null, headingAt: 0, trip: { ms: 0, m: 0, lastAt: 0 }, gps: { status: 'off' }, phoneGps: null, phoneGpsAt: 0, phoneGpsSentAt: 0, phoneGpsAge: 0,
  controlsTimer: 0, panel: false, openedAt: 0, upAt: 0, offer: null, shown: null,   // upAt: when the brokers last came up; shown: what the speed self-check said last
  setup: false,   // the saved phone link has been read (found or not): until then nothing is known about the phone
};

// ---- small things ----------------------------------------------------------------------------------

function local(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (e) { /* storage can be off; the page still works for this visit */ }
  return null;
}

function clockText(when) {
  return when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('bakar-drive', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction('keys').objectStore('keys').get(k);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(k, v) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('keys', 'readwrite');
    t.objectStore('keys').put(v, k);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ---- turn arrows: drawn for a right-hand turn, mirrored for left ------------------------------------

const HEAD = (x, y, deg) => `<path class="head" transform="translate(${x} ${y}) rotate(${deg})" d="M0 -15 L14 6 L-14 6 Z"/>`;
const GLYPHS = {
  straight: () => `<path class="way" d="M50 90 V30"/>${HEAD(50, 22, 0)}`,
  slight: () => `<path class="road" d="M44 90 V12"/><path class="way" d="M44 90 V62 Q44 50 52 42 L64 30"/>${HEAD(70, 24, 45)}`,
  turn: () => `<path class="road" d="M38 90 V12"/><path class="way" d="M38 90 V52 Q38 40 50 40 H72"/>${HEAD(80, 40, 90)}`,
  sharp: () => `<path class="road" d="M34 90 V12"/><path class="way" d="M34 90 V36 Q34 24 44 30 L66 54"/>${HEAD(72, 61, 135)}`,
  uturn: () => `<path class="way" d="M64 90 V44 Q64 22 46 22 Q28 22 28 44 V60"/>${HEAD(28, 68, 180)}`,
  exit: () => `<path class="road" d="M40 90 V12"/><path class="way" d="M40 90 V66 Q40 52 54 42 L66 34"/>${HEAD(72, 29, 55)}`,
  round: (n) => `<circle class="ring" cx="50" cy="44" r="18"/><path class="way" d="M50 90 V62"/><path class="way" d="M63 31 L72 20"/>${HEAD(76, 15, 40)}${n ? `<text class="num" x="50" y="44">${n}</text>` : ''}`,
  finish: () => `<path class="way" d="M34 90 V16"/><path class="head" d="M34 16 H76 L66 30 L76 44 H34 Z"/>`,
  start: () => `<path class="road" d="M18 30 H82"/><path class="way" d="M50 90 V44"/>${HEAD(50, 36, 0)}`,
};
const TURN_GLYPH = {
  NO_TURN: ['straight'], GO_STRAIGHT: ['straight'],
  TURN_RIGHT: ['turn'], TURN_LEFT: ['turn', true],
  TURN_SLIGHT_RIGHT: ['slight'], TURN_SLIGHT_LEFT: ['slight', true],
  TURN_SHARP_RIGHT: ['sharp'], TURN_SHARP_LEFT: ['sharp', true],
  U_TURN_LEFT: ['uturn'], U_TURN_RIGHT: ['uturn', true],
  ENTER_ROUND_ABOUT: ['round'], LEAVE_ROUND_ABOUT: ['round'], STAY_ON_ROUND_ABOUT: ['round'],
  START_AT_THE_END_OF_STREET: ['start'], REACHED_YOUR_DESTINATION: ['finish'],
  EXIT_HIGHWAY_TO_RIGHT: ['exit'], EXIT_HIGHWAY_TO_LEFT: ['exit', true],
};
const TURN_WORDS = {
  NO_TURN: 'Straight on', GO_STRAIGHT: 'Straight on', TURN_RIGHT: 'Turn right', TURN_LEFT: 'Turn left',
  TURN_SLIGHT_RIGHT: 'Bear right', TURN_SLIGHT_LEFT: 'Bear left', TURN_SHARP_RIGHT: 'Sharp right', TURN_SHARP_LEFT: 'Sharp left',
  U_TURN_LEFT: 'U-turn', U_TURN_RIGHT: 'U-turn', ENTER_ROUND_ABOUT: 'Roundabout', LEAVE_ROUND_ABOUT: 'Leave the roundabout',
  STAY_ON_ROUND_ABOUT: 'Stay on the roundabout', START_AT_THE_END_OF_STREET: 'To the end of the street',
  REACHED_YOUR_DESTINATION: 'Destination', EXIT_HIGHWAY_TO_RIGHT: 'Exit right', EXIT_HIGHWAY_TO_LEFT: 'Exit left',
};

function drawArrow(turn, exit) {
  const [name, mirror] = TURN_GLYPH[turn] || [];
  const svg = $('arrow');
  if (!name) { svg.innerHTML = ''; return; }
  // Only fixed shapes and a number go into the SVG; no text from the phone.
  const body = GLYPHS[name](name === 'round' && Number.isInteger(exit) && exit > 0 ? exit : 0);
  svg.innerHTML = mirror ? `<g transform="translate(100 0) scale(-1 1)">${body}</g>` : body;  // no glyph with a number is mirrored
}

// ---- phone GPS ---------------------------------------------------------------------------------------

// The shared feed reads speed only. This wrapper also notes the GPS course (a direction, never a position) when
// the phone reports one at driving speed.
function noteHeading(p) {
  const c = p && p.coords, h = c && c.heading;
  const fresh = p && Number.isFinite(p.timestamp) && Date.now() - p.timestamp < StudioDriveLocation.MAX_AGE_MS;
  if (fresh && Number.isFinite(h) && h >= 0 && h < 360 && Number.isFinite(c.speed) && c.speed >= HEADING_MIN_MPS
    && Number.isFinite(c.accuracy) && c.accuracy <= StudioDriveLocation.MAX_ACCURACY_M) {
    S.heading = h; S.headingAt = Date.now();
  }
}

function compass(deg) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

const motion = typeof DriveGuide==='undefined'?null:new DriveGuide.Guide();
// Fixed-camera warning (cameras.js, the same module and list as Bakar Home's Drive tab): worked out here from each fix;
// nothing about the position is kept or sent. A missing module or list leaves the speed screen as it was.
const cams = typeof DriveCameras==='undefined'?null:new DriveCameras.Watch();
let camsAsked=false,camsFailed=false;
function loadCameras() {
  if(!cams||camsAsked)return;
  camsAsked=true;
  fetch('cameras.json').then(r=>r.ok?r.json():Promise.reject()).then(file=>{cams.load(file);camsFailed=!cams.count;})
    .catch(()=>{camsAsked=false;camsFailed=true;});   // a miss is tried again the next time the page is shown
}
const feed = new StudioDriveLocation.Feed({geo:navigator.geolocation,permissions:navigator.permissions,change:onGps,
  transform:position=>{
    motion?.fix(position);const sample=motion?motion.fill(position):position;noteHeading(sample);
    if(motion)cams?.fix(position,motion.course(sample.coords),sample.coords.speed);
    return sample;
  }
});

// Trip: time and an estimated distance from reported speed (not from positions), while a speed is live. One source
// at a time (the phone's while it is fresh, else the glasses'), so nothing counts twice.
function addTrip(kmh) {
  const now = performance.now();
  if (S.trip.lastAt) {
    const dt = now - S.trip.lastAt;
    if (dt > 0 && dt <= 3000) { S.trip.ms += dt; S.trip.m += (kmh / 3.6) * (dt / 1000); }
  }
  S.trip.lastAt = now;
}

// The phone's own GPS speed and heading from the link, only while the phone is live and the reading is fresh.
function phoneSpeed(now = performance.now()) {
  const g = S.phoneGps;
  const elapsed=now-S.phoneGpsAt;
  const age=Math.max(Date.now()-S.phoneGpsSentAt,S.phoneGpsAge+elapsed);
  return g && S.phone === 'live' && S.phoneGpsAge>=0 && elapsed>=0 && Date.now()>=S.phoneGpsSentAt && age < PHONE_GPS_FRESH_MS ? {...g,ageMs:age} : null;
}

function onGps(reading) {
  S.gps = reading;
  if(reading.status==='waiting'&&!local('bd.gps'))local('bd.gps','asked');
  if(reading.status==='live'&&local('bd.gps')!=='on')local('bd.gps','on');
  // A position came back, so location is allowed here even if no speed could be shown yet (rough or too few fixes).
  // Remember that, so the next visit starts by itself where the runtime cannot report the permission.
  if(feed.hadGrant&&local('bd.gps')==='asked')local('bd.gps','on');
  if(reading.status==='denied')local('bd.gps','denied');
  if (phoneSpeed()) { render(); return; }          // the phone's speed is on screen and in the trip already
  if (reading.status === 'live') addTrip(reading.speed); else S.trip.lastAt = 0;
  render();
}

function toggleGps() {
  if (feed.enabled) { feed.stop(); local('bd.gps', 'off'); }
  else { local('bd.gps','asked'); feed.enable(); }
  render();
}

// ---- the link to the phone ------------------------------------------------------------------------------

// The phone link comes from the address once (?t=…&p=…) and is kept on the glasses. The glasses' own key is
// made per phone link, so a different link never reuses it. A link for a different phone than the one kept
// is not taken over silently: the panel asks first (S.offer).
const sameAddr = (a, b) => Boolean(a && b) && a.t === b.t && a.p === b.p;
const validAddr = (a) => Boolean(a) && Boolean(L.readAddress(`?t=${a.t}&p=${a.p}`, ''));

// Whether a phone key is a real P-256 point, so a broken link is never offered in place of a working one.
async function pointOk(p) {
  try { await subtle.importKey('raw', L.fromB64url(p), { name: 'ECDH', namedCurve: 'P-256' }, false, []); return true; }
  catch (e) { return false; }
}

// Keys for one phone link, or null. The glasses key is kept only once the keys work.
async function linkKeys(addr) {
  const devKey = `dev:${addr.t}:${addr.p}`;
  let dev = null;
  try { dev = await idbGet(devKey); } catch (e) { /* made below */ }
  const made = !dev;
  try {
    if (made) {
      const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      dev = { priv: pair.privateKey, pub: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
    }
    const devId = await L.deviceId(subtle, dev.pub);
    const keys = await L.deriveKeys(subtle, dev.priv, L.fromB64url(addr.p), addr.t, devId);
    const link = { addr, devId, devPubB64: L.toB64url(dev.pub), code: await L.pairCode(subtle, dev.pub), keys };
    if (made) { try { await idbPut(devKey, dev); } catch (e) { /* this visit only */ } }
    return link;
  } catch (e) { return null; }
}

async function setupLink() {
  if (!subtle || !window.indexedDB) return false;
  const fromUrl = L.readAddress(location.search, location.hash);
  let saved = null;
  try { saved = await idbGet('pairing'); } catch (e) { /* no storage: this visit only */ }
  if (!validAddr(saved)) saved = null;
  let link = saved ? await linkKeys(saved) : null;
  if (link && fromUrl && !sameAddr(saved, fromUrl) && await pointOk(fromUrl.p)) S.offer = fromUrl;
  if (!link && fromUrl) {
    link = await linkKeys(fromUrl);
    // Kept only once its keys work, so a link that can't be used never replaces one that can.
    if (link) { try { await idbPut('pairing', fromUrl); } catch (e) { /* this visit only */ } }
  }
  if (!link) return false;
  Object.assign(S, link);
  return true;
}

// The wearer chose the new phone link: keep it and start again with it (a fresh glasses key and code).
async function useOffer() {
  const next = S.offer;
  if (!next) return;
  try { await idbPut('pairing', next); } catch (e) { return; }
  location.replace(`${location.pathname}?t=${encodeURIComponent(next.t)}&p=${encodeURIComponent(next.p)}`);
}

// The wearer kept the phone they have: forget the offer and take it out of the address, so it isn't asked again.
function keepCurrent() {
  if (!S.offer) return;
  S.offer = null;
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* the address stays; harmless */ }
}

function setNet(state) {
  if (S.net === state) return;
  S.net = state;
  render();
}

// The one state the screen shows, from the brokers, the phone and the age of the last turn.
function linkView(now = performance.now()) {
  if (S.net === 'none') return 'none';
  const age = now - S.frameAt;
  if (S.phone === 'live' && age < FRAME_FRESH_MS) return 'live';
  if (S.phone === 'pairing') return 'pairing';
  if (S.phone === 'live' && age < FRAME_DROP_MS) return 'paused';
  if (S.net === 'down') return 'offline';
  if (S.net === 'connecting') return 'connecting';
  if (S.phone === 'ready' || S.phone === 'live') return 'ready';
  return 'waiting';
}

// What the speed self-check is told about the phone. It must never blame the phone for something that is only "not yet":
// until the saved link has been read, and while the page is opening its brokers again (after the display slept or the
// signal came back), the phone is being found. And when the glasses cannot reach the brokers at all, that is the story.
function checkLink(view) {
  if (!S.setup) return 'connecting';
  if (view === 'offline') return 'nosignal';
  if (view === 'paused') {
    if (S.net === 'connecting') return 'connecting';
    if (S.net === 'down') return 'nosignal';
    // The last turn is from before the brokers came back up (the display woke, or the signal returned), so it says nothing
    // about the phone now. The phone has just been asked again: it gets the same wait as when the page first opens before it
    // counts as silent. The render timer in linkChanged fires when this wait is over.
    return S.frameAt < S.upAt && performance.now() - S.upAt < PHONE_WAIT_MS ? 'connecting' : 'paused';
  }
  return view;
}

function loadMqtt() {
  if (S.mqttLoading || S.mqttTries >= 10) return;
  S.mqttLoading = true;
  S.mqttTries += 1;
  const tag = document.createElement('script');
  tag.src = `../vendor/mqtt.min.js?try=${S.mqttTries}`;
  tag.onload = () => { S.mqttLoading = false; if (!document.hidden) openLink(); };
  tag.onerror = () => { S.mqttLoading = false; tag.remove(); setTimeout(loadMqtt, 3000); };
  document.head.append(tag);
}

function openLink() {
  if (!S.addr || S.links.length || document.hidden) return;
  if (typeof mqtt === 'undefined') { loadMqtt(); setNet('connecting'); return; }
  S.linkId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  setNet('connecting');
  for (const b of BROKERS) addBroker(b);
}

function retryDelay(fails, othersUp) {
  if (othersUp) return Math.min(600000, 1000 * 2 ** Math.min(fails, 10));
  return fails <= 3 ? 1000 : Math.min(30000, 1000 * 2 ** (fails - 3));
}

function scheduleRetry(client) {
  if (client.retryTimer || !S.links.includes(client) || client.connected) return;
  client.fails = (client.fails || 0) + 1;
  client.retryTimer = setTimeout(() => {
    client.retryTimer = 0;
    if (!S.links.includes(client) || client.connected) return;
    try { client.reconnect(); } catch (e) { scheduleRetry(client); }
  }, retryDelay(client.fails, S.links.some((l) => l.connected)));
}

function addBroker({ url, ...extra }) {
  const client = mqtt.connect(url, {
    clientId: `bdg-${S.linkId}-${S.links.length}`, clean: true, keepalive: 45, protocolVersion: 4,
    reconnectPeriod: 0, connectTimeout: 6000, ...extra,
  });
  client.on('connect', () => {
    client.fails = 0;
    clearTimeout(client.retryTimer);
    client.retryTimer = 0;
    client.subscribe(`bkd/${S.addr.t}/d/${S.devId}`, { qos: 1 });
    hello(client);
    linkChanged();
  });
  client.on('message', (topic, payload) => onDown(new TextDecoder().decode(payload)));
  client.on('offline', linkChanged);
  client.on('close', () => { linkChanged(); scheduleRetry(client); });
  client.on('error', () => { /* a close follows, and the retry is set there */ });
  S.links.push(client);
}

function closeLink() {
  const old = S.links;
  S.links = [];
  clearInterval(S.helloTimer); S.helloTimer = 0;
  clearTimeout(S.waitTimer); S.waitTimer = 0;
  for (const l of old) {
    clearTimeout(l.retryTimer);
    try { l.end(true); } catch (e) { /* closed already */ }
  }
  if (S.addr) setNet('down');
}

function linkChanged() {
  const up = S.links.some((l) => l.connected);
  if (!up) { if (S.links.length && S.net === 'up') setNet('down'); return; }
  if (!S.helloTimer) S.helloTimer = setInterval(() => hello(), HELLO_MS);
  if (S.net !== 'up') {
    S.upAt = performance.now();
    setNet('up');
    clearTimeout(S.waitTimer);
    S.waitTimer = setTimeout(render, PHONE_WAIT_MS + 100);   // a moment after the wait is over, so the screen sees that it is
  }
}

async function hello(only) {
  if (!S.keys || document.hidden) return;
  const id = L.toB64url(crypto.getRandomValues(new Uint8Array(9)));
  S.hellos = S.hellos.slice(-5).concat(id);
  const payload = await L.sealUp(subtle, S.keys.up, S.devPubB64, { c: 'hello', id, ts: Date.now(), v: 1 });
  for (const l of only ? [only] : S.links) if (l.connected) l.publish(`bkd/${S.addr.t}/u`, payload, { qos: 1 });
}

async function onDown(text) {
  if (typeof text !== 'string' || text.length > L.MAX_DOWN || !S.keys) return;
  if (S.recent.includes(text)) return;           // the same message through another broker
  S.recent.push(text);
  if (S.recent.length > 32) S.recent.shift();
  const m = await L.openDown(subtle, S.keys.down, text);
  if (!m) return;
  const pair = L.checkPair(m);
  if (pair) {
    if (!S.hellos.includes(pair.re)) return;      // an answer to a hello from before this page opened
    S.heardAt = Date.now();
    if (!pair.ok) S.phone = 'pairing';
    else if (S.phone !== 'live') S.phone = 'ready';
    render();
    return;
  }
  const r = L.checkNav(m, Date.now(), S.last, S.hellos);
  if (!r.ok) return;
  S.last = r.last;
  S.heardAt = Date.now();
  S.phone = 'live';
  S.frame = r.frame.nav;
  S.frameAt = performance.now();
  S.phoneGps = r.frame.gps;
  S.phoneGpsAt = S.frameAt;
  S.phoneGpsSentAt = r.frame.at;
  S.phoneGpsAge = Date.now()-r.frame.at;
  if (S.phoneGps) addTrip(S.phoneGps.kmh); else if (S.gps.status !== 'live') S.trip.lastAt = 0;
  for (const t of S.staleTimers) clearTimeout(t);
  S.staleTimers = [setTimeout(render, Math.max(0,PHONE_GPS_FRESH_MS-Math.max(0,S.phoneGpsAge)) + 1), setTimeout(render, FRAME_FRESH_MS + 50), setTimeout(render, FRAME_DROP_MS + 50)];
  render();
}

// ---- screen -----------------------------------------------------------------------------------------

function lightPick() {
  const pick = local('bd.light');
  return LIGHTS.includes(pick) ? pick : 'auto';
}

// Auto follows the sun at Toronto's latitude, the same way as Bakar Home's Drive tab; no position is used.
function sunLight(when = new Date()) {
  const day = (when - new Date(when.getFullYear(), 0, 0)) / 86400000;
  const tilt = -23.44 * Math.cos(2 * Math.PI * (day + 10) / 365) * Math.PI / 180;
  const lat = 43.7 * Math.PI / 180;
  const halfDay = Math.acos(Math.max(-1, Math.min(1, -Math.tan(lat) * Math.tan(tilt)))) * 12 / Math.PI;
  const zone = -when.getTimezoneOffset() / 60;
  const noon = 12 + zone + 79.4 / 15;
  const hour = when.getHours() + when.getMinutes() / 60;
  const fromNoon = Math.abs(hour - noon);
  if (fromNoon < halfDay - 0.75) return 'day';
  return fromNoon < halfDay + 0.75 ? 'dusk' : 'night';
}

const GPS_WORDS = {
  off: 'App GPS stopped', waiting: 'Finding GPS…', 'no-response': 'No GPS answer yet', live: 'App GPS',
  stale: 'GPS signal old', inaccurate: 'GPS too rough', invalid: 'GPS reading rejected', unavailable: 'No speed from GPS',
  error: 'Location provider error', timeout: 'GPS timed out', disconnected: 'No GPS fix yet', found: 'Location found', standing: 'Standing still', denied: 'Location not allowed', paused: 'GPS paused',
  unsupported: 'No GPS here',
};

function topLine(view) {
  const n = S.frame;
  switch (view) {
    case 'connecting': return 'Linking to your phone…';
    case 'offline': return 'No signal for directions';
    case 'pairing': return 'Pair with your phone';
    case 'waiting': return performance.now() - (S.openedAt || 0) > PHONE_WAIT_MS ? 'Open Bakar Drive on your phone' : 'Looking for your phone…';
    case 'ready': return 'Phone linked · no route';
    case 'paused': return S.net === 'down' ? 'No signal · directions paused' : 'Directions paused';
    case 'live':
      if (!n) return 'Phone linked · no route';
      if (n.sim) return 'Bakar Drive · demo route';
      if (n.ss === 'OffRoute') return 'Off route';
      if (n.ss === 'RouteRebuilding' || n.ss === 'RouteNeedsRebuild') return 'Rerouting…';
      return 'Bakar Drive';
    default:
      if(S.gps.status==='live'&&S.gps.source==='estimated')return 'Speed estimated from positions';
      if(S.gps.status==='unavailable'&&feed.report().fresh&&feed.report().coordinates)return 'Location found · measuring speed';
      return S.shown && S.shown.text ? 'No speed' : (GPS_WORDS[S.gps.status] || 'App GPS');   // the amber line under the dash says why
  }
}

function render() {
  const hud = $('hud');
  const pick = lightPick();
  hud.dataset.light = pick === 'auto' ? sunLight() : pick;
  $('lightBtn').textContent = `Light: ${pick[0].toUpperCase()}${pick.slice(1)}`;

  // Speed: the phone's own GPS through the link while it is fresh, else the glasses' own location.
  const pg = phoneSpeed();
  const localReading=feed.snapshot();
  const selection=StudioDriveLocation.display(pg,localReading);
  const live=selection.kmh!==null;
  hud.dataset.source=selection.source;
  hud.dataset.gps = live ? 'live' : 'off';
  $('speed').textContent=live?String(selection.kmh):'—';
  const headingFresh = S.heading !== null && Date.now() - S.headingAt < 5000 && S.gps.status === 'live';
  // The phone already leaves the heading out below 2 m/s. From walking pace up, with no reported heading: the bearing between fixes.
  const walked = S.gps.status === 'live' && S.gps.speed >= 1.8 && motion ? motion.course() : null;
  const course = pg ? pg.hdg : (headingFresh ? S.heading : walked);
  $('heading').textContent = course !== null ? compass(course) : '';
  if(motion)DriveGuide.paintTape($('tape'),course);else $('tape').style.visibility='hidden';
  $('gpsBtn').textContent = feed.enabled ? 'Stop GPS' : 'Start GPS';
  $('gpsBtn').disabled = S.gps.status === 'unsupported';
  const mins = Math.floor(S.trip.ms / 60000);
  $('trip').textContent = S.trip.ms > 60000 ? `Trip ${mins} min · ${(S.trip.m / 1000).toFixed(1)} km est.` : '';

  // Directions
  const view = linkView();
  const fresh = view === 'live';
  const n = view === 'live' || view === 'paused' ? S.frame : null;
  const phase = n ? L.phase(n.ss) : 'none';
  const guide = Boolean(n) && ['guide', 'arrived', 'ready', 'building'].includes(phase);
  const pairing = view === 'pairing';
  // Speed self-check: with no speed on screen, a definite fault and nothing healthy behind it gets a plain amber line.
  const health = SC ? SC.check({ phoneFresh: Boolean(pg), gpsStatus: S.gps.status, link: checkLink(view) }) : { source: live ? 'ok' : 'none', level: 'wait', text: '', short: '' };
  S.shown = health;
  const warnText = guide ? health.short : health.text;   // beside the directions the corner is narrow: the same two lines, shorter
  $('speedWarn').textContent = warnText;
  $('speedWarn').hidden = !warnText;
  hud.dataset.speedLevel = health.level;
  hud.dataset.mode=guide?'guide':'speed';
  $('pairBox').hidden=true; // Link setup continues in the on-demand Details panel.
  $('pairCode').textContent = pairing ? `${S.code.slice(0, 3)} ${S.code.slice(3)}` : '';
  hud.dataset.link = view;
  $('turn').hidden = !guide;
  $('turn').classList.toggle('stale', guide && !fresh);
  if (guide) {
    let big = n.toTurn, small = n.next || TURN_WORDS[n.turn] || '';
    let turn = n.turn;
    if (phase === 'arrived') { turn = 'REACHED_YOUR_DESTINATION'; big = 'Arrived'; small = ''; }
    else if (phase === 'ready') { big = 'Route ready'; small = 'Start it in Bakar Drive'; turn = null; }
    else if (phase === 'building') { big = 'Finding route…'; small = ''; turn = null; }
    else if (!big) big = TURN_WORDS[n.turn] || '';
    drawArrow(turn, n.exit);
    $('toTurn').textContent = big;
    $('next').textContent = small;
    const eta = n.secs !== null && phase === 'guide';
    $('arriveTime').textContent = eta ? `Arrive ${clockText(new Date(Date.now() + n.secs * 1000))}` : '';
    $('arriveLeft').textContent = eta && n.left ? `${n.left} to go` : '';
  } else {
    $('arriveTime').textContent = '';
    $('arriveLeft').textContent = '';
  }
  // No speed: one short reason on the top line and what happens next under the unit, never a bare "unavailable".
  // The glasses' own location is the story unless a linked phone has answered and is about to send its speed.
  const linkedSoon=!live&&Boolean(S.addr)&&['live','ready'].includes(checkLink(view));
  const why=live?(selection.why||selection.label):linkedSoon?'Waiting for speed from phone':selection.why;
  const next=live?(selection.next||''):linkedSoon?'It shows when the phone sends it':selection.next;
  // A fixed camera on the road ahead takes the top line while the glasses' own reading is live: what it is and how far.
  const camera=cams&&localReading.status==='live'&&!pg?DriveCameras.words(cams.snapshot(),localReading.speed):null;
  hud.dataset.camera=camera?(camera.over?'over':'ahead'):'none';
  // An old or missing camera list says so under the speed, in amber: a quiet screen must not look like a clear road.
  const listNote=live&&!next&&cams?cams.faceNote(camsFailed):'';
  $('camLine').textContent=camera?camera.text:'';$('camLine').hidden=!camera;
  $('status').textContent=camera&&guide?camera.text:guide?topLine(view):why;
  $('speedNext').textContent=guide?'':next||listNote;
  $('speedNext').dataset.level=listNote?'warn':'ok';
  $('clock').textContent = clockText(new Date());
  if (S.panel) renderPanel();
}

// Why there is no speed when nothing is wrong yet: GPS not started, still asking, or a reading that is not usable. One short
// line: the panel has no room for more.
function quietWhy() {
  return { off: 'GPS is not started.', waiting: 'Waiting for GPS.', 'no-response': 'Waiting for GPS.', paused: 'GPS is paused.' }[S.gps.status]
    || `${GPS_WORDS[S.gps.status] || 'No GPS speed'}.`;
}

function renderPanel() {
  const view = linkView();
  let state, help;
  $('panelUse').hidden = !S.offer;
  if (S.offer) {
    state = 'This link is for a different phone.';
    help = 'These glasses get directions from another phone now. Use this phone switches to the new one, with a new code to accept on it. Back keeps the phone you have.';
  } else if (!S.addr) {
    state = 'No phone app is linked.';
    help = 'Speed comes from location, sent by your phone. Nothing else needs setting up.';
  } else if (S.phone === 'pairing') {
    state = 'Your phone hasn\'t accepted these glasses yet.';
    help = 'On your phone, open the glasses link and accept this code.';
  } else if (S.net === 'down') {
    state = 'No signal right now.';
    help = 'Directions come back on their own when the phone has signal.';
  } else if (checkLink(view) === 'paused') {   // the same silence the screen goes by, not the first moments after the link came back
    state = 'Your phone is not answering.';
    help = 'Directions come back on their own when the phone answers. Keep Bakar Drive and the phone\'s glasses link running.';
  } else if (S.phone === 'live' || S.phone === 'ready') {
    state = 'Linked to your phone.';
    help = 'When your linked source sends a route, the next turn appears here.';
  } else {
    state = 'Looking for your phone.';
    help = 'Keep Bakar Drive and the phone\'s glasses link running. The phone sends turns only while this screen is open.';
  }
  $('panelState').textContent = state;
  $('panelHelp').textContent = help;
  const h = S.shown;
  const source=StudioDriveLocation.display(phoneSpeed(),feed.snapshot()).source;
  const origin={linked:'Speed is coming from the linked source.',location:'App location is providing speed.',estimated:'Speed is estimated from recent positions.',standing:'Standing still. The speed stays 0 until a fix shows movement.'};
  $('panelSpeed').textContent = origin[source] || (!h ? 'No current speed.' : `Speed unavailable. ${h.short ? h.short.split('\n')[0] + '.' : quietWhy()}`);   // one line: the panel has no room for more, and the screen has the rest
  // Plain facts for a photo of this screen: how often location was asked for and answered, the last error in words,
  // the permission, and the last fix's time and accuracy. Never a position.
  const f = feed.details(), fix = f.lastFix, err = f.lastError;
  const errWords = err ? ({ 1: 'not allowed', 2: 'phone gave no position', 3: 'timed out' }[err.code] || 'unknown') : 'none';
  const at = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  $('panelFacts').textContent = `Location: asked ${f.asks} · answers ${f.fixes} · last error ${errWords}${err ? ' ' + at(err.at) : ''} · permission ${f.permission === 'unknown' ? 'not reported' : f.permission} · last fix ${
    fix ? (fix.at == null ? 'time unknown' : at(fix.at)) + ', ' + (fix.accuracy == null ? 'accuracy unknown' : Math.round(fix.accuracy) + ' m') : 'none'}`;
  $('panelCode').hidden = !S.code || S.phone!=='pairing' || Boolean(S.offer);
  $('panelQuiet').hidden = Boolean(S.offer);
  $('panelFacts').hidden = Boolean(S.addr) || Boolean(S.offer);   // with a phone app linked, its own state and code need the room
  $('panelCodeNum').textContent = !$('panelCode').hidden ? `${S.code.slice(0, 3)} ${S.code.slice(3)}` : '';
}

// ---- input: any press shows the controls, which go away again on their own ---------------------------

function showControls() {
  $('controls').hidden = false;
  if (!$('controls').contains(document.activeElement)) $('gpsBtn').focus({ preventScroll: true });
  armControls();
}
function armControls() {
  clearTimeout(S.controlsTimer);
  S.controlsTimer = setTimeout(hideControls, CONTROLS_MS);
}
function hideControls() {
  clearTimeout(S.controlsTimer);
  $('controls').hidden = true;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
function panelButtons() {
  return ['panelUse', 'panelStudio', 'panelBack'].map($).filter((b) => !b.hidden);
}
function openPanel() {
  S.panel = true;
  hideControls();
  renderPanel();
  $('panel').hidden = false;
  panelButtons()[0].focus({ preventScroll: true });
}
function closePanel() {
  keepCurrent();
  S.panel = false;
  $('panel').hidden = true;
  showControls();
  $('linkBtn').focus({ preventScroll: true });
}

const ORDER = ['gpsBtn', 'lightBtn', 'linkBtn'];
document.addEventListener('keydown', (e) => {
  const k = e.key;
  if (S.panel) {
    if (k === 'Escape' || k === 'Backspace') { e.preventDefault(); closePanel(); }
    else if (k.startsWith('Arrow')) {
      e.preventDefault();
      const list = panelButtons(), at = list.indexOf(document.activeElement);
      const step = k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 1;
      list[(Math.max(0, at) + step + list.length) % list.length].focus({ preventScroll: true });
    }
    return;
  }
  if ($('controls').hidden) {
    if (k.startsWith('Arrow') || k === 'Enter' || k === ' ') { e.preventDefault(); showControls(); }
    return;
  }
  armControls();
  if (k === 'Escape') { e.preventDefault(); hideControls(); return; }
  if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
    e.preventDefault();
    const at = ORDER.indexOf(document.activeElement && document.activeElement.id);
    const step = k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 1;
    $(ORDER[(Math.max(0, at) + step + ORDER.length) % ORDER.length]).focus({ preventScroll: true });
  }
});
// A pinch arrives as a click on the focused control. A click while the controls are hidden only shows them.
document.addEventListener('click', (e) => {
  if (S.panel || !$('controls').hidden) return;
  if (e.target.closest && e.target.closest('button')) return;
  showControls();
});
$('gpsBtn').addEventListener('click', () => { armControls(); toggleGps(); });
$('lightBtn').addEventListener('click', () => {
  armControls();
  local('bd.light', LIGHTS[(LIGHTS.indexOf(lightPick()) + 1) % LIGHTS.length]);
  render();
});
$('linkBtn').addEventListener('click', openPanel);
$('panelBack').addEventListener('click', closePanel);
$('panelUse').addEventListener('click', useOffer);
// A deliberate setup handoff carries only the existing phone's topic and public key.
// Studio keeps its own keys; a separate storage context still needs the normal code comparison.
$('panelStudio').addEventListener('click',()=>{
  const next=new URL('../',location.href),q=new URLSearchParams({tab:'drive'});
  if(S.addr){q.set('dt',S.addr.t);q.set('dp',S.addr.p);}
  next.hash=q.toString();location.assign(next.href);
});

// ---- life cycle --------------------------------------------------------------------------------------

function visible() {
  const on = !document.hidden;
  const preference=local('bd.gps');
  if(!on&&feed.visible)motion?.clearMotion?.();
  feed.setVisible(on,{autoStart:preference!=='off',resumeOnly:preference==='asked'||preference==='denied',worked:preference==='on'});
  if (on) { S.openedAt = performance.now(); openLink(); loadCameras(); } else closeLink();
  render();
}

function tickClock() {
  render();
  const now = new Date();
  setTimeout(tickClock, (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 50);
}

(async () => {
  const buildLabel=document.createElement('small');
  buildLabel.id='runningBuild';
  buildLabel.textContent='v'+APP_BUILD;
  buildLabel.setAttribute('aria-label','Bakar Drive build '+APP_BUILD);
  // Keep the running build in the safe area alongside the clock. The full-screen
  // directions panel has its own copy because it covers the entire header.
  Object.assign(buildLabel.style,{fontSize:'19px',fontWeight:'650',color:'var(--soft, #d3ddd7)',flex:'none',marginLeft:'auto'});
  $('clock').before(buildLabel);
  const panelBuild=buildLabel.cloneNode(true);panelBuild.removeAttribute('id');panelBuild.style.float='right';
  Object.assign(panelBuild.style,{position:'absolute',right:'6vmin',top:'5vmin'});
  $('panelTitle').style.paddingInlineEnd='3rem';$('panel').prepend(panelBuild);
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pagehide', () => { motion?.clearMotion?.();feed.setVisible(false);closeLink(); });
  window.addEventListener('pageshow', visible);
  window.addEventListener('online', () => { for (const l of S.links) if (!l.connected) { clearTimeout(l.retryTimer); l.retryTimer = 0; l.fails = 0; scheduleRetry(l); } });
  tickClock();
  visible();
  let linked = false;
  try { linked = await setupLink(); } catch (e) { /* no phone link this visit */ }
  S.setup = true;
  if (linked) openLink();
  render();
  if(S.offer)openPanel(); // Only a newly opened address offering a different phone needs a choice.
  if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js',{updateViaCache:'none'}).then(reg=>{
    let lastCheck=0;
    const check=()=>{if(!document.hidden&&Date.now()-lastCheck>=60000){lastCheck=Date.now();reg.update().catch(()=>{});}};
    window.addEventListener('pageshow',check);document.addEventListener('visibilitychange',check);
    if(navigator.serviceWorker.controller)check();
  }).catch(()=>{});
})();

// For tests in a desktop browser: the same entry the brokers use.
window.__bakarDrive = { onDown, state: S, render, linkChanged };
;
