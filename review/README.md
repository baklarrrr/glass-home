# Embedded picture review

This component preserves the picture, version and feedback UI from
`baklarrrr/studio-glass` commit `b61cb2ea5d423d7e3c3e7bc339beacf85406f52a`.
The parent keeps the existing `glass-home` registration and URL. This directory
has no wearable app marker and registers no separate service worker.

`home-shell.js` passes only the already-saved `sg` pairing through a URL fragment.
Both sides validate message origin and sender. The parent grants interaction only
after the temporary parked declaration. Hidden views close their connections and
cancel read requests and polling. The parent owns the shell cache; MQTT code is
shared with the existing parent vendor file.

The original app and its saved drafts are not deleted or migrated. Storage that
Meta isolates per installed app cannot be assumed to appear here. Missing
connections are shown explicitly; no new pairing is performed automatically.

Focus has one owner. `moveFocus` in the parent's `app.js` walks the frame's controls
as more rows of the same list. `embedded.js` sends up the arrow keys that land in this
document, and stops the browser's own focus move. A text box's caret, long-text scrolling
and Inspect's pan take a press first; at their end the press moves on. Back stays the
shell's `history.back()`, and `navigation.js` remains the only history owner.

Feedback submission and agent Send remain disabled in this preparation candidate.
Future enablement requires an authorized target, verified delivery and a correlated
receipt. Current task status is not proof that it answers a new instruction.
