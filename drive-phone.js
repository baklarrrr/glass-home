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
