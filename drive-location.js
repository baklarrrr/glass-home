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
  const NO_ANSWER=new Set(['no-response','timeout','disconnected','error']), ASKING=new Set(['off','waiting',...NO_ANSWER]);
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
    // Whose turn it is when no location comes: the wearer has not answered the permission question ('prompt'), location is
    // allowed or has answered before ('granted'), or this host does not say ('unknown'). Only on states with no location.
    mark(s) {
      delete s.permission;
      if(!ASKING.has(s.status))return s;
      const p=this.facts.permission;
      if(p==='prompt')s.permission='prompt';
      else if(NO_ANSWER.has(s.status))s.permission=p==='granted'||this.facts.fixes>0?'granted':'unknown';
      return s;
    }
    // The permission question is unanswered: only a real press may ask again (never a timer), and each press does.
    get needsPress() { return this.facts.permission==='prompt'&&ASKING.has(this.snapshot().status); }
    snapshot() { return this.mark(this.read()); }
    read() {
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
    // Nothing came back and this host does not say whether location is allowed (see NO_ANSWER_LINES for the other cases).
    'no-response':['No location yet','Allow location for this app'],
    timeout:['No location yet','Allow location for this app'],
    disconnected:['No location yet','Allow location for this app'],
    error:['No location yet','Allow location for this app'],
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
  // Real reports from the glasses (15 Nov 2026): no callback ever, and the permission reads "prompt". The question on the
  // glasses was never answered, so the lines must not blame the phone. Three cases, by what the permission says.
  const NO_ANSWER_LINES=Object.freeze({
    prompt:['Location not allowed yet','Press Start GPS, then say yes'],
    granted:['No location from your phone','Set Meta AI location to Always'],
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
    const [why,next]=(ASKING.has(location?.status)&&NO_ANSWER_LINES[location.permission])||NO_SPEED[location?.status==='live'?'stale':location?.status]||['Speed unavailable',''];
    return {source:'none',kmh:null,why,next,label:next?why+' · '+next[0].toLowerCase()+next.slice(1):why};
  }

  const api=Object.freeze({Feed,reading,display,NO_SPEED,NO_ANSWER_LINES,FUTURE_MS,SLOW_KMH,SLOW_AGE_MS,STILL_KMH,MAX_AGE_MS,MAX_ACCURACY_M,MAX_SPEED_MPS,RESPONSE_NOTICE_MS});
  if(typeof module!=='undefined'&&module.exports)module.exports=api; else root.StudioDriveLocation=api;
})(globalThis);
