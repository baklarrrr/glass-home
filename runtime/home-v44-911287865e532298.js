// parked.js
'use strict';
// No parked check. Bakar, 11 Nov 2026: "get rid of those CHECKS to see if im driving. im a professional driver ... I want
// any CHECKS like that GONE AND REMOVED." The app never asks whether the wearer is parked and never holds a control back
// for it. This keeps the small interface the screens already call, and answers yes at once: a control that used to ask
// first now simply runs. The earlier dialog is in git history (parked.js before this change).
(() => {
  const $=id=>document.getElementById(id);
  const changed=()=>document.dispatchEvent(new Event('studio-parked-change'));
  window.StudioParked=Object.freeze({
    request(confirm){if(typeof confirm==='function')confirm();},
    revoke:changed,            // screens repaint their controls on this, as they did when a yes ran out
    confirmed:()=>true,controlsAllowed:()=>true,isOpen:()=>false,
    drivingContext:()=>!!($('drive')&&!$('drive').hidden)||!!($('route')&&!$('route').hidden),
    start(){}
  });
})();
;

// drive-location.js
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
;

// drive/link-core.js
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

// drive-phone.js
'use strict';
// The existing Journal link, hosted inside Studio. The protocol is drive/link-core.js.
// No PC relay, position storage, permission changes or guessed speeds.
(function (root) {
  const FRESH_MS = 3500;
  const BROKERS = [
    {url:'wss://broker.emqx.io:8084/mqtt'},
    {url:'wss://broker.hivemq.com:8884/mqtt'},
    {url:'wss://public.cloud.shiftr.io',username:'public',password:'public'}
  ];
  class Phone {
    constructor({core=root.DriveLinkCore,crypto=root.crypto,store,storage=null,
      mqtt=()=>root.mqtt,now=Date.now,mono=()=>performance.now(),
      schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id),change=()=>{}}={}) {
      Object.assign(this,{core,crypto,store,storage,mqtt,now,mono,schedule,cancel,change});
      if(!this.storage)try {this.storage=root.localStorage;}catch(_){}
      this.enabled=true;
      try {this.enabled=this.storage.getItem('studio.drive.phone.off')!=='1';}catch(_){}
      this.visible=false;this.link=null;this.offer=null;this.links=[];this.hellos=[];
      this.recent=[];this.last=null;this.frame=null;this.frameAt=0;this.frameAge=0;this.phone='unknown';
      this.timer=null;this.helloTimer=null;this.epoch=0;this.problem='';
      this.choiceEpoch=0;this.choiceTx=null;
    }
    async db(op,key,value,guard) {
      if(guard&&!guard())throw new Error('Cancelled phone choice');
      if(this.store)return this.store(op,key,value,guard);
      return new Promise((resolve,reject)=>{
        const r=indexedDB.open('bakar-drive',1);
        r.onupgradeneeded=()=>r.result.createObjectStore('keys');
        r.onerror=()=>reject(r.error);
        r.onsuccess=()=>{
          const db=r.result;
          if(guard&&!guard()){db.close();reject(new Error('Cancelled phone choice'));return;}
          const t=db.transaction('keys',op==='get'?'readonly':'readwrite');
          if(guard)this.choiceTx=t;
          const q=t.objectStore('keys')[op](...(op==='get'?[key]:[value,key]));
          q.onerror=()=>{db.close();reject(q.error);};
          const clear=()=>{if(this.choiceTx===t)this.choiceTx=null;db.close();};
          t.oncomplete=()=>{clear();resolve(q.result);};
          t.onabort=()=>{clear();reject(t.error||new Error('Cancelled phone choice'));};
        };
      });
    }
    valid(a) {return Boolean(a&&this.core.readAddress(`?t=${encodeURIComponent(a.t)}&p=${encodeURIComponent(a.p)}`,''));}
    same(a,b) {return Boolean(a&&b&&a.t===b.t&&a.p===b.p);}
    async keys(addr) {
      try {
        const subtle=this.crypto.subtle;
        await subtle.importKey('raw',this.core.fromB64url(addr.p),{name:'ECDH',namedCurve:'P-256'},false,[]);
        const key=`dev:${addr.t}:${addr.p}`;
        let dev;try {dev=await this.db('get',key);}catch(_){}
        if(!dev){const p=await subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
          dev={priv:p.privateKey,pub:new Uint8Array(await subtle.exportKey('raw',p.publicKey))};
          try {await this.db('put',key,dev);}catch(_){}
        }
        const id=await this.core.deviceId(subtle,dev.pub);
        return {addr,devId:id,pub:this.core.toB64url(dev.pub),
          code:await this.core.pairCode(subtle,dev.pub),
          keys:await this.core.deriveKeys(subtle,dev.priv,this.core.fromB64url(addr.p),addr.t,id)};
      } catch(_) {return null;}
    }
    async setup(params=new URLSearchParams()) {
      if(!this.core||!this.crypto?.subtle){this.problem='Secure phone link unavailable in this app';this.emit();return false;}
      // Distinct names: Studio's own PC pairing also uses t/p. Never reinterpret that link.
      const incoming=this.core.readAddress(`?t=${encodeURIComponent(params.get('dt')||'')}&p=${encodeURIComponent(params.get('dp')||'')}`,'');
      let saved;try {saved=await this.db('get','pairing');}catch(_){}
      if(!this.valid(saved))saved=null;
      this.link=saved?await this.keys(saved):null;
      if(this.link&&incoming&&!this.same(saved,incoming)){
        // Validate the offered point without replacing any existing pairing or key.
        try {await this.crypto.subtle.importKey('raw',this.core.fromB64url(incoming.p),{name:'ECDH',namedCurve:'P-256'},false,[]);this.offer=incoming;}catch(_){}
      }
      if(!this.link&&incoming){
        this.link=await this.keys(incoming);
        if(this.link)try {await this.db('put','pairing',incoming);}catch(_){}
      }
      this.emit();this.open();return Boolean(this.link);
    }
    async acceptOffer() {
      if(!this.offer)return false;
      const offer=this.offer,epoch=this.epoch,choice=++this.choiceEpoch;
      const current=()=>this.offer===offer&&this.epoch===epoch&&this.choiceEpoch===choice;
      const next=await this.keys(offer);if(!next||!current())return false;
      try {await this.db('put','pairing',offer,current);}catch(_){return false;}
      if(!current())return false;
      this.close();this.link=next;this.offer=null;this.last=null;this.open();this.emit();return true;
    }
    cancelChoice(){++this.choiceEpoch;if(this.choiceTx){try{this.choiceTx.abort();}catch(_){}this.choiceTx=null;}}
    keepCurrent(){this.cancelChoice();this.offer=null;this.emit();}
    setEnabled(on) {
      this.enabled=Boolean(on);
      try {this.storage.setItem('studio.drive.phone.off',on?'0':'1');}catch(_){}
      if(on)this.open();else this.close();this.emit();
    }
    setVisible(on) {
      if(this.visible===Boolean(on))return;
      this.visible=Boolean(on);if(on)this.open();else this.close();this.emit();
    }
    snapshot() {
      const live=this.visible&&this.enabled;
      const up=this.links.some(x=>x.connected);
      const elapsed=this.mono()-this.frameAt;
      // Protocol clock tolerance is for navigation, not speed freshness. An old encrypted
      // frame must never gain another 3.5 seconds merely because it arrived just now.
      const age=this.frame?Math.max(this.now()-this.frame.at,this.frameAge+elapsed):Infinity;
      const timeOk=this.frameAge>=0&&elapsed>=0&&this.now()>=this.frame?.at;
      const gps=live&&this.phone==='live'&&timeOk&&age<FRESH_MS?this.frame?.gps:null;
      const nav=live&&this.phone==='live'&&timeOk&&age<4000?this.frame?.nav:null;
      let state=!this.enabled?'off':!this.link?'unpaired':!this.visible?'paused':
        gps?'live':this.phone==='pairing'?'pairing':
        this.frame?.gps&&(!timeOk||age>=FRESH_MS)?'stale':
        this.phone==='live'&&age<8000?'no-sample':this.phone==='ready'?'ready':
        up?'waiting':this.links.length?'connecting':'offline';
      if(this.problem)state='unavailable';
      return {state,gps:gps||null,nav:nav||null,ageMs:gps?age:null,code:this.link?.code||'',offer:Boolean(this.offer),
        configured:Boolean(this.link),enabled:this.enabled,problem:this.problem};
    }
    emit(){this.change(this.snapshot());}
    open() {
      if(!this.visible||!this.enabled||!this.link||this.links.length)return;
      const mqtt=this.mqtt();if(!mqtt){this.problem='Phone link library unavailable';this.emit();return;}
      this.problem='';const epoch=++this.epoch;
      for(const b of BROKERS){
        const {url,...auth}=b;
        const client=mqtt.connect(url,{clientId:'sdp-'+this.core.toB64url(this.crypto.getRandomValues(new Uint8Array(9))),
          clean:true,keepalive:45,protocolVersion:4,reconnectPeriod:0,connectTimeout:6000,...auth});
        this.links.push(client);client.fails=0;
        const retry=()=>{
          if(epoch!==this.epoch||client.connected||client.retry)return;
          const other=this.links.some(x=>x.connected);++client.fails;
          const delay=other?Math.min(600000,1000*2**Math.min(client.fails,10)):
            client.fails<=3?1000:Math.min(30000,1000*2**(client.fails-3));
          client.retry=this.schedule(()=>{client.retry=null;if(epoch===this.epoch&&!client.connected){try{client.reconnect();}catch(_){retry();}}},delay);
        };
        client.on('connect',()=>{if(epoch!==this.epoch)return;client.fails=0;this.cancel(client.retry);client.retry=null;
          client.subscribe(`bkd/${this.link.addr.t}/d/${this.link.devId}`,{qos:1});this.hello(client);this.emit();});
        client.on('message',(_topic,payload)=>{if(epoch===this.epoch)this.receive(String(payload),epoch);});
        client.on('close',()=>{if(epoch===this.epoch){retry();this.emit();}});
        client.on('offline',()=>{if(epoch===this.epoch)this.emit();});
        client.on('error',()=>{});
      }
      this.armHello(epoch);this.emit();
    }
    armHello(epoch){this.helloTimer=this.schedule(()=>{if(epoch!==this.epoch)return;this.hello();this.armHello(epoch);},20000);}
    async hello(only) {
      if(!this.visible||!this.enabled||!this.link)return;
      const epoch=this.epoch,link=this.link,id=this.core.toB64url(this.crypto.getRandomValues(new Uint8Array(9)));
      this.hellos=this.hellos.slice(-5).concat(id);
      try {
        const text=await this.core.sealUp(this.crypto.subtle,link.keys.up,link.pub,{c:'hello',id,ts:this.now(),v:1});
        if(epoch!==this.epoch)return;
        for(const c of only?[only]:this.links)if(c.connected)c.publish(`bkd/${link.addr.t}/u`,text,{qos:1});
      }catch(_){}
    }
    async receive(text,epoch=this.epoch) {
      if(!this.visible||!this.enabled||!this.link||epoch!==this.epoch||typeof text!=='string'||text.length>this.core.MAX_DOWN||this.recent.includes(text))return;
      this.recent.push(text);if(this.recent.length>32)this.recent.shift();
      const link=this.link,m=await this.core.openDown(this.crypto.subtle,link.keys.down,text);
      if(!m||epoch!==this.epoch||link!==this.link||!this.visible||!this.enabled)return;
      const pair=this.core.checkPair(m);
      if(pair){if(!this.hellos.includes(pair.re))return;if(!pair.ok)this.phone='pairing';else if(this.phone!=='live')this.phone='ready';this.emit();return;}
      const checked=this.core.checkNav(m,this.now(),this.last,this.hellos);if(!checked.ok)return;
      this.last=checked.last;this.frame=checked.frame;this.frameAt=this.mono();this.phone='live';
      this.frameAge=this.now()-checked.frame.at;
      this.armExpiry();this.emit();
    }
    armExpiry(){
      this.cancel(this.timer);this.timer=null;if(!this.frame)return;
      const age=Math.max(this.now()-this.frame.at,this.frameAge+this.mono()-this.frameAt);
      const next=[FRESH_MS,4000,8000].find(at=>at>age);
      if(next)this.timer=this.schedule(()=>{this.timer=null;this.emit();this.armExpiry();},next-age+1);
    }
    close() {
      this.cancelChoice();
      ++this.epoch;this.cancel(this.timer);this.cancel(this.helloTimer);this.timer=this.helloTimer=null;
      for(const c of this.links){this.cancel(c.retry);try{c.end(true);}catch(_){}}
      this.links=[];this.hellos=[];this.recent=[];this.frame=null;this.frameAt=0;this.phone='unknown';
    }
  }
  const api=Object.freeze({Phone,FRESH_MS});
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.StudioDrivePhone=api;
})(globalThis);
;

// drive/speed-check.js
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
        gpsStatus==='unsupported'?'location API unavailable':'waiting for a new fix';
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
    timeout: ['GPS timed out'],
    disconnected: ['No GPS fix'],
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

// drive/guide.js
'use strict';
// Compass tape and saved-route guidance for the Drive screens. No DOM, no timers and no network here, so Node runs this
// same code in drive/tests/guide.test.cjs.
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
    clearMotion() { this.trail=[];this.anchor=null;this.moved=null; }
    // The way the car is moving, for a runtime whose location gives no heading: the bearing between two fixes at least
    // 12 m apart (more when the fix is rough). The earlier fix is held in page memory for this only and replaced as the car
    // moves; a reported heading always wins. Nothing here needs a route.
    track(c, at) {
      // A few seconds of fixes, for a speed where the device reports none (see estimate). Page memory only.
      this.trail = this.trail.filter((p) => at - p.at <= 12000 && at > p.at);
      this.trail.push({ lat: c.latitude, lon: c.longitude, at, acc: c.accuracy });
      const a = this.anchor;
      if (a && at - a.at <= 15000 && at >= a.at) {
        const [dx, dy] = flat(a.lat, a.lon, c.latitude, c.longitude), far = Math.hypot(dx, dy);
        if (far < Math.max(12, c.accuracy)) return;
        if (far < 400) this.moved = { deg: norm(Math.atan2(dx, dy) * 180 / Math.PI), at };
      }
      this.anchor = { lat: c.latitude, lon: c.longitude, at };
    }
    // Ground speed in metres a second from the last few fixes, for a runtime whose location reports no speed: the distance
    // from a fix 1.5 to 6 seconds back (up to 12 seconds for sparse one-shot callbacks), over the time between. Movement smaller than the fixes' own scatter counts as
    // standing still. Null until there are two usable fixes. An estimate from positions, labelled as GPS on screen.
    estimate() {
      const t = this.trail, last = t[t.length - 1];
      if (!last || this.now() - last.at >= FIX_MAX_AGE_MS) return null;
      const from = t.find((p) => last.at-p.at>=1500 && last.at-p.at<=6000) || t.find((p) => last.at-p.at>=1500);
      if (!from) return null;
      const [dx, dy] = flat(from.lat, from.lon, last.lat, last.lon), far = Math.hypot(dx, dy);
      const speed = far < Math.max(5, 0.6 * Math.max(from.acc, last.acc)) ? 0 : far / ((last.at - from.at) / 1000);
      return { speed, heading: speed >= 2 ? this.course() : null };
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
      if (c && finite(c.speed) && c.speed >= 0 && c.speed < 2) return null;                   // the device says stopped
      return this.moved && this.now() - this.moved.at < FIX_MAX_AGE_MS && this.now() >= this.moved.at ? this.moved.deg : null;
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
      if (!c || !finite(at) || at > now || now - at >= FIX_MAX_AGE_MS) return;
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
      if (this.now() - this.at >= FIX_MAX_AGE_MS || this.now() < this.at) return { state: 'paused', title: r.ti };
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

  const api = Object.freeze({ tape, prepare, project, clip, Guide, metres, words, POINTS,
    FIX_MAX_AGE_MS, FIX_MAX_ACCURACY_M, ROUTE_MAX_AGE_S, OFF_BASE_M, OFF_FIXES, GIVE_UP_M, GIVE_UP_MS, ARRIVE_M,
    JOIN_FIXES, AGAINST_FIXES, ARRIVED_SHOW_MS, ARRIVED_LEAVE_M });
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DriveGuide = api;
})(globalThis);
;

