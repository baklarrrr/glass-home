# Bakar Home

<sub>BAKAR STUDIO / WEARABLE EXPERIMENTS</sub>

A compact home screen for Meta Ray-Ban Display, bringing studio status, app links and picture review into one web interface.

It explores a practical question: how much useful studio context can fit into a brief glance? Work, Review and Drive have separate sections, with a dark interface designed for the glasses' 600 x 600 additive display.

[Hosted page](https://baklarrrr.github.io/glass-home/) | [Picture-review notes](review/README.md) | [Bakar Studio](https://bakar.ca/)

## Current status

This is a preparation build. **Task sending and feedback submission are disabled**, including the embedded picture-review Send action. The current source is not evidence of a finished agent workflow or acceptance on physical glasses.

Drive includes a sample gauge and a head-sensor check; it does not establish vehicle speed or verify that the wearer is parked. The interface asks for a parked declaration before interactive controls. The Games list is empty in the current source.

## Preview locally

Prerequisites: Git, Python 3 and a current browser. This repository is a static web app; no Node install or build step is needed. The app files are at the repository root.

```sh
git clone https://github.com/baklarrrr/glass-home.git
cd glass-home
python -m http.server 8000 --bind 127.0.0.1
```

Open <http://127.0.0.1:8000/> in a fresh browser profile without pairing information. A 600 x 600 browser viewport is useful for layout inspection. Use the visible controls or arrows and Enter; browser interaction does not qualify Neural Band input.

An unpaired preview has no studio session data or private pictures. Some sections need a relay or an existing app connection, and picture review reports a missing connection. This is a shell preview, with no bundled demo account or sample studio backend. Stop the server with Ctrl+C.

## Connected use

Studio status needs the separate studio PC relay and an explicit pairing accepted at that PC. This public repository contains the browser interface, not the PC relay or a complete backend setup. There is no relay install command in this checkout.

The Home connection uses a browser-generated P-256 key held in IndexedDB, ECDH/HKDF and AES-GCM messages. Embedded picture review can reuse an existing saved Studio Glass connection; it does not automatically create or migrate one. Installed apps may have separate browser storage, so another app's saved pairing cannot be assumed to exist here.

## Privacy and limits

The connection uses public MQTT brokers. Application messages are encrypted, while brokers can still observe topic names, connection metadata and traffic timing. Browser storage holds connection information and local state. Treat pairing material and browser profiles as private; do not commit them, runtime reports, private images or session links.

Opening external app links or video services contacts those services. Connection freshness, actual display readability, gestures and full device behavior need their own checks. This documentation update does not establish new browser, relay or hardware test results.

## Credits

Personal project by [Bakar Studio](https://bakar.ca/), independent of Meta. Embedded picture review derives from [Studio Glass](https://github.com/baklarrrr/studio-glass); its source checkpoint and behavior are recorded in [review/README.md](review/README.md). The app links to [Watchlight by Herald](https://watchlight.heralds.gg/) for an external YouTube experience.

The vendored [MQTT.js](https://github.com/mqttjs/MQTT.js) library retains its [MIT license and contributor credits](vendor/mqtt-LICENSE.md). That dependency license does not assign a license to the rest of this application.
