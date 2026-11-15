# Drive speed

Bakar Home and Bakar Drive share one speed display. An authenticated linked reading has priority for less than 3.5 seconds from its frame timestamp, with a separate receiving clock to enforce expiry. The existing phone protocol identifies a speed value but does not identify a wheel sensor, vehicle bus or handset model.

If the link has no fresh reading, Drive uses location supplied to the web app. An accurate speed can be shown for up to five seconds from acquisition. When the provider omits speed, the app can estimate it from two recent, sufficiently accurate positions. The local calculation and the linked source have distinct labels. An unavailable value stays a dash. Position samples are held briefly in page memory for calculations and are cleared when leaving Drive. The private workstation diagnostics contain no coordinates, headings or speed values.

Entering Drive requests location when permitted. A recorded Stop remains in force until the user starts it again. Returning to a visible Drive page rechecks the native permission and can resume an existing grant without a new prompt. The driver sees a single speed status. Detailed permission, link and callback information is available in the controls. An unrelated workstation timeout or pairing notice cannot replace the active Drive pane.

## A dash always says why (15 Nov 2026, build 46)

Bakar's glasses are paired with an iPhone since about 10 Nov 2026, so there is no phone app sending speed: Drive runs on the location the glasses' browser gives it. Until build 46 every state without a speed read "Speed unavailable" and nothing else.

- `drive-location.js` (`NO_SPEED`, `display`) now gives each state one short reason and what happens next. Bakar Drive shows the reason on the top line and the next step under "km/h"; Bakar Home's Drive tab shows both on its one status line.

| State | Reason | Next |
|---|---|---|
| Asked, no answer yet | Waiting for location | It comes from your phone |
| No answer after 12 s, timed out, or no fix (build 49) | No location from your phone | Open Meta AI on your phone |
| A position more than 5 s old (build 49) | Location found | Waiting for a newer fix |
| Fixes stopped | No new location | Waiting for your phone |
| Fix without a speed | Location found | Working out speed |
| Fix rougher than 50 m | Location too rough | Waiting for a better fix |
| Fix with a bad time or speed | Location not usable | Waiting for the next fix |
| Refused | Location not allowed | Allow it for this app, then Start GPS |
| Not started | GPS is off | Press Start GPS |

- With a linked Android phone that has answered, Bakar Drive says "Waiting for speed from phone / It shows when the phone sends it" instead. A fresh linked speed still wins over everything.
- A fix rougher than 50 m with no speed is now "too rough", not "working out speed": no speed can be worked out from it.
- Bakar Drive remembers that location works as soon as one position arrives, not only once a speed shows, so the next visit starts by itself.
- Not changed, by rule: a speed older than 5 s is dropped, a fix rougher than 50 m is not used, and a fix stamped later than the glasses' clock is rejected. (Build 50 changed three of these on Bakar's word: see "Always a speed" below.)
- Checked in a desktop browser with played location only. Not checked: the real glasses, an iPhone, a real drive.

## It keeps asking until the phone answers (15 Nov 2026, build 49)

Bakar, from the glasses on build 48, 15 Nov 2026 13:00: "it's still stuck on waiting for location. No location yet. It keeps trying by itself ... Broken".

The glasses have no GPS. The Meta AI app on the paired iPhone hands location to the web app. Meta's guidance says positions are one-shot and that `timeout` and `maximumAge` are not used. Until build 49 the app opened one watch and asked again by itself only after proof of permission (a granted answer from the browser, or a first position). With neither, one silent watch was all there was.

- `drive-location.js` now also takes a returned error (timed out, or no position) as proof that no permission question is open, and keeps asking: one request after the error, then again after 4 s, 4 s, 6 s, 9 s, 13 s and every 15 s while nothing comes back. A request that is answered starts the count again.
- The requests take turns: a relaxed one (no high accuracy, a position up to 10 s old allowed), then a precise one (new fix only).
- A watch that has produced nothing for 30 s is opened again.
- On glasses where location answered on an earlier visit (the app remembers that in `bakar.drive.gps` / `bd.gps`), one request is made even before any error. If it is never answered, nothing more is asked until there is proof: a second request must not stack a permission question.
- Never while a permission question may be open: with the permission reported as "prompt", or unknown with no answer of any kind yet, the app does not ask twice.
- A position older than 5 s is never a speed. If it is under a minute old it now reads "Location found / Waiting for a newer fix" instead of "No new location": it shows that the phone is answering.
- The words for no answer are "No location from your phone" and "Open Meta AI on your phone".
- Details on both faces list: how many times location was asked for, how many answers came, the last error in words (timed out, phone gave no position, not allowed), the permission, and the last fix's time and accuracy. No coordinates.
- Checks: `tests/drive-location.test.cjs`, section "keeps asking" (a provider that never answers; a timeout then an answer to a relaxed request; "no position" five times then a fix; only 8-second-old positions). Played in Node and a desktop browser only. Not seen on the real glasses: whether the Meta runtime answers the repeated requests is not known until Bakar tries build 49.