// drive/cameras.js
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
    staleNote() { const age = this.ageDays(); return this.ix.count && age !== null && age > STALE_DAYS ? `Camera list ${age} days old` : ''; }
    // One location fix, with the course of travel in degrees (or null: stopped, or unknown) and the speed in metres a second.
    fix(position, course, speed) {
      const c = position && position.coords, at = position && position.timestamp, now = this.now();
      if (!c || !finite(at) || at > now || now - at >= FIX_MAX_AGE_MS) return;
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
      if (!this.target || this.now() - this.at >= FIX_MAX_AGE_MS || this.now() < this.at) return null;
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

// home-shell.js
'use strict';
// One existing app registration. Pairings stay in this app's browser storage and URL fragments.
window.HomeShell=(()=>{
  const by=id=>document.getElementById(id);
  const groups={now:'work',work:'work',watch:'work',apps:'work',games:'work',review:'review',route:'drive',drive:'drive'};
  let shown=false,wayOut=false,idle=0,lastDrive='driveGps',depth=0,frameReady=false,pendingTab='',returnTimer=0,locationPending=false,pendingReview=false;
  const frame=()=>by('reviewFrame');
  function tell(message){if(frameReady)frame().contentWindow.postMessage(message,location.origin);}
  function activateReview(active){
    const allowed=!!active&&!document.hidden,inside=document.activeElement===frame();
    frame().hidden=!allowed||!frameReady;
    frame().inert=!allowed;
    by('reviewEnter').hidden=false;
    by('reviewEnter').textContent=allowed?'Focus review':'Open pictures';
    tell({type:'studio-review-visible',active:allowed});
    if(inside&&!allowed&&!StudioParked.isOpen())by('reviewEnter').focus({preventScroll:true}); // A closing frame must not take focus with it.
  }
  function quiet(focus=true){
    clearTimeout(idle);idle=0;shown=false;wayOut=false;
    if(['driveGps','driveRetry','driveLight','driveInfoButton'].includes(document.activeElement?.id))lastDrive=document.activeElement.id;
    closeDriveInfo(false);
    by('drive').dataset.controls='quiet';
    document.body.classList.toggle('drive-quiet',S.tab==='drive');StudioParked.revoke();
    if(focus&&S.tab==='drive'&&!document.hidden)by('driveReveal').focus({preventScroll:true});
  }
  function touch(){
    clearTimeout(idle);idle=0;
    if(S.tab!=='drive'||!(shown||wayOut)||!by('driveInfo').hidden||locationPending)return;
    idle=setTimeout(()=>quiet(),8000);
  }
  function setLocationPending(pending){if(locationPending===pending)return;locationPending=pending;touch();}
  // The sections come back so Drive can be left without saying anything about being parked. Controls stay hidden.
  function showWayOut(){wayOut=true;document.body.classList.remove('drive-quiet');touch();}
  function reveal(){
    if(S.tab!=='drive'||document.hidden||StudioParked.isOpen())return;
    if(!StudioParked.confirmed()){StudioParked.request(reveal);return;}
    shown=true;by('drive').dataset.controls='open';document.body.classList.remove('drive-quiet');
    [by(lastDrive),by('driveGps'),by('driveLight')].find(button=>button&&!button.disabled&&!button.hidden)?.focus({preventScroll:true});touch();
  }
  function openDriveInfo(){
    if(S.tab!=='drive'||!shown||document.hidden)return;
    by('drive').dataset.details='open';by('driveInfo').hidden=false;
    document.body.classList.add('drive-details-open');
    paintDriveDetails();by('driveInfoClose').focus({preventScroll:true});touch();
  }
  function closeDriveInfo(focus=true){
    if(typeof drivePhone!=='undefined')drivePhone.cancelChoice();
    by('drive').removeAttribute('data-details');by('driveInfo').hidden=true;
    document.body.classList.remove('drive-details-open');
    if(focus&&S.tab==='drive'&&shown){by('driveInfoButton').focus({preventScroll:true});touch();}
  }
  function ensureReview(){
    if(frame().getAttribute('src')){activateReview(true);return;}
    const pair=passPairing('sg');
    if(!pair){by('reviewState').textContent='This app has no existing picture-review connection. Keep the current Studio app until its connection can be brought across.';return;}
    const url=new URL('review/index.html',location.href);
    url.hash=new URLSearchParams({t:pair.t,k:pair.k}).toString();
    frame().src=url.href; // Fragment never goes to a web server; no new pairing is requested.
    by('reviewState').textContent='Opening existing picture review.';
  }
  function paint(){
    const group=groups[S.tab]||'work';
    by('appContext').textContent=S.view==='compose'?'Message':S.view==='detail'?'Chat':group==='review'?'Pictures':S.tab==='watch'?'Watch':group==='drive'?'Drive':S.tab==='apps'?'Apps':S.tab==='games'?'Games':'Work';
    for(const button of document.querySelectorAll('[data-section]')){button.setAttribute('aria-current',button.dataset.section===group?'page':'false');button.disabled=S.view!=='list';button.title=button.disabled?'Use Back to return before changing sections.':'';}
    for(const button of document.querySelectorAll('.tab')){button.hidden=groups[button.dataset.tab]!==group;button.disabled=S.view!=='list';}
    document.querySelector('.tabs').hidden=group==='review';
  }
  function onPane(id,before){
    paint();document.body.classList.toggle('drive-view',id==='drive');
    if(id==='drive'&&before!=='drive'){stopReading();by('push').hidden=true;quiet(false);}
    else if(id!=='drive'){clearTimeout(idle);idle=0;shown=false;wayOut=false;closeDriveInfo(false);document.body.classList.remove('drive-quiet');}
    if(id==='review')ensureReview();else activateReview(false);
  }
  // Route is parked-only. Every way to it comes through selectTab, so arrows ask the same question a press does.
  function canEnterRoute(tab,focusTab){
    if(tab!=='route'||StudioParked.confirmed())return true;
    StudioParked.request(()=>selectTab('route',focusTab));
    return false;
  }
  function canLeaveReview(tab){
    if(S.tab!=='review'||tab==='review'||depth===0)return true;
    pendingTab=tab;tell({type:'studio-review-root'});clearTimeout(returnTimer);
    returnTimer=setTimeout(()=>{pendingTab='';by('reviewState').hidden=false;by('reviewState').textContent='Use Back to return to the picture list before changing sections.';},2500);
    return false;
  }
  function focusReview(){
    ensureReview();
    if(frameReady){frame().focus();tell({type:'studio-review-focus'});}
    else (by('reviewEnter').hidden?by('section-review'):by('reviewEnter')).focus();
  }
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.source!==frame()?.contentWindow||!event.data)return;
    const m=event.data;
    if(m.type==='studio-review-ready'){
      frameReady=true;frame().hidden=false;by('reviewEnter').hidden=false;by('reviewState').hidden=true;activateReview(S.tab==='review');
    }
    if(m.type==='studio-review-depth'&&Number.isInteger(m.depth)&&m.depth>=0&&m.depth<=4){
      depth=m.depth;
      if(depth===0&&pendingReview){pendingReview=false;clearTimeout(returnTimer);if(S.tab==='review'&&!document.hidden)focusReview();}
      if(depth===0&&pendingTab){const tab=pendingTab;pendingTab='';clearTimeout(returnTimer);selectTab(tab);}
    }
    if(m.type==='studio-review-key'&&S.tab==='review'&&!StudioParked.isOpen())reviewKey(m.key);
  });
  function handleKey(event){
    if(S.tab!=='drive'||StudioParked.isOpen()||!event.isTrusted)return false;
    if(!shown&&['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter',' '].includes(event.key)){
      // Up is always the way out, with no question asked. Once it's showing the app's own keys work too;
      // only a deliberate press on the quiet face itself reveals the controls.
      const off=document.activeElement!==by('driveReveal')||event.key==='ArrowLeft'||event.key==='ArrowRight';
      if(event.key==='ArrowUp'&&!wayOut)showWayOut();
      else if(!wayOut||(!off&&event.key!=='ArrowUp')){event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)reveal();return true;}
    }
    if((shown||wayOut)&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();if(!by('driveInfo').hidden){closeDriveInfo();touch();}else quiet();return true;}
    if(shown||wayOut)touch();
    return false;
  }
  function init(){
    for(const button of document.querySelectorAll('[data-section]'))button.addEventListener('click',e=>selectTab({work:'now',review:'review',drive:'drive'}[button.dataset.section],false,e.isTrusted));
    by('reviewEnter').addEventListener('click',focusReview);by('driveReveal').addEventListener('click',reveal);
    by('driveInfoButton').addEventListener('click',openDriveInfo);by('driveInfoClose').addEventListener('click',()=>closeDriveInfo());
    document.addEventListener('studio-parked-change',()=>{
      activateReview(S.tab==='review');
      if(StudioParked.controlsAllowed()||StudioParked.isOpen())return;
      // The answer is gone, however it went: nothing parked-only stays open behind it.
      if(S.tab==='route')selectTab('drive');
      if(S.tab==='drive'&&(shown||wayOut))quiet();
      if(S.view==='play'&&S.player?.pauseVideo)S.player.pauseVideo();
    });
    document.addEventListener('click',event=>{if(event.isTrusted)touch();},true);
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden){if(S.tab==='drive'){clearTimeout(idle);idle=0;if(by('driveInfo').hidden)quiet(false);}activateReview(false);}
      else {activateReview(S.tab==='review');} // Resume quietly; ask only on deliberate entry.
    });
    window.addEventListener('pagehide',()=>{pendingReview=false;pendingTab='';clearTimeout(idle);idle=0;clearTimeout(returnTimer);activateReview(false);if(S.tab==='drive'&&by('driveInfo').hidden)quiet(false);});
  }
  return Object.freeze({init,onPane,canEnterRoute,canLeaveReview,focusReview,handleKey,setLocationPending,driveQuiet:()=>S.tab==='drive'&&!shown,
    tabsForInput(target){return target.closest('.sections')?['now','review','drive']:Object.keys(groups).filter(key=>groups[key]===groups[S.tab]);}
  });
})();
;

// watch-phone.js
'use strict';
// An explicit parked handoff over the existing Tidal pairing/connection pool. No PC sender or new broker/topic.
(function(root){
  const allowedCodes=new Set(['posted','notifications-disabled','unavailable','expired','invalid','id-conflict']);
  function payload(input){
    if(input?.kind==='search'&&input.provider==='youtube'){
      const query=String(input.query||'').replace(/\s+/g,' ').trim();
      if(!query||query.length>160||/[\u0000-\u001f\u007f]/.test(query))throw new Error('Use a search of 1–160 characters.');
      return {kind:'search',provider:'youtube',query};
    }
    if(input?.kind==='video'&&typeof input.videoId==='string'&&((input.provider==='youtube'&&/^[A-Za-z0-9_-]{11}$/.test(input.videoId))||
      (input.provider==='vimeo'&&/^[0-9]{1,12}$/.test(input.videoId))))return {kind:'video',provider:input.provider,videoId:input.videoId};
    throw new Error('This provider link cannot be handed to the phone.');
  }
  class Handoff {
    constructor({pair,publish,active,ensureConnected=async()=>true,timeout=9000,clock=()=>Date.now()}){
      Object.assign(this,{pair,publish,active,ensureConnected,timeout,clock});this.pending=null;this.epoch=0;
    }
    async request(input){
      const fields=payload(input);
      if(this.pending)throw new Error('A phone handoff is already waiting for confirmation.');
      if(!this.active())throw new Error('Open Watch while parked before sending to your phone.');
      const pair=this.pair();
      if(!pair?.key||!pair.t||!/^[A-Za-z0-9_-]{6,128}$/.test(pair.t))throw new Error('This Studio app has no saved Tidal phone pairing.');
      const epoch=++this.epoch,id=crypto.randomUUID(),ts=this.clock();
      let resolve,reject;
      const result=new Promise((yes,no)=>{resolve=yes;reject=no;});
      // A handler is attached before asynchronous encryption so cancellation never creates an unhandled rejection.
      result.catch(()=>{});
      const pending={id,provider:fields.provider,epoch,resolve,reject,timer:0};this.pending=pending;
      try{
        const current=()=>this.pending===pending&&this.epoch===epoch&&this.active()&&this.pair()===pair;
        if(!await this.ensureConnected(current))throw new Error('Phone link unavailable. Check its notifications before trying again.');
        if(!current())throw new Error('Phone handoff cancelled before sending.');
        const iv=crypto.getRandomValues(new Uint8Array(12));
        const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv},pair.key,new TextEncoder().encode(JSON.stringify({c:'watchOpen',id,ts,...fields})));
        if(this.pending!==pending||this.epoch!==epoch||!this.active()||this.pair()!==pair)throw new Error('Phone handoff cancelled before sending.');
        const sealed=new Uint8Array(12+bytes.byteLength);sealed.set(iv);sealed.set(new Uint8Array(bytes),12);
        const body=btoa(String.fromCharCode(...sealed)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
        // Register before publish: an immediate fake/real reply can be correlated safely.
        pending.timer=setTimeout(()=>this.finish(pending,new Error('Your phone has not confirmed this handoff. This feature requires the Tidal Glass Watch update. Check phone notifications before trying again.')),this.timeout);
        if(!this.publish('bkr/'+pair.t+'/c',body))this.finish(pending,new Error('Phone link unavailable. Try again after the connection returns.'));
      }catch(error){this.finish(pending,error);}
      return result;
    }
    receive(state){
      const p=this.pending,r=state?.watchReply;
      if(!p||state?.t!=='state'||state.watchHandoff!==1||!r||r.id!==p.id||!allowedCodes.has(r.code)||
        !Number.isSafeInteger(r.at)||r.at<this.clock()-15000||r.at>this.clock()+5000)return false;
      if(r.code==='posted'&&r.provider!==p.provider)return false;
      if(r.provider&&r.provider!==p.provider)return false;
      this.finish(p,null,{code:r.code,provider:r.provider});return true;
    }
    finish(p,error,value){
      if(this.pending!==p)return;
      clearTimeout(p.timer);this.pending=null;
      if(error)p.reject(error);else p.resolve(value);
    }
    cancel(){
      this.epoch++;
      if(this.pending)this.finish(this.pending,new Error('Phone handoff view closed.'));
    }
  }
  const api={Handoff,payload};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.StudioWatchPhone=api;
})(globalThis);
;

// watch-library.js
'use strict';
// Parent-curated official creator/publisher links. Durations and playback availability are not inferred.
globalThis.STUDIO_WATCH_LIBRARY=Object.freeze([
  {provider:'youtube',videoId:'ENnEYoUpFfU',ti:'Fundamentals of Lighting in Blender',ch:'Blender Guru',why:'Light size, falloff, staging and color'},
  {provider:'youtube',videoId:'fxz6p-QATfs',ti:'The animation of Flow',ch:'Blender · BCON2024',why:'Feature animation production workflow'},
  {provider:'youtube',videoId:'8yHuJLeAAsA',ti:'Inklines Across the Spider-Verse',ch:'Blender / Sony Imageworks',why:'Linework and 3D shot breakdowns'},
  {provider:'youtube',videoId:'Tm2nn8OXFVk',ti:'A feature animation pipeline with a woolly look',ch:'Blender · BCON26',why:'Geometry Nodes grooming and lighting'},
  {provider:'youtube',videoId:'C-AjCqjKRSs',ti:'Profiling with Purpose',ch:'Unreal Engine',why:'Performance lessons from a real project'},
  {provider:'youtube',videoId:'1uFR9lXrpyQ',ti:'UE5 Optimization: Lighting & Shadows',ch:'Tom Looman',why:'Virtual shadow maps and light costs'},
  {provider:'youtube',videoId:'wL5Hf1hT6c4',ti:'Lessons from Optimizing Chaos',ch:'Unreal Engine',why:'Physics, threading and measured profiling'},
  {provider:'youtube',videoId:'SqPaL8HS_Lw',ti:'Everything You Wanted to Know About Substrate',ch:'Unreal Engine',why:'Material layering and migration'},
  {provider:'vimeo',videoId:'340544320',ti:'Advanced Vellum Workflows',ch:'SideFX / John Lynch',why:'Constraints and solver workflows · older H17 UI'},
  {provider:'vimeo',videoId:'999739285',ti:'MPM H20.5 Masterclass',ch:'SideFX',why:'Simulation workflow and example files'},
  {provider:'youtube',videoId:'w2Knw9bD06Y',ti:'Solaris/USD Workflows with Unreal',ch:'SideFX / Peter Arcara',why:'Non-destructive USD variants · 2022 UI'},
  {provider:'vimeo',videoId:'1125207167',ti:'MaterialX Introduction',ch:'SideFX / Peter Arcara',why:'Karma MaterialX concepts'},
  {provider:'youtube',videoId:'WigIALCnEvw',ti:'Timing animations',ch:'Remotion official resources',why:'Timing functions and playground examples'},
  {provider:'youtube',videoId:'uDqjIdI4bF4',ti:'12 Principles of Animation',ch:'Alan Becker Tutorials',why:'Timing, staging and arcs'},
  {provider:'youtube',videoId:'7A70hBrPL4I',ti:'Record and analyze a performance trace',ch:'Chrome Developers',why:'LCP, CLS and trace inspection'},
  {provider:'youtube',videoId:'KxjGYcHZ_uI',ti:'Override and mock network responses',ch:'Chrome Developers',why:'Local API and UI verification'}
].map(v=>Object.freeze({...v,id:'curated-'+v.provider+'-'+v.videoId,curated:true})));
;

// app.js
'use strict';
const APP_BUILD = 44; // Identity of this executing entry script, including offline launches.

// Bakar Home on Meta Ray-Ban Display: Claude and Codex sessions from the studio PC (Work), Bakar's glasses apps
// (Apps) and games kept apart from them (Games).
//
// The link: three free public MQTT brokers at once (EMQX, HiveMQ, and shiftr.io on port 443), the same link Tidal
// Glass and Bakar Studio use. No account, no daily cap, and any broker can be down without anything stopping. From
// Bakar's home network only shiftr.io answers reliably, so none of them waits for another. The PC keeps the latest
// session list retained there, so the list shows the moment a broker connects.
//
// Privacy: the brokers only carry ciphertext. The first time it runs, this page makes a P-256 key pair and keeps
// the private half in IndexedDB as a key that can't be exported. The PC accepts that key once, while a pairing
// window is open at the PC. Both sides then derive the same AES-GCM keys (ECDH + HKDF). The address carries only the
// topic and the PC's public key, so a copied link can't read or send anything.
//
// Battery: nothing runs while the app is hidden. On screen, the page keeps one connection per broker and says hello
// every 2.5 minutes so the PC keeps sending. After 90 seconds without a key press it closes the link (10 minutes
// while you watch a task you started). Times are clock times, so nothing ticks.

