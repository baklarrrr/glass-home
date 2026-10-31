'use strict';
// A temporary human declaration, not measured vehicle motion or a safety certification.
(() => {
  const $=id=>document.getElementById(id),gate=$('parkedGate'),glance=$('glance');
  if(!gate||!glance||!$('parkedConfirm')||!$('parkedCancel'))return;
  let approved=false,onConfirm=null,onCancel=null,returnFocus=null,enterDown=false,consumeEnter=false;
  function close(){gate.hidden=true;glance.inert=false;onConfirm=null;onCancel=null;}
  function focusBack(){
    const usable=el=>el?.isConnected&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&
      !el.matches('textarea,input,select,iframe')&&el.getClientRects().length;
    // Do not programmatically reopen a system text composer. Restore a nearby visible
    // action instead of leaving focus in the now-hidden dialog, preserving the draft.
    const nearby=returnFocus?.closest('section,main')?.querySelectorAll('button,[tabindex="0"]')||[];
    const target=[returnFocus,...nearby,...glance.querySelectorAll('button,[tabindex="0"]')].find(usable);
    target?.focus({preventScroll:true});
  }
  function request(confirm,cancel){
    if(!gate.hidden)return;
    returnFocus=document.activeElement;onConfirm=confirm;onCancel=cancel;
    gate.hidden=false;glance.inert=true;$('parkedConfirm').focus({preventScroll:true});
  }
  function changed(){document.dispatchEvent(new Event('studio-parked-change'));}
  function cancel(){const callback=onCancel;consumeEnter=enterDown;close();approved=false;changed();if(callback)callback();else focusBack();}
  $('parkedConfirm').addEventListener('click',()=>{const callback=onConfirm;consumeEnter=enterDown;close();approved=true;changed();if(callback)callback();else focusBack();});
  $('parkedCancel').addEventListener('click',cancel);
  document.addEventListener('keydown',event=>{
    // Confirmation changes focus. Consume the same held press until release so it cannot
    // immediately activate the newly focused sample, job, or feedback action.
    if(event.key==='Enter'&&consumeEnter){event.preventDefault();event.stopImmediatePropagation();return;}
    if(gate.hidden)return;
    if(event.key==='Enter'&&event.repeat){event.preventDefault();event.stopImmediatePropagation();return;}
    if(event.key==='Enter')enterDown=true;
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
    if(approved||!gate.hidden)return;
    const control=event.target.closest?.('button,textarea,input,select,iframe');
    if(!control||['section-work','section-review','section-drive','tab-now','tab-drive','driveReveal','reviewEnter'].includes(control.id)||gate.contains(control))return;
    event.preventDefault();event.stopImmediatePropagation();request();
  },true);
  document.addEventListener('focusin',event=>{
    if(!gate.hidden&&!gate.contains(event.target)){$('parkedConfirm').focus();return;}
    if(!approved&&gate.hidden&&event.target.matches?.('textarea,input,select,iframe'))request();
  });
  function revoke(){approved=false;if(!gate.hidden)close();changed();}
  document.addEventListener('visibilitychange',()=>{if(document.hidden)revoke();});
  window.addEventListener('pagehide',revoke);
  window.addEventListener('popstate',()=>{if(!gate.hidden)cancel();});
  window.StudioParked=Object.freeze({request,revoke,confirmed:()=>approved,isOpen:()=>!gate.hidden,
    start(){if(typeof navigation!=='undefined'&&navigation.route?.peer!=='drive')request();}
  });
})();
