'use strict';
// One existing app registration. Pairings stay in this app's browser storage and URL fragments.
window.HomeShell=(()=>{
  const by=id=>document.getElementById(id);
  const groups={now:'work',work:'work',watch:'work',apps:'work',games:'work',review:'review',route:'drive',drive:'drive'};
  let shown=false,idle=0,lastDrive='driveRun',depth=0,frameReady=false,pendingTab='',returnTimer=0;
  const frame=()=>by('reviewFrame');
  function tell(message){if(frameReady)frame().contentWindow.postMessage(message,location.origin);}
  function activateReview(active){
    const allowed=!!active&&!document.hidden&&StudioParked.confirmed();
    frame().hidden=!allowed||!frameReady;
    frame().inert=!allowed;
    by('reviewEnter').hidden=false;
    by('reviewEnter').textContent=allowed?'Focus review':'Open pictures while parked';
    tell({type:'studio-review-visible',active:allowed});
  }
  function quiet(focus=true){
    clearTimeout(idle);idle=0;shown=false;
    if(['driveRun','driveLight','driveLive'].includes(document.activeElement?.id))lastDrive=document.activeElement.id;
    stopDriveDemo();stopDriveLive();by('drive').dataset.controls='quiet';
    document.body.classList.toggle('drive-quiet',S.tab==='drive');StudioParked.revoke();
    if(focus&&S.tab==='drive'&&!document.hidden)by('driveReveal').focus({preventScroll:true});
  }
  function touch(){if(S.tab!=='drive'||!shown)return;clearTimeout(idle);idle=setTimeout(()=>quiet(),8000);}
  function reveal(){
    if(S.tab!=='drive'||document.hidden||StudioParked.isOpen())return;
    StudioParked.request(()=>{
      shown=true;by('drive').dataset.controls='parked';document.body.classList.remove('drive-quiet');
      (by(lastDrive)||by('driveRun')).focus({preventScroll:true});touch();
    },()=>quiet());
  }
  function ensureReview(){
    if(!StudioParked.confirmed()){activateReview(false);by('reviewState').hidden=false;by('reviewState').textContent='Open picture review only while parked.';return;}
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
    for(const button of document.querySelectorAll('[data-section]')){button.setAttribute('aria-current',button.dataset.section===group?'page':'false');button.disabled=S.view!=='list';button.title=button.disabled?'Use Back to return before changing sections.':'';}
    for(const button of document.querySelectorAll('.tab')){button.hidden=groups[button.dataset.tab]!==group;button.disabled=S.view!=='list';}
    document.querySelector('.tabs').hidden=group==='review';
  }
  function onPane(id,before){
    paint();document.body.classList.toggle('drive-view',id==='drive');
    if(id==='drive'&&before!=='drive'){stopReading();by('push').hidden=true;quiet(false);}
    else if(id!=='drive'){clearTimeout(idle);idle=0;shown=false;document.body.classList.remove('drive-quiet');}
    if(id==='review')ensureReview();else activateReview(false);
  }
  function canLeaveReview(tab){
    if(S.tab!=='review'||tab==='review'||depth===0)return true;
    pendingTab=tab;tell({type:'studio-review-root'});clearTimeout(returnTimer);
    returnTimer=setTimeout(()=>{pendingTab='';by('reviewState').hidden=false;by('reviewState').textContent='Use Back to return to the picture list before changing sections.';},2500);
    return false;
  }
  function focusReview(){
    if(!StudioParked.confirmed()){StudioParked.request(()=>{ensureReview();focusReview();},()=>activateReview(false));return;}
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
      if(depth===0&&pendingTab){const tab=pendingTab;pendingTab='';clearTimeout(returnTimer);selectTab(tab);}
    }
  });
  function handleKey(event){
    if(S.tab!=='drive'||StudioParked.isOpen()||!event.isTrusted)return false;
    if(!shown&&['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter',' '].includes(event.key)){
      event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)reveal();return true;
    }
    if(shown&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();quiet();return true;}
    if(shown)touch();
    return false;
  }
  function init(){
    for(const button of document.querySelectorAll('[data-section]'))button.addEventListener('click',()=>selectTab({work:'now',review:'review',drive:'drive'}[button.dataset.section]));
    by('reviewEnter').addEventListener('click',focusReview);by('driveReveal').addEventListener('click',reveal);
    document.addEventListener('studio-parked-change',()=>{activateReview(S.tab==='review');});
    document.addEventListener('click',event=>{if(event.isTrusted)touch();},true);
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden){if(S.tab==='drive')quiet(false);activateReview(false);}
      else {activateReview(S.tab==='review');if(S.tab==='review'&&!StudioParked.confirmed())StudioParked.request();}
    });
    window.addEventListener('pagehide',()=>{clearTimeout(idle);clearTimeout(returnTimer);activateReview(false);if(S.tab==='drive')quiet(false);});
  }
  return Object.freeze({init,onPane,canLeaveReview,focusReview,handleKey,driveQuiet:()=>S.tab==='drive'&&!shown,
    tabsForInput(target){return target.closest('.sections')?['now','review','drive']:Object.keys(groups).filter(key=>groups[key]===groups[S.tab]);}
  });
})();