const BROKERS = [
  { url: 'wss://broker.emqx.io:8084/mqtt' },
  { url: 'wss://broker.hivemq.com:8884/mqtt' },
  { url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public' },
];
// A broker that connects late (or again) is also handed what went out in the last few seconds, so a hello that went
// only to a broker the PC isn't on still arrives. The PC drops the repeat by its id.
const RESEND_WINDOW = 10000;
const OUTBOX_MAX_AGE = 60 * 1000;   // the PC drops commands older than 90 seconds
const IDLE_MS = 90 * 1000;
const WATCH_MS = 10 * 60 * 1000;
const HELLO_MS = 150 * 1000;
const ANSWER_MS = 12 * 1000;
const DAILY_SENDS = 400;            // a safety valve against a runaway loop, not a budget
const HELP_OPTIONS = ['Give me THREE good options.', 'Unjumble this for me.'];

const SITE = 'https://baklarrrr.github.io/';
// The Apps and Games lists live in apps.json so another session can add an app or a game without touching this
// code. These are used when it can't be read.
let APPS = [
  { group: 'Studio', name: 'Bakar Studio', url: SITE + 'studio-glass/', why: 'Review pictures and check render progress', icon: 'studio-glass/icon-mono.svg', pass: 'sg' },
  { group: 'Faith', name: 'Quran Glass', url: SITE + 'quran-glass/', why: 'Read or follow a recitation word by word', icon: 'quran-glass/icon-mono.svg' },
  { group: 'Listening', name: 'TIDAL Glass', url: SITE + 'tidal-glass/', why: 'Music from your iPhone through the glasses', icon: 'tidal-glass/icon-mono.svg', pass: 'tg' },
  { group: 'Listening', name: 'Sound Lab', url: SITE + 'tidal-glass/sound/', why: 'Check the audio output on your iPhone', icon: 'tidal-glass/sound/icon-mono.svg', pass: 'tg' },
  { group: 'Driving', name: 'Bakar Drive', url: SITE + 'glass-home/drive/', why: 'GPS speed, heading and linked directions', icon: 'glass-home/drive/icon-mono.svg', pass: 'drive' },
  { group: 'Utilities', name: 'Battery', url: SITE + 'battery-glass/', why: 'Check the charge on your glasses', icon: 'battery-glass/icon-mono.svg', pass: 'tg' },
  { group: 'Activities', name: 'Gulzar', url: SITE + 'gulzar/', why: 'Guided cooking, crafts and drawing', icon: 'gulzar/icon-mono.svg' },
];
let GAMES = [];
const GLYPHS = {
  play: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect x='6' y='14' width='52' height='36' rx='9' fill='%23fff' opacity='.45'/%3E%3Cpath d='M27 23v18l15-9z' fill='%23fff'/%3E%3C/svg%3E",
  game: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cpath d='M18 20h28a12 12 0 0 1 11.6 15l-3 11a6 6 0 0 1-10.4 2L40 43H24l-4.2 5A6 6 0 0 1 9.4 46l-3-11A12 12 0 0 1 18 20z' fill='%23fff'/%3E%3C/svg%3E",
  app: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect x='10' y='10' width='44' height='44' rx='12' fill='%23fff'/%3E%3C/svg%3E",
};

const $ = (id) => document.getElementById(id);
const enc = (s) => new TextEncoder().encode(s);

// The address may carry its settings as ?query or #fragment. Nothing in it is secret (topic and the PC's public
// key), so the install link uses the query form, which every launcher keeps.
function addressParams() {
  const out = new URLSearchParams(location.search);
  for (const [k, v] of new URLSearchParams(location.hash.slice(1))) out.set(k, v);
  return out;
}

const S = {
  topic: '', relayPubB64: '', fragment: addressParams(), links: [], outbox: [], recent: [], linkId: '', sentLately: [],
  mqttTries: 0, mqttLoading: false, calmTimer: 0, tg: null, battery: null, tidalLast: '',
  devId: '', devPubB64: '', kUp: null, kDown: null, z: 0,
  snap: null, details: {}, view: 'list', tab: 'now', open: '',
  paused: true, idle: 0, hello: 0, answer: 0, askedAt: 0, heardAt: 0, quiet: false, hellos: [], pcAt: 0,
  pending: {}, pairing: null, flash: '', compose: null, openedAt: 0, lastKeyAt: 0,
};

// ---- bytes, storage --------------------------------------------------------------------------------

function fromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('glass-home', 1);
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

function local(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* storage can be unavailable; the app still works for this visit */ }
  return null;
}

// ---- keys ------------------------------------------------------------------------------------------

async function setupKeys() {
  let t = S.fragment.get('t');
  let p = S.fragment.get('p');
  if (t && p) await idbPut('pairing', { t, p }).catch(() => {});
  else {
    const saved = await idbGet('pairing').catch(() => null);
    if (saved) ({ t, p } = saved);
  }
  if (!t || !p || !window.crypto || !crypto.subtle) return false;
  S.topic = t;
  S.relayPubB64 = p;
  let dev = await idbGet('dev:' + t).catch(() => null);
  if (!dev) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    dev = { priv: pair.privateKey, pub: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
    await idbPut('dev:' + t, dev).catch(() => {});
  }
  S.devPubB64 = toB64url(dev.pub);
  S.devId = toB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', dev.pub))).slice(0, 16);
  const relay = await crypto.subtle.importKey('raw', fromB64url(p), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: relay }, dev.priv, 256);
  const ikm = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const derive = (dir, use) => crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc('glass-home v1'), info: enc(`${dir}|${S.devId}|${t}`) },
    ikm, { name: 'AES-GCM', length: 256 }, false, [use]);
  S.kUp = await derive('up', 'encrypt');
  S.kDown = await derive('down', 'decrypt');
  try { new DecompressionStream('deflate-raw'); S.z = 1; } catch (e) { S.z = 0; }
  return true;
}

async function inflate(bytes) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
  return new Uint8Array(await out.arrayBuffer());
}

async function openDown(text) {
  const [v, flag, blob] = String(text).trim().split('.');
  if (v !== '1' || !blob) return null;
  const raw = fromB64url(blob);
  let plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, S.kDown, raw.slice(12)));
  if (flag === 'z') plain = await inflate(plain);
  return JSON.parse(new TextDecoder().decode(plain));
}

async function send(c, extra = {}, options = {}) {
  if (!S.kUp) return '';
  const pairedKey=S.kUp,pairedTopic=S.topic,pairedPublic=S.devPubB64;
  if (options.guard && !options.guard()) throw new Error('Cancelled before sending. Your draft is kept.');
  const today = new Date().toDateString();
  const b = local('gh.sends') || {};
  const n = b.d === today ? (b.n || 0) : 0;
  if (n >= DAILY_SENDS) { flash('Too many messages today; check the PC'); return ''; }
  local('gh.sends', { d: today, n: n + 1 });
  const id = options.id || toB64url(crypto.getRandomValues(new Uint8Array(9)));
  if (c === 'hello') S.hellos = S.hellos.slice(-4).concat(id);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = enc(JSON.stringify({ c, id, ts: Date.now(), z: S.z, ...extra }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, S.kUp, body));
  if(options.noQueue&&(S.kUp!==pairedKey||S.topic!==pairedTopic||S.devPubB64!==pairedPublic))throw new Error('The paired connection changed before sending. Your draft is kept.');
  if (options.guard && !options.guard()) throw new Error('Cancelled before sending. Your draft is kept.');
  const sealed = new Uint8Array(12 + ct.length);
  sealed.set(iv, 0);
  sealed.set(ct, 12);
  const payload = `1.${S.devPubB64}.${toB64url(sealed)}`;
  const live = S.links.filter((l) => l.connected);
  if (!live.length && options.noQueue) throw new Error('Connection unavailable. Nothing was sent; your draft is kept.');
  if(options.noQueue){
    let queued=false;
    for(const client of live){try{options.onPublish?.();client.publish(`bkr/${S.topic}/u`,payload,{qos:1});queued=true;}catch(_){}}
    if(!queued)throw new Error('The connection did not confirm publication. Check the saved receipt before trying anything else.');
    return id; // Explicit requests never enter the automatic reconnect/replay buffer.
  }
  if (!live.length) {
    // Not connected this instant (just opened, or the glasses' network is waking): it goes out the moment a
    // broker connects. The PC drops a command it has already seen.
    S.outbox.push({ payload, at: Date.now() });
    openLink();
  } else {
    for (const l of live) l.publish(`bkr/${S.topic}/u`, payload, { qos: 1 });
    remember(payload);
  }
  return id;
}

// ---- link ------------------------------------------------------------------------------------------

function linkUp() {
  return S.links.some((l) => l.connected);
}

function linkChanged() {
  renderState();
}

function remember(payload) {
  S.sentLately.push({ payload, at: Date.now() });
  if (S.sentLately.length > 20) S.sentLately.shift();
}

// The link library is a large file. On the first launch after an update the previous offline copy of this app can
// give up on it before it arrives, so it is fetched again for about half a minute instead of waiting silently.
function loadMqtt() {
  if (S.mqttLoading || S.mqttTries >= 10) return;
  S.mqttLoading = true;
  S.mqttTries += 1;
  const tag = document.createElement('script');
  tag.src = `vendor/mqtt.min.js?try=${S.mqttTries}`;
  tag.onload = () => { S.mqttLoading = false; if (!S.paused) openLink(); };
  tag.onerror = () => { S.mqttLoading = false; tag.remove(); setTimeout(loadMqtt, 3000); };
  document.head.append(tag);
}

function openLink() {
  if (S.links.length || (!S.kUp && !S.tg)) return;
  if (typeof mqtt === 'undefined') { loadMqtt(); return; }
  S.linkId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  for (const b of BROKERS) addBroker(b);
}

// Retries are scheduled here, not by mqtt.js (reconnectPeriod 0). On 2026-10-25 a Tidal Glass page left open without
// signal on Bakar's glasses tried every broker about every 2 s for 8.5 minutes, which keeps the radio awake. Now: 1 s
// for the first three tries, then doubling to 30 s while nothing is connected; a broker that keeps failing while
// another carries the link backs off to 10 min. A connect, the network coming back ('online') or a new visit starts
// it fast again.
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
  }, retryDelay(client.fails, linkUp()));
}

// Connect timeout 6 s: the slowest good connect the glasses reported was 4.1 s, and a try that hangs costs the whole
// timeout before the next one.
function addBroker({ url, ...extra }) {
  // Random ids: shiftr.io shows client ids on a public dashboard.
  const client = mqtt.connect(url, {
    clientId: `ghg-${S.linkId}-${S.links.length}`, clean: true, keepalive: 45, protocolVersion: 4,
    reconnectPeriod: 0, connectTimeout: 6000, ...extra,
  });
  client.on('connect', () => {
    client.fails = 0;
    clearTimeout(client.retryTimer);
    client.retryTimer = 0;
    const topics = S.kUp ? [`bkr/${S.topic}/d/${S.devId}/s`, `bkr/${S.topic}/d/${S.devId}/m`] : [];
    if (S.tg) topics.push(`bkr/${S.tg.t}/s`); // Existing phone state: battery and correlated Watch handoff receipts
    client.subscribe(topics, { qos: 1 });
    // What already went out on the other brokers in the last few seconds goes on this one too.
    const now = Date.now();
    S.sentLately = S.sentLately.filter((o) => now - o.at < RESEND_WINDOW);
    for (const o of S.sentLately) client.publish(`bkr/${S.topic}/u`, o.payload, { qos: 1 });
    flushOutbox();
    linkChanged();
    if(S.tab==='drive')scheduleDriveReport();
    // Back after a drop: a hello the PC hasn't answered is asked again (the PC ignores a repeat).
    if (!S.paused && S.askedAt && S.heardAt < S.askedAt && now - S.askedAt > 3000) hello();
  });
  client.on('message', (t, payload) => {
    const text = new TextDecoder().decode(payload);
    if (S.tg && t === `bkr/${S.tg.t}/s`) handleTidal(text);
    else handle(text);
  });
  client.on('offline', linkChanged);
  client.on('close', () => { linkChanged(); scheduleRetry(client); });
  client.on('error', () => { /* a 'close' follows, and the retry is scheduled there */ });
  S.links.push(client);
  return client;
}

function closeLink() {
  const old = S.links;
  S.links = [];
  S.outbox = [];
  S.sentLately = [];   // a reopened link never resends an old hello
  for (const l of old) {
    clearTimeout(l.retryTimer);
    l.retryTimer = 0;
    try { l.end(true); } catch (e) { /* already closed */ }
  }
}

function flushOutbox() {
  const live = S.links.filter((l) => l.connected);
  if (!live.length) return;
  const now = Date.now();
  const due = S.outbox.filter((o) => now - o.at < OUTBOX_MAX_AGE);
  S.outbox = [];
  for (const o of due) {
    for (const l of live) l.publish(`bkr/${S.topic}/u`, o.payload, { qos: 1 });
    remember(o.payload);
  }
}

async function handle(text) {
  if (S.recent.includes(text)) return; // the same message from the other broker
  S.recent.push(text);
  if (S.recent.length > 24) S.recent.shift();
  let m;
  try { m = await openDown(text); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  // The retained list can be minutes old. A reply that names one of this visit's hellos is live, and so is anything
  // the PC wrote after that reply (by the PC's own clock, so the two clocks needn't agree).
  const live = Boolean(m.re && S.hellos.includes(m.re)) || (S.pcAt > 0 && (m.at || 0) >= S.pcAt);
  if (live) { S.heardAt = Date.now(); S.quiet = false; S.pcAt = Math.max(S.pcAt, m.at || 0); }
  if (m.t === 'snap') {
    if (!S.snap || m.at >= S.snap.at) {
      S.snap = m;
      showPush(m.say);
      if (S.pairing && live) closePairing();
      renderWork();
      if (S.view === 'detail') renderDetail();
    }
  } else if (m.t === 'det') {
    const old = S.details[m.k];
    if (!old || m.at >= old.at) {
      S.details[m.k] = m;
      if (S.view === 'detail' && S.open === m.k) renderDetail();
    }
  } else if (m.t === 'ack') {
    const done = S.pending[m.re];
    if (done) { delete S.pending[m.re]; done(m); }
  } else if (m.t === 'unpaired' && live) {
    showPairing(m.code);
  } else if (m.t === 'paired' && live) {
    closePairing();
    flash(`Paired · code ${m.code}`);
  }
  renderState();
}

// Yes/no facts about this browser, sent once per visit so the PC can record what the glasses support. Only whether
// the other apps' pairing exists here (shared storage), never its value.
function diagnostics() {
  if (S.diagSent) return undefined;
  S.diagSent = true;
  let sg = false;
  const tg = Boolean(passPairing('tg'));
  try { sg = Boolean(localStorage.getItem('sg.pair')); } catch (e) { /* none */ }
  return { ua: navigator.userAgent.slice(0, 160), sg, tg, ref: document.referrer ? new URL(document.referrer).pathname : '',
    z: S.z, idb: Boolean(window.indexedDB), w: innerWidth, h: innerHeight };
}

function hello() {
  S.askedAt = Date.now();
  const gps=S.tab==='drive'&&S.view==='list'&&!document.hidden?{...driveFeed.report(),build:APP_BUILD}:undefined;
  send('hello', { w: S.view === 'detail' ? S.open : '', d: diagnostics(), gps });
  clearTimeout(S.answer);
  S.answer = setTimeout(() => {
    if (S.heardAt < S.askedAt) { S.quiet = true; renderState(); }
  }, ANSWER_MS);
}

function wake() {
  if ((!S.kUp && !S.tg) || document.visibilityState !== 'visible') return;
  const was = S.paused;
  S.paused = false;
  armIdle();
  if (!was) return;
  S.askedAt = Date.now();
  openLink();
  hello();
  clearInterval(S.hello);
  S.hello = setInterval(hello, HELLO_MS);
  renderState();
}

function sleep(reason) {
  S.paused = true;
  if (reason === 'hidden') clearTimeout(S.renderStatusTimer);
  closeLink();
  if (reason === 'hidden') { clearTimeout(S.calmTimer); S.calmTimer = 0; }
  clearInterval(S.hello);
  clearTimeout(S.idle);
  clearTimeout(S.answer);
  renderState();
}

function watchingOwnTask() {
  const d = S.view === 'detail' && S.details[S.open];
  return Boolean(d && d.own && d.st === 'work');
}

function armIdle() {
  clearTimeout(S.idle);
  S.idle = setTimeout(() => sleep('idle'), watchingOwnTask() ? WATCH_MS : IDLE_MS);
}

// ---- other apps' pairings ----------------------------------------------------------------------------
// Studio's PC registration survives an update. A legacy phone registration does
// not identify the current iPhone. A new Android companion integration must
// explicitly supply its own Android bridge in the fragment, never the query.
function passPairing(name) {
  if (name === 'tg') {
    const bridge = new URLSearchParams(location.hash.slice(1)).get('androidBridge') || '';
    const [t, k] = bridge.split('~');
    return t && k ? { t, k } : null;
  }
  if (name !== 'sg') return null;
  const saved = local('gh.pass') || {};
  const incoming = S.fragment.get('sg');
  const studio = incoming && incoming.includes('~') ? incoming : saved.sg || '';
  const [t, k] = studio.split('~');
  if (t && k) {
    if (saved.sg !== studio) local('gh.pass', { ...saved, sg: studio });
    return { t, k };
  }
  // The embedded Review also stores its surviving Studio pairing on this origin.
  const review = local('sg.pair');
  return review && review.t && review.k ? { t: review.t, k: review.k } : null;
}

// ---- glasses battery -------------------------------------------------------------------------------
// The phone's Tidal Glass app reports the glasses' battery (5% steps) in Tidal Glass's retained state. With Tidal's
// pairing (above), Bakar Home reads state. Explicit parked Watch actions can also use the existing command topic. No Tidal pairing,
// or no battery in the state: no chip.

async function setupBattery() {
  const pair = passPairing('tg');
  if (!pair || !window.crypto || !crypto.subtle) return;
  try {
    const key = await crypto.subtle.importKey('raw', fromB64url(pair.k), 'AES-GCM', false, ['encrypt','decrypt']);
    S.tg = { t: pair.t, key };
  } catch (e) { S.tg = null; }
}

async function handleTidal(text) {
  if (!text || text === S.tidalLast) return; // the same state from the other broker
  S.tidalLast = text;
  let m;
  try {
    const buf = fromB64url(text.trim());
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, S.tg.key, buf.slice(12));
    m = JSON.parse(new TextDecoder().decode(plain));
  } catch (e) { return; }
  if (!m || m.t !== 'state') return;
  watchPhone.receive(m);
  if (S.battery && m.at && S.battery.at && m.at < S.battery.at) return;
  // gb/gc: the glasses (5% steps, charging); bb: the Neural Band, which the phone reads over Bluetooth.
  const gb = Number.isFinite(m.gb) ? m.gb : null;
  const bb = Number.isFinite(m.bb) ? m.bb : null;
  S.battery = gb != null || bb != null ? { gb, gc: Boolean(m.gc), bb, at: m.at || Date.now() } : null;
  renderBattery();
}

function renderBattery() {
  const b = S.battery;
  // A reading over 30 minutes old (the phone app stopped, say) is hidden rather than shown as current.
  const fresh = Boolean(b) && Date.now() - (b.at || 0) < 30 * 60 * 1000;
  const glasses = $('gbat');
  glasses.hidden = !fresh || b.gb == null;
  if (!glasses.hidden) {
    $('gbatText').textContent = `${b.gb}%`;
    $('gbatFill').setAttribute('width', String(Math.max(1, (13.4 * b.gb) / 100)));
    glasses.classList.toggle('charging', b.gc);
    glasses.classList.toggle('low', !b.gc && b.gb <= 15);
    glasses.setAttribute('aria-label', `Glasses battery ${b.gb}%${b.gc ? ', charging' : ''}`);
  }
  const band = $('bbat');
  band.hidden = !fresh || b.bb == null;
  if (!band.hidden) {
    $('bbatText').textContent = `${b.bb}%`;
    band.classList.toggle('low', b.bb <= 15);
    band.setAttribute('aria-label', `Neural Band battery ${b.bb}%`);
  }
}

// ---- calm: less light while nobody is touching it --------------------------------------------------
// After CALM_AFTER without a swipe or pinch on a list or a session, the page dims what doesn't need full light
// (see style.css). The first input wakes it at once and is handled as usual. One timer, reset by input; none while
// the app is hidden.
const CALM_AFTER = 15000;
const CALM_PANES = ['now', 'work', 'detail', 'watch', 'route', 'play', 'apps', 'games'];

function enterCalm() {
  const pane = PANES.find((p) => !$(p).hidden);
  if (CALM_PANES.includes(pane) && document.visibilityState === 'visible') document.body.classList.add('calm');
}

