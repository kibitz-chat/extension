// Kibitz side panel — the redone extension's home. The side panel is GLOBAL (one
// document per window), so it persists across tab switches and navigation, which is
// exactly why it can host the call engine + WebRTC and have a shared cast survive
// page changes. We render our own tiles from the composable-engine controller.
// The call engine comes from the vendored widget.js (global `window.Kibitz`), loaded
// via <script> in sidepanel.html — NOT bundled here. That keeps this app small and,
// crucially, buildable on its own (no monorepo). Types: ./kibitz.d.ts.
import { qrSvg } from '../core/qr'
import type { KibitzGlobal, MountedWidget, Participant } from './kibitz'

// widget.js (loaded first in sidepanel.html) installs window.Kibitz.
const Kibitz = (window as unknown as { Kibitz: KibitzGlobal }).Kibitz

// Minimal typings for the bits of the extension API we touch (this runs on a
// chrome-extension:// page; the full @types/chrome aren't pulled into the build).
declare const chrome: {
  storage: {
    local: { get(k: string, cb: (v: Record<string, unknown>) => void): void; set(v: Record<string, unknown>, cb?: () => void): void }
    sync: {
      get(k: string, cb: (v: Record<string, unknown>) => void): void
      set(v: Record<string, unknown>, cb?: () => void): void
      remove(k: string, cb?: () => void): void
    }
  }
  runtime: {
    sendMessage(msg: unknown): Promise<{ streamId?: string; err?: string } | undefined>
    onMessage: {
      addListener(cb: (msg: { type?: string }) => void): void
      removeListener(cb: (msg: { type?: string }) => void): void
    }
  }
  tabs: { create(opts: { url: string }): void }
  windows: {
    create(
      opts: { url: string; type?: string; width?: number; height?: number; focused?: boolean },
      cb?: (w?: { id?: number }) => void,
    ): void
    get(id: number, cb: (w?: { id?: number }) => void): void
    remove(id: number, cb?: () => void): void
    onRemoved: { addListener(cb: (id: number) => void): void; removeListener(cb: (id: number) => void): void }
  }
}

const SIGNAL_HOST = 'signal.kibitz.chat'
// /api/turn lives on kibitz.chat. The extension can't use a relative one — it runs
// on a chrome-extension:// origin, so `/api/turn` 404s → STUN-only, no relay. Point
// turnHost here and the endpoint's CORS:* serves the extension its TURN. Swap to
// your own provider (or a license + ?turn=) to relay & bill through it instead.
const TURN_HOST = 'kibitz.chat'
// "Upgrade" entry point. Routes to the relay / who-pays docs for now; swap to the
// real pricing/checkout URL when billing goes live — the single place to change.
const UPGRADE_URL = 'https://kibitz.chat/docs#turn'
// The shareable VIEWER link: opens the web room (kibitz.chat reads the room from the
// URL hash, normalized the same on both sides). A non-extension viewer clicks or
// scans this to join + watch — no install. Only PRESENTING a tab needs the extension.
const WEB_BASE = 'https://kibitz.chat'
const inviteUrl = (room: string): string => `${WEB_BASE}/#${room}`
const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const rand = (n = 8): string => {
  const a = new Uint8Array(n)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('')
}
const store = {
  get: (k: string) => new Promise<string | null>((r) => chrome.storage.local.get(k, (v) => r((v[k] as string) ?? null))),
  set: (k: string, val: string) => new Promise<void>((r) => chrome.storage.local.set({ [k]: val }, () => r())),
}
// The premium license key lives in chrome.storage.sync so it follows the user
// across their Chrome profiles and survives a reinstall (unlike per-page storage).
const LICENSE_KEY = 'kibitz.license'
const sync = {
  get: (k: string) => new Promise<string | null>((r) => chrome.storage.sync.get(k, (v) => r((v[k] as string) ?? null))),
  set: (k: string, val: string) => new Promise<void>((r) => chrome.storage.sync.set({ [k]: val }, () => r())),
  remove: (k: string) => new Promise<void>((r) => chrome.storage.sync.remove(k, () => r())),
}
// Reflect whether a key is saved: light up ⚡ (reuses .on) and note it in the panel.
function reflectLicense(key: string | null): void {
  el('upgrade').classList.toggle('on', !!key)
  el('keyStatus').textContent = key ? 'Premium key saved ✓' : ''
}

