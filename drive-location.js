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
    return {status:'live', speed:c.speed * 3.6, at};
  }
  class Feed {
    constructor({geo, permissions, now=Date.now, mono=()=>performance.now(),
      schedule=(fn,ms)=>setTimeout(fn,ms), cancel=id=>clearTimeout(id), change=()=>{}}) {
      Object.assign(this,{geo,permissions,now,mono,schedule,cancel,change});
      this.enabled=false; this.visible=false; this.watch=null; this.timer=null; this.epoch=0;
      this.state={status:geo?'off':'unsupported',speed:null}; this.permission=null;
      // Page-local facts only: never copy the position object or its coordinates.
      this.facts={attempts:0,fixes:0,lastFix:null,lastError:null,permission:'unknown'};
    }
    publish(state) { this.state=state; this.change(this.snapshot()); }
    snapshot() {
      const s={...this.state};
      if (s.status==='live') {
        const elapsed=this.mono()-s.receivedMono, age=Math.max(this.now()-s.at,s.initialAge+elapsed);
        if (!Number.isFinite(age)||elapsed<0||this.now()<s.at||age>=MAX_AGE_MS)
          return {status:'stale',speed:null,at:s.at};
        s.ageMs=Math.max(0,age);
      }
      delete s.receivedMono; delete s.initialAge;
      return s;
    }
    details() {
      const f=this.facts,last=f.lastFix;
      const age=last?.at===null?NaN:last?Math.max(this.now()-last.at,last.initialAge+this.mono()-last.receivedMono):NaN;
      return {status:this.snapshot().status,attempts:f.attempts,fixes:f.fixes,watchActive:this.watch!==null,
        visible:this.visible,enabled:this.enabled,permission:f.permission,
        lastFix:last?{at:last.at,ageMs:Number.isFinite(age)&&age>=0&&this.now()>=last.at?age:null,
          accuracy:last.accuracy,speedPresent:last.speedPresent,status:last.status}:null,
        lastError:f.lastError?{...f.lastError}:null};
    }
    clear() {
      ++this.epoch;
      if(this.timer!==null){this.cancel(this.timer);this.timer=null;}
      if(this.watch!==null){this.geo.clearWatch(this.watch);this.watch=null;}
      if(this.permission){this.permission.onchange=null;this.permission=null;}
    }
    tick() {
      this.timer=null; const s=this.snapshot();
      if(s.status!=='live') { this.publish(s); return; }
      this.change(s);
      this.timer=this.schedule(()=>this.tick(),Math.min(1000,MAX_AGE_MS-s.ageMs));
    }
    // Only a deliberate Start or Retry calls enable. Re-entry may resume an existing grant.
    enable() { this.enabled=true; if(this.visible)this.start(true); }
    stop() { this.enabled=false;this.clear();this.publish({status:this.geo?'off':'unsupported',speed:null}); }
    setVisible(visible) {
      if(this.visible===visible)return;
      this.visible=visible;
      if(!visible){this.clear();this.publish({status:this.enabled?'paused':this.geo?'off':'unsupported',speed:null});}
      else if(this.enabled)this.start();
    }
    async start(deliberate=false) {
      this.clear();
      this.facts.permission='unknown';
      if(!this.visible||!this.enabled)return;
      if(!this.geo){this.publish({status:'unsupported',speed:null});return;}
      const epoch=this.epoch;
      // Resume only with an existing grant. Never surprise a returning wearer
      // with a permission prompt after waking a sleeping page.
      if(!deliberate){
        let permission;
        try { permission=await this.permissions?.query({name:'geolocation'}); } catch(_) {}
        if(epoch!==this.epoch||!this.visible||!this.enabled)return;
        this.facts.permission=['granted','denied','prompt'].includes(permission?.state)?permission.state:'unknown';
        if(permission?.state!=='granted'){this.enabled=false;this.publish({status:permission?.state==='denied'?'denied':'off',speed:null});return;}
      }
      ++this.facts.attempts;
      this.publish({status:'waiting',speed:null});
      // Some hosts return neither callback. This notice is NOT a synthetic API timeout.
      // Keep the watch alive for a later fix; never repeatedly request permission.
      this.timer=this.schedule(()=>{
        this.timer=null;
        if(epoch===this.epoch&&this.visible&&this.enabled&&this.state.status==='waiting')
          this.publish({status:'no-response',speed:null});
      },RESPONSE_NOTICE_MS);
      // watchPosition is itself the supported permission flow, invoked by Enable.
      // It is never invoked on first entry, polling, or an incoming PC update.
      try {
        this.watch=this.geo.watchPosition(position=>{
          if(epoch!==this.epoch||!this.visible||!this.enabled)return;
          const now=this.now(), next=reading(position,now);
          ++this.facts.fixes;
          const at=position?.timestamp,c=position?.coords;
          this.facts.lastFix={at:Number.isFinite(at)&&at>0&&at<=now?at:null,
            receivedMono:this.mono(),initialAge:Number.isFinite(at)&&at>0&&at<=now?now-at:null,
            accuracy:Number.isFinite(c?.accuracy)&&c.accuracy>=0?c.accuracy:null,
            speedPresent:Number.isFinite(c?.speed)&&c.speed>=0,status:next.status};
          if(this.state.at && next.at && next.at<this.state.at)return; // late fix cannot replace a newer one
          if(this.timer!==null){this.cancel(this.timer);this.timer=null;}
          if(next.status==='live')Object.assign(next,{receivedMono:this.mono(),initialAge:now-next.at});
          this.publish(next);
          if(next.status==='live')this.timer=this.schedule(()=>this.tick(),Math.min(1000,MAX_AGE_MS-(now-next.at)));
        },error=>{
          if(epoch!==this.epoch)return;
          this.facts.lastError={code:[1,2,3].includes(error?.code)?error.code:null,at:this.now(),attempt:this.facts.attempts};
          if(this.timer!==null){this.cancel(this.timer);this.timer=null;}
          if(error?.code===1){this.enabled=false;this.clear();}
          this.publish({status:error?.code===1?'denied':error?.code===3?'timeout':'disconnected',speed:null});
        },{enableHighAccuracy:true,maximumAge:0,timeout:10000});
      } catch (_) { this.enabled=false;this.clear();this.publish({status:'unsupported',speed:null});return; }
      // Observe revocation when this browser supports it; do not request permissions here.
      if(this.permissions?.query)this.permissions.query({name:'geolocation'}).then(p=>{
        if(epoch!==this.epoch)return;
        this.permission=p;
        this.facts.permission=['granted','denied','prompt'].includes(p.state)?p.state:'unknown';
        p.onchange=()=>{if(epoch!==this.epoch)return;this.facts.permission=['granted','denied','prompt'].includes(p.state)?p.state:'unknown';if(p.state!=='granted'){this.enabled=false;this.clear();this.publish({status:p.state==='denied'?'denied':'off',speed:null});}else this.change(this.snapshot());};
        if(p.state==='denied')p.onchange();else this.change(this.snapshot());
      }).catch(()=>{});
    }
  }
  const api=Object.freeze({Feed,reading,MAX_AGE_MS,MAX_ACCURACY_M,MAX_SPEED_MPS,RESPONSE_NOTICE_MS});
  if(typeof module!=='undefined'&&module.exports)module.exports=api; else root.StudioDriveLocation=api;
})(globalThis);