function wakeUp() {
  document.body.classList.remove('calm');
  clearTimeout(S.calmTimer);
  S.calmTimer = document.visibilityState === 'visible' ? setTimeout(enterCalm, CALM_AFTER) : 0;
}

// ---- words -----------------------------------------------------------------------------------------

const STATUS = { needs: 'Needs you', work: 'Working', done: 'Done', stop: 'Stopped' };
const PROVIDER = { c: 'Claude', x: 'Codex' };

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function age(sec) {
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// Explicit provider handoff. Posted confirms a phone notification, never playback or search results.
let watchViewEpoch=0;
const watchPhone=new StudioWatchPhone.Handoff({
  pair:()=>S.tg,
  active:()=>!document.hidden&&StudioParked.controlsAllowed()&&S.tab==='watch'&&(S.view==='list'||(S.view==='compose'&&S.compose?.mode==='yt')),
  ensureConnected:async current=>{
    wake();openLink();
    const until=performance.now()+2500;
    while(current()&&performance.now()<until){if(linkUp())return true;await new Promise(resolve=>setTimeout(resolve,20));}
    return false;
  },
  publish:(topic,body)=>{
    let sent=false;
    for(const client of S.links){if(!client.connected)continue;try{client.publish(topic,body,{qos:1,retain:false});sent=true;}catch(_){}}
    return sent;
  }
});
function cancelWatch(){watchViewEpoch++;watchPhone.cancel();}
async function handoffWatch(fields,note){
  if(watchPhone.pending)return;
  const epoch=++watchViewEpoch,compose=S.compose,view=S.view;
  note.hidden=false;note.textContent='Sending to your phone…';
  if(view==='compose')$('cSend').setAttribute('aria-disabled','true');
  try{
    const result=await watchPhone.request(fields);
    if(epoch!==watchViewEpoch||S.view!==view||S.compose!==compose||S.tab!=='watch'||document.hidden)return;
    note.textContent=result.code==='posted'?'Notification posted. Tap it on your phone to open '+(fields.kind==='search'?'YouTube search.':'the video. Playback has not started.'):
      result.code==='notifications-disabled'?'Your phone could not show its notification. Its existing notification setting is off.':
      result.code==='expired'?'The handoff expired before your phone accepted it. Try again.':'Your phone could not confirm this handoff. Check its notifications before trying again.';
  }catch(error){if(epoch===watchViewEpoch&&S.view===view&&S.compose===compose&&S.tab==='watch'&&!document.hidden)note.textContent=error.message;}
  finally{if(view==='compose'&&S.compose===compose)$('cSend').removeAttribute('aria-disabled');}
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// ---- drawing ---------------------------------------------------------------------------------------

function renderState() {
  const dot = $('dot');
  let text = '';
  let tone = '';
  if (S.flash) text = S.flash;
  else if (!S.kUp) text = '';
  else if (S.pairing) { text = 'Not paired'; tone = 'warn'; }
  else if (S.paused) text = S.snap ? `Paused · ${clock(S.snap.at)}` : 'Paused';
  else if (!linkUp() && !S.snap) text = 'Connecting…';
  else if (S.quiet && !S.snap) { text = 'PC not answering'; tone = 'warn'; }
  else if (!S.snap) text = 'Asking your PC…';
  else if (S.quiet) { text = `PC quiet · ${clock(S.snap.at)}`; tone = 'warn'; }
  else if (S.heardAt < S.askedAt) text = `Updating · ${clock(S.snap.at)}`;
  else { text = `Live · ${clock(S.snap.at)}`; tone = 'live'; }
  $('stateText').textContent = text;
  dot.className = 'dot' + (tone ? ' ' + tone : '');
}

function flash(text) {
  S.flash = text;
  renderState();
  clearTimeout(S.flashTimer);
  S.flashTimer = setTimeout(() => { S.flash = ''; renderState(); }, 4000);
}

function renderWork() {
  renderNow();
  renderWatch();
  renderRoute();
  const s = S.snap;
  const list = $('rows');
  const focusedKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : '';
  list.textContent = '';
  const sum = $('summary');
  sum.textContent = '';
  if (!S.kUp) {
    sum.textContent = 'Open Bakar Home from its existing link to see Claude and Codex.';
    return;
  }
  if (!s) {
    sum.textContent = S.paused ? 'Press any key to ask your PC.' : 'Asking your PC for Claude and Codex…';
    return;
  }
  const n = s.n || {};
  const parts = [];
  if (n.needs) parts.push(['needs', `${n.needs} need${n.needs === 1 ? 's' : ''} you`]);
  if (n.work) parts.push(['', `${n.work} working`]);
  if (n.done) parts.push(['', `${n.done} done`]);
  if (n.stop) parts.push(['', `${n.stop} stopped`]);
  if (!parts.length) sum.textContent = 'No Claude or Codex sessions in the last day.';
  parts.forEach(([cls, text], i) => {
    if (i) sum.append(' · ');
    sum.append(el('b', cls, text));
  });
  const can = s.can || {};
  $('newTask').hidden = !(can.new && can.new.length);
  (s.rows || []).forEach((r, i) => {
    const li = el('li');
    const why = r.st === 'work' && !r.why ? 'Working' : r.why;
    // The first session is the hero: the same row in the same place in the order, drawn with more presence.
    const b = el('button', `row ${r.st}${i === 0 ? ' hero' : ''}`);
    b.dataset.k = r.k;
    if (i === 0) {
      const kicker = el('span', 'kicker');
      const meta = el('span', 'km', ` · ${r.own ? 'Glasses · ' : ''}${PROVIDER[r.p]} · `);
      meta.append(el('span', 'ag', age(r.at)));
      kicker.append(el('span', 'st', STATUS[r.st]), meta);
      b.append(kicker, el('span', 'ti', r.ti), el('span', 'why', why));
    } else {
      b.append(el('span', `mark ${r.st}`), el('span', 'ti', r.ti), el('span', 'tag', (r.own ? 'Glasses · ' : '') + PROVIDER[r.p]));
      b.append(el('span', 'why', why), el('span', 'age', age(r.at)));
    }
    b.setAttribute('aria-label', `${r.ti}. ${PROVIDER[r.p]}. ${STATUS[r.st]}. ${r.why}`);
    b.addEventListener('click', () => openDetail(r.k));
    li.append(b);
    list.append(li);
  });
  if (s.more) list.append(el('li', 'empty', `${s.more} more on your PC`));
  if (focusedKey) {
    const again = list.querySelector(`[data-k="${CSS.escape(focusedKey)}"]`);
    if (again) again.focus({ preventScroll: true });
  } else if (!S.listShown && S.view === 'list' && S.tab === 'work' && !S.pairing) {
    // The first list after opening: start on the top session unless Bakar has already moved somewhere.
    const a = document.activeElement;
    if (!a || a === document.body || a.dataset.tab === 'work') focusFirst('work');
  }
  S.listShown = S.listShown || Boolean((s.rows || []).length);
}

// ---- now: the first screen -------------------------------------------------------------------------
// One hero and at most three quiet cards: what in Bakar's world needs him or is moving right now. Built from the
// session list plus the PC's glance (renders from the shared queue, open GreenCitizen site notes). The hero is the
// most pressing card; when nothing is, the screen says so and stays dark.

function ago(sec) {
  const a = age(sec);
  return a === 'now' ? 'just now' : `${a} ago`;
}

// A line short enough for one row on the glasses, cut between words.
function shortAt(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:·-]+$/, '')}…`;
}

function duration(sec) {
  if (!sec) return '';
  return sec < 90 ? `${sec} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} h`;
}

function openStudio() {
  selectTab('review');
}

// ---- messages from the PC (relay/push.py, MCP glasses_say) ------------------------------------------

function showPush(p) {
  if (S.tab === 'drive' || S.tab === 'route') return; // Never reveal or speak an incoming banner in Drive.
  if (!p || !p.id || p.id === S.pushed) return;
  S.pushed = p.id;
  const box = $('push');
  $('pushTitle').textContent = p.ti || '';
  $('pushText').textContent = p.tx || '';
  box.hidden = false;
  box.classList.remove('go');
  void box.offsetWidth;   // restart the light sweep for a second message
  box.classList.add('go');
  clearTimeout(S.pushTimer);
  S.pushTimer = setTimeout(() => { box.hidden = true; box.classList.remove('go'); }, 7000);
  if (p.sp && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance([p.ti, p.tx].filter(Boolean).join('. ')));
  }
}

function speakNote(text) {
  if (!('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  if (S.speaking === 'now') { stopReading(); return; }
  stopReading();
  const u = new SpeechSynthesisUtterance(text);
  u.onend = u.onerror = () => { if (S.speaking === 'now') S.speaking = ''; };
  S.speaking = 'now';
  synth.speak(u);
}

function renderObservation(r, now = Date.now() / 1000) {
  const observed = (x) => x && Number.isInteger(x.run) && x.run >= 0
    && Number.isFinite(x.checkedAt) && x.checkedAt > 0 && x.checkedAt <= now;
  const validFor = r && Number.isFinite(r.validFor) && r.validFor > 0 && r.validFor <= 120 ? r.validFor : 0;
  const trusted = r && r.state === 'ok' && observed(r);
  const known = Boolean(trusted && validFor && now - r.checkedAt < validFor);
  return { known, validFor,
    lastKnown: trusted ? r : r && observed(r.lastKnown) ? r.lastKnown : null,
    reason: trusted ? 'Last check is stale' : !r || r.error === 'Not checked yet' ? 'Awaiting a process check' : 'Process check unavailable' };
}

function scheduleRenderStatusRefresh() {
  clearTimeout(S.renderStatusTimer);
  S.renderStatusTimer = 0;
  if (document.visibilityState !== 'visible' || $('now').hidden || !S.snap) return;
  const r = (S.snap.g || {}).r;
  const observation = renderObservation(r);
  if (!observation.known && !observation.lastKnown) return;
  const delay = observation.known ? Math.min(60000, Math.max(1000, (r.checkedAt + observation.validFor - Date.now() / 1000) * 1000 + 10)) : 60000;
  // UI age/expiry only: no query, broker request or timer while this pane is hidden.
  S.renderStatusTimer = setTimeout(() => {
    if (document.visibilityState === 'visible' && !$('now').hidden) renderNow();
  }, delay);
}

function nowCards() {
  const s = S.snap;
  if (!s) return [];
  const g = s.g || {};
  const n = s.n || {};
  const rows = s.rows || [];
  const cards = [];
  const needs = rows.filter((r) => r.st === 'needs');
  if (needs.length) {
    const one = needs.length === 1;
    cards.push({ id: 'needs', st: 'needs', rank: 0, kick: 'Needs you',
      ti: one ? needs[0].ti : `${needs.length} sessions need you`,
      meta: one ? ` · ${PROVIDER[needs[0].p]} · ${age(needs[0].at)}` : '',
      why: one ? needs[0].why : needs.slice(0, 2).map((r) => r.ti).join(' · '),
      go: () => (one ? openDetail(needs[0].k) : selectTab('work')) });
  }
  const r = g.r;
  const observation = renderObservation(r);
  if (!observation.known) {
    const last = observation.lastKnown;
    cards.push({ id: 'render-status', st: 'stop', rank: 2.1, unknown: true,
      kick: observation.reason === 'Last check is stale' ? 'Stale' : 'Unknown', ti: 'Blender activity unknown',
      why: last ? `Last known: ${last.run} background job${last.run === 1 ? '' : 's'} · ${ago(last.checkedAt)}` : observation.reason,
      go: openStudio });
  }
  if (observation.known && r.run > 0) {
    // The longest-running job, named from its .blend, with how long it has run: the card moves on its own.
    const job = r.job || {};
    const running = job.since ? `Running ${duration(Math.max(1, Math.round(Date.now() / 1000 - job.since)))}` : 'Running';
    // A headless Blender run that isn't rendering frames (a bake, an export) is only "busy", and never the hero.
    const verb = job.busy ? 'Blender busy' : 'Rendering';
    cards.push({ id: 'render', st: 'work', rank: job.busy ? 2.2 : 1, kick: r.run === 1 ? verb : `${verb} · ${r.run} jobs`,
      ti: job.ti || 'Blender render',
      why: `${running}${r.last ? ` · last ${r.last.ok ? 'finished' : 'failed'}: ${r.last.ti}` : ''}`, go: openStudio });
  } else if (r && r.last) {
    cards.push({ id: 'render', st: r.last.ok ? 'done' : 'needs', rank: r.last.ok ? 3 : 0.5,
      kick: r.last.ok ? 'Last render' : 'Render failed', ti: r.last.ti,
      why: `${observation.known ? '0 background jobs · ' : ''}${r.last.ok ? 'Finished' : 'Stopped'} ${ago(r.last.at)}${r.last.sec ? ` · took ${duration(r.last.sec)}` : ''}`,
      go: openStudio });
  } else if (observation.known) {
    cards.push({ id: 'render', st: 'stop', rank: 3, kick: 'Checked', ti: 'No background Blender jobs',
      why: `Checked ${ago(r.checkedAt)}`, go: openStudio });
  }
  if (observation.known && r.run > 0 && r.last && r.last.ok === false) {
    cards.push({ id: 'render-history', st: 'needs', rank: 0.5, kick: 'Earlier render failed', ti: r.last.ti,
      why: `Stopped ${ago(r.last.at)}${r.last.sec ? ` · took ${duration(r.last.sec)}` : ''}`, go: openStudio });
  }
  if (n.work) {
    const w = rows.filter((x) => x.st === 'work');
    cards.push({ id: 'work', st: 'work', rank: 2, kick: 'Claude and Codex',
      ti: `${n.work} session${n.work === 1 ? '' : 's'} working`,
      why: w.length ? `Newest: ${w[0].ti}${w.length > 1 ? ` and ${w.length - 1} more` : ''}` : '', go: () => selectTab('work') });
  }
  // Site notes are steady background: they show beside anything else, and on a quiet screen only when one changed
  // in the last day, so "Nothing needs you" never sits above an old pile.
  const gc = g.gc;
  const fresh = gc && gc.up && Date.now() / 1000 - gc.up < 86400;
  if (gc && gc.open && (fresh || cards.some((c) => c.rank < 2.5))) {
    cards.push({ id: 'gc', st: 'done', rank: 2.5, kick: 'GreenCitizen · reads aloud',
      ti: `${gc.open} site note${gc.open === 1 ? '' : 's'} open`,
      why: gc.top ? shortAt(`${gc.pg ? gc.pg[0].toUpperCase() + gc.pg.slice(1) + ' · ' : ''}${gc.top.replace(/…$/, '')}`, 50) : '',
      go: () => speakNote(`GreenCitizen. ${gc.open} site notes open. Newest${gc.pg ? `, on ${gc.pg}` : ''}: ${gc.top || ''}`) });
  }
  cards.sort((a, b) => a.rank - b.rank);
  return cards.slice(0, 4);
}

function renderNow() {
  clearTimeout(S.renderStatusTimer);
  const list = $('nowRows');
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.now : '';
  list.textContent = '';
  const line = $('nowLine');
  if (!S.kUp) { line.textContent = 'Open Bakar Home from its existing link to see your studio.'; return; }
  if (!S.snap) { line.textContent = S.paused ? 'Press any key to ask your PC.' : 'Asking your PC…'; return; }
  const cards = nowCards();
  const calm = !cards.length || cards[0].rank >= 2;
  line.textContent = calm ? (cards.some((c) => c.unknown) ? 'Some activity is unknown.' : 'Nothing needs you right now.') : '';
  line.hidden = !calm;
  scheduleRenderStatusRefresh();
  cards.forEach((c, i) => {
    const li = el('li');
    const hero = i === 0 && !calm;
    const b = el('button', `row ${c.st}${hero ? ' hero' : ''}`);
    b.dataset.now = c.id;
    if (hero) {
      const kicker = el('span', 'kicker');
      kicker.append(el('span', 'st', c.kick));
      if (c.meta) kicker.append(el('span', 'km', c.meta));
      b.append(kicker, el('span', 'ti', c.ti), el('span', 'why', c.why));
    } else {
      // A quiet card's line is cut between words to fit beside its tag; the full text is in its label and read aloud.
      b.append(el('span', `mark ${c.st}`), el('span', 'ti', c.ti), el('span', 'tag', c.kick), el('span', 'why', shortAt(c.why, 54)), el('span', 'age', ''));
    }
    b.setAttribute('aria-label', `${c.kick}. ${c.ti}. ${c.why}`);
    b.addEventListener('click', c.go);
    li.append(b);
    list.append(li);
  });
  if (focused && document.visibilityState === 'visible' && !$('now').hidden) {
    const again = list.querySelector(`[data-now="${CSS.escape(focused)}"]`)
      || list.querySelector('[data-now="render-status"]') || list.querySelector('button');
    if (again) again.focus({ preventScroll: true });
  } else if (S.view === 'list' && S.tab === 'now' && !S.pairing && !S.nowShown) {
    const a = document.activeElement;
    if (!a || a === document.body || a.dataset.tab === 'now') focusFirst('now');
  }
  S.nowShown = S.nowShown || cards.length > 0;
}

// ---- watch: YouTube on the glasses ---------------------------------------------------------------
// The list lives on the PC (relay/youtube.py): videos shared from the phone, or the newest from chosen channels.
// Playback is YouTube's own embedded player; this page only drives it with the arrows and Enter, and tells the PC where
// he stopped so the next visit picks up there. Meta's driving detection keeps the display off at driving speed.

function clockTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// ---- route: a parked preview, drawn from relay/route.py ---------------------------------------------

function fitDistance(km) { return km < 1 ? `${Math.round(km * 1000)} m` : `${km} km`; }

function renderRoute() {
  const r = (S.snap && S.snap.rt) || {};
  const line = $('routeLine');
  const map = $('routeMap');
  const list = $('routeRows');
  if (!r.id) {
    map.setAttribute('hidden', '');   // an svg has no .hidden property
    list.textContent = '';
    line.textContent = S.snap ? 'No route yet. Ask an AI or use Send route on your PC. This is for planning, before you set off.' : 'Asking your PC for your route…';
    return;
  }
  const hours = Math.floor(r.min / 60);
  line.textContent = `Saved preview: ${r.ti}. ${r.km} km, ${hours ? `${hours} h ` : ''}${r.min % 60} min. No live guidance or traffic.`;
  if (S.routeShown === r.id) return;
  S.routeShown = r.id;
  map.removeAttribute('hidden');
  const path = r.pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
  for (const id of ['routeTrace', 'routeGlow']) $(id).setAttribute('d', path);
  const end = r.pts[r.pts.length - 1];
  $('routeEnd').setAttribute('cx', end[0]);
  $('routeEnd').setAttribute('cy', end[1]);
  placeRouteDot(r.steps[0]);
  map.classList.remove('draw');
  void map.getBoundingClientRect();   // restart the line drawing itself on for a new route
  map.classList.add('draw');
  list.textContent = '';
  r.steps.forEach((s, i) => {
    const li = el('li');
    const b = el('button', 'row step');
    b.dataset.s = i;
    b.append(el('span', 'ti', s.t), el('span', 'tag', fitDistance(s.km)));
    b.setAttribute('aria-label', `${s.t}. ${fitDistance(s.km)}`);
    li.append(b);
    list.append(li);
  });
}

function placeRouteDot(s) {
  if (!s) return;
  $('routeDot').setAttribute('transform', `translate(${s.x} ${s.y})`);
}

// ---- drive: reported phone GPS speed, never a vehicle instrument or a sample -------------------------
const DRIVE_PHONE_LABELS=Object.freeze({
  off:'Phone link stopped in this app', unpaired:'Phone link not set up', paused:'Phone link paused',
  live:'Phone GPS through Journal', stale:'Phone speed expired', 'no-sample':'Phone linked · no fresh GPS speed',
  pairing:'Compare the code on your phone', ready:'Phone linked · waiting for GPS',
  waiting:'Waiting for your phone', connecting:'Connecting to your phone', offline:'Phone link unavailable',
  unavailable:'Secure phone link unavailable'
});
const drivePhone = typeof StudioDrivePhone!=='undefined'?new StudioDrivePhone.Phone({change:()=>paintDrive(driveFeed.snapshot())}):{
  enabled:false,snapshot:()=>({state:'unavailable',configured:false,gps:null,nav:null,offer:false,code:''}),
  setup:async()=>false,setVisible(){},setEnabled(){},cancelChoice(){},acceptOffer:async()=>false,keepCurrent(){}
};
// Compass tape and saved-route guidance (drive/guide.js). The guide is handed each fix as it arrives and keeps only how far
// along the saved route it is; the position is not stored and nothing is sent. A missing module leaves Drive as it was.
const driveGuide = typeof DriveGuide!=='undefined'?new DriveGuide.Guide():null;
// Fixed-camera warning (drive/cameras.js): a red light or speed camera on the road ahead, from a public list shipped with
// the app (drive/cameras.json). Worked out here from each fix; nothing about the position is kept or sent.
const driveCams = typeof DriveCameras!=='undefined'?new DriveCameras.Watch():null;
let driveCamsAsked=false,driveCamsFailed=false;
// What the Drive face must admit about the list, or '': it could not be loaded, or it is more than 30 days old.
function driveCamsNote(){return !driveCams?'':driveCamsFailed&&!driveCams.count?'no camera list':driveCams.staleNote().replace(/^C/,'c');}
function loadDriveCameras() {
  if(!driveCams||driveCamsAsked)return;
  driveCamsAsked=true;
  fetch('drive/cameras.json').then(r=>r.ok?r.json():Promise.reject()).then(file=>{driveCams.load(file);driveCamsFailed=!driveCams.count;})
    .catch(()=>{driveCamsAsked=false;driveCamsFailed=true;});   // a miss is tried again next time Drive opens, and the face says there is no list
}
let driveTapeShown='';
function paintDriveTape(course) {
  const svg=$('driveTape'); if(!svg?.style)return;
  const t=driveGuide?DriveGuide.tape(Number.isFinite(course)?course:NaN):null,key=t?String(Math.round(course*2)/2):'';
  svg.style.visibility=t?'visible':'hidden';
  svg.setAttribute('aria-label',t?`Compass: heading ${t.point}, ${t.deg} degrees`:'Compass: no heading while stopped');
  if(key===driveTapeShown)return;
  driveTapeShown=key; svg.textContent='';
  if(!t)return;
  const make=(name,attrs,text)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',name);for(const k in attrs)n.setAttribute(k,attrs[k]);if(text)n.textContent=text;svg.append(n);};
  for(const k of t.ticks){
    const x=(k.x*150).toFixed(1),fade=k.north?1:(1-Math.abs(k.x)*.35).toFixed(2);   // the edges dim a little; north never does
    make('line',{x1:x,x2:x,y1:9,y2:k.major?19:15,class:k.north?'major north':k.major?'major':'',opacity:fade});
    if(k.label&&Math.abs(k.x)>.36)make('text',{x,y:40,class:k.north?'north':'',opacity:fade},k.label);   // the middle belongs to the readout
  }
  make('path',{d:'M-6 0H6L0 8Z',class:'needle'});
  make('text',{x:0,y:41,class:'readout'},t.readout);
}
const driveFeed = new StudioDriveLocation.Feed({
  geo:navigator.geolocation, permissions:navigator.permissions,
  // Each fix goes to the guide (course, saved route, a speed where the device reports none) and to the camera watch.
  transform:position=>{
    if(!driveGuide)return position;
    driveGuide.fix(position);
    const seen=driveGuide.fill(position);
    driveCams?.fix(position,driveGuide.course(seen.coords),seen.coords.speed);
    return seen;
  },
  change:paintDrive
});
const driveCheck = typeof SpeedCheck!=='undefined'?SpeedCheck:null;
const DRIVE_STATUS_LABELS=Object.freeze({
    off:'GPS stopped', error:'Location provider error', unsupported:'Location API unavailable',
    waiting:'Finding your location…', unavailable:'GPS has no speed reading',
    invalid:'GPS reading unavailable', inaccurate:'GPS signal too weak',
    stale:'GPS reading expired', denied:'Location permission not granted',
    timeout:'GPS request timed out', 'no-response':'No GPS response yet', disconnected:'No GPS fix yet',
    paused:'App GPS paused'
  });
// Only the already-paired private workstation receives these coarse facts.
let driveReportTimer=0,lastDriveReport='',lastDriveReportAt=-Infinity;
const driveBursts=[],driveMilestones=new Set();
function scheduleDriveReport(){
  if(S.tab!=='drive'||S.view!=='list'||document.hidden||!S.kUp||!driveFeed.visible)return;
  const report=driveFeed.report(),now=performance.now();
  const signature=[report.status,report.source,report.reason,report.coordinates,report.fresh,report.accurate,
    Math.min(report.positions,2),report.error,report.held].join('|');
  if(signature===lastDriveReport)return;
  while(driveBursts.length&&now-driveBursts[0]>=60000)driveBursts.shift();
  const milestone=!lastDriveReport?'entry':report.positions>0&&!driveMilestones.has('fix')?'fix':
    (report.status==='timeout'||report.status==='denied')?report.status:'';
  const urgent=milestone&&!driveMilestones.has(milestone);
  const delay=driveBursts.length>=6?60000-(now-driveBursts[0]):urgent?0:3000-(now-lastDriveReportAt);
  clearTimeout(driveReportTimer);driveReportTimer=0;
  if(delay>0){driveReportTimer=setTimeout(scheduleDriveReport,Math.ceil(delay));return;}
  if(!S.paused&&!linkUp()){openLink();return;} // connect events recheck the current state.
  if(milestone)driveMilestones.add(milestone);
  lastDriveReport=signature;lastDriveReportAt=now;driveBursts.push(now);
  if(S.paused)wake();else hello(); // wake sends its own authenticated hello immediately.
}
function resetDriveReport(){
  clearTimeout(driveReportTimer);driveReportTimer=0;lastDriveReport='';driveMilestones.clear();
}
function paintDrive(reading) {
  const phone=drivePhone.snapshot(),pg=phone.gps;
  // The course: the phone's, else the one the location reports, else the one worked out from movement (drive/guide.js).
  const course=pg?pg.hdg:Number.isFinite(reading.heading)?reading.heading:reading.status==='live'&&reading.speed>=7.2&&driveGuide?driveGuide.course():null;   // 7.2 km/h is the feed's own 2 m/s: slower than that there is no course
  if($('driveHeading'))$('driveHeading').textContent=driveGuide&&$('driveTape')?.style?'':Number.isFinite(course)?['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(course/22.5)%16]:'';
  let guide=null;
  const nav=phone.nav,words={NO_TURN:'Straight on',GO_STRAIGHT:'Straight on',TURN_RIGHT:'Turn right',TURN_LEFT:'Turn left',TURN_SLIGHT_RIGHT:'Bear right',TURN_SLIGHT_LEFT:'Bear left',TURN_SHARP_RIGHT:'Sharp right',TURN_SHARP_LEFT:'Sharp left',U_TURN_LEFT:'U-turn',U_TURN_RIGHT:'U-turn',ENTER_ROUND_ABOUT:'Roundabout',LEAVE_ROUND_ABOUT:'Leave roundabout',STAY_ON_ROUND_ABOUT:'Roundabout',START_AT_THE_END_OF_STREET:'To the end of the street',REACHED_YOUR_DESTINATION:'Destination',EXIT_HIGHWAY_TO_RIGHT:'Exit right',EXIT_HIGHWAY_TO_LEFT:'Exit left'};
  if($('driveTurn')){
    const route=nav&&['OnRoute','OffRoute','RouteRebuilding','RouteNeedsRebuild','RouteNotStarted'].includes(nav.ss);
    $('driveTurn').textContent=route?[nav.sim?'Preview':null,({OffRoute:'Off route',RouteRebuilding:'Rerouting',RouteNeedsRebuild:'Rerouting',RouteNotStarted:'Route ready'})[nav.ss],nav.toTurn,words[nav.turn],nav.next||nav.street].filter(Boolean).join(' · '):'';
    // No directions from a phone: the next turn along the route the PC saved, if the glasses are on it (drive/guide.js).
    driveGuide?.setRoute(S.snap&&S.snap.rt);
    // Only beside a live reading. Without one the last turn must not sit there: it says paused, or nothing once GPS is off.
    const seen=!route&&driveGuide?driveGuide.snapshot():null;
    guide=seen?DriveGuide.words(reading.status==='live'||seen.state==='none'?seen:{state:driveFeed.enabled?'paused':'none'}):null;
    if(guide?.turn){
      const line=$('driveTurn');line.textContent=guide.turn;
      if(guide.dist&&line.replaceChildren){   // the distance is the part that changes: it gets its own weight, larger when the turn is close
        const dist=document.createElement('span');dist.className=guide.near?'dist near':'dist';dist.textContent=guide.dist;
        line.replaceChildren(dist,guide.turn.slice(guide.dist.length));
      }
    }
    $('driveTurn').dataset.level=guide?.turn?guide.level:'ok';
    $('driveTurn').hidden=!$('driveTurn').textContent;
  }
  paintDriveTape(course);
  if(reading.status==='live'&&!pg)driveRemember('1');
  else if(reading.status==='waiting'&&!drivePreference())driveRemember('asked');
  else if(reading.status==='denied'&&!driveHeld())driveRemember('denied');
  const live=Boolean(pg)||reading.status==='live';
  $('driveSpeed').textContent=pg?String(pg.kmh):reading.status==='live'?String(Math.round(reading.speed)):'—';
  // Self-check (drive/speed-check.js): with no speed on screen, a definite fault and nothing healthy behind it is said
  // in plain words and shown amber. Calm states keep the words below; a missing module leaves the old wording alone.
  const check=driveCheck?driveCheck.check({phoneFresh:Boolean(pg),gpsStatus:reading.status,link:driveCheck.fromStudio(phone)}):null;
  const phoneFault=!live&&phone.configured&&phone.enabled&&['stale','offline','unavailable'].includes(phone.state);
  $('driveState').textContent=pg?'Phone link · GPS estimate':reading.status==='live'?(reading.source==='estimated'?'Speed estimated from positions':'App location · GPS estimate'):
    (reading.status==='unavailable'&&driveFeed.report().fresh&&driveFeed.report().coordinates?'Location found · measuring speed':null)||check?.text||(phone.configured&&phone.enabled?(DRIVE_PHONE_LABELS[phone.state]||'Phone speed unavailable'):
    (DRIVE_STATUS_LABELS[reading.status]||'Speed unavailable'));
  $('driveHud').dataset.level=check?.level==='warn'||phoneFault?'warn':'ok';
  // A fixed camera on the road ahead takes the top line while the glasses' own reading is live: what it is and how far.
  const camera=driveCams&&reading.status==='live'&&!pg?DriveCameras.words(driveCams.snapshot(),reading.speed):null;
  if(camera)$('driveState').textContent=camera.text;
  $('driveHud').dataset.camera=camera?(camera.over?'over':'ahead'):'none';
  const age=pg?phone.ageMs:reading.ageMs;
  // An old camera list says so here, in amber, until a fresh one is published: a quiet screen must not look like a clear road.
  // The fix's own age stays; the list's trouble is added after it.
  const oldList=!guide?.note&&live?driveCamsNote():'';
  $('driveAge').textContent=guide?.note||(live?(age<1000?'Just now':Math.floor(age/1000)+' s ago')+(oldList?' · '+oldList:''):'');
  $('driveAge').dataset.level=oldList?'warn':'ok';
  $('driveHud').dataset.status=live?'live':reading.status;
  $('driveGps').textContent=driveFeed.enabled?'Stop app GPS':'Start app GPS';
  $('driveGps').disabled=reading.status==='unsupported';
  const retry=$('driveRetry');
  const canRetry=driveFeed.enabled&&['timeout','no-response','disconnected','stale','invalid','inaccurate'].includes(reading.status);
  retry.hidden=!canRetry&&document.activeElement!==retry;
  const permission=driveFeed.details().permission;
  HomeShell.setLocationPending(driveFeed.enabled&&['waiting','no-response'].includes(reading.status)&&permission!=='granted');
  if(!$('driveInfo').hidden)paintDriveDetails();
  if(S.tab==='drive')scheduleDriveReport();
}
function toggleDriveGps() {
  if(HomeShell.driveQuiet()||S.tab!=='drive'||document.hidden)return;
  driveStopped=driveFeed.enabled;
  if(driveFeed.enabled){driveRemember('0');driveFeed.stop();} else {driveRemember('asked');driveFeed.enable();}
}
function retryDriveGps() {
  if(HomeShell.driveQuiet()||S.tab!=='drive'||document.hidden||$('driveRetry').hidden)return;
  driveFeed.enable(); // Replaces one watch, only on this deliberate press.
}
function paintDriveDetails() {
  const f=driveFeed.details(),last=f.lastFix,error=f.lastError,status=f.status,phone=drivePhone.snapshot();
  const sample=driveFeed.report();
  if($('drivePhoneState')){
  $('drivePhoneState').textContent=DRIVE_PHONE_LABELS[phone.state]||'Phone link unavailable';
  $('drivePhoneCode').textContent=phone.configured&&['pairing','waiting','ready','connecting'].includes(phone.state)?'Pairing code: '+phone.code:'';
  $('drivePhoneToggle').textContent=phone.enabled?'Stop phone link':'Resume phone link';
  $('drivePhoneToggle').disabled=!phone.configured;
  $('drivePhoneUse').hidden=$('drivePhoneKeep').hidden=!phone.offer;
  }
  // Details can stay open indefinitely: use acquisition time rather than an age
  // that would freeze when the expired feed stops its refresh timer.
  const fixTime=last?.at==null?'time unknown':new Date(last.at).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const fix=last?fixTime+' · accuracy '+(last.accuracy==null?'unknown':Math.round(last.accuracy)+' m')+' · speed '+(last.speedPresent?'reported':'absent'):'none';
  const errorName=error?({1:'Denied',2:'Unavailable',3:'Timeout'}[error.code]||'Unknown'):'none';
  const errorTime=error?' '+new Date(error.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'';
  let policy='unknown';
  try {const p=document.permissionsPolicy||document.featurePolicy;if(p?.allowsFeature)policy=p.allowsFeature('geolocation')?'allowed':'blocked';}catch(_){}
  $('driveFacts').textContent=[
    'Bakar Home v'+APP_BUILD+' · '+(f.watchActive?'watch active':'watch stopped')+' · '+(f.visible?'page visible':'page hidden'),
    'Now: '+(status==='live'?'Phone GPS speed received':DRIVE_STATUS_LABELS[status]||'Speed unavailable'),
    'Fresh positions: '+f.positionFixes+' · callbacks: '+f.fixes+' · starts: '+f.attempts,
    'Last fix: '+fix+(last?' · position '+(sample.coordinates?'present':'missing'):''),
    driveCams?(driveCamsFailed&&!driveCams.count?'Cameras: the list could not be loaded':driveCams.about()):'Cameras: not available',
    'Last API error: '+errorName+errorTime+(error?' (#'+error.attempt+')':''),
    'Web permission: '+f.permission+' · policy: '+policy,
    'Secure page: '+(window.isSecureContext===true?'yes':window.isSecureContext===false?'no':'unknown')
  ].join('\n');
  const help={
    off:'This page has not started a location request. It does not read Android’s GPS switch. Start app GPS here, or use the paired Journal phone link.',
    denied:'Open the glasses’ Web App menu → Permissions. Check this app’s location access, then return and press Start GPS.',
    timeout:'No fix within 10 seconds. The watch is still listening. Retry starts a new request.',
    'no-response':'The location provider has not called back. Check for an outstanding app permission prompt. Retry replaces the request.',
    unavailable:'A position arrived without speed. Nothing is converted to zero.',
    inaccurate:'The returned position exceeds this app’s 50 m accuracy filter.',
    stale:'The last usable speed expired after five seconds.',
    disconnected:'The location provider could not supply a fix. This does not establish that the phone is disconnected.',
    unsupported:'This runtime has not supplied the geolocation API.'
  };
  $('driveHelp').textContent=help[status]||'“Now” is current. The last API error may be from an earlier request. No coordinates or raw error text are saved or sent.';
}
function syncDriveFeed(gesture=false) {
  const visible=S.tab==='drive'&&S.view==='list'&&!$('drive').hidden&&!document.hidden;
  if(visible!==driveFeed.visible)resetDriveReport();
  const pref=drivePreference();
  if(!visible&&driveFeed.visible)driveGuide?.clearMotion?.();
  const fromWearer=visible && gesture===true && !driveStopped && pref!=='0' && pref!=='denied';
  driveFeed.setVisible(visible,{autoStart:!driveStopped&&pref!=='0',resumeOnly:pref==='asked'||pref==='denied',gesture:fromWearer});
  drivePhone.setVisible(visible);
  if(visible)scheduleDriveReport();
  if(visible)loadDriveCameras();
}
let driveStopped=false;
const DRIVE_REMEMBER='bakar.drive.gps';
function drivePreference(){try{return localStorage.getItem(DRIVE_REMEMBER);}catch(_){return null;}}
function driveHeld(){return drivePreference()==='0';}
function driveRemember(value){try{if(drivePreference()!==value)localStorage.setItem(DRIVE_REMEMBER,value);}catch(_){}}
document.addEventListener('visibilitychange',syncDriveFeed);
window.addEventListener('pagehide',()=>{resetDriveReport();driveGuide?.clearMotion?.();driveFeed.setVisible(false);drivePhone.setVisible(false);});
window.addEventListener('pageshow',syncDriveFeed);
// Light: the display adds to whatever is behind it, so a bright sky needs solid, simple shapes and a dark road needs
// far less light. Auto follows the sun at Toronto's latitude; pressing the button picks one by hand and it's remembered.
const DRIVE_LIGHTS = ['auto', 'day', 'dusk', 'night'];

function sunLight(when = new Date()) {
  const day = (when - new Date(when.getFullYear(), 0, 0)) / 86400000;
  const tilt = -23.44 * Math.cos(2 * Math.PI * (day + 10) / 365) * Math.PI / 180;
  const lat = 43.7 * Math.PI / 180;
  const halfDay = Math.acos(Math.max(-1, Math.min(1, -Math.tan(lat) * Math.tan(tilt)))) * 12 / Math.PI;
  const zone = -when.getTimezoneOffset() / 60;
  const noon = 12 + zone + 79.4 / 15;            // Toronto's longitude
  const hour = when.getHours() + when.getMinutes() / 60;
  const fromNoon = Math.abs(hour - noon);
  if (fromNoon < halfDay - 0.75) return 'day';
  return fromNoon < halfDay + 0.75 ? 'dusk' : 'night';
}

function applyDriveLight() {
  let pick = 'auto';
  try { pick = localStorage.getItem('driveLight') || 'auto'; } catch (e) { /* private window: stay on Auto */ }
  $('driveHud').dataset.light = $('drive').dataset.light = pick === 'auto' ? sunLight() : pick;
  $('driveLight').textContent = `Light: ${pick[0].toUpperCase()}${pick.slice(1)}`;
}

function nextDriveLight() {
  let pick = 'auto';
  try { pick = localStorage.getItem('driveLight') || 'auto'; } catch (e) { /* stays on Auto */ }
  const next = DRIVE_LIGHTS[(DRIVE_LIGHTS.indexOf(pick) + 1) % DRIVE_LIGHTS.length];
  try { localStorage.setItem('driveLight', next); } catch (e) { /* forgotten next launch, which is fine */ }
  applyDriveLight();
}

function renderWatch() {
  const list = $('watchRows');
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.v : '';
  list.textContent = '';
  const found = S.ytFound;
  const shared = (S.snap && S.snap.yt) || [];
  const items = found || [...STUDIO_WATCH_LIBRARY,...shared];
  const line = $('watchLine');
  line.hidden = false;
  line.textContent = found ? found.length+' PC results. Back returns to the list.' : STUDIO_WATCH_LIBRARY.length+' studio lessons. Provider videos open on your phone.';
  items.forEach((v) => {
    const li = el('li');
    const started = v.pos > 5;
    const left = v.len ? Math.max(0, v.len - v.pos) : 0;
    const b = el('button', `row ${started ? 'work' : 'done'}`);
    b.dataset.v = v.id;
    const status = v.curated ? (v.provider==='vimeo'?'Vimeo · Phone':'YouTube · Phone') : started ? (left ? `${Math.max(1, Math.round(left / 60))} min left` : `at ${clockTime(v.pos)}`) : (v.src === 'feed' ? 'New' : 'Saved');
    b.append(el('span', `mark ${started ? 'work' : 'done'}`), el('span', 'ti', v.ti || 'YouTube video'), el('span', 'tag', status),
      el('span', 'why', [v.ch,v.curated&&v.why].filter(Boolean).join(' · ')), el('span', 'age', ''));
    b.setAttribute('aria-label', `${v.ti || 'YouTube video'}. ${v.ch || ''}. ${status}`);
    b.addEventListener('click', () => { if(v.curated){handoffWatch({kind:'video',provider:v.provider,videoId:v.videoId},$('watchPhoneNote'));return;} if (found) send('ytadd', { u: `https://youtu.be/${v.id}` }); openPlayer(v); });
    li.append(b);
    list.append(li);
  });
  if (focused) {
    const again = list.querySelector(`[data-v="${CSS.escape(focused)}"]`);
    if (again) again.focus({ preventScroll: true });
  }
}