// Fill the QR panel for the current room — a locally-generated QR + the link text.
// Scanning it opens the web room (kibitz.chat/#room), so a phone joins to watch
// without installing anything.
function renderInvite(): void {
  const link = inviteUrl(currentRoom)
  el('qrUrl').textContent = link
  try {
    el('qr').innerHTML = qrSvg(link)
  } catch {
    el('qr').textContent = link // QR encode failed (absurd length) — the link still shows
  }
}

// Inline SVG icons (stroke = currentColor, so they inherit each button's colour).
const svgIcon = (inner: string, w = 16): string =>
  `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
const ICON = {
  mic: svgIcon('<rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/>'),
  cam: svgIcon('<rect x="2" y="6" width="13" height="12" rx="2"/><path d="M22 8l-7 4 7 4z"/>'),
  share: svgIcon('<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><path d="M12 14V7m-2.5 2.5L12 7l2.5 2.5"/>'),
  stop: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  chat: svgIcon('<path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z"/>'),
  monitor: svgIcon('<rect x="2" y="4" width="20" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/>', 14),
  expand: svgIcon('<path d="M8 3H5a2 2 0 0 0-2 2v3m0 8v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3m0-8V5a2 2 0 0 0-2-2h-3"/>'),
}
const EMOJIS = ['😀', '😂', '👍', '❤️', '🎉', '🔥', '🤔', '👏', '🙌', '😮', '😅', '🙏']

// This same page runs in TWO places: the side panel, and a big pop-out WINDOW
// (?big=1). The window can do everything a normal page can (resize/fullscreen/PiP),
// which the side panel can't — so it's the "watch big" surface. Only ONE of the two
// runs the call engine at a time (hand-off), so there's never a duplicate-you.
const IS_BIG = new URLSearchParams(location.search).has('big')
// Quiet by default; add ?debug to the panel/window URL to see the [kibitz] logs.
const DEBUG = new URLSearchParams(location.search).has('debug')
const dbg = (...args: unknown[]): void => {
  if (DEBUG) console.log(...args)
}

let call: MountedWidget | null = null
let myName = 'You'
let currentRoom = ''
let bigWinId: number | null = null // (side panel only) the open big window, if any
// Presenter take-over: each new presenter stamps a higher sequence in roster meta,
// so the newest wins the stage and older presenters auto-stop (one stage, always).
let myPresentAt = 0
const setStatus = (s: string) => {
  el('status').textContent = s
}

// --- Chat (rides the engine's broadcast/onMessage app-channel) ---------------
// Collapsed by default to free room; a badge counts unread while it's closed.
type ChatWire = { t?: string; name?: string; text?: string }
let unread = 0

function openChat(open: boolean): void {
  el('chat').classList.toggle('collapsed', !open)
  if (open) {
    unread = 0
    el('unread').hidden = true
    el('msgs').scrollTop = el('msgs').scrollHeight
    el<HTMLInputElement>('chatInput').focus()
  }
}

function appendMsg(from: string, text: string, mine: boolean): void {
  const msgs = el('msgs')
  const div = document.createElement('div')
  div.className = `msg${mine ? ' me' : ''}`
  const f = document.createElement('span')
  f.className = 'from'
  f.textContent = `${from}:`
  div.appendChild(f)
  div.appendChild(document.createTextNode(` ${text}`))
  msgs.appendChild(div)
  msgs.scrollTop = msgs.scrollHeight
  if (!mine && el('chat').classList.contains('collapsed')) {
    unread++
    const u = el('unread')
    u.hidden = false
    u.textContent = String(unread)
  }
}

function sendChat(): void {
  const input = el<HTMLInputElement>('chatInput')
  const text = input.value.trim()
  if (!text || !call) return
  // broadcast is never echoed to us, so render our own line locally.
  call.broadcast({ t: 'chat', name: myName, text })
  appendMsg(myName, text, true)
  input.value = ''
}

function buildEmojiRow(): void {
  const row = el('emojiRow')
  row.replaceChildren()
  for (const e of EMOJIS) {
    const b = document.createElement('button')
    b.className = 'emoji'
    b.type = 'button'
    b.textContent = e
    b.onclick = () => {
      const input = el<HTMLInputElement>('chatInput')
      input.value += e
      input.focus()
    }
    row.appendChild(b)
  }
}

// --- Active share / stage ----------------------------------------------------
// `Participant.sharing` is self-only, so a presenter advertises via roster meta
// (`setMeta({presenting})`, driven by the share state). Everyone renders that
// person's stream big as the "stage".
const isPresenting = (p: Participant): boolean => !!(p.meta && (p.meta as Record<string, unknown>).presenting)
const presentAtOf = (p: Participant): number =>
  isPresenting(p) ? Number((p.meta as Record<string, unknown>).presentAt) || 0 : 0

// --- Fullscreen (the big window only; a side panel can't fullscreen) ---------
let stageVidEl: HTMLVideoElement | null = null
const stageVideo = (): HTMLVideoElement => (stageVidEl ??= el<HTMLVideoElement>('stageVid'))

async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement) {
    void document.exitFullscreen()
    return
  }
  try {
    await el('stage').requestFullscreen()
  } catch {
    setStatus('Fullscreen isn’t available here.')
  }
}

function renderStage(parts: Participant[]): void {
  // Newest presenter wins the stage.
  const live = parts.filter((p) => isPresenting(p) && p.stream)
  const presenter = live.length ? live.reduce((a, b) => (presentAtOf(b) >= presentAtOf(a) ? b : a)) : undefined
  const vid = stageVideo()
  const selfNote = el('stageSelf')
  const who = el('stageWho')
  const body = document.body
  if (document.fullscreenElement && (!presenter || presenter.isSelf)) void document.exitFullscreen()
  if (!presenter) {
    body.classList.remove('has-stage', 'presenting-self')
    if (vid.srcObject) vid.srcObject = null
    return
  }
  if (presenter.isSelf) {
    // You're watching your own real tab — collapse to a thin banner, keep faces+chat.
    body.classList.add('presenting-self')
    body.classList.remove('has-stage')
    vid.style.display = 'none'
    if (vid.srcObject) vid.srcObject = null
    selfNote.hidden = false
    who.textContent = ''
  } else {
    // Someone else presents → their page is the dominant stage.
    body.classList.add('has-stage')
    body.classList.remove('presenting-self')
    selfNote.hidden = true
    vid.style.display = ''
    if (vid.srcObject !== presenter.stream) {
      vid.srcObject = presenter.stream
      vid.play?.().catch(() => {})
    }
    who.innerHTML = ICON.monitor
    who.append(` ${presenter.name || 'Guest'} is presenting`)
  }
}

// --- Camera/mic permission ---------------------------------------------------
// A Chrome side panel can't show a *grantable* getUserMedia prompt — it fires and
// auto-dismisses ("Permission dismissed"), so the panel's mic/cam never turn on.
// A normal extension window CAN grant it, and the grant is stored per extension
// origin and shared by every page of the extension, INCLUDING the side panel. So
// we grant once via a tiny window (permission.html), then reuse it forever.

/** Already granted for this extension origin? `query` never prompts. */
async function hasPermission(kind: 'microphone' | 'camera'): Promise<boolean> {
  try {
    const p = await navigator.permissions.query({ name: kind as PermissionName })
    return p.state === 'granted'
  } catch {
    return false // unsupported → assume not granted; the grant window is harmless
  }
}

/** Open the one-time grant window; resolve when it reports success or is closed. */
function openGrantWindow(): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    let winId: number | undefined
    const finish = () => {
      if (done) return
      done = true
      chrome.runtime.onMessage.removeListener(onMsg)
      chrome.windows.onRemoved.removeListener(onRemoved)
      resolve()
    }
    const onMsg = (m: { type?: string }) => {
      if (m && m.type === 'kibitz-media-granted') finish()
    }
    const onRemoved = (id: number) => {
      if (id === winId) finish()
    }
    chrome.runtime.onMessage.addListener(onMsg)
    chrome.windows.onRemoved.addListener(onRemoved)
    chrome.windows.create({ url: 'permission.html', type: 'popup', width: 440, height: 340, focused: true }, (w) => {
      winId = w?.id
    })
    setTimeout(finish, 120000) // safety net if the window is left open
  })
}

/** Ensure we can capture `kind` before the engine tries to (its internal
 *  getUserMedia would fail silently in the panel). Returns true if granted. */
async function ensureCapture(kind: 'microphone' | 'camera'): Promise<boolean> {
  if (await hasPermission(kind)) return true
  setStatus(`Enabling ${kind}… click Allow in the window that opens.`)
  await openGrantWindow()
  if (await hasPermission(kind)) {
    setStatus('')
    return true
  }
  setStatus(`${kind === 'microphone' ? 'Microphone' : 'Camera'} not enabled — tap again to retry.`)
  return false
}

function renderTiles(parts: Participant[]): void {
  const tiles = el('tiles')
  if (!parts.length) {
    tiles.innerHTML = '<div class="empty">Waiting for others — copy the invite to bring someone (or an agent) in.</div>'
    return
  }
  tiles.replaceChildren()
  for (const p of parts) {
    const tile = document.createElement('div')
    tile.className = `tile${p.speaking ? ' speaking' : ''}`
    if (p.stream && p.camOn) {
      const v = document.createElement('video')
      v.autoplay = true
      v.muted = true
      v.playsInline = true
      if (p.isSelf || p.mirror) v.className = 'mirror'
      v.srcObject = p.stream
      v.play?.().catch(() => {})
      tile.appendChild(v)
    } else {
      const av = document.createElement('div')
      av.className = 'avatar'
      av.textContent = p.avatar || (p.name || '?').trim().slice(0, 2).toUpperCase()
      tile.appendChild(av)
    }
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = `${p.name || 'Guest'}${p.isSelf ? ' (you)' : ''}`
    tile.appendChild(label)
    if (isPresenting(p)) {
      const b = document.createElement('span')
      b.className = 'badge'
      b.innerHTML = ICON.monitor
      tile.appendChild(b)
    }
    tiles.appendChild(tile)
  }
}

// Reconciles the three control buttons. No disabling: anyone can take over the
// presenter role, and the camera ⟂ tab-share (same video lane) toggle each other.
function updateControls(): void {
  if (!call) return
  const s = call.getState()
  const camActive = s.camOn && !s.sharing // a real camera (not the share lane)

  const mic = el<HTMLButtonElement>('mic')
  mic.className = s.micOn ? 'on' : 'ghost'
  mic.innerHTML = `${ICON.mic}<span>${s.micOn ? 'Mic on' : 'Mic'}</span>`

  const cam = el<HTMLButtonElement>('cam')
  cam.className = camActive ? 'on' : 'ghost'
  cam.innerHTML = `${ICON.cam}<span>Cam</span>`

  const share = el<HTMLButtonElement>('share')
  if (s.sharing) {
    // You ARE the presenter — distinct colour; tap to stop (camera also stops it).
    share.className = 'live'
    share.title = 'You’re presenting — tap to stop (turning the camera on also stops it)'
    share.innerHTML = `${ICON.monitor}<span>Presenter</span>`
  } else {
    share.className = ''
    share.title = 'Present this tab to everyone'
    share.innerHTML = `${ICON.share}<span>Share tab</span>`
  }
}

// --- Lobby / knock-to-admit --------------------------------------------------
// Host bar (toggle + admit/deny queue) when we own the room; a "waiting" note when
// we're a joiner held at the door. All driven off the engine's lobby surface.
function renderLobby(): void {
  const bar = el('lobbybar')
  const note = el('lobbyNote')
  if (!call) {
    bar.hidden = true
    note.hidden = true
    return
  }
  const s = call.getState()

  // Host bar — only the room authority can gate.
  bar.hidden = !s.isHost
  if (s.isHost) {
    const toggle = el<HTMLButtonElement>('lobToggle')
    toggle.className = `lobtoggle${s.lobbyOn ? ' on' : ''}`
    toggle.textContent = s.lobbyOn ? '🔒 Approving joiners' : '🔓 Anyone with the link'
    toggle.title = s.lobbyOn ? 'Tap to let the link admit anyone' : 'Tap to require your approval to join'
    const knocks = el('knocks')
    knocks.replaceChildren()
    for (const k of call.getKnocks()) {
      const row = document.createElement('div')
      row.className = 'knockrow'
      const who = document.createElement('span')
      who.className = 'who'
      who.textContent = `${k.avatar || '✋'} ${k.name || 'Guest'}`
      const admit = document.createElement('button')
      admit.textContent = 'Admit'
      admit.title = `Let ${k.name || 'them'} in`
      admit.onclick = () => call?.admit(k.id)
      const deny = document.createElement('button')
      deny.className = 'deny'
      deny.textContent = 'Deny'
      deny.title = 'Refuse'
      deny.onclick = () => call?.deny(k.id)
      row.append(who, admit, deny)
      knocks.appendChild(row)
    }
  }

  // Joiner note — our OWN status while we're held at (or refused from) the door.
  if (s.lobbyStatus === 'waiting') {
    note.hidden = false
    note.className = 'lobbynote'
    note.textContent = '✋ Waiting for the host to let you in…'
  } else if (s.lobbyStatus === 'denied') {
    note.hidden = false
    note.className = 'lobbynote denied'
    note.textContent = '🚪 The host didn’t let you in.'
  } else {
    note.hidden = true
  }
}

// --- Big-window hand-off -----------------------------------------------------
const setHandedOff = (on: boolean): void => {
  el('handoff').hidden = !on
}

/** (Side panel) hand the live call to a big resizable window, then fold back when
 *  it closes. Unmounts our engine first so the window can re-join as the same
 *  person (one engine at a time → no duplicate-you in the room). */
function openBigWindow(): void {
  if (IS_BIG) return
  if (call) {
    call.unmount()
    call = null
  }
  setHandedOff(true)
  const url = `sidepanel.html?big=1&room=${encodeURIComponent(currentRoom)}`
  chrome.windows.create({ url, type: 'popup', width: 1024, height: 720, focused: true }, (w) => {
    bigWinId = w?.id ?? null
    if (bigWinId != null) void store.set('kibitz.bigWin', String(bigWinId))
  })
}

const bringBack = (): void => {
  if (bigWinId != null) chrome.windows.remove(bigWinId) // → onRemoved re-mounts the panel
}

async function start(room: string): Promise<void> {
  currentRoom = room
  if (call) {
    call.unmount()
    call = null
  }
  await store.set('kibitz.room', room)
  let uid = await store.get('kibitz.uid')
  if (!uid) {
    uid = `u${rand(10)}`
    await store.set('kibitz.uid', uid)
  }
  el('room').textContent = room
  el('room').title = `Room ${room} — share the invite link or QR`
  renderInvite()
  setStatus(`Connecting via ${SIGNAL_HOST}…`)

  const license = await sync.get(LICENSE_KEY)
  reflectLicense(license)
  call = Kibitz.mount({
    room,
    headless: true,
    signalHost: SIGNAL_HOST,
    turnHost: TURN_HOST,
    ...(license ? { licenseKey: license } : {}),
    identity: uid,
    name: myName,
  })
  // Join muted (camera off). The engine still negotiates silent/black placeholder
  // tracks, so mic:false peers connect fine (proven on real Chrome).
  for (let i = 0; i < 40; i++) {
    if (await call.join({ mic: false, cam: false })) break
    await sleep(100)
  }
  call.onMessage((data) => {
    const m = data as ChatWire | null
    if (m && m.t === 'chat' && typeof m.text === 'string') appendMsg(m.name || 'Guest', m.text, false)
  })
  const renderRoom = (p: Participant[]) => {
    renderStage(p)
    renderTiles(p)
  }
  renderRoom(call.getParticipants())
  updateControls()
  renderLobby()
  // Lobby: the host's queue changed, or our own knock status did.
  call.on('knocks', () => renderLobby())
  call.on('lobby', () => renderLobby())
  call.on('participants', (p) => {
    renderRoom(p)
    updateControls()
    renderLobby()
    // Someone newer took the presenter role → drop ours (one stage, always).
    if (call?.getState().sharing && p.some((q) => !q.isSelf && presentAtOf(q) > myPresentAt)) {
      call.stopShare()
    }
    setStatus(p.length > 1 ? '' : 'Waiting for others to join…')
  })
  // When sharing STOPS by any path (tap, camera take-over of the lane, a newer
  // presenter, or the browser's own bar), clear our presenter meta. Starting is
  // stamped with a sequence in shareTab (the only start path).
  let lastSharing = false
  call.on('state', (s) => {
    updateControls()
    renderLobby()
    if (!s.sharing && lastSharing) {
      myPresentAt = 0
      call?.setMeta({ presenting: false })
    }
    lastSharing = s.sharing
  })
  setStatus('Waiting for others to join…')
}

async function shareTab(): Promise<void> {
  if (!call) return
  if (call.getState().sharing) {
    call.stopShare()
    return
  }
  setStatus('Starting tab share…')
  try {
    dbg('[kibitz] share: asking background to capture the active tab')
    // Race a timeout so a non-responding background can never hang the UI forever.
    const res = (await Promise.race([
      chrome.runtime.sendMessage({ type: 'kibitz-capture-tab' }),
      new Promise<{ err: string }>((r) => setTimeout(() => r({ err: 'background did not respond (timeout)' }), 6000)),
    ])) as { streamId?: string; err?: string } | undefined
    dbg('[kibitz] share: background replied', res)
    if (res?.streamId) {
      dbg('[kibitz] share: consuming stream id via getUserMedia in the panel')
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: res.streamId } },
      } as unknown as MediaStreamConstraints)
      const track = stream.getVideoTracks()[0]
      dbg('[kibitz] share: got tab video track?', !!track)
      if (track && (await call.shareTrack(track))) {
        dbg('[kibitz] share: published to the room ✓')
        // Take over the presenter role: stamp a sequence above any current presenter.
        myPresentAt = call.getParticipants().reduce((m, p) => Math.max(m, presentAtOf(p)), 0) + 1
        call.setMeta({ presenting: true, presentAt: myPresentAt })
        setStatus('')
        return
      }
      setStatus('Captured the tab, but couldn’t publish it to the room.')
      return
    }
    // NOTE: no getDisplayMedia fallback — its picker can't appear in a side panel,
    // so the call would hang forever. Surface the real reason instead.
    const err = res?.err
    if (err && /invoked|activeTab/i.test(err)) {
      // tabCapture needs the extension "invoked" on the page. Clicking the toolbar
      // icon (our onClicked handler) grants activeTab for the current tab.
      setStatus('Click the Kibitz icon in your toolbar on the page you want to share, then tap 🖥️ Share tab again.')
    } else {
      setStatus(err ? `Couldn’t share this tab: ${err}` : 'Tab share was cancelled.')
    }
  } catch (e) {
    dbg('[kibitz] share: error', e)
    setStatus(`Share failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function init(): Promise<void> {
  const fromUrl = new URL(location.href).searchParams.get('room')
  const room = fromUrl || (await store.get('kibitz.room')) || `kbz-${rand(10)}`

  // Display name — stable per browser; used for tiles + chat. Generate a friendly
  // default so peers aren't all "You".
  myName = (await store.get('kibitz.name')) || `guest-${rand(4)}`
  await store.set('kibitz.name', myName)
  const nameInput = el<HTMLInputElement>('nameInput')
  nameInput.value = myName
  nameInput.onchange = async () => {
    const v = nameInput.value.trim().slice(0, 24) || myName
    myName = v
    nameInput.value = v
    await store.set('kibitz.name', v)
    call?.setName(v)
  }

  // Static icons + chat plumbing.
  el('selfIc').innerHTML = ICON.monitor
  el('chatIc').innerHTML = ICON.chat
  el('popout').innerHTML = ICON.expand
  // In the side panel ⛶ hands the call to a big window; in that window it toggles
  // fullscreen (the side panel can do neither).
  el('popout').onclick = () => void (IS_BIG ? toggleFullscreen() : openBigWindow())
  el('popout').title = IS_BIG ? 'Fullscreen' : 'Open in a big window'
  buildEmojiRow()
  el('chatTab').onclick = () => openChat(el('chat').classList.contains('collapsed'))
  el('chatSend').onclick = sendChat
  el<HTMLInputElement>('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat()
  })

  el('mic').onclick = async () => {
    if (!call) return
    // Turning OFF needs no permission; turning ON (mic currently off) may need the grant.
    if (call.getState().micOn || (await ensureCapture('microphone'))) call.toggleMic()
  }
  el('cam').onclick = async () => {
    if (!call) return
    const s = call.getState()
    if (s.sharing) {
      // "Cam makes it off": turning the camera on stops your share (same lane), then
      // the camera takes over. stopShare() leaves camOn=false, so toggle turns it on.
      call.stopShare()
      if (await ensureCapture('camera')) await call.toggleCam()
      return
    }
    // Plain camera toggle (on needs the grant; off is free).
    if (s.camOn || (await ensureCapture('camera'))) await call.toggleCam()
  }
  el('share').onclick = shareTab
  el('lobToggle').onclick = () => {
    if (call) call.setLobby(!call.getState().lobbyOn)
  }
  el('upgrade').onclick = () => (el('license').hidden = !el('license').hidden)
  el('getKey').onclick = (e) => {
    e.preventDefault()
    chrome.tabs.create({ url: UPGRADE_URL })
  }
  el('keySave').onclick = async () => {
    const v = el<HTMLInputElement>('keyInput').value.trim()
    if (v) await sync.set(LICENSE_KEY, v)
    else await sync.remove(LICENSE_KEY)
    location.reload() // re-mount with the new key + re-fetch TURN (a fresh page clears the ICE cache)
  }
  el('copy').onclick = async () => {
    const link = inviteUrl(currentRoom)
    try {
      await navigator.clipboard.writeText(link)
      setStatus('Invite link copied — anyone can open it to watch + talk, no extension needed.')
    } catch {
      setStatus(link) // clipboard blocked — show the link to copy by hand
    }
  }
  el('qrBtn').onclick = () => {
    el('qrpanel').hidden = !el('qrpanel').hidden
  }
  const join = () => {
    const v = el<HTMLInputElement>('joinInput').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
    if (v) void start(v)
  }
  el('joinBtn').onclick = join
  el<HTMLInputElement>('joinInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join()
  })

  if (!IS_BIG) {
    el('bringBack').onclick = bringBack
    // When the big window closes (button, its own X, or a crash), re-mount here.
    chrome.windows.onRemoved.addListener((id) => {
      if (id !== bigWinId) return
      bigWinId = null
      void store.set('kibitz.bigWin', '')
      setHandedOff(false)
      void start(currentRoom)
    })
    // Panel reopened while a big window is still up? Adopt the handed-off state
    // instead of mounting a second engine.
    const saved = await store.get('kibitz.bigWin')
    if (saved) {
      const stillOpen = await new Promise<boolean>((r) =>
        chrome.windows.get(Number(saved), (w) => r(!!(w && w.id != null))),
      )
      if (stillOpen) {
        bigWinId = Number(saved)
        currentRoom = room
        setHandedOff(true)
        return
      }
      void store.set('kibitz.bigWin', '')
    }
  }

  await start(room)
}

void init()
