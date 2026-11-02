'use strict';
// One existing app registration. Pairings stay in this app's browser storage and URL fragments.
window.HomeShell=(()=>{
  const by=id=>document.getElementById(id);
  const groups={now:'work',work:'work',watch:'work',apps:'work',games:'work',review:'review',route:'drive',drive:'drive'};
  let shown=false,wayOut=false,idle=0,lastDrive='driveGps',depth=0,frameReady=false,pendingTab='',returnTimer=0,locationPending=false,pendingReview=false;
  const frame=()=>by('reviewFrame');
  function tell(message){if(frameReady)frame().contentWindow.postMessage(message,location.origin);}
  function activateReview(active){
    const allowed=!!active&&!document.hidden&&StudioParked.confirmed(),inside=document.activeElement===frame();
    frame().hidden=!allowed||!frameReady;
    frame().inert=!allowed;
    by('reviewEnter').hidden=false;
    by('reviewEnter').textContent=allowed?'Focus review':'Open pictures while parked';
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
    // The child can already occupy all five history entries. Return it to its existing
    // root before adding the parked dialog entry; its saved drafts/receipts are retained.
    if(!StudioParked.confirmed()&&depth>0){
      pendingReview=true;tell({type:'studio-review-root'});clearTimeout(returnTimer);
      returnTimer=setTimeout(()=>{pendingReview=false;by('reviewState').hidden=false;by('reviewState').textContent='Use Back to return to the picture list, then open pictures while parked.';},2500);
      return;
    }
    if(!StudioParked.confirmed()){StudioParked.request(()=>{ensureReview();focusReview();},()=>{activateReview(false);by('reviewEnter').focus({preventScroll:true});});return;}
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
    for(const button of document.querySelectorAll('[data-section]'))button.addEventListener('click',()=>selectTab({work:'now',review:'review',drive:'drive'}[button.dataset.section]));
    by('reviewEnter').addEventListener('click',focusReview);by('driveReveal').addEventListener('click',reveal);
    by('driveInfoButton').addEventListener('click',openDriveInfo);by('driveInfoClose').addEventListener('click',()=>closeDriveInfo());
    document.addEventListener('studio-parked-change',()=>{
      activateReview(S.tab==='review');
      if(StudioParked.confirmed()||StudioParked.isOpen())return;
      // The answer is gone, however it went: nothing parked-only stays open behind it.
      if(S.tab==='route')selectTab('drive');
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