## Always a speed: standing still, walking, running (15 Nov 2026, build 50)

Bakar, 15 Nov 2026 12:57: "Make sure the speed is always available, even if we're at 0 km/h, for the drive app." And 12:58: "it should work even with my human speed. Even my walking speed and running speed should be detected. It should always work."

Both faces (Bakar Drive and Bakar Home's Drive tab) share these rules through `drive-location.js` and `drive/guide.js`.

**Standing still stays 0.**
- Once a usable fix has shown standing still (a speed under 1 km/h, reported by the phone or worked out from positions), the big number stays 0 when fixes go quiet. It is not replaced by a dash for silence, a timed-out request, an old cached position or a rough fix.
- The age of the last fix is always beside it: "Standing still · last location 40 s ago" (Home), or "Standing still" with "Last location 40 s ago" under km/h (Bakar Drive). It moves in 5 s steps, then minutes.
- A fix that shows movement replaces the 0 at once.
- The 0 ends, and the reason line returns, when: location is refused; GPS is stopped; the display was hidden and shown again (the car may have moved off while it slept, so the first fix after says what is true); or a new fix arrives that cannot say whether you moved.
- A fix with speed 0 shows 0 at once. With no speed from the phone, the second fix in the same place shows 0 at once. After a long quiet gap, a fix in the same place as the last one shows 0 at once; a fix somewhere else shows no number until the next fix gives a speed.
- Before any fix at all (waiting, refused, off, no location in this app) nothing is invented: the reason lines stay.
- The PC's diagnostics still hear "stale" for this state, the word the relay already knows.

**A moving speed is not held.** At 20 km/h and above, a speed older than 5 s is dropped and the reason line shows, as before. A held 60 would be a lie.

**Under 20 km/h a speed may stay up to 10 s.** On foot fixes are sparse. From 5 s it is labelled "Estimated speed". After 10 s it is dropped (unless it was standing still).

**Walking and running.** Where the phone gives no speed, it is worked out from positions:
- At car speeds: the distance between two fixes 1.5 to 6 s apart, as before. Pulling away, a clear difference over the last two seconds wins, so the number does not lag behind.
- Under 20 km/h: the slope of a straight line fitted through the last 12 s of fixes, because a few seconds of walking is smaller than GPS scatter. It counts only when the last 6 s show movement too, and one doubtful look does not drop a walker to 0 (the third in a row does).
- Braking or stopping: anything faster than a walk must show in the last 4 s too, or those 4 s alone are the speed.
- Moving estimates under 20 km/h are blended a little with the one before. Standing still is never blended: it is 0 at once.
- A speed reported by the phone always wins over all of this.
- The trail of fixes kept in page memory is now 20 s (was 12 s), plus the one fix before a long gap. Still nothing in storage, nothing sent.

**Compass on foot.** From 1.8 km/h (0.5 m/s) the course is the bearing between two fixes at least 12 m apart, kept for 12 s at walking pace (5 s in a car). Standing still there is no course and no tape. The glasses' own compass (device orientation) is not used: it says where the head points, not where you are going, and its axes on these glasses could not be checked without the device.

**A phone clock that runs ahead.** A fix stamped up to 2 s ahead of the glasses' clock is used as "now" (speed, guidance and cameras). One stamped further ahead is still rejected.

**Checks.** `tests/drive-location.test.cjs` (standing still, slow hold, clock), `drive/tests/guide.test.cjs` ("on foot": walking 5 and 3.5 km/h, running 12 km/h, a fix every 4 s, stop and go, walking then driving then a stop, with made-up scatter of 3 m), `drive/tests/speed-faces.cjs` (both faces in a browser with a played clock). All played. Not checked: the real glasses, a real walk, run or drive. How often the phone really sends fixes on foot, and how they scatter, is not known.

## Compass and saved-route guidance (11 Nov 2026)

Bakar, 11 Nov 2026: "I also want to be able to navigate, have a compass, have a speedometer ... I'm a professional driver" and "get rid of those CHECKS to see if im driving ... GONE AND REMOVED."

- **Compass tape** (`drive/guide.js`, `tape`): the GPS course over the ground under the unit line: ticks every 15 degrees, the compass points either side, north in the accent colour and never dimmed, and one readout at the needle ("E 090°"). It is the way the car moves, not the way the wearer looks. Standing still there is no course and the tape is not drawn: never an old heading. (Until build 50 this was below about 7 km/h; on foot it now uses the bearing between fixes.) It always keeps its room, so the speed does not move when it comes and goes.
- **Saved-route guidance** (`drive/guide.js`, `Guide`): with no directions from a phone, the turn line shows the next turn along the route the PC saved (`relay/route.py` adds `gl`, the road as latitude/longitude pairs within about 12 m; `gs`, every turn as metres from the start plus words; `gm`, the road's length). The glasses work it out from their own location.
  - It starts only after three fixes in a row on the line and moving the way the road runs there (course within 60 degrees), and only for a route saved in the last 18 hours. Crossing the route, or driving it the other way, starts nothing.
  - Three fixes off the line: "Off the saved route" in amber, and how far. 2.5 km off or five minutes off: it stops quietly. Three fixes going back along it: it stops, and stays stopped for that route.
  - A fix older than five seconds or rougher than 50 m never moves it. Beside anything but a live reading the turn is replaced by "Saved route paused / Waiting for location", and by nothing once GPS is stopped.
  - "Arrived" shows for two minutes, or until the wearer is 150 m from the end.
  - The words: distance first ("350 m · Turn left · Second Ave"), one line always (a long name is cut), the distance larger under 300 m. The line under it says what this is: "Saved route · not live · 850 m to go". There is no rerouting and no traffic.
- **No press to start:** opening Drive starts the speed by itself when location is already allowed (the feed's own resume path, so no permission prompt can come from looking at Drive). A Start that worked is remembered on the glasses (`localStorage`, `bakar.drive.gps`) and made again next visit even where the runtime cannot report the permission. A deliberate Stop holds until the next Start and clears that memory.
- **Course without a heading:** where the glasses' location gives no heading, the course is the bearing between two fixes at least 12 m apart, used for the tape and for guidance, and dropped after five seconds without fresh movement. A reported heading always wins.
- **Speed without a reported speed:** where the glasses' location reports no speed, the feed is handed one worked out from the last few fixes (distance from a fix 1.5 to 6 seconds back, over the time between; movement inside the fixes' own scatter is zero). A reported speed is never replaced. It passes the same filters and shows under the same "GPS estimate" label.
- **Privacy:** the fix is read as it arrives. Page memory holds metres along the route, metres off it, and the last few seconds of fixes needed to work out direction and speed, replaced as the car moves. Nothing is written to storage and nothing is sent. The route itself reaches the glasses inside the same encrypted snapshot as before.
- **No parked check:** `parked.js` no longer asks anything; the Route tab and Drive controls open at once. The old dialog is in git history.
- **Checks:** `node --test drive/tests/guide.test.cjs` (28 cases) and the auto-start and saved-route sections of `node drive/tests/studio-browser.cjs [outDir]` (frames `s13` to `s17`). Not checked: real optics, real GPS on the glasses, a real drive.
- **Limits:** a route is made on the PC (`route.py "Place"`, or the AIs' `glasses_route` tool) before setting off. Picking a destination from the car or rerouting needs an iPhone-side sender; that is not built.

## Fixed-camera warning (11 Nov 2026)

Bakar, 11 Nov 2026: "radarbot functionality for when i am near speed cameras or any areas where i need to be cautious or watch my speed" and "No bullshit, though."

- **What it does** (`drive/cameras.js`): when a fixed camera is on the road ahead, the top line of Drive says what and how far in amber: "Red light camera · 300 m", "Speed camera · limit 50 · 300 m". Over a speed camera's posted limit, the speed number itself turns amber. It takes the same room as the calm line, so the speed does not move. It is silent: no sound.
- **"Ahead on this road":** in front of the car, within 25 seconds of travel (never under 400 m, never over 1 km), and no more than 60 m to the side of the line of travel (up to 15 m more for a rough fix). It starts only on a camera at least 25 m ahead, then stays through the stop line and the junction until the camera is 15 m behind. Stopped with no course, it stays unless the camera falls 40 m behind where it was. No fresh fix, no warning.
- **The list** (`drive/cameras.json`, built by `node tools/build-cameras.cjs`): the City of Toronto's own red light cameras (open data, refreshed daily by the City) plus the cameras mapped in OpenStreetMap for Canada. 739 sites on 11 Nov 2026: 504 red light, 235 speed. One site per place and kind.
- **Where the law ended speed cameras:** Ontario (municipal speed cameras banned from 14 November 2025, Bill 56) and Alberta (speed-on-green and highway photo radar ended 1 April 2025). Speed cameras mapped there are left out (183 on 11 Nov 2026); red light cameras stay. So in Ontario this warns about red light cameras only. One table in the builder.
- **Beside a motorway:** a red light camera within 80 m of a motorway (40 on 11 Nov 2026; the Lake Shore cameras under the Gardiner are the case) is marked. A speed camera near a motorway is never marked: it watches the motorway and warns at any speed. It warns only below 70 km/h and names its street where the City gives one ("Red light camera on Lake Shore · 300 m"), so a driver on the motorway is not told about the street below.
- **Where it warns when it should not, or late. Known and not fixed:**
  - The City publishes the junction, not the approach: every approach to a camera junction warns, including ones the camera does not watch.
  - The other side of a divided road warns too, and so does a parallel street closer than about 60 m.
  - Crawling under 70 km/h on a motorway beside a marked camera still warns; the street name is what tells them apart.
  - Stopped just past the camera point (inside the junction), it still shows the last few metres until the car moves on.
  - Above 70 km/h on the street itself beside a motorway (Lake Shore under the Gardiner), a marked camera is silent.
  - On a bend the camera can be outside the straight line of travel until the car has turned toward it, so the warning comes later.
  - While speed comes from an Android phone link instead of the glasses' own location, there are no positions and so no camera warnings.
- **What it does not know, and never claims:** mobile radar, police positions, temporary cameras, and any camera nobody mapped. No open source has them. Canada only: it is silent in the United States. Outside Toronto the list is volunteer-mapped and can be incomplete or out of date. A quiet screen is not a promise.
- **Fresh list:** run the builder and publish; it refuses to write a list much shorter than the last one. GPS details says what the list covers, its date, and its age once that passes 14 days. Past 30 days the Drive face itself adds "camera list N days old" in amber after "Just now", and "no camera list" if the list could not be loaded. Nothing refreshes it automatically yet.
- **Privacy:** worked out on the glasses from each fix. Only the camera being warned about and the last distance to it are held, in page memory. The builder asks its sources for whole regions and for the camera sites themselves, never for where anyone is.
- **Checks:** `node --test drive/tests/cameras.test.cjs` (15 cases, with the builder on saved answers and the shipped list) and the camera section of `node drive/tests/studio-browser.cjs [outDir]` (frames `s18` to `s20`). A played drive on the shipped list toward Toronto's Dixon Rd / Carlingview camera warned from 400 m. Not checked: the real glasses, a real drive past a real camera.
- **Licences:** contains information licensed under the Open Government Licence - Toronto; map data (c) OpenStreetMap contributors, ODbL.

Sources:
- [Meta glasses device guidance](https://github.com/meta/meta-wearables-webapp/blob/main/plugins/meta-wearables-webapp/skills/ai-glasses-webapp-device/SKILL.md)
- [W3C Geolocation](https://www.w3.org/TR/geolocation/)
- [Meta Sensors and location](https://wearables.developer.meta.com/docs/develop/webapps/build/sensors-and-location/)

## One compass and one camera watch for both faces (15 Nov 2026, build 50, round 2)

Bakar Drive (drive/) now shows the same compass tape and the same fixed-camera warning as Bakar Home's Drive tab, from the
same code: `DriveGuide.paintTape` (drive/guide.js) draws the tape for both, `drive/tape.css` styles it for both, and
drive/cameras.js with drive/cameras.json is in Bakar Drive's bundle and offline cache. On Bakar Drive the camera line sits
above the number across the whole width (the top line shares its row with the clock) and the number goes amber over the
posted limit.

Not shared: the next turn along the route saved by the PC. That route reaches the glasses inside Bakar Home's encrypted
snapshot from the PC. Bakar Drive has no link to the PC and must not get one by copying Home's pairing and crypto code, and
the route is deliberately not written to storage where another page could read it. Bakar Drive's turns come from the phone
app link instead (LINK.md).

Also in this round: a reading of 0 is never called "estimated" (from five seconds it is "Standing still"); the details
words for "the phone sent nothing" are the same as on the face; the turn line on Home's Drive tab always keeps its room so
the speed does not move; Speed details scrolls its words and keeps "Back to speed" on screen; "Open Studio Drive" is
"Open Bakar Home".
