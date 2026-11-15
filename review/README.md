# Review: what was the separate Bakar Studio app

Bakar Home is the one app. This directory is its Review section: **Pictures**, **Feedback** and **Renders**.
It is the code of `baklarrrr/studio-glass` (first taken at commit `b61cb2ea5d423d7e3c3e7bc339beacf85406f52a`),
kept as its own modules (`app.js`, `review.js`, `navigation.js`) and loaded in a same-origin frame, so its
behaviour is reused, not rewritten. `studio-glass` itself is now only a page that forwards here.

| Place | What it does | Code |
|---|---|---|
| Pictures | Recent render pictures, Fit and Inspect, Previous/Next, Give feedback | `review.js` |
| Feedback | Saved feedback and its progress, result pictures, Revise | `review.js` |
| Renders | Render progress and jobs, AI at work, AI use today, glasses state | `app.js` (the `studio` peer) |

The parent keeps the one `glass-home` registration and URL. This directory has no wearable app marker and
registers no service worker; the parent owns the shell cache, and the MQTT library is the parent's vendor file.

Pairing: `passPairing('sg')` in the parent's `app.js` gives the Studio pairing, in this order: a `#sg=topic~key`
fragment (what the forwarding page sends), a Bakar Studio link opened here directly (`#t=…&k=…`), the copy Bakar
Home already keeps (`gh.pass`), then the pairing the old Studio app saved on this origin (`sg.pair`), which is
brought across once. `home-shell.js` hands it to this frame in a URL fragment only. Feedback drafts and receipts
use the same storage key as the old app (`sg.review.v1.<topic>`), so they are still here. Storage that Meta may
isolate per installed app cannot be assumed to appear; a missing pairing is said plainly and nothing pairs itself.

Both sides validate message origin and sender. Messages: `studio-review-visible`, `-root`, `-focus`, `-place`
(parent to frame; `-place` selects Pictures, Feedback or Renders) and `studio-review-ready`, `-depth` (with the
current place), `-key` (frame to parent). Hidden views close their connections and cancel read requests and polling.

Focus has one owner. `moveFocus` in the parent's `app.js` walks the frame's controls as more rows of the same
list. `embedded.js` sends up the arrow keys that land in this document, and stops the browser's own focus move.
A text box's caret, long-text scrolling and Inspect's pan take a press first; at their end the press moves on.
Back stays the shell's `history.back()`, and `navigation.js` remains the only history owner.

The PC sidebar view (`window.STUDIO_LOCAL`) is not part of Bakar Home: it stays in `studio-glass` as `local.html`.
