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
  //   waiting / connecting   still looking for the phone (or opening the link): normal for a moment, so no warning on top
  //   none              no phone set up on these glasses
  //   pairing           the phone has not accepted these glasses yet
  //   stopped           the wearer stopped the phone link in this app
  //   unavailable       this app cannot run the secure link
  //   paused            the phone was found, the glasses can reach the brokers, and the phone has gone quiet
  //   nosignal          the glasses cannot reach the brokers at all: that is the story, not the phone
  const ALL = Object.freeze(['live', 'ready', 'waiting', 'connecting', 'none', 'pairing', 'stopped', 'unavailable', 'paused', 'nosignal']);
  // With these the phone is, or is about to be, the speed source: the glasses' own location problem is noise.
  const HEALTHY = Object.freeze(['live', 'ready', 'waiting', 'connecting']);

  // What backs the glasses' own GPS up, in words. "Compare", not "accept": the wearer taps Yes on the phone only when the
  // number it asks about is the one the glasses show (the Journal's own rule), and Studio Drive already says it this way.
  function backup(link) {
    switch (link) {
      case 'live': case 'ready': case 'waiting': case 'connecting': return 'phone speed once you move';
      case 'none': return 'pair your phone';
      case 'pairing': return 'compare the code on your phone';
      case 'stopped': return 'resume the phone link';
      case 'unavailable': return 'phone link unavailable';
      case 'nosignal': return 'no signal to phone';
      default: return 'phone not answering';
    }
  }

  // The hard faults of the glasses' own location, by status: [the line for a whole screen, the line for the small corner].
  // These stay put until something is done or the signal comes back, so they are worth an amber line. A reading that is
  // merely rough, without a speed or unusable (inaccurate, unavailable, invalid) comes and goes by itself, often while
  // parked or just after Start, so it keeps each screen's own calm words, and so does any status this does not know.
  // The corner beside turn-by-turn directions is about 250 px wide, so its first line stays at 20 characters or fewer; the
  // second line there is always "Phone not answering" or "No signal to phone" (directions are on screen only while the link is live or paused).
  const FAULTS = Object.freeze({
    denied: ['Glasses location not allowed', 'Glasses GPS refused'],
    unsupported: ['This app gets no location', 'No GPS in this app'],
    stale: ['GPS speed lost'],
    timeout: ['GPS timed out'],
    disconnected: ['No GPS fix'],
  });

  // The state of Studio Drive's phone link (drive-phone.js snapshot) in the shared words.
  function fromStudio(phone) {
    if (!phone) return 'none';
    if (phone.state === 'unavailable') return 'unavailable';   // this app cannot run the secure link, paired or not: nothing to pair
    if (!phone.configured) return 'none';
    if (!phone.enabled || phone.state === 'off') return 'stopped';
    switch (phone.state) {
      case 'live': case 'ready': case 'no-sample': case 'stale': return 'live';
      case 'pairing': case 'waiting': case 'connecting': return phone.state;
      case 'offline': return 'nosignal';
      default: return 'connecting';   // paused (the Drive tab is not on screen) or a state this does not know: not a fault
    }
  }

  // The plain line for "no speed from the glasses' own location", given the phone link.
  // level: 'ok' (live) | 'wait' (nothing is wrong, or the phone is expected to supply the speed) | 'warn' (a definite
  // fault and nothing healthy behind it). text is '' unless level is 'warn': calm states keep each screen's own words.
  // short is the same two lines for the small corner (see FAULTS).
  function line(gpsStatus, link) {
    const quiet = { level: gpsStatus === 'live' ? 'ok' : 'wait', text: '', short: '' };
    if (!Object.prototype.hasOwnProperty.call(FAULTS, gpsStatus) || HEALTHY.includes(link)) return quiet;
    const fault = FAULTS[gpsStatus];
    const way = backup(link);
    const then = `${way[0].toUpperCase()}${way.slice(1)}`;
    // two short lines: what is wrong, then what to do
    return { level: 'warn', text: `${fault[0]}\n${then}`, short: `${fault[1] || fault[0]}\n${then}` };
  }

  // i: { phoneFresh, gpsStatus, link }
  //   phoneFresh: the phone sent its own speed within the last few seconds
  //   gpsStatus:  the glasses' own location feed (live, denied, off, waiting, no-response, stale, ...)
  //   link:       one of ALL
  // Returns { source: 'phone' | 'glasses' | 'none', level: 'ok' | 'wait' | 'warn', text, short, code }.
  function check(i) {
    if (i.phoneFresh) return { source: 'phone', level: 'ok', text: '', short: '', code: 'phone' };
    if (i.gpsStatus === 'live') return { source: 'glasses', level: 'ok', text: '', short: '', code: 'glasses' };
    const l = line(i.gpsStatus, i.link);
    return { source: 'none', level: l.level, text: l.text, short: l.short, code: i.gpsStatus };
  }

  const api = Object.freeze({ check, line, backup, fromStudio, ALL, HEALTHY });
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SpeedCheck = api;
})(globalThis);
