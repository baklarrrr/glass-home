'use strict';
// A temporary human declaration, not measured vehicle motion or a safety certification.
(() => {
  // How long one "I'm parked" lasts. Five minutes covers a stop: read a session, answer it, check a picture.
  // It counts from the yes and activity never extends it, because someone who drove off and keeps pressing is
  // exactly who this is for. Going past it costs one press, and what is on screen stays where it was.
  const PARKED_ANSWER_MS=5*60*1000;
  const $=id=>document.getElementById(id),gate=$('parkedGate'),glance=$('glance');
  if(!gate||!glance||!$('parkedConfirm')||!$('parkedCancel'))return;
  let approved=false,until=0,expiry=0,onConfirm=null,onCancel=null,returnFocus=null,heldPress=null,enterDown=false,consumeEnter=false;
  let entry=false,decision=null;
  const usable=el=>el?.isConnected&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&
    !el.matches('textarea,input,select,iframe')&&el.getClientRects().length;
  function close(){gate.hidden=true;glance.inert=false;onConfirm=null;onCancel=null;heldPress=null;}
  function focusBack(){
    // Do not programmatically reopen a system text composer. Restore a nearby visible
    // action instead of leaving focus in the now-hidden dialog, preserving the draft.
    const nearby=returnFocus?.closest('section,main')?.querySelectorAll('button,[tabindex="0"]')||[];
    const target=[returnFocus,...nearby,...glance.querySelectorAll('button,[tabindex="0"]')].find(usable);
    target?.focus({preventScroll:true});
  }
  let enterAt=0;
  function request(confirm,cancel){
    if(!gate.hidden||entry)return;
    returnFocus=document.activeElement;onConfirm=confirm;onCancel=cancel;
    // One temporary entry, removed before any action runs. Parent screens use at most
    // three entries; HomeShell returns nested Review to its root before requesting.
    history.pushState({...history.state,studioParkedGate:true},'');entry=true;
    gate.hidden=false;glance.inert=true;$('parkedConfirm').focus({preventScroll:true});
  }
  function changed(){document.dispatchEvent(new Event('studio-parked-change'));}
  function grant(){approved=true;until=Date.now()+PARKED_ANSWER_MS;clearTimeout(expiry);expiry=setTimeout(revoke,PARKED_ANSWER_MS);}
  function withdraw(){approved=false;clearTimeout(expiry);}
  // The clock is also read here, because a sleeping page can run its timer late.
  function parked(){if(approved&&Date.now()>=until)revoke();return approved;}
  function drivingContext(){return !!($('drive')&&!$('drive').hidden)||!!($('route')&&!$('route').hidden);}
  function controlsAllowed(){return !drivingContext()||parked();}
  function finish(kind){
    if(gate.hidden||decision)return;
    consumeEnter=enterDown;decision=kind;history.back();
  }
  function cancel(){finish('cancel');}
  $('parkedConfirm').addEventListener('click',()=>finish('confirm'));
  $('parkedCancel').addEventListener('click',cancel);
  document.addEventListener('keydown',event=>{
    if(decision){event.preventDefault();event.stopImmediatePropagation();return;}
    // Confirmation changes focus. Consume the same held press until release so it cannot
    // immediately activate the newly focused sample, job, or feedback action.
    // Its release can land elsewhere once focus has moved, as into the picture frame, so after a second it's a new press.
    if(event.key==='Enter'&&consumeEnter&&(event.repeat||Date.now()<enterAt+1000)){event.preventDefault();event.stopImmediatePropagation();return;}
    if(event.key==='Enter')consumeEnter=false;
    if(gate.hidden)return;
    if(event.key==='Enter'&&event.repeat){event.preventDefault();event.stopImmediatePropagation();return;}
    if(event.key==='Enter'){enterDown=true;enterAt=Date.now();}
    if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();cancel();return;}
    // Two ordinary buttons. Keep desktop keys and wrist-arrow equivalents inside the dialog.
    if(event.key==='Tab'||event.key.startsWith('Arrow')){
      event.preventDefault();event.stopImmediatePropagation();
      (document.activeElement===$('parkedConfirm')?$('parkedCancel'):$('parkedConfirm')).focus();
    }
  },true);
  document.addEventListener('keyup',event=>{
    if(event.key!=='Enter')return;
    enterDown=false;
    if(consumeEnter){event.preventDefault();event.stopImmediatePropagation();consumeEnter=false;}
  },true);
  document.addEventListener('click',event=>{
    if(decision){event.preventDefault();event.stopImmediatePropagation();return;}
    if(!drivingContext()||parked()||!gate.hidden)return;
    const control=event.target.closest?.('button,textarea,input,select,iframe');
    if(!control||['section-work','section-review','section-drive','tab-now','tab-work','tab-watch','tab-drive','tab-apps','tab-games','driveReveal','driveGps','driveRetry','driveLight','driveInfoButton','driveInfoClose','reviewEnter'].includes(control.id)||gate.contains(control))return;
    event.preventDefault();event.stopImmediatePropagation();request();heldPress=control;
  },true);
  document.addEventListener('focusin',event=>{
    if(!gate.hidden&&!gate.contains(event.target)){$('parkedConfirm').focus();return;}
    if(drivingContext()&&!parked()&&gate.hidden&&event.target.matches?.('textarea,input,select,iframe'))request();
  });
  function revoke(){withdraw();if(!gate.hidden)finish('revoke');changed();}
  document.addEventListener('visibilitychange',()=>{if(document.hidden)revoke();});
  window.addEventListener('pagehide',()=>{withdraw();decision=null;close();changed();});
  window.addEventListener('pageshow',()=>{
    // A restored page must not revive an unanswered dialog or any deferred action.
    if(entry&&gate.hidden){decision='revoke';history.back();}
  });
  window.addEventListener('popstate',event=>{
    if(entry){
      event.stopImmediatePropagation();
      const kind=decision||'cancel',callback=kind==='confirm'?onConfirm:onCancel,press=heldPress;
      entry=false;decision=null;close();
      if(kind==='confirm'&&!document.hidden)grant();else withdraw();
      changed();
      if(kind==='revoke'||document.hidden)return;
      if(callback){callback();return;}
      focusBack();
      if(kind==='confirm'&&usable(press))press.click();
      return;
    }
    if(event.state?.studioParkedGate){
      // Forward through an old confirmation never grants permission or replays a press.
      event.stopImmediatePropagation();history.back();
    }
  });
  window.StudioParked=Object.freeze({request,revoke,confirmed:parked,controlsAllowed,drivingContext,isOpen:()=>!gate.hidden,
    start(){} // Passive startup never opens a dialog.
  });
})();