let YT_READY = null;
function loadYouTube() {
  if (!YT_READY) {
    YT_READY = new Promise((resolve, reject) => {
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { YT_READY = null; reject(new Error('YouTube could not load')); };
      document.head.append(s);
    });
  }
  return YT_READY;
}

const SPEEDS = [1, 1.25, 1.5, 2];

async function openPlayer(v) {
  S.video = v;
  S.view = 'play';
  history.pushState({ v: 'play', id: v.id }, '');
  showPane('play');
  $('pvTitle').textContent = v.ti || 'YouTube video';
  $('pvTime').textContent = v.ch || '';
  $('pvNote').textContent = 'Loading…';
  $('pvPlay').focus();
  armIdle();
  try {
    const YT = await loadYouTube();
    if (S.view !== 'play' || S.video !== v) return;
    const start = v.len && v.pos > v.len - 15 ? 0 : Math.floor(v.pos || 0);
    if (S.player && S.player.loadVideoById) {
      S.player.loadVideoById({ videoId: v.id, startSeconds: start });
    } else {
      S.player = new YT.Player('ytPlayer', {
        width: 600, height: 338, videoId: v.id,
        playerVars: { autoplay: 1, start, playsinline: 1, controls: 0, disablekb: 1, rel: 0, fs: 0, iv_load_policy: 3, origin: location.origin },
        events: {
          onReady: (e) => { e.target.setPlaybackRate(SPEEDS[S.speedAt || 0]); e.target.playVideo(); },
          onStateChange: playerState,
          onError: () => { $('pvNote').textContent = 'YouTube won’t play this one on the glasses (the owner may block embedding).'; },
        },
      });
      const frame = $('ytWrap').querySelector('iframe');
      if (frame) frame.tabIndex = -1;   // the arrows stay with this page's controls
    }
    $('pvNote').textContent = 'Enter pauses · ← → choose · ↑ ↓ jump 10 s · Back keeps your place';
  } catch (e) {
    $('pvNote').textContent = 'YouTube didn’t load. Check the glasses’ connection and try again.';
  }
}

