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
  //   waiting / connecting   still looking for the phone: normal for a moment, so no warning on top of the screen's own line
  //   none              no phone set up on these glasses
  //   pairing           the phone has not accepted these glasses yet
  //   stopped           the wearer stopped the phone link in this app
  //   unavailable       this app cannot run the secure link
  //   offline / paused  the phone was found but is not answering now
  const ALL = Object.freeze(['live', 'ready', 'waiting', 'connecting', 'none', 'pairing', 'stopped', 'unavailable', 'offline', 'paused']);
  // With these the phone is, or is about to be, the speed source: the glasses' own location problem is noise.
  const HEALTHY = Object.freeze(['live', 'ready', 'waiting', 'connecting']);

  // What backs the glasses' own GPS up, in words.
  function backup(link) {
    switch (link) {
      case 'live': case 'ready': case 'waiting': case 'connecting': return 'phone speed once you move';
      case 'none': return 'pair your phone';
      case 'pairing': return 'accept the code on your phone';
      case 'stopped': return 'phone link stopped';
      case 'unavailable': return 'phone link unavailable';
      default: return 'phone not answering';
    }
  }

  // The state of Studio Drive's phone link (drive-phone.js snapshot) in the shared words.
  function fromStudio(phone) {
    if (!phone || !phone.configured) return 'none';
    if (!phone.enabled || phone.state === 'off') return 'stopped';
    switch (phone.state) {
      case 'live': case 'ready': case 'no-sample': case 'stale': return 'live';
      case 'pairing': case 'waiting': case 'connecting': case 'offline': case 'paused': case 'unavailable': return phone.state;
      default: return 'offline';
    }
  }

  // The plain line for "no speed from the glasses' own location", given the phone link.
  // level: 'ok' (live) | 'wait' (nothing is wrong, or the phone is expected to supply the speed) | 'warn' (a definite
  // fault and nothing healthy behind it). text is '' unless level is 'warn': calm states keep each screen's own words.
  function line(gpsStatus, link) {
    const quiet = { level: gpsStatus === 'live' ? 'ok' : 'wait', text: '' };
    if (gpsStatus === 'live' || HEALTHY.includes(link)) return quiet;
    let fault;
    switch (gpsStatus) {
      case 'denied': fault = 'Glasses location not allowed'; break;
      case 'unsupported': fault = 'This app gets no location'; break;
      case 'inaccurate': fault = 'GPS signal too weak'; break;
      case 'unavailable': fault = 'GPS gives no speed'; break;
      case 'stale': fault = 'GPS speed lost'; break;
      case 'timeout': fault = 'GPS timed out'; break;
      case 'disconnected': fault = 'No GPS fix'; break;
      case 'invalid': fault = 'GPS reading unusable'; break;
      case 'off': case 'paused': case 'waiting': case 'no-response': return quiet;   // not started or still asking: no fault yet
      default: fault = 'GPS not working';
    }
    const way = backup(link);
    return { level: 'warn', text: `${fault}\n${way[0].toUpperCase()}${way.slice(1)}` };   // two short lines: what is wrong, then what to do
  }

  // i: { phoneFresh, gpsStatus, link }
  //   phoneFresh: the phone sent its own speed within the last few seconds
  //   gpsStatus:  the glasses' own location feed (live, denied, off, waiting, no-response, stale, ...)
  //   link:       one of ALL
  // Returns { source: 'phone' | 'glasses' | 'none', level: 'ok' | 'wait' | 'warn', text, code }.
  function check(i) {
    if (i.phoneFresh) return { source: 'phone', level: 'ok', text: '', code: 'phone' };
    if (i.gpsStatus === 'live') return { source: 'glasses', level: 'ok', text: '', code: 'glasses' };
    const l = line(i.gpsStatus, i.link);
    return { source: 'none', level: l.level, text: l.text, code: i.gpsStatus };
  }

  const api = Object.freeze({ check, line, backup, fromStudio, ALL, HEALTHY });
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SpeedCheck = api;
})(globalThis);
