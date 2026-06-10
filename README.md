# Kibitz — browser extension

Co-browse + call over any page, for people **and** AI.

Cast your browser tab into a shared room that **follows you across the web**: click
through pages and sites, and everyone in the room keeps seeing exactly what you see,
live — alongside voice, video, and chat. Peer-to-peer and end-to-end encrypted; no
account, no media server.

Part of [Kibitz](https://kibitz.chat). The call engine is the same composable WebRTC
core that powers kibitz.chat itself.

---

## Install (unpacked)

Not on the Chrome Web Store yet — load it directly:

1. Download this repo (Code → Download ZIP, then unzip) or `git clone` it.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and pick this folder (the one with `manifest.json`).
5. Pin the **Kibitz** icon to your toolbar.

Chrome 116+ on desktop. Chromium-based browsers (Edge, Brave, …) should work too.

## Use it

1. Open a website, then **click the Kibitz toolbar icon** — the side panel opens.
   (Clicking the icon on a page is also what authorizes Kibitz to share *that* page.)
2. **Copy invite** → send the room code to whoever (or whatever) you want in. They
   open Kibitz and paste the code to join.
3. **🖥️ Share tab** — your current tab becomes the room's "stage"; everyone sees it,
   and it keeps flowing as you navigate. Anyone can press Share to take over.
4. **🎙️ / 📷** for voice and camera, and the **chat** for messages and emoji.
5. **⛶** pops the shared page into a big resizable window (and fullscreen from there).

The mic/camera permission is granted once via a small window and then reused (a
Chrome side panel can't show that prompt itself).

## How it works

- **MV3 side panel hosts the call engine.** The side panel is one document per window
  that persists across tab switches and navigation — which is exactly why a shared
  cast survives you clicking from page to page.
- **Tab-scoped sharing.** Sharing captures a single browser *tab* via
  `chrome.tabCapture`, so the Kibitz UI itself is never in the stream (no nesting),
  and you only ever share the page you mean to.
- **Peer-to-peer media.** Voice/video/screen go straight between browsers over WebRTC,
  encrypted end-to-end (DTLS-SRTP). A signaling server (`signal.kibitz.chat`) only
  introduces peers; it never sees call content. There is no media server.
- **People and agents join the same room.** An AI agent can join a room the same way a
  person does — see what's shared, read the chat, and take part.

## Permissions

| Permission   | Why |
|--------------|-----|
| `sidePanel`  | The panel is the app's home, and persists across navigation. |
| `tabCapture` | Capture the current tab to share it (tab-scoped, never the whole screen). |
| `activeTab`  | Granted when you click the toolbar icon — what lets Kibitz capture *that* tab. |
| `tabs`       | Find the active tab to capture, and manage the big-watch window. |
| `storage`    | Remember your name, room, and a stable per-browser id. |

No analytics, no tracking, no ads.

## Build it yourself

The loadable files at the repo **root** are prebuilt, so you can Load unpacked with no
build step. To rebuild from source — **entirely within this repo, no monorepo needed**:

```bash
npm install
npm run build        # → recompiles sidepanel.js (the side-panel app) at the root
npm run typecheck    # optional: type-check against src/kibitz.d.ts
```

- [`src/sidepanel.ts`](src/sidepanel.ts) is the side-panel app; `vite` compiles it to
  `sidepanel.js`. It's small because the call engine is **not** bundled here.
- The engine is the vendored [`widget.js`](widget.js) — the same Kibitz engine bundle
  that powers kibitz.chat. It's loaded via `<script>` in
  [`sidepanel.html`](sidepanel.html) and used as the global `window.Kibitz`
  (types in [`src/kibitz.d.ts`](src/kibitz.d.ts)). To refresh it, download
  <https://kibitz.chat/widget.js> or build it from the
  [Kibitz repo](https://github.com/kibitz-chat/kibitz) (`npm run build` there emits
  `dist/widget.js`).

## License

MIT — see [LICENSE](LICENSE).