function playerState(e) {
  const playing = e.data === 1;
  $('pvPlay').textContent = playing ? 'Pause' : 'Play';
  clearInterval(S.pvTick);
  if (playing) S.pvTick = setInterval(tickPlayer, 1000);
  tickPlayer();
  if (e.data === 2) savePosition();          // paused
  if (e.data === 0) savePosition(true);      // ended
}

function tickPlayer() {
  const p = S.player;
  if (!p || !p.getCurrentTime) return;
  const t = p.getCurrentTime() || 0;
  const len = p.getDuration() || 0;
  $('pvTime').textContent = `${clockTime(t)} / ${clockTime(len)}${S.video && S.video.ch ? ` · ${S.video.ch}` : ''}`;
  $('pvBar').style.transform = `scaleX(${len ? Math.min(1, t / len) : 0})`;
  if (Date.now() - (S.savedAt || 0) > 30000) savePosition();
  armIdle();   // watching counts as using the page
}

function savePosition(done) {
  const p = S.player;
  if (!p || !p.getCurrentTime || !S.video) return;
  S.savedAt = Date.now();
  const t = p.getCurrentTime() || 0;
  const len = p.getDuration() || 0;
  S.video.pos = t;
  S.video.len = len;
  send('ytpos', { v: S.video.id, t: Math.floor(t), l: Math.floor(len), d: done ? 1 : 0 });
}

function closePlayer() {
  clearInterval(S.pvTick);
  if (S.player && S.player.pauseVideo) { savePosition(); S.player.pauseVideo(); }
}

function rowFor(k) {
  return ((S.snap && S.snap.rows) || []).find((r) => r.k === k) || null;
}

function renderDetail() {
  const k = S.open;
  const d = S.details[k] || rowFor(k);
  if (!d) { $('dTitle').textContent = 'This session is no longer listed'; return; }
  const focused = document.activeElement;
  const focusId = focused && focused.dataset ? focused.dataset.f : '';
  $('dTitle').textContent = d.ti;
  const meta = $('dMeta');
  meta.textContent = '';
  meta.append(`${d.own ? 'Glasses task · ' : ''}${PROVIDER[d.p]} · ${d.pr || ''} · `);
  meta.append(el('span', d.st, STATUS[d.st]));
  if (d.step) meta.append(` · Step ${d.step.n} of ${d.step.of}`);
  const nowParts = [];
  if (d.step && d.step.c && d.st === 'work') nowParts.push(d.step.c);
  if (d.now && d.st === 'work') nowParts.push(d.now);
  $('dNow').textContent = nowParts.join(' — ');
  $('dAsked').textContent = d.asked ? `You said: “${d.asked}”` : '';

  const acts = d.acts || [];
  const q = d.q;
  const box = $('dQuestion');
  box.hidden = !q;
  const opts = $('dOptions');
  opts.textContent = '';
  $('dQNote').textContent = '';
  if (q) {
    $('dQText').textContent = q.text + (q.more ? ` (+${q.more} more)` : '');
    if (!q.safe) {
      $('dQNote').textContent = 'This needs your own yes at your PC. The glasses can’t approve it.';
    } else if (acts.includes('answer')) {
      const choices = (q.opts || []).concat(HELP_OPTIONS);
      choices.forEach((label, i) => {
        const b = el('button', 'btn opt' + (i >= (q.opts || []).length ? ' help' : ''), label);
        b.dataset.f = 'opt' + i;
        b.addEventListener('click', () => startCompose({ mode: 'answer', k, text: label }));
        opts.append(b);
      });
      const written=el('button','btn primary','Write an answer');written.dataset.f='write-answer';
      written.addEventListener('click',()=>startCompose({mode:'answertext',k}));opts.append(written);
    } else {
      // Its choices are shown so he can decide now, then answer where the session lives.
      const choices = (q.opts || []).length ? `Choices: ${q.opts.join(' · ')}. ` : '';
      $('dQNote').textContent = choices + (d.p === 'x'
        ? 'Answer this in Codex on your PC.'
        : 'Answer this at your PC, or in the Claude app on your phone.');
    }
  }
  const res = $('dResult');
  res.textContent = S.details[k] ? (d.res || (d.st === 'work' ? 'Nothing to report yet.' : 'No message yet.')) : 'Loading…';
  requestAnimationFrame(updateGauge);

  const actions = $('dActions');
  actions.textContent = '';
  if (acts.includes('say')) {
    const b = el('button', 'btn primary', d.p === 'x' ? 'Reply to Codex' : 'Reply to Claude');
    b.dataset.f = 'say';
    b.addEventListener('click', () => startCompose({ mode: 'say', k }));
    actions.append(b);
  }
  if (acts.includes('stop') && d.st === 'work') {
    const b = el('button', 'btn', 'Stop this task');
    b.dataset.f = 'stop';
    b.addEventListener('click', () => startCompose({ mode: 'stop', k }));
    actions.append(b);
  }
  if ('speechSynthesis' in window && S.details[k]) {
    const b = el('button', 'btn', S.speaking === k ? 'Stop reading' : 'Read aloud');
    b.dataset.f = 'read';
    b.addEventListener('click', () => readAloud(k));
    actions.append(b);
  }
  if (focusId) {
    const again = document.querySelector(`[data-f="${focusId}"]`);
    if (again) again.focus({ preventScroll: true });
  } else if (S.lastKeyAt < S.openedAt && document.activeElement === $('dResult')) {
    // The question arrived after the screen opened and Bakar hasn't moved yet: start on its first answer.
    const first = $('dOptions').querySelector('button');
    if (first) first.focus();
  }
}

// The hairline gauge beside a long result: where you are in it. Shown only when there is more to read.
function updateGauge() {
  const r = $('dResult');
  const wrap = r.parentElement;
  const max = r.scrollHeight - r.clientHeight;
  const scrolls = max > 4;
  wrap.classList.toggle('scrolls', scrolls);
  r.classList.toggle('above', scrolls && r.scrollTop > 2);
  r.classList.toggle('below', scrolls && r.scrollTop < max - 2);
  if (!scrolls) return;
  const track = wrap.clientHeight - 16;
  const thumb = Math.max(24, (track * r.clientHeight) / r.scrollHeight);
  const t = $('rThumb');
  t.style.blockSize = `${thumb}px`;
  t.style.transform = `translateY(${((track - thumb) * r.scrollTop) / max}px)`;
}

// Read aloud through the glasses' speaker, on request only: the title, its state, the question, then the result.
function readAloud(k) {
  const synth = window.speechSynthesis;
  if (S.speaking === k) { stopReading(); renderDetail(); return; }
  const d = S.details[k];
  if (!d) return;
  synth.cancel();
  const parts = [`${d.ti}.`, `${PROVIDER[d.p]}, ${STATUS[d.st].toLowerCase()}.`];
  if (d.q) parts.push(`Question: ${d.q.text}`);
  if (d.res) parts.push(d.res.replace(/•/g, '').slice(0, 1200));
  const u = new SpeechSynthesisUtterance(parts.join(' '));
  const done = () => {
    clearInterval(S.speakCheck);
    if (S.speaking !== k) return;
    S.speaking = '';
    if (S.view === 'detail' && S.open === k) renderDetail();
  };
  u.onend = done;
  u.onerror = done;
  S.speaking = k;
  synth.speak(u);
  renderDetail();
  // In case the end of speech is never reported, look once a second while reading (and only then).
  clearInterval(S.speakCheck);
  S.speakCheck = setInterval(() => { if (!synth.speaking && !synth.pending) done(); }, 1000);
}

