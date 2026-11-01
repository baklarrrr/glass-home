# Bakar Drive for Meta Ray-Ban Display

A glasses app for driving, opened from Bakar Home's Apps list or as its own app
(`https://baklarrrr.github.io/glass-home/drive/`). It shows:

- **The next turn from Bakar Drive on the phone**: arrow, distance, next street, arrival time and distance left.
  This needs the phone's glasses link and a one-time pairing; see [LINK.md](LINK.md).
- **Phone GPS speed and heading**: through the glasses' web runtime, with the same filters as Bakar Home's Drive tab
  (`../drive-location.js`). The heading is the GPS course, shown only above about 7 km/h. Nothing about the position is
  kept or sent.

The screen is glance-only. Controls (Start GPS, Light, Directions) appear on a press and hide after 8 seconds. Light
follows the sun (Day, Dusk, Night) or is picked by hand. A turn older than 4 seconds dims and the top line says
directions are paused; after 30 seconds it is taken off the screen.

The phone link is kept on the glasses after the first visit. Opening a link for a different phone doesn't take over
silently: the screen asks (Use this phone, or Back to keep the one you have). Directions recorded earlier can't be
played back to the page, because every frame has to answer one of the page's own recent hellos.

## Files

| File | What it does |
|---|---|
| `index.html`, `style.css`, `app.js` | The screen, controls, GPS and the link to the phone |
| `link-core.js` | Keys, sealing and the checks on every message from the phone (no DOM, no network) |
| `sw.js` | Keeps this app's own files for a weak signal; handles nothing else |
| `.well-known/meta-wearables-manifest.json`, `icon*.svg` | Name and icon in the glasses launcher |
| `LINK.md` | The phone-to-glasses protocol, for the phone side |
| `tests/` | `node --test tests/link-core.test.cjs`, and `node tests/browser.cjs [outDir]` (Playwright, 600×600) |

`tests/vectors.json` holds throwaway test keys and exact expected bytes, so the phone sender can prove it matches.
