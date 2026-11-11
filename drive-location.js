'use strict';
// Phone-reported GPS ground speed. No coordinates are retained, sent or inferred.
// Product policy: at most 5 s old, <=50 m position uncertainty, <=100 m/s.
// These are conservative display filters, not a guarantee of speed accuracy.
// The W3C API does not report speed uncertainty or whether a fix is mocked.
(function (root) {
  const MAX_AGE_MS = 5000, MAX_ACCURACY_M = 50, MAX_SPEED_MPS = 100, RESPONSE_NOTICE_MS = 12000;
  function reading(position, now) {
    const c = position?.coords, at = position?.timestamp;
    if (!Number.isFinite(at) || at <= 0 || at > now) return {status:'invalid', speed:null};
    if (now - at >= MAX_AGE_MS) return {status:'stale', speed:null, at};
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
      this.probeTimer=null;this.probeDeadline=null;this.probeId=0;this.denied=false;this.gestureTried=false;this.positionFacts=null;this.lastGood=null;this.pendingState=null;this.observed='off';
      this.hadGrant=false; this.enabled=false; this.visible=false; this.watch=null; this.timer=null; this.epoch=0;
      this.state={status:geo?'off':'unsupported',speed:null}; this.permission=null;
      // Page-local facts only: never copy the position object or its coordinates.
      this.facts={attempts:0,fixes:0,positionFixes:0,lastFix:null,lastError:null,permission:'unknown'};
    }
    publish(state) { this.state=state; this.change(this.snapshot()); }
    snapshot() {
      const s={...this.state};
      if (s.status==='live') {
        const elapsed=this.mono()-s.receivedMono, age=Math.max(this.now()-s.at,s.initialAge+elapsed);
        if (!Number.isFinite(age)||elapsed<0||this.now()<s.at||age>=MAX_AGE_MS)
          return this.pendingState?{...this.pendingState}:{status:'stale',speed:null,at:s.at};
        s.ageMs=Math.max(0,age);
      }
      delete s.receivedMono; delete s.initialAge;
      return s;
    }
    details() {
      const f=this.facts,last=f.lastFix;
      const age=last?.at===null?NaN:last?Math.max(this.now()-last.at,last.initialAge+this.mono()-last.receivedMono):NaN;
      return {status:this.snapshot().status,attempts:f.attempts,fixes:f.fixes,positionFixes:f.positionFixes,watchActive:this.watch!==null,
        visible:this.visible,enabled:this.enabled,permission:f.permission,
        lastFix:last?{at:last.at,ageMs:Number.isFinite(age)&&age>=0&&this.now()>=last.at?age:null,
          accuracy:last.accuracy,speedPresent:last.speedPresent,status:last.status}:null,
        lastError:f.lastError?{...f.lastError}:null};
    }
    report() {
      const state=this.snapshot();
      const f=this.positionFacts;
      return {version:1,status:state.status,permission:this.facts.permission,
        callbacks:this.facts.fixes,positions:this.facts.positionFixes,
        coordinates:f?.coordinates===true,fresh:Boolean(f?.at>0&&this.now()>=f.at&&this.now()-f.at<MAX_AGE_MS),
        accurate:f?.accurate===true,source:state.status==='live'?(state.source||'reported'):'none',
        reason:f?.reason||'no-callback',error:this.facts.lastError?.code||0,observation:this.observed,held:state.status==='live'&&this.observed!=='live'};
    }
    observe(next) {
      this.observed=next.status;
      // Keep a usable reading only for its original freshness interval. An error
      // or incomplete fix can change what follows it, never its timestamp.
      if(next.status!=='live'&&this.snapshot().status==='live') {
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
      if(s.status!=='live') { this.publish(s); return; }
      this.change(s);
      this.timer=this.schedule(()=>this.tick(),Math.min(1000,MAX_AGE_MS-s.ageMs));
    }
    // Explicit Start or Retry replaces the watch. Entering the same visible view keeps it.
    enable() { this.denied=false;this.enabled=true; if(this.visible)this.start(true); }
    stop() { this.observed='off';this.lastGood=null;this.pendingState=null;this.hadGrant=false;this.enabled=false;this.clear();this.publish({status:this.geo?'off':'unsupported',speed:null}); }
    setVisible(visible, {autoStart=false, resumeOnly=false, gesture=false}={}) {
      if(this.visible===visible){
        if(visible&&gesture&&!this.denied&&!this.hadGrant&&!this.gestureTried&&
          (!this.enabled||['timeout','no-response'].includes(this.state.status))){
          this.gestureTried=true;this.enable();
        }
        return;
      }
      this.visible=visible;
      if(!visible){this.clear();this.publish({status:this.enabled?'paused':this.geo?'off':'unsupported',speed:null});}
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
      const active=()=>epoch===this.epoch&&this.visible&&this.enabled;
      const accept=(position,fromWatch)=>{
        if(!active())return;
        const now=this.now(),at=position?.timestamp,raw=position?.coords;
        const fresh=Number.isFinite(at)&&at>0&&now>=at&&now-at<MAX_AGE_MS;
        const coordinates=Number.isFinite(raw?.latitude)&&Math.abs(raw.latitude)<=90&&
          Number.isFinite(raw?.longitude)&&Math.abs(raw.longitude)<=180;
        const accurate=Number.isFinite(raw?.accuracy)&&raw.accuracy>=0&&raw.accuracy<=MAX_ACCURACY_M;
        const hasPosition=fresh&&coordinates;
        ++this.facts.fixes;
        if(this.positionFacts?.at && at<this.positionFacts.at)return;
        if(hasPosition&&at!==this.positionFacts?.at)++this.facts.positionFixes;
        const next=reading(this.transform(position),now);
        const reported=Number.isFinite(raw?.speed)&&raw.speed>=0;
        if(next.status==='live')next.source=reported?'reported':'estimated';
        const reason=!fresh?'invalid-time':!coordinates?'missing-coordinates':!accurate?'low-accuracy':
          next.status==='live'?(reported?'reported-speed':'positions-estimate'):'need-speed-fixes';
        this.positionFacts={at:Number.isFinite(at)&&at>0&&at<=now?at:null,coordinates,accurate,reason};
        if(fromWatch && fresh && (hasPosition||next.status==='live'))lastWatchFix=this.mono();
        if(raw&&Number.isFinite(at)&&at>0)this.hadGrant=true;
        this.facts.lastFix={at:Number.isFinite(at)&&at>0&&at<=now?at:null,
          receivedMono:this.mono(),initialAge:Number.isFinite(at)&&at>0&&at<=now?now-at:null,
          accuracy:Number.isFinite(raw?.accuracy)&&raw.accuracy>=0?raw.accuracy:null,
          speedPresent:Number.isFinite(raw?.speed)&&raw.speed>=0,status:next.status};
        if(next.status==='live'){
          const previous=this.lastGood?.at===next.at?this.lastGood:null;
          Object.assign(next,{receivedMono:previous?.receivedMono??this.mono(),initialAge:previous?.initialAge??(now-next.at)});
        }
        if(!this.observe(next))return;
        if(this.timer!==null){this.cancel(this.timer);this.timer=null;}
        if(next.status==='live')this.timer=this.schedule(()=>this.tick(),Math.min(1000,MAX_AGE_MS-(now-next.at)));
      };
      const fail=error=>{
        if(!active())return;
        const code=[1,2,3].includes(error?.code)?error.code:null;
        this.facts.lastError={code,at:this.now(),attempt:this.facts.attempts};
        if(code===1){
          this.lastGood=null;this.pendingState=null;this.denied=true;this.hadGrant=false;this.enabled=false;this.clear();
          this.observed='denied';this.publish({status:'denied',speed:null});return;
        }
        if(!this.observe({status:code===3?'timeout':code===2?'disconnected':'error',speed:null}))return;
        if(this.timer!==null){this.cancel(this.timer);this.timer=null;}
      };
      // A second API call while the first prompt is open can stack permission
      // sheets. Poll only after evidence of permission; leave a silent watch alive.
      const mayPoll=()=>this.facts.permission==='granted'||
        (this.facts.permission==='unknown'&&this.hadGrant);
      const scheduleProbe=(delay=4000)=>{
        if(!this.geo.getCurrentPosition||!active()||!mayPoll()||this.probeDeadline!==null)return;
        if(this.probeTimer!==null)this.cancel(this.probeTimer);
        this.probeTimer=this.schedule(probe,delay);
      };
      let probeNumber=0;
      const probe=()=>{
        if(!active()||!this.geo.getCurrentPosition||this.probeDeadline!==null)return;
        if(this.probeTimer!==null){this.cancel(this.probeTimer);this.probeTimer=null;}
        const watchAge=this.mono()-lastWatchFix;
        if(watchAge<MAX_AGE_MS){scheduleProbe(MAX_AGE_MS-watchAge);return;}
        const id=++this.probeId;
        const finish=callback=>{
          if(!active()||id!==this.probeId)return;
          ++this.probeId;
          this.cancel(this.probeDeadline);this.probeDeadline=null;probeExpired=false;
          callback();scheduleProbe();
        };
        this.probeDeadline=this.schedule(()=>{
          if(!active()||id!==this.probeId)return;
          if(this.mono()-lastWatchFix>=MAX_AGE_MS)this.observe({status:'no-response',speed:null});
          if(mayPoll())finish(()=>{});
          else probeExpired=true; // A pending prompt can still produce a valid first callback.
        },RESPONSE_NOTICE_MS);
        let nativeDone=false;
        const success=p=>{
          if(!active()||nativeDone)return;
          nativeDone=true;
          if(id===this.probeId){finish(()=>accept(p,false));return;}
          // A timeout retires the request, not a freshly acquired sample from
          // this still-visible visit. Never let an old request revoke permission.
          const age=this.now()-p?.timestamp;
          if(Number.isFinite(age)&&age>=0&&age<MAX_AGE_MS)accept(p,false);
        };
        try {
          const precise=this.watch===null||(++probeNumber%2===0);
          this.geo.getCurrentPosition(success,e=>{
            if(nativeDone)return;
            nativeDone=true;finish(()=>{
              if(e?.code===1||this.mono()-lastWatchFix>=MAX_AGE_MS)fail(e);
            });
          },{...options,enableHighAccuracy:precise,timeout:10000});
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
            this.denied=state==='denied';this.lastGood=null;this.pendingState=null;
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
      if(typeof this.geo.watchPosition==='function'){
        try{
          const watch=this.geo.watchPosition(p=>{
            accept(p,true);
            if(this.probeTimer===null)scheduleProbe();
          },e=>{
            fail(e);
            scheduleProbe(0);
          },options);
          if(!active()){this.geo.clearWatch?.(watch);return;}
          this.watch=watch;
          if(this.hadGrant)scheduleProbe();
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
  const api=Object.freeze({Feed,reading,MAX_AGE_MS,MAX_ACCURACY_M,MAX_SPEED_MPS,RESPONSE_NOTICE_MS});
  if(typeof module!=='undefined'&&module.exports)module.exports=api; else root.StudioDriveLocation=api;
})(globalThis);
