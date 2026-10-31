'use strict';
window.reviewHostVisible=false;
document.body.inert=true;
window.addEventListener('message',event=>{
  if(event.source!==window.parent||event.origin!==location.origin||!event.data)return;
  const m=event.data;
  if(m.type==='studio-review-visible'&&typeof m.active==='boolean'){
    if(window.reviewHostVisible===m.active)return;
    window.reviewHostVisible=m.active;
    document.body.inert=!m.active;
    if(typeof onVisibility==='function')onVisibility();
  }
  if(m.type==='studio-review-root'&&typeof choosePeer==='function'&&navigation.route)choosePeer('pictures');
  if(m.type==='studio-review-focus'&&typeof visibleControls==='function')visibleControls()[0]?.focus({preventScroll:true});
});
window.reviewComponentReady=()=>window.parent.postMessage({type:'studio-review-ready'},location.origin);
