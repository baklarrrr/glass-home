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
