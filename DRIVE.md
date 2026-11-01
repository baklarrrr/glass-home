# Drive: phone GPS speed

Drive uses standard `navigator.geolocation.watchPosition()` in the existing glasses web app. Enable phone GPS is an explicit parked action. The browser/OS controls the permission prompt; the app never bypasses it. Re-entry in the same page resumes only if the browser reports an existing grant. Missing permission-query support requires another deliberate Enable. Leaving Drive or hiding the page releases the watch. Menu auto-hide does not stop an enabled feed.

The value is reported GPS ground speed, converted from metres per second to kilometres per hour. It is an estimate, not vehicle ECU telemetry, a vehicle instrument, or live navigation. No OBD connection is assumed. Saved routes remain parked planning previews. Platform driving restrictions remain in force.

The display accepts only finite nonnegative reported speed, finite nonnegative position accuracy no worse than 50 metres, and acquisition time less than five seconds old and not in the future. Values above 100 m/s are rejected as implausible for this road-oriented view. These are explicit product filters, not SDK thresholds or a guarantee of speed accuracy. The W3C API does not expose speed uncertainty or mock-location provenance. It cannot certify sensor truth. Null, invalid, denied, stale, disconnected and unsupported states display a dash; zero is shown only when the source reports zero. No speed is derived from coordinates.

Coordinates are neither retained nor transmitted by this feature. Only the current speed and its acquisition/arrival clocks exist in page memory. There is no new server, account, stored location history or background permission. `enableHighAccuracy` is a hint. No camera, microphone or motion permission is requested.

Controls reveal deliberately and hide after eight seconds without input. Incoming data does not reveal controls or move focus. Real agent Send remains disabled. The worker update waits for normal client closure and never forces an open HUD to reload.

Unit checks: `node --test tests/drive-location.test.cjs`. Browser fixtures must use synthetic geolocation callbacks, block external requests and avoid pairing. Browser checks do not establish physical-glasses acceptance or a real GPS stream. Parked wearer acceptance is tracked separately from web publication.

Sources:
- [Meta glasses device guidance](https://github.com/meta/meta-wearables-webapp/blob/main/plugins/meta-wearables-webapp/skills/ai-glasses-webapp-device/SKILL.md)
- [W3C Geolocation](https://www.w3.org/TR/geolocation/)
