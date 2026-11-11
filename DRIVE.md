# Drive speed

Bakar Home and Bakar Drive share one speed display. An authenticated linked reading has priority for less than 3.5 seconds from its frame timestamp, with a separate receiving clock to enforce expiry. The existing phone protocol identifies a speed value but does not identify a wheel sensor, vehicle bus or handset model.

If the link has no fresh reading, Drive uses location supplied to the web app. An accurate speed can be shown for up to five seconds from acquisition. When the provider omits speed, the app can estimate it from two recent, sufficiently accurate positions. The local calculation and the linked source have distinct labels. An unavailable value stays a dash. Position samples are held briefly in page memory for calculations and are cleared when leaving Drive. The private workstation diagnostics contain no coordinates, headings or speed values.

Entering Drive requests location when permitted. A recorded Stop remains in force until the user starts it again. Returning to a visible Drive page rechecks the native permission and can resume an existing grant without a new prompt. The driver sees a single speed status. Detailed permission, link and callback information is available in the controls. An unrelated workstation timeout or pairing notice cannot replace the active Drive pane.

## Compass and saved-route guidance (11 Nov 2026)

Bakar, 11 Nov 2026: "I also want to be able to navigate, have a compass, have a speedometer ... I'm a professional driver" and "get rid of those CHECKS to see if im driving ... GONE AND REMOVED."

- **Compass tape** (`drive/guide.js`, `tape`): the GPS course over the ground under the unit line: ticks every 15 degrees, the compass points either side, north in the accent colour and never dimmed, and one readout at the needle ("E 090°"). It is the way the car moves, not the way the wearer looks. Below about 7 km/h the feed gives no course and the tape is not drawn: never an old heading. It always keeps its room, so the speed does not move when it comes and goes.
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
