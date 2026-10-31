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
  if(m.type==='studio-review-focus'&&typeof visibleControls==='function'){
    const here=document.activeElement;
    (here!==document.body&&here?.getClientRects().length?here:window.reviewRows()[0]?.[0])?.focus({preventScroll:true});
  }
});
// One focus model. The parent's moveFocus also moves focus in here, through these rows, so a swipe means the same inside
// the frame as outside it and the top row leads back up to the sections. Neighbours side by side share a row (a list
// scrolled under the heading isn't beside it); a list is its rows, unless focus sits on the list itself.
window.reviewRows=()=>{
  const controls=visibleControls(),rows=[];
  for(const el of controls){
    const scroller=el.classList.contains('native-scroll');
    if(scroller&&el!==document.activeElement&&controls.some(c=>c!==el&&el.contains(c)))continue;
    const box=el.getBoundingClientRect(),mid=(box.top+box.bottom)/2,last=rows[rows.length-1];
    if(last&&last[0].parentElement===el.parentElement&&!scroller&&mid>last.top&&mid<last.bottom)last.push(el);
    else rows.push(Object.assign([el],{top:box.top,bottom:box.bottom}));
  }
  return rows;
};
// Arrow keys land in this document, where the parent can't see them. Three things keep a press here first: a text box
// moves its caret, long text scrolls, and Inspect pans. At the end of each, the press moves on like any other, so
// nothing in the frame can hold focus. Everything else goes up to moveFocus, with the browser's own focus move stopped.
function arrowStaysHere(event){
  const a=event.target,k=event.key,ahead=k==='ArrowDown'||k==='ArrowRight';
  if(a.matches?.('textarea,input,select'))return ahead?a.selectionEnd<a.value.length:a.selectionStart>0;
  if(a.id==='pictureFrame'&&navigation.route?.kind==='inspect')return k==='ArrowLeft'?review.panX<50:k==='ArrowRight'?review.panX>-50:k==='ArrowUp'?review.panY<50:review.panY>-50;
  return false;
}
document.addEventListener('keydown',event=>{
  if(window.parent===window)return;
  if(event.key==='Enter'&&event.repeat){event.preventDefault();return;} // Still the press that moved focus in here.
  if(!event.key.startsWith('Arrow')||arrowStaysHere(event))return;
  event.preventDefault();
  const a=event.target,down=event.key==='ArrowDown';
  if(a.classList?.contains('native-scroll')&&(down||event.key==='ArrowUp')){
    const room=down?a.scrollHeight-a.clientHeight-a.scrollTop:a.scrollTop;
    if(room>2){a.scrollBy({top:down?150:-150});return;}
  }
  window.parent.postMessage({type:'studio-review-key',key:event.key},location.origin);
},true);
window.reviewComponentReady=()=>window.parent.postMessage({type:'studio-review-ready'},location.origin);
