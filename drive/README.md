# Bakar Drive for Meta Ray-Ban Display

Open the installed Bakar Drive app or select Bakar Drive in Bakar Home’s Apps list. The speed display prefers fresh readings from a linked source. It uses the location available to the app when that source has no current reading. Only an active route supplies turns and arrival details. The speed number is an estimate for reference; vehicle instruments remain the reference for driving.

Use **Details** for connection and permission information. A pairing code is shown only while a new registration awaits acceptance. See [the Drive notes](../DRIVE.md) for speed selection, freshness and privacy.

## Files

| File | What it does |
|---|---|
| `index.html`, `style.css`, `app.js` | The screen, controls, GPS and the link to the phone |
| `link-core.js` | Keys, sealing and the checks on every message from the phone (no DOM, no network) |
| `speed-check.js` | The speed self-check: with no speed on screen, a plain two-line warning for a hard fault of the glasses' own location with nothing healthy behind it (no DOM, no timers; also loaded by Studio Drive) |
| `guide.js` | Compass tape and saved-route guidance for Studio Drive (Home's Drive tab): no DOM, no timers, no network. See `../DRIVE.md`, "Compass and saved-route guidance" |
| `cameras.js`, `cameras.json` | Fixed-camera warning for Studio Drive and its public list (built by `../tools/build-cameras.cjs`). See `../DRIVE.md`, "Fixed-camera warning" |
| `sw.js` | Keeps this app's own files for a weak signal; handles nothing else |
| `.well-known/meta-wearables-manifest.json`, `icon*.svg` | Name and icon in the glasses launcher |
| `LINK.md` | The phone-to-glasses protocol, for the phone side |
| `tests/` | `node --test tests/link-core.test.cjs tests/speed-check.test.cjs`, `node tests/browser.cjs [outDir]` (this page) and `node tests/studio-browser.cjs [outDir]` (Studio Drive); Playwright, 600×600 |

`tests/vectors.json` holds throwaway test keys and exact expected bytes, so the phone sender can prove it matches.