function stopReading() {
  clearInterval(S.speakCheck);
  if (S.speaking && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  S.speaking = '';
}

function appRow(app) {
  const b = el('button', 'row app');
  b.dataset.appUrl = app.url;
  const icon = el('span', 'icon');
  if (app.icon && !GLYPHS[app.icon]) icon.dataset.src = SITE + app.icon;
  icon.style.setProperty('--icon', `url("${iconSrc(app)}")`);
  b.append(icon, el('span', 'ti', app.name), el('span', 'why', app.why || ''));
  b.addEventListener('click', () => launch(app));
  return b;
}

async function loadApps() {
  try {
    const r = await fetch('apps.json', { cache: 'no-cache' });
    const list = await r.json();
    const ok = (a) => a && typeof a.name === 'string' && /^https:\/\//.test(a.url || '');
    if (Array.isArray(list.apps)) APPS = list.apps.filter(ok);
    if (Array.isArray(list.games)) GAMES = list.games.filter(ok);
  } catch (e) { /* the built-in list stays */ }
  renderApps();
  keepIcons();
}

function renderApps() {
  const list = $('appRows');
  const focusedUrl = document.activeElement?.dataset.appUrl;
  list.textContent = '';
  let group = '';
  for (const app of APPS) {
    if (app.group !== group) { group = app.group; list.append(el('li', 'group', group)); }
    const li = el('li');
    li.append(appRow(app));
    list.append(li);
  }
  const games = $('gameRows');
  games.textContent = '';
  for (const game of GAMES) {
    const li = el('li');
    li.append(appRow(game));
    games.append(li);
  }
  if (focusedUrl) focusApp(focusedUrl);
  $('gamesNote').textContent = GAMES.length
    ? 'Games stay here, away from Work and Apps.'
    : 'No web games added yet. Games you add will appear here, away from Work and Apps. Meta’s own games stay in the glasses’ main app list.';
}

// App icons are kept here as data: addresses, so a section paints with its icons on its first frame; an icon fetched
// from the site arrives a few frames after its section has slid in. Refreshed in place at most once a day.
const ICONS_KEY = 'glass-home.icons';
const iconsKept = local(ICONS_KEY) || {};
let iconData = iconsKept.data || {};

function iconSrc(app) {
  if (GLYPHS[app.icon]) return GLYPHS[app.icon];
  if (!app.icon) return GLYPHS.app;
  return iconData[SITE + app.icon] || SITE + app.icon;
}

async function keepIcons() {
  const wanted = [...new Set(APPS.concat(GAMES).filter((a) => a.icon && !GLYPHS[a.icon]).map((a) => SITE + a.icon))];
  if (Date.now() - (iconsKept.at || 0) < 86400000 && wanted.every((url) => iconData[url])) return;
  const kept = {};
  for (const url of wanted) {
    kept[url] = iconData[url];
    try {
      const r = await fetch(url);
      const svg = r.ok ? await r.text() : '';
      if (svg.length < 20000 && /<svg[\s>]/i.test(svg)) kept[url] = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    } catch (e) { /* keep what we had */ }
  }
  for (const url of Object.keys(kept)) if (!kept[url]) delete kept[url];
  local(ICONS_KEY, { at: Date.now(), data: kept });
  if (JSON.stringify(kept) === JSON.stringify(iconData)) return;
  iconData = kept;
  for (const icon of document.querySelectorAll('.row.app .icon[data-src]')) {
    if (iconData[icon.dataset.src]) icon.style.setProperty('--icon', `url("${iconData[icon.dataset.src]}")`);
  }
}

function focusApp(url) {
  const button = [...document.querySelectorAll('.row.app')].find(b => b.dataset.appUrl === url && !b.closest('[hidden]'));
  if (button) button.focus();
  return Boolean(button);
}

function launch(app) {
  const url = new URL(app.url);
  // Only these exact app addresses may receive a pairing. Never forward it to another catalog entry.
  const destinations = {
    'studio-glass/': 'sg', 'tidal-glass/': 'tg', 'tidal-glass/sound/': 'tg',
    'battery-glass/': 'tg', 'glass-home/drive/': 'drive',
  };
  const pairing = destinations[url.pathname.slice(1)];
  if (url.origin === new URL(SITE).origin && pairing && app.pass === pairing) {
    const data = pairing === 'drive' ? drivePhone.link?.addr : passPairing(pairing);
    if (data) {
      const fragment = pairing === 'drive' ? { t: data.t, p: data.p }
        : pairing === 'tg' ? { androidBridge: data.t + '~' + data.k } : { t: data.t, k: data.k };
      url.hash = new URLSearchParams(fragment).toString();
    }
  }
  // The public catalog address identifies the focus row. Keep pairing data out of history state.
  history.replaceState({ v: 'list', tab: S.tab, appUrl: app.url }, '');
  location.assign(url.href);
}

// ---- pairing ---------------------------------------------------------------------------------------

function showPairing(code) {
  S.pairing = code || '…';
  $('pTitle').textContent = 'Pair these glasses';
  $('pText').textContent = 'At your PC, ask Claude to open Glass Home pairing, then press Try again. The PC shows this code when it pairs.';
  $('pCode').textContent = code || '';
  $('pRetry').hidden = false;
  showPane('pair');
  $('pRetry').focus();
}

function closePairing() {
  if (!S.pairing) return;
  S.pairing = null;
  if (S.view === 'list') showPane(S.tab);
}

// ---- screens and history ---------------------------------------------------------------------------

const PANES = ['review', 'now', 'work', 'detail', 'compose', 'watch', 'route', 'drive', 'play', 'apps', 'games', 'pair'];
const MOTION = !window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const DEPTH = { review: 0, now: 0, work: 0, watch: 0, route: 0, drive: 0, apps: 0, games: 0, pair: 0, detail: 1, play: 1, compose: 2 };
const TABS = ['review', 'now', 'work', 'watch', 'route', 'drive', 'apps', 'games'];
// Sections that show the pairing screen instead while these glasses aren't paired: both need the PC.
const NEEDS_PC = ['now', 'work'];

function showPane(id,driveGesture=false) {
  const before = PANES.find((p) => !$(p).hidden);
  for (const p of PANES) $(p).hidden = p !== id;
  clearTimeout(S.renderStatusTimer);
  syncDriveFeed(driveGesture); if (id === 'drive') applyDriveLight();
  if (id === 'now') renderNow();
  if (!CALM_PANES.includes(id)) wakeUp();
  const listView = ['now', 'work', 'watch', 'route', 'drive', 'apps', 'games', 'pair'].includes(id);
  for (const t of document.querySelectorAll('.tab')) {
    t.setAttribute('aria-selected', String(t.dataset.tab === S.tab));
    t.tabIndex = listView ? 0 : -1;
  }
  placeTabline();
  // Continuity: deeper screens come in from the right and go back to the left; sections slide the way you swiped.
  if (id !== 'drive' && before !== 'drive' && MOTION && before && before !== id && $(id).animate) {
    let dir = Math.sign(DEPTH[id] - DEPTH[before]);
    if (!dir) dir = S.slide || Math.sign(TABS.indexOf(id) - TABS.indexOf(before)) || 1;
    // Mostly a slide: opacity starts at 0.92 (about 83% of the light), because a dark first frame between screens
    // reads as a blink on a see-through display.
    $(id).animate([{ opacity: 0.92, transform: `translateX(${dir * 22}px)` }, { opacity: 1, transform: 'none' }],
      { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }
  S.slide = 0;
  HomeShell.onPane(id, before);
}

// The section underline glides to the selected section (transform only).
function placeTabline() {
  const t = document.querySelector(`.tab[data-tab="${S.tab}"]`);
  const line = $('tabline');
  if (!t || !line) return;
  line.style.transform = `translateX(${t.offsetLeft + 12}px) scaleX(${Math.max(1, t.offsetWidth - 24)})`;
}

// At the end of a list a further press nudges the focus that way and springs it back past rest, so the end is felt
// rather than silent. Added to the control's own transform, so a lifted row keeps its lift.
function rubberBand(dy, dx) {
  if (!MOTION) return;
  const a = focusedControl();
  const target = a && a !== document.body && a.animate ? a : $(PANES.find((p) => !$(p).hidden));
  if (!target || !target.animate) return;
  target.animate([
    { transform: 'translate(0, 0)', easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    { transform: `translate(${dx * 6}px, ${dy * 6}px)`, offset: 0.28, easing: 'cubic-bezier(0.34, 1.45, 0.64, 1)' },
    { transform: 'translate(0, 0)' },
  ], { duration: 300, composite: 'add' });
}

// A press: a short sink and a brighter rim, settled within 100 ms; the control's spring brings it back.
function press(target) {
  if (!target || !target.matches || !target.matches('button')) return;
  target.classList.add('pressing');
  setTimeout(() => target.classList.remove('pressing'), 90);
}

function focusFirst(pane) {
  if (pane === 'drive' && HomeShell.driveQuiet()) { $('driveReveal').focus(); return; }
  if (pane === 'review') { HomeShell.focusReview(); return; }
  // On Work, start on the top session (needs-you sessions sort first); New task is one press up.
  const first = (pane === 'work' && $('rows').querySelector('.row[data-k]'))
    || (pane === 'now' && $('nowRows').querySelector('.row'))
    || $(pane).querySelector('button:not([hidden]), [tabindex="0"]');
  (first || document.querySelector(`.tab[data-tab="${S.tab}"]`)).focus();
}

function selectTab(tab, focusTab, driveGesture=false) {
  if (S.tab==='watch' && tab !== 'watch') cancelWatch();
  if (S.view !== 'list') return; // Native Back preserves the current draft and bounds shared history.
  if (!HomeShell.canEnterRoute(tab, focusTab) || !HomeShell.canLeaveReview(tab)) return;
  S.tab = tab;
  S.view = 'list';
  history.replaceState({ v: 'list', tab }, '');
  if (S.pairing && NEEDS_PC.includes(tab)) showPane('pair');
  else showPane(tab,driveGesture);
  if (tab === 'review') HomeShell.focusReview();
  else if (focusTab) document.querySelector(`.tab[data-tab="${tab}"]`).focus();
  else focusFirst(NEEDS_PC.includes(tab) && S.pairing ? 'pair' : tab);
}

function openDetail(k) {
  S.open = k;
  S.view = 'detail';
  S.openedAt = Date.now();
  history.pushState({ v: 'detail', k }, '');
  showPane('detail');
  renderDetail();
  $('dResult').scrollTop = 0;
  const first = $('dOptions').querySelector('button') || $('dResult');
  first.focus();
  // Ask the PC only when what's here is more than a minute old; each request costs two messages.
  const d = S.details[k];
  if (!d || Date.now() - d.at > 60000) send('det', { k });
  armIdle();
}

function apply(state) {
  if(S.view==='compose')saveCompose();
  cancelWatch();
  closeConfirm();
  if (!state || state.v === 'list') {
    stopReading();
    if (S.view === 'play') {
      // Leaving a video: pause it, keep the place, and land back on its row.
      const v = S.video;
      closePlayer();
      S.view = 'list';
      showPane(S.tab);
      renderWatch();
      const vrow = v && $('watchRows').querySelector(`[data-v="${CSS.escape(v.id)}"]`);
      if (vrow) vrow.focus(); else focusFirst(S.tab);
      return;
    }
    const backTo = S.open;
    if (S.ytFound && S.view === 'list') { S.ytFound = null; renderWatch(); }
    S.view = 'list';
    S.open = '';
    showPane(S.pairing && NEEDS_PC.includes(S.tab) ? 'pair' : S.tab);
    const row = backTo && $('rows').querySelector(`[data-k="${CSS.escape(backTo)}"]`);
    if (row) row.focus(); else focusFirst(S.tab);
  } else if (state.v === 'detail') {
    S.view = 'detail';
    S.open = state.k;
    showPane('detail');
    renderDetail();
    ($('dActions').querySelector('button') || $('dOptions').querySelector('button') || $('dResult')).focus();
  } else if (state.v === 'play') {
    // Back from a video is the list; Forward never reopens the player.
    history.back();
  } else if (state.v === 'compose') {
    if(!S.compose){const saved=(local('gh.composeDrafts')||{})[state.draft];if(saved)startCompose(saved,false);else {history.back();return;}}
    S.view='compose';showPane('compose');closeConfirm();$('cText').readOnly=!!S.compose?.request&&['sending','uncertain'].includes(S.compose.request.status);$('cSend').focus();
  } else if(state.v==='confirm') {
    if(!S.compose){const saved=(local('gh.composeDrafts')||{})[state.draft];if(saved)startCompose(saved,false);else {history.back();return;}}
    S.view='compose';showPane('compose');paintConfirmation(S.compose,false);
  }
}

// ---- writing: new task, reply, answer, stop --------------------------------------------------------

function composeKey(c) { return `${c.mode}:${c.k || 'new'}`; }
function saveCompose(c = S.compose, durable = false) {
  if (!c || !['new','say','answertext','answer','stop'].includes(c.mode)) return false;
  if(c.request?.status==='accepted')return true;
  const drafts = local('gh.composeDrafts') || {};
  if(S.compose===c)c.text=$('cText').value;
  drafts[composeKey(c)] = {mode:c.mode,k:c.k||'',text:c.text||c.final||'',provider:c.provider,project:c.project,
    final:c.final||'',question:c.question||'',request:c.request||null,at:Date.now()};
  if(!durable){local('gh.composeDrafts',drafts);return true;}
  try{
    localStorage.setItem('gh.composeDrafts',JSON.stringify(drafts));
    const saved=JSON.parse(localStorage.getItem('gh.composeDrafts')||'null')?.[composeKey(c)];
    return !!saved&&saved.request?.id===c.request?.id&&JSON.stringify(saved.request?.payload)===JSON.stringify(c.request?.payload)&&saved.request?.summary===c.request?.summary&&saved.question===(c.question||'')&&saved.final===(c.final||'');
  }catch(_){return false;}
}
function clearComposeDraft(c) {
  const drafts=local('gh.composeDrafts')||{},key=composeKey(c),saved=drafts[key],sent=c.request?.payload?.text??c.final;
  if(saved&&saved.text!==sent){saved.request=null;saved.final='';}else delete drafts[key];
  local('gh.composeDrafts',drafts);
}
function startCompose(c, record = true) {
  const saved=(local('gh.composeDrafts')||{})[composeKey(c)];
  if(saved?.request?.status==='sending')saved.request={...saved.request,status:'uncertain'};
  if(saved?.request&&['sending','uncertain'].includes(saved.request.status))c={...c,...saved};
  else if(saved && ['new','say','answertext'].includes(c.mode))c={...saved,...c,text:c.text??saved.text};
  S.compose = Object.assign({ provider: '', project: '' }, c);
  S.view = 'compose';
  if(record)history.pushState({ v: 'compose', draft:composeKey(c) }, '');
  showPane('compose');
  closeConfirm();
  $('cNote').textContent = '';
  const can = (S.snap && S.snap.can) || {};
  const pick = $('cPick');
  pick.textContent = '';
  const text = $('cText');
  text.value = c.text || '';
  text.readOnly=!!S.compose.request&&['sending','uncertain'].includes(S.compose.request.status);
  const field = text.closest('.field');
  field.hidden = c.mode === 'stop' || c.mode === 'answer';
  $('cSend').textContent = 'Review';
  const d = S.details[c.k] || rowFor(c.k) || {};
  if(S.compose.request&&['sending','uncertain','accepted'].includes(S.compose.request.status)){
    $('cTitle').textContent=c.mode==='new'?'New task':c.mode==='stop'?'Stop this task?':c.mode==='say'?'Reply':'Answer';
    S.compose.final=c.final||c.text||'';paintConfirmation(S.compose,false);return;
  }
  if (c.mode === 'new') {
    $('cTitle').textContent = 'New task';
    $('cLabel').textContent = 'Say what you want done';
    const providers = can.new || [];
    S.compose.provider = providers.includes(c.provider) ? c.provider : providers.length === 1 ? providers[0] : '';
    const who = el('div', 'pickgroup');
    who.append(el('span', 'label', 'AI'));
    for (const p of providers) who.append(choice(PROVIDER[p], 'provider', p));
    const projects = can.projects || [];
    S.compose.project = projects.some(p=>p.k===c.project) ? c.project : projects.some(p=>p.k==='desk') ? 'desk' : '';
    const where = el('div', 'pickgroup');
    where.append(el('span', 'label', 'Folder'));
    for (const p of projects) where.append(choice(p.n, 'project', p.k));
    pick.append(who, where);
    syncChoices();
  } else if (c.mode === 'yt') {
    $('cTitle').textContent = 'Search YouTube on phone';
    $('cLabel').textContent = 'Say what to find';
    $('cSend').textContent = 'Send search to phone';
  } else if (c.mode === 'say') {
    $('cTitle').textContent = `Reply to ${d.ti || 'this task'}`;
    $('cLabel').textContent = 'Say your reply';
  } else if(c.mode === 'answertext') {
    $('cTitle').textContent='Answer this question';
    $('cLabel').textContent=d.q?.text||'Say your answer';
  } else if (c.mode === 'answer') {
    $('cTitle').textContent = 'Answer';
    review();
    return;
  } else if (c.mode === 'stop') {
    $('cTitle').textContent = 'Stop this task?';
    review();
    return;
  }
  saveCompose();
  (pick.querySelector('button') || text).focus();
  if (!pick.querySelector('button')) text.focus();
}

function choice(label, kind, value) {
  const b = el('button', 'btn', label);
  b.dataset.kind = kind;
  b.dataset.value = value;
  b.addEventListener('click', () => { S.compose[kind] = value; syncChoices(); saveCompose(); });
  return b;
}

function syncChoices() {
  for (const b of $('cPick').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(S.compose[b.dataset.kind] === b.dataset.value));
  }
}

function review() {
  const c = S.compose;
  if (!c) return;
  if(c.request?.status==='accepted'){openAcceptedTask(c);return;}
  if(c.request&&['sending','uncertain'].includes(c.request.status)){paintConfirmation(c);return;}
  if(c.request?.status==='rejected'){c.request=null;$('cText').readOnly=false;saveCompose(c);}
  if (c.mode === 'yt') { findVideos(); return; }
  const text = c.mode === 'answer' ? c.text : $('cText').value;
  if (['new','say','answertext'].includes(c.mode) && !text.trim()) {
    $('cNote').textContent = 'Nothing to send yet. Focus the box and speak.';
    $('cText').focus();
    return;
  }
  const can = (S.snap && S.snap.can) || {};
  const d = S.details[c.k] || rowFor(c.k) || {};
  let summary = '';
  if (c.mode === 'new') {
    if (!(can.new || []).includes(c.provider) || !(can.projects || []).some(p=>p.k===c.project)) {
      $('cNote').textContent='Choose an available agent and folder before reviewing.';return;
    }
    const project = (can.projects || []).find((p) => p.k === c.project);
    const place = !project ? 'the chosen folder' : project.k === 'desk' ? 'a fresh folder' : project.n;
    summary = `Send to ${PROVIDER[c.provider] || 'the AI'}, working in ${place}:`;
  } else if (c.mode === 'say') summary = `Send to ${PROVIDER[d.p] || 'the selected agent'} - ${d.ti || 'this task'}:`;
  else if (c.mode === 'answer' || c.mode === 'answertext') summary = `Answer ${d.ti || 'this task'} with:`;
  else summary = `Stop ${d.ti}? Its work so far is kept.`;
  c.final = text;
  c.question=JSON.stringify(d.q||null);
  $('cSummary').textContent = summary;
  $('cQuote').textContent = c.mode === 'stop' ? '' : `“${text}”`;
  paintConfirmation(c);
}

function taskSendProblem(c) {
  if(!c || document.hidden || S.view!=='compose' || S.compose!==c)return 'Return to this draft before sending.';
  if(!S.kUp||!S.topic||S.pairing)return 'The Studio connection is not paired. Your draft is kept.';
  if(!linkUp()||S.quiet||!S.pcAt)return 'The PC has not confirmed a live connection. Your draft is kept.';
  if(!StudioParked.controlsAllowed())return 'Drive controls require a parked declaration.';
  const can=S.snap?.can||{},d=S.details[c.k]||rowFor(c.k)||{};
  if(c.mode==='new'){
    if(!(can.new||[]).includes(c.provider))return 'That agent is not currently available. Choose an available agent.';
    if(!(can.projects||[]).some(p=>p.k===c.project))return 'Choose an available folder.';
  }else{
    const action=c.mode==='stop'?'stop':c.mode==='answer'||c.mode==='answertext'?'answer':'say';
    if(!/^g[0-9a-f]{8}$/.test(c.k||'') || !(d.acts||[]).includes(action))return 'This session does not provide that action from the glasses.';
    if(['answer','answertext'].includes(c.mode)&&(!d.q?.safe||JSON.stringify(d.q||null)!==c.question))return 'The question changed or requires approval in its original app. Your draft is kept.';
  }
  if(c.mode!=='stop'&&(!String(c.final||'').trim()||String(c.final).length>2000))return 'Use a message of 1–2000 characters.';
  if(['new','say','answertext'].includes(c.mode)&&$('cText').value!==c.final)return 'Your words changed. Review them again before sending.';
  return '';
}

function paintConfirmation(c, record = true, focus = true) {
  if(record && history.state?.v!=='confirm')history.pushState({v:'confirm',draft:composeKey(c)},'');
  $('compose').classList.add('compose-review');$('cConfirm').hidden=false;
  if(c.request&&['sending','uncertain','accepted'].includes(c.request.status)){
    const original=c.request.summary||(c.request.command==='new'?`Send to ${PROVIDER[c.request.payload.p]||'the selected agent'}, folder ${c.request.payload.w}:`:`Request for task ${c.k}:`);
    $('cSummary').textContent=`Original request. ${original}`;
  }
  $('cQuote').textContent=c.mode==='stop'?'':c.final||'';
  const pending=c.request && ['sending','uncertain'].includes(c.request.status),accepted=c.request?.status==='accepted';
  const problem=pending||accepted?'':taskSendProblem(c);
  $('cGo').disabled=!!problem || c.request?.status==='sending';
  $('cGo').textContent=accepted?'Open task':pending?'Check saved receipt':c.mode==='stop'?'Stop task':'Send';
  // An answer or a stop has no text to edit, so its second button goes back instead.
  $('cEdit').textContent=pending||accepted||['answer','stop'].includes(c.mode)?'Back':'Edit';
  $('cNote').textContent=problem||(accepted?'This request was accepted. Open its task.':pending?'This request is unconfirmed. Check its saved receipt; it will not be sent again.':'Review the agent, folder and text. Send is the only action that submits.');
  saveCompose(c);if(focus)($('cGo').disabled?$('cEdit'):$('cGo')).focus();
}

async function findVideos() {
  if(watchPhone.pending)return;
  const query=$('cText').value;
  await handoffWatch({kind:'search',provider:'youtube',query},$('cNote'));
}

function closeConfirm() {
  $('cConfirm').hidden = true;
  $('compose').classList.remove('compose-review');
}

function openAcceptedTask(c) {
  const k=c.request?.k;if(!/^g[0-9a-f]{8}$/.test(k||''))return;
  S.compose=null;S.open=k;S.view='detail';history.replaceState({v:'detail',k},'');showPane('detail');renderDetail();
  ($('dActions').querySelector('button')||$('dResult')).focus();armIdle();
}

function completeTaskReply(c, request, ack) {
  if(c.request!==request || typeof ack.ok!=='boolean')return false;
  if(S.compose&&S.compose!==c&&S.compose.request?.id===request.id&&JSON.stringify(S.compose.request.payload)===JSON.stringify(request.payload)){
    const current=S.compose;c.request=current.request;return completeTaskReply(current,current.request,ack);
  }
  const active=S.compose===c&&S.view==='compose'&&!document.hidden&&!$('cConfirm').hidden;
  if(!ack.ok){request.status='rejected';saveCompose(c);if(active){$('cNote').textContent=ack.why||'The PC refused this request. Your draft is kept.';$('cGo').disabled=true;$('cEdit').textContent='Edit';}return true;}
  const k=ack.k||c.k;
  if(!/^g[0-9a-f]{8}$/.test(k||'') || (ack.det&&ack.det.k!==k))return false;
  if(request.command!=='new'&&k!==c.k)return false;
  request.status='accepted';request.k=k;clearComposeDraft(c);
  if(ack.det)S.details[k]=ack.det;
  if(!active){if(S.compose===c){$('cSend').textContent='Open accepted task';$('cNote').textContent='Request accepted. Open its task when ready.';}return true;}
  openAcceptedTask(c);
  return true;
}

async function checkTaskReceipt(c) {
  const request=c.request;if(!request)return;
  if(S.snap?.can?.receipts!==1){$('cNote').textContent='This relay cannot check a saved task receipt yet. The request remains unconfirmed; no duplicate was sent.';return;}
  const query=toB64url(crypto.getRandomValues(new Uint8Array(9)));
  const active=()=>S.compose===c&&S.view==='compose'&&!document.hidden;
  $('cGo').disabled=true;$('cNote').textContent='Checking the original request. Nothing is being sent again.';
  const timer=setTimeout(()=>{delete S.pending[query];if(active()){$('cGo').disabled=false;$('cNote').textContent='No receipt answer arrived. The original request is still unconfirmed.';}},15000);
  S.pending[query]=ack=>{
    clearTimeout(timer);
    const kind=request.command==='say'&&request.payload.answer?'answer':request.command;
    if(ack.mutationId!==request.id||ack.status!=='accepted'||ack.kind!==kind){if(active()){$('cGo').disabled=false;$('cNote').textContent='No saved receipt was confirmed. Your original request and draft are kept.';}return;}
    completeTaskReply(c,request,ack);
  };
  try{const id=await send('taskreceipt',{mutationId:request.id},{id:query,noQueue:true,guard:active});if(id!==query)throw new Error('The receipt check was not sent. Your original request remains unconfirmed.');}
  catch(error){clearTimeout(timer);delete S.pending[query];if(active()){$('cGo').disabled=false;$('cNote').textContent=error.message;}}
}

async function go() {
  const c=S.compose;if(!c||$('cGo').disabled||$('cConfirm').hidden)return;
  if(c.request?.status==='accepted'){openAcceptedTask(c);return;}
  if(c.request&&['sending','uncertain'].includes(c.request.status)){await checkTaskReceipt(c);return;}
  const problem=taskSendProblem(c);if(problem){$('cNote').textContent=problem;return;}
  const command=c.mode==='new'?'new':c.mode==='stop'?'stop':'say';
  const payload=c.mode==='new'?{p:c.provider,w:c.project,text:c.final}:c.mode==='stop'?{k:c.k}:{k:c.k,text:c.final,answer:['answer','answertext'].includes(c.mode)};
  const request={id:toB64url(crypto.getRandomValues(new Uint8Array(9))),command,payload,summary:$('cSummary').textContent,status:'sending',at:Date.now()};
  c.request=request;
  if(!saveCompose(c,true)){c.request=null;$('cGo').disabled=true;$('cNote').textContent='This device could not save the request safely. Nothing was sent; your draft stays open.';return;}
  $('cText').readOnly=true;$('cGo').disabled=true;$('cNote').textContent='Sending. Waiting for the PC’s saved acknowledgement.';
  const active=()=>S.compose===c&&S.view==='compose'&&!document.hidden&&!$('cConfirm').hidden&&history.state?.v==='confirm'&&c.request===request;
  let published=false;
  const timer=setTimeout(()=>{if(c.request===request&&request.status==='sending'){request.status='uncertain';saveCompose(c);if(active())paintConfirmation(c,false);}},20000);
  S.pending[request.id]=ack=>{if(completeTaskReply(c,request,ack))clearTimeout(timer);};
  try{
    const sent=await send(command,payload,{id:request.id,noQueue:true,guard:()=>active()&&!taskSendProblem(c),onPublish:()=>{published=true;}});
    if(sent!==request.id)throw new Error('Nothing was sent. Check the connection or message limit; your draft is kept.');
  }catch(error){
    clearTimeout(timer);
    if(['accepted','rejected'].includes(request.status))return;
    if(published){request.status='uncertain';saveCompose(c);if(active())paintConfirmation(c,false);}
    else{delete S.pending[request.id];c.request=null;saveCompose(c);if(S.compose===c&&S.view==='compose'){$('cText').readOnly=false;$('cNote').textContent=error.message;$('cGo').disabled=true;}}
  }
}

// ---- keys ------------------------------------------------------------------------------------------

// Each screen is a column of rows of controls. Up and Down move between rows; Left and Right move within a row
// (or, on the section lists, between sections). This doesn't depend on the browser's guess of the nearest element.
function visible(n) {
  return n && !n.hidden && !n.disabled && n.offsetParent !== null && !n.closest('[hidden]');
}

// One focus model: the review frame is same-origin, so its controls join the rows moveFocus already walks.
function reviewRows() {
  const f = $('reviewFrame');
  return (!f.hidden && !f.inert && f.contentWindow.reviewRows?.()) || [];
}

function focusedControl() {
  const a = document.activeElement;
  return a === $('reviewFrame') ? a.contentDocument?.activeElement : a;
}

function rowsOfControls() {
  const groups = [];
  const add = (list) => { const g = [...list].filter(visible); if (g.length) groups.push(g); };
  const pane = PANES.find((p) => !$(p).hidden);
  add(document.querySelectorAll('[data-section]'));
  if (pane === 'review') { add([$('reviewEnter')]); for (const g of reviewRows()) add(g); }
  else if (['now', 'work', 'watch', 'route', 'drive', 'apps', 'games', 'pair'].includes(pane)) {
    add([document.querySelector(`.tab[data-tab="${S.tab}"]`)]);
    if (pane === 'pair') add([$('pRetry')]);
    else if (pane === 'now') for (const b of $('nowRows').querySelectorAll('.row')) add([b]);
    else if (pane === 'watch') { add([$('ytFind')]); for (const b of $('watchRows').querySelectorAll('.row')) add([b]); }
    else if (pane === 'route') for (const b of $('routeRows').querySelectorAll('.row')) add([b]);
    else if (pane === 'drive' && HomeShell.driveQuiet()) add([$('driveReveal')]);
    else if (pane === 'drive' && !$('driveInfo').hidden) add([$('drivePhoneToggle'),$('drivePhoneUse'),$('drivePhoneKeep'),$('driveInfoClose')]);
    else if (pane === 'drive') { add([$('driveGps'),$('driveRetry')]); add([$('driveLight'),$('driveInfoButton')]); }
    else if (pane === 'work') { add([$('newTask')]); for (const b of $('rows').querySelectorAll('.row')) add([b]); }
    else for (const b of $(pane === 'apps' ? 'appRows' : 'gameRows').querySelectorAll('.row')) add([b]);
  } else if (pane === 'play') {
    add($('pvControls').querySelectorAll('button'));
  } else if (pane === 'detail') {
    add($('dOptions').querySelectorAll('button'));
    if ($('dResult').textContent) add([$('dResult')]);
    add($('dActions').querySelectorAll('button'));
  } else if (pane === 'compose') {
    for (const g of $('cPick').querySelectorAll('.pickgroup')) add(g.querySelectorAll('button'));
    add([$('cText')]);
    add([$('cSend')]);
    if(!$('cConfirm').hidden&&$('cQuote').textContent)add([$('cQuote')]);
    add([$('cGo'), $('cEdit')]);
  }
  return groups;
}

function moveFocus(dy, dx) {
  const groups = rowsOfControls();
  const a = focusedControl();
  let gi = groups.findIndex((g) => g.includes(a));
  if (gi < 0) { (document.activeElement === $('reviewFrame') && reviewRows()[0] || groups[0] || [])[0]?.focus(); return; }
  if (dx) {
    const g = groups[gi];
    const next = g[g.indexOf(a) + dx];
    if (next) next.focus(); else rubberBand(0, dx);
    return;
  }
  gi += dy;
  if (gi < 0 || gi >= groups.length) { rubberBand(dy, 0); return; }
  const g = groups[gi];
  const pick = g.find((n) => n.getAttribute('aria-selected') === 'true' || n.getAttribute('aria-pressed') === 'true' || n.getAttribute('aria-current') === 'page') || g[0];
  pick.focus();
  if (pick.scrollIntoView) pick.scrollIntoView({ block: 'nearest' });
}

// A swipe that landed inside the picture frame: the same rows and the same mover as everywhere else.
function reviewKey(k) {
  wakeUp();
  if (k === 'ArrowDown' || k === 'ArrowUp') moveFocus(k === 'ArrowDown' ? 1 : -1, 0);
  else if (k === 'ArrowLeft' || k === 'ArrowRight') moveFocus(0, k === 'ArrowRight' ? 1 : -1);
}

function onKey(e) {
  if (document.visibilityState !== 'visible') return;
  if (HomeShell.handleKey(e)) return;
  if (e.key !== 'Enter') S.lastKeyAt = Date.now();
  if (e.key === 'Enter' && !e.target.closest('textarea')) press(e.target);
  if (S.paused && (S.kUp || S.tg)) wake(); else if (S.kUp || S.tg) armIdle();
  const k = e.key;
  if (e.target.closest('.sections') && (k === 'ArrowLeft' || k === 'ArrowRight')) {
    e.preventDefault();moveFocus(0,k === 'ArrowRight' ? 1 : -1);return;
  }
  if (S.view === 'list' && S.tab === 'drive' && e.target.closest('.drive-actions, .drive-info') && (k === 'ArrowLeft' || k === 'ArrowRight')) {
    e.preventDefault();moveFocus(0,k === 'ArrowRight' ? 1 : -1);return;
  }
  if (S.view === 'list' && (k === 'ArrowLeft' || k === 'ArrowRight') && !e.target.closest('textarea')) {
    const tabs = HomeShell.tabsForInput(e.target);
    if (tabs.length < 2) { e.preventDefault(); moveFocus(0, k === 'ArrowRight' ? 1 : -1); return; } // Review has no tab to step to.
    const i = Math.max(0,tabs.indexOf(S.tab));
    const next = tabs[(i + (k === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    e.preventDefault();
    S.slide = k === 'ArrowRight' ? 1 : -1;
    selectTab(next, Boolean(e.target.closest('.tabs')),e.isTrusted);
    return;
  }
  if ((e.target === $('dResult') || e.target === $('cQuote')) && (k === 'ArrowDown' || k === 'ArrowUp')) {
    const r = e.target;
    const down = k === 'ArrowDown';
    const room = down ? r.scrollHeight - r.clientHeight - r.scrollTop : r.scrollTop;
    e.preventDefault();
    if (room > 2) r.scrollBy({ top: down ? 150 : -150, behavior: MOTION ? 'smooth' : 'auto' });
    else moveFocus(down ? 1 : -1, 0);
    return;
  }
  if (e.target === $('cText')) {
    // A normal activated textarea belongs to the glasses' system composer.
    return;
  }
  // In a video, up and down jump 10 seconds; left and right move along the controls.
  if (S.view === 'play' && (k === 'ArrowDown' || k === 'ArrowUp')) {
    e.preventDefault();
    if (S.player && S.player.getCurrentTime) S.player.seekTo(Math.max(0, S.player.getCurrentTime() + (k === 'ArrowUp' ? 10 : -10)), true);
    return;
  }
  if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); moveFocus(k === 'ArrowDown' ? 1 : -1, 0); return; }
  if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); moveFocus(0, k === 'ArrowRight' ? 1 : -1); }
}

// ---- start -----------------------------------------------------------------------------------------

function registerServiceWorker() {
  if(!('serviceWorker' in navigator))return;
  navigator.serviceWorker.register('sw.js',{updateViaCache:'none'}).then(reg=>{
    let lastCheck=0;
    const check=()=>{
      if(document.hidden||Date.now()-lastCheck<60000)return;
      lastCheck=Date.now();reg.update().catch(()=>{});
    };
    window.addEventListener('pageshow',check);
    document.addEventListener('visibilitychange',check);
    if(navigator.serviceWorker.controller)check();
  }).catch(()=>{});
}

async function main() {
  const buildLabel=document.createElement('small');
  buildLabel.id='runningBuild';buildLabel.textContent='v'+APP_BUILD;
  Object.assign(buildLabel.style,{fontSize:'19px',fontWeight:'650',color:'var(--ink, #e6eee8)'});
  buildLabel.setAttribute('aria-label','Bakar Home build '+APP_BUILD);
  const context=$('appContext');
  if(context)context.before(buildLabel);else ($('appIdentity')||document.querySelector('header')||document.body).append(buildLabel);
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', e => selectTab(t.dataset.tab,true,e.isTrusted));
  $('newTask').addEventListener('click', () => startCompose({ mode: 'new' }));
  $('cSend').addEventListener('click', review);
  $('cGo').addEventListener('click', go);
  $('cText').addEventListener('input',()=>{saveCompose();if(!$('cConfirm').hidden)closeConfirm();});
  $('cEdit').addEventListener('click', () => {
    const mode = S.compose && S.compose.mode;
    if(S.compose?.request&&['sending','uncertain'].includes(S.compose.request.status)){history.go(-2);return;}
    if(S.compose?.request?.status==='rejected'){
      const c=S.compose;c.request=null;$('cText').readOnly=false;saveCompose(c);
      if(['new','say','answertext'].includes(mode)){if(history.state?.v==='confirm')history.back();startCompose(c,false);return;}
    }
    if(history.state?.v==='confirm'){history.back();return;}
    if (mode === 'answer' || mode === 'stop') { history.back(); return; }
    closeConfirm();$('cText').focus();
  });
  $('pRetry').addEventListener('click', () => { if (S.paused) wake(); else hello(); });
  // The video controls: the player's own controls are hidden so the arrows and pinch drive these.
  const seek = (d) => { if (S.player && S.player.getCurrentTime) S.player.seekTo(Math.max(0, S.player.getCurrentTime() + d), true); };
  $('pvBack10').addEventListener('click', () => seek(-10));
  $('pvFwd10').addEventListener('click', () => seek(10));
  $('pvPlay').addEventListener('click', () => {
    const p = S.player;
    if (!p || !p.getPlayerState) return;
    if (p.getPlayerState() === 1) p.pauseVideo(); else p.playVideo();
  });
  $('pvSpeed').addEventListener('click', () => {
    S.speedAt = ((S.speedAt || 0) + 1) % SPEEDS.length;
    $('pvSpeed').textContent = `${SPEEDS[S.speedAt]}×`;
    if (S.player && S.player.setPlaybackRate) S.player.setPlaybackRate(SPEEDS[S.speedAt]);
  });
  // Back keeps the place; a video leaves the list on its own once it has played to the end.
  $('pvDone').addEventListener('click', () => history.back());
  // Any swipe or pinch wakes the page from calm before anything else handles it (and is still handled).
  document.addEventListener('keydown', wakeUp, true);
  document.addEventListener('pointerdown', wakeUp, true);
  document.addEventListener('pointerdown', (e) => press(e.target.closest && e.target.closest('button')), true);
  document.addEventListener('keydown', onKey, true);
  $('dResult').addEventListener('scroll', updateGauge, { passive: true });
  for (const id of ['rows', 'appRows', 'gameRows']) {
    $(id).addEventListener('scroll', (e) => e.target.classList.toggle('scrolled', e.target.scrollTop > 2), { passive: true });
  }
  window.addEventListener('popstate', (e) => apply(e.state));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { wakeUp(); wake(); if (!$('now').hidden) renderNow(); } else { cancelWatch(); stopReading(); if (S.view === 'play') closePlayer(); sleep('hidden'); }
  });
  window.addEventListener('pagehide', () => { cancelWatch(); stopReading(); sleep('hidden'); });
  // The network is back (signal again after driving through a dead zone, say): fresh links, tried fast.
  window.addEventListener('online', () => {
    if ((!S.kUp && !S.tg) || S.paused || document.visibilityState !== 'visible') return;
    closeLink();
    openLink();
    hello();
  });
  HomeShell.init();
  renderApps();
  loadApps();
  const returned = history.state;
  const requested=S.fragment.get('tab') || (location.hash==='#drive'?'drive':null);
  const fromApp=returned?.appUrl && ['apps','games'].includes(returned.tab) && (!requested||requested===returned.tab);
  const start=fromApp?returned.tab:TABS.includes(requested)?requested:'now';
  history.replaceState(fromApp ? returned : { v: 'list', tab: start }, '');
  S.tab = start;
  if(start==='drive')showPane('drive'); // Start location before waiting for the unrelated workstation or phone links.
  let ready = false;
  try { ready = await setupKeys(); } catch (e) { ready = false; }
  try { await setupBattery(); } catch (e) { S.tg = null; }
  await drivePhone.setup(S.fragment);
  wakeUp();
  renderWork();
  showPane(start);
  requestAnimationFrame(placeTabline);
  if (!fromApp || !focusApp(returned.appUrl)) focusFirst(start);
  renderState();
  registerServiceWorker();
  if (ready || S.tg) wake();
  // Opening the passive Now/Drive view is not a declaration that the wearer is parked.
  // Interactive controls ask when deliberately activated; the route preview is parked-only.
  if (S.tab === 'route') StudioParked.request();
}

main();

$('driveGps').addEventListener('click', toggleDriveGps);
$('drivePhoneToggle')?.addEventListener('click',()=>drivePhone.setEnabled(!drivePhone.enabled));
$('drivePhoneUse')?.addEventListener('click',()=>drivePhone.acceptOffer());
$('drivePhoneKeep')?.addEventListener('click',()=>drivePhone.keepCurrent());
$('driveRetry').addEventListener('click', retryDriveGps);
$('driveLight').addEventListener('click', nextDriveLight);
applyDriveLight();
paintDrive(driveFeed.snapshot());

// This is a saved route preview, not live navigation.
// Moving through the turns moves the dot along the route.
$('routeRows').addEventListener('focusin', (e) => {
  const b = e.target.closest('[data-s]');
  if (b && S.snap && S.snap.rt) placeRouteDot(S.snap.rt.steps[+b.dataset.s]);
});

// Watch: search lives above the list.
$('ytFind').addEventListener('click', () => startCompose({ mode: 'yt' }));
;
