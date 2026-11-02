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
