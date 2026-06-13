// Kibitz side panel — the redone extension's home. The side panel is GLOBAL (one
// document per window), so it persists across tab switches and navigation, which is
// exactly why it can host the call engine + WebRTC and have a shared cast survive
// page changes. We render our own tiles from the composable-engine controller.
// The call engine comes from the vendored widget.js (global `window.Kibitz`), loaded
// via <script> in sidepanel.html — NOT bundled here. That keeps this app small and,
// crucially, buildable on its own (no monorepo). Types: ./kibitz.d.ts.
import { qrSvg } from '../core/qr'
import { normalizeRoom } from '../core/transport'
import { encodeGateParams, withGateFragment, type GateDescriptor } from '../core/joinGateLink'
import { buildVerifiedRoster, type InviteeInput } from '../core/joinGateRuntime'
import { linkWithGrant, requestRoomGrant } from '../core/grant'
import { identityFromGate, parseRoomLink } from './roomLink'
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
// The shareable link for a room. An OPEN room is just `…/#room`; a verified room re-encodes the
// link-carried gate (mode, client id, creator pubkey, signed roster) + the description — the SAME
// link the web app reads, so the room opens identically in a browser, the widget, or here. The
// per-peer invite token (`gt`) is deliberately NOT included: you share the room, not your own seat.
function linkFor(room: string, gate: GateDescriptor, desc?: string): string {
  if (!gate || gate.mode === 'open') return `${WEB_BASE}/#${room}`
  const params = encodeGateParams(gate)
  if (desc) params.set('d', desc)
  // Carry the gate in the FRAGMENT (`…/#room?g=…`), host-private — the same link the web app
  // reads (gateParamsFrom), so the roster never reaches the host. Open rooms stay bare `#room`.
  return withGateFragment(`${WEB_BASE}/#${room}`, params)
}
const inviteUrl = (room: string): string => linkFor(room, currentGate, currentDesc)
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
// The live room's admission gate + this peer's seat credential + the human label. An open room
// leaves these at their defaults; opening a verified link (or creating one) fills them, and they
// drive the mount options, the shareable link, and the verify bar.
let currentGate: GateDescriptor = { mode: 'open' }
let currentCred: string | undefined
let currentDesc = ''
let currentGrant: string | undefined // sponsor room-grant adopted from a joined link (opener-pays)
let verifyPopup: Window | null = null
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
    if (p.meta?.role === 'agent') {
      // Shown to EVERYONE: never ambiguous that a participant is an AI agent.
      const ai = document.createElement('span')
      ai.className = 'agent-tag'
      ai.textContent = '🤖 AI'
      ai.title = 'An AI agent — read-only unless the host grants it more'
      tile.appendChild(ai)
    }
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

// --- Verified rooms ----------------------------------------------------------
// Google's button + our email backend can't run on this chrome-extension:// origin, so the
// "Verify" button opens a kibitz.chat popup that signs in with the engine's cert-bound nonce
// and posts the token back (adopted by the message listener in init via provideIdentityToken).
// The bar otherwise reflects the verified-roster state the engine reports. Inert for open rooms.
function renderVerify(): void {
  const bar = el('verifybar')
  if (!call) {
    bar.hidden = true
    return
  }
  const s = call.getState()
  if (!s.identityEnabled) {
    bar.hidden = true
    return
  }
  bar.hidden = false
  const msg = el('vmsg')
  const btn = el<HTMLButtonElement>('vbtn')
  bar.classList.remove('ok', 'alarm')
  if (s.rosterCompromised) {
    bar.classList.add('alarm')
    msg.textContent =
      '⚠️ Someone here isn’t on the verified list — content is held. Leave if you didn’t expect that.'
    btn.hidden = true
    return
  }
  if (s.selfEmail) {
    bar.classList.add('ok')
    msg.textContent =
      s.rosterActive && !s.rosterCanShare
        ? `✓ Verified as ${s.selfEmail} — waiting for everyone else to verify before content flows…`
        : `✓ Verified as ${s.selfEmail}.`
    btn.hidden = true
    return
  }
  msg.textContent = '🔒 This room is for verified participants. Verify to be let in — and to see or share content.'
  btn.hidden = false
  btn.textContent = verifyPopup && !verifyPopup.closed ? 'Continue in the popup…' : 'Verify to join'
}

/** Open the kibitz.chat verify popup for THIS connection (passing its cert-bound nonce). */
async function openVerifyPopup(): Promise<void> {
  if (!call) return
  if (verifyPopup && !verifyPopup.closed) {
    verifyPopup.focus()
    return
  }
  setStatus('Preparing a secure verification…')
  const nonce = await call.identityNonce()
  if (!nonce) {
    setStatus('Couldn’t prepare verification yet — wait a moment, then tap Verify again.')
    return
  }
  const params = new URLSearchParams({
    kibitzVerify: '1',
    nonce,
    client: currentGate.clientId ?? '',
    room: normalizeRoom(currentRoom),
    methods: 'google,email',
    opener: location.origin, // the popup posts the token back to exactly this origin
  })
  if (currentDesc) params.set('d', currentDesc)
  // Carry the adopted sponsor grant so an email-code send in the popup is billed to the room's
  // premium key (opener-pays), not the free pool.
  if (currentGrant) params.set('grant', currentGrant)
  verifyPopup = window.open(`${WEB_BASE}/?${params.toString()}`, 'kibitzVerify', 'width=420,height=620')
  if (!verifyPopup) {
    setStatus('Your browser blocked the verification window — allow popups for the panel and retry.')
    return
  }
  setStatus('Finish signing in in the window that opened…')
  renderVerify()
}

// --- Host-only agent capability consent --------------------------------------
// The visible face of the capability layer (engine enforces it, host-local). For each AGENT in the
// room (meta.role='agent') the host toggles what it may perceive/act + revokes. Grants live in the
// engine; we re-read after each change. Inert unless we're the host and agents are present.
const PERCEIVE_CAPS = ['see-screen', 'hear-audio', 'read-chat', 'read-roster', 'receive-directed'] as const
const ACT_CAPS = ['send-chat', 'speak', 'act'] as const
const CAP_LABEL: Record<string, string> = {
  'see-screen': 'see screen',
  'hear-audio': 'hear audio',
  'read-chat': 'read chat',
  'read-roster': 'see who’s here',
  'receive-directed': 'private data',
  'send-chat': 'post chat',
  'speak': 'speak',
  'act': 'act / control',
}

function toggleCap(id: string, cap: string): void {
  if (!call) return
  const g = call.getCapabilityGrant(id)
  const key = (PERCEIVE_CAPS as readonly string[]).includes(cap) ? 'perceive' : 'act'
  const list = [...(g[key] as string[])]
  const next = list.includes(cap) ? list.filter((c) => c !== cap) : [...list, cap]
  call.setCapabilityGrant(id, { ...g, [key]: next })
}

function renderAgents(): void {
  const bar = el('agentbar')
  if (!call) {
    bar.hidden = true
    return
  }
  const agents = call.getParticipants().filter((p) => !p.isSelf && p.meta?.role === 'agent')
  if (!call.getState().isHost || !agents.length) {
    bar.hidden = true
    return
  }
  bar.hidden = false
  bar.replaceChildren()
  const h = document.createElement('h4')
  h.textContent = '🤖 Agents — what each may do'
  bar.appendChild(h)
  for (const a of agents) {
    const g = call.getCapabilityGrant(a.id)
    const row = document.createElement('div')
    row.className = 'agentrow'
    const who = document.createElement('div')
    who.className = 'who'
    who.textContent = a.name || 'Agent'
    if (g.backend) {
      const b = document.createElement('span')
      b.className = 'back'
      b.textContent = ` · ${g.backend}${g.egress ? ' — leaves the room' : ''}`
      who.appendChild(b)
    }
    row.appendChild(who)
    const caps = document.createElement('div')
    caps.className = 'agentcaps'
    for (const cap of [...PERCEIVE_CAPS, ...ACT_CAPS]) {
      const on = (g.perceive as string[]).includes(cap) || (g.act as string[]).includes(cap)
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `agentcap${on ? ' on' : ''}`
      btn.textContent = `${on ? '✓' : '+'} ${CAP_LABEL[cap]}`
      btn.onclick = () => {
        toggleCap(a.id, cap)
        renderAgents()
      }
      caps.appendChild(btn)
    }
    row.appendChild(caps)
    const rev = document.createElement('button')
    rev.type = 'button'
    rev.className = 'agentrevoke'
    rev.textContent = 'Revoke all'
    rev.onclick = () => {
      call?.setCapabilityGrant(a.id, { perceive: [], act: [] })
      renderAgents()
    }
    row.appendChild(rev)
    const events = call.getAgentAudit(a.id).slice(0, 4)
    if (events.length) {
      const feed = document.createElement('div')
      feed.className = 'agentaudit'
      for (const e of events) {
        const line = document.createElement('div')
        line.textContent = e.kind === 'blocked' ? `⛔ tried to ${e.detail} (blocked)` : `⚙ permissions: ${e.detail}`
        feed.appendChild(line)
      }
      row.appendChild(feed)
    }
    bar.appendChild(row)
  }
}

// --- "Who can join?" — build a verified-room link from the panel ---------------
// A compact inline version of the web's create screen: a roster of people, each with a method
// (Sign in / Any verified @domain / Email code), → buildVerifiedRoster → a single shareable link
// the gate runs from. The creator is the host (first row) and still has to verify like everyone.
function makeWhoRow(isHost: boolean): HTMLElement {
  const row = document.createElement('div')
  row.className = 'whorow'
  const r1 = document.createElement('div')
  r1.className = 'r1'
  const name = document.createElement('input')
  name.className = 'who-name'
  name.placeholder = isHost ? 'Your name' : 'Name (optional)'
  name.maxLength = 40
  const method = document.createElement('select')
  method.className = 'who-method'
  for (const [v, label] of [
    ['signin', 'Sign in'],
    ['oidc', 'Any @domain'],
    ['mail', 'Email code'],
  ] as const) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = label
    method.appendChild(o)
  }
  r1.append(name, method)
  const r2 = document.createElement('div')
  r2.className = 'r2'
  const id = document.createElement('input')
  id.className = 'who-id'
  id.placeholder = 'email'
  const showLabel = document.createElement('label')
  const show = document.createElement('input')
  show.type = 'checkbox'
  show.className = 'who-show'
  showLabel.append(show, document.createTextNode(' show'))
  r2.append(id, showLabel)
  if (!isHost) {
    const rm = document.createElement('button')
    rm.className = 'who-rm'
    rm.type = 'button'
    rm.textContent = '✕'
    rm.title = 'Remove'
    rm.onclick = () => row.remove()
    r2.append(rm)
  }
  // The match parameter depends on the method: an exact email, or a whole domain.
  method.onchange = () => {
    id.placeholder = method.value === 'oidc' ? 'domain, e.g. acme.com' : 'email'
  }
  row.append(r1, r2)
  return row
}

async function createFromWho(access: 'open' | 'verified'): Promise<void> {
  const desc = el<HTMLInputElement>('whoDesc').value.trim().slice(0, 60)
  const room = `kbz-${rand(10)}`
  if (access === 'open') {
    el('whopanel').hidden = true
    await start(room, { desc })
    return
  }
  const clientId = el<HTMLInputElement>('whoClient').value.trim()
  if (!clientId) {
    setStatus('Add your Google sign-in app (client id) to create a verified room.')
    return
  }
  const invitees: InviteeInput[] = []
  for (const r of Array.from(el('whoRows').children)) {
    const method = (r.querySelector('.who-method') as HTMLSelectElement).value as InviteeInput['method']
    const nm = (r.querySelector('.who-name') as HTMLInputElement).value.trim()
    const idv = (r.querySelector('.who-id') as HTMLInputElement).value.trim()
    const show = (r.querySelector('.who-show') as HTMLInputElement).checked
    if (!idv) continue
    invitees.push({
      method,
      ...(method === 'oidc' ? { domain: idv } : { email: idv }),
      ...(nm ? { name: nm } : {}),
      ...(show ? { show: true } : {}),
    })
  }
  if (!invitees.length) {
    setStatus('Add at least one person — an email (Sign in / Email code) or a domain (Any @domain).')
    return
  }
  const base = `${WEB_BASE}/#${room}`
  const exp = Math.floor(Date.now() / 1000) + 7 * 86400 // a week
  const { roomLink } = await buildVerifiedRoster(base, room, invitees, clientId, exp)
  const parsed = parseRoomLink(roomLink)
  el('whopanel').hidden = true
  await start(parsed.room || room, { gate: parsed.gate, desc })
  setStatus('Verified room created — share the invite link. Sign in to be let in (you’re the host).')
}

function wireWhoPanel(): void {
  const panel = el('whopanel')
  const access = el('whoAccess')
  let accessMode: 'open' | 'verified' = 'open'
  const open = () => {
    const rows = el('whoRows')
    if (!rows.children.length) rows.appendChild(makeWhoRow(true)) // seed the host row
    const client = el<HTMLInputElement>('whoClient')
    if (!client.value) client.value = currentGate.clientId ?? ''
    // Reflect the saved premium key (held in chrome.storage.sync, same as the ⚡ panel).
    void sync.get(LICENSE_KEY).then((k) => {
      el<HTMLInputElement>('whoPremKey').value = k ?? ''
      el('whoPremOk').hidden = !k
    })
    panel.hidden = false
  }
  el('whoBtn').onclick = () => {
    if (panel.hidden) open()
    else panel.hidden = true
  }
  el('whoPremSave').onclick = async () => {
    const v = el<HTMLInputElement>('whoPremKey').value.trim()
    if (v) await sync.set(LICENSE_KEY, v)
    else await sync.remove(LICENSE_KEY)
    el('whoPremOk').hidden = !v
    reflectLicense(v || null) // keep the header ⚡ indicator in sync
    // No reload: the key is read fresh when this new room mounts (start → licenseKey) and when
    // Copy mints the opener-pays grant. The header ⚡ panel handles re-keying a call in progress.
  }
  el('whoCancel').onclick = () => (panel.hidden = true)
  el('whoPremToggle').onclick = () => {
    const body = el('whoPremBody')
    const show = body.hidden
    body.hidden = !show
    el('whoPremToggle').setAttribute('aria-expanded', String(show))
    const caret = el('whoPremToggle').querySelector('.whoprem-caret')
    if (caret) caret.textContent = show ? '▾' : '▸'
  }
  el('whoAdd').onclick = () => el('whoRows').appendChild(makeWhoRow(false))
  for (const b of Array.from(access.querySelectorAll('button'))) {
    ;(b as HTMLButtonElement).onclick = () => {
      accessMode = ((b as HTMLElement).dataset.access as 'open' | 'verified') ?? 'open'
      for (const x of Array.from(access.querySelectorAll('button'))) x.classList.toggle('sel', x === b)
      el('whoVerified').hidden = accessMode !== 'verified'
    }
  }
  el('whoCreate').onclick = () => void createFromWho(accessMode)
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
  // Carry the FULL link (gate + description), not just the bare id — else a verified room would
  // re-mount ungated in the big window. init() parses `?link=` back into the gate.
  const url = `sidepanel.html?big=1&link=${encodeURIComponent(linkFor(currentRoom, currentGate, currentDesc))}`
  chrome.windows.create({ url, type: 'popup', width: 1024, height: 720, focused: true }, (w) => {
    bigWinId = w?.id ?? null
    if (bigWinId != null) void store.set('kibitz.bigWin', String(bigWinId))
  })
}

const bringBack = (): void => {
  if (bigWinId != null) chrome.windows.remove(bigWinId) // → onRemoved re-mounts the panel
}

interface StartOpts {
  gate?: GateDescriptor
  credential?: string
  desc?: string
  grant?: string
}

async function start(room: string, opts: StartOpts = {}): Promise<void> {
  currentRoom = room
  currentGate = opts.gate ?? { mode: 'open' }
  currentCred = opts.credential
  currentDesc = opts.desc ?? ''
  currentGrant = opts.grant
  if (call) {
    call.unmount()
    call = null
  }
  await store.set('kibitz.room', room)
  // Persist the FULL link (gate + description), so a panel reopen or a big-window hand-off
  // restores a verified room intact — not just the bare id, which would mount it ungated.
  await store.set('kibitz.link', linkFor(room, currentGate, currentDesc))
  let uid = await store.get('kibitz.uid')
  if (!uid) {
    uid = `u${rand(10)}`
    await store.set('kibitz.uid', uid)
  }
  el('room').textContent = currentDesc || room
  el('room').title = `Room ${room} — share the invite link or QR`
  renderInvite()
  setStatus(`Connecting via ${SIGNAL_HOST}…`)

  // A `google`-mode link implies verified identity (the client id rides the link). Decode it the
  // same way the web app does, so opening a link someone else produced behaves identically here.
  const verifyIdentity = identityFromGate(currentGate)

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
    ...(verifyIdentity ? { verifyIdentity } : {}),
    ...(currentGate.mode !== 'open' ? { joinGate: currentGate } : {}),
    ...(currentCred ? { joinCredential: currentCred } : {}),
    // Email-method peers' tokens are issued by kibitz.chat — verify them there, not against
    // this chrome-extension:// origin (Google tokens are origin-independent and need no base).
    apiBase: WEB_BASE,
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
  renderVerify()
  renderAgents()
  // Lobby: the host's queue changed, or our own knock status did.
  call.on('knocks', () => renderLobby())
  call.on('lobby', () => renderLobby())
  call.on('participants', (p) => {
    renderRoom(p)
    updateControls()
    renderLobby()
    renderVerify()
    renderAgents()
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
    renderVerify()
    renderAgents()
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
  // Resolve what to open into a room + its gate: `?link=` (the big-window hand-off carries the
  // FULL gated link), a legacy `?room=`, the persisted full link (restores a verified room across
  // a reopen), the persisted bare id, or a fresh generated id. parseRoomLink unifies every shape.
  const search = new URL(location.href).searchParams
  const source =
    search.get('link') ||
    (search.get('room') ? `#${search.get('room')}` : '') ||
    (await store.get('kibitz.link')) ||
    ((await store.get('kibitz.room')) ? `#${await store.get('kibitz.room')}` : '') ||
    `#kbz-${rand(10)}`
  const entry = parseRoomLink(source)
  const room = entry.room || `kbz-${rand(10)}`

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
    let link = inviteUrl(currentRoom)
    // Opener-pays: if a premium key is saved, mint a signed room-grant (against kibitz.chat — this
    // origin has no /api) and bake it into the invite so guests get a relay billed to us.
    const key = await sync.get(LICENSE_KEY)
    let sponsored = false
    if (key) {
      const g = await requestRoomGrant(normalizeRoom(currentRoom), key, WEB_BASE)
      if (g) {
        link = linkWithGrant(link, g.grant)
        sponsored = true
      }
    }
    try {
      await navigator.clipboard.writeText(link)
      setStatus(
        sponsored
          ? 'Invite link copied — guests you invite get a sponsored relay.'
          : 'Invite link copied — anyone can open it to watch + talk, no extension needed.',
      )
    } catch {
      setStatus(link) // clipboard blocked — show the link to copy by hand
    }
  }
  el('qrBtn').onclick = () => {
    el('qrpanel').hidden = !el('qrpanel').hidden
  }
  const join = () => {
    // Accept a full link (verified rooms carry their gate in the URL) OR a bare room code.
    const parsed = parseRoomLink(el<HTMLInputElement>('joinInput').value)
    if (parsed.room)
      void start(parsed.room, {
        gate: parsed.gate,
        credential: parsed.credential,
        desc: parsed.description,
        grant: parsed.grant,
      })
  }
  el('joinBtn').onclick = join
  el<HTMLInputElement>('joinInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join()
  })
  el('vbtn').onclick = () => void openVerifyPopup()
  // The verify popup (kibitz.chat origin) posts the cert-bound token back here; adopt it.
  window.addEventListener('message', (e) => {
    if (e.origin !== WEB_BASE) return
    const d = e.data as { kibitzVerify?: boolean; jwt?: string } | null
    // A token is ~1KB; cap the length so a hostile message can't feed the verifier megabytes.
    if (!d || !d.kibitzVerify || typeof d.jwt !== 'string' || d.jwt.length > 8192 || !call) return
    void call.provideIdentityToken(d.jwt).then((ok) => {
      setStatus(ok ? '' : 'That verification didn’t match this connection — tap Verify to try again.')
      renderVerify()
    })
  })
  wireWhoPanel()

  if (!IS_BIG) {
    el('bringBack').onclick = bringBack
    // When the big window closes (button, its own X, or a crash), re-mount here.
    chrome.windows.onRemoved.addListener((id) => {
      if (id !== bigWinId) return
      bigWinId = null
      void store.set('kibitz.bigWin', '')
      setHandedOff(false)
      void start(currentRoom, { gate: currentGate, credential: currentCred, desc: currentDesc })
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
        currentGate = entry.gate
        currentCred = entry.credential
        currentDesc = entry.description ?? ''
        setHandedOff(true)
        return
      }
      void store.set('kibitz.bigWin', '')
    }
  }

  await start(room, { gate: entry.gate, credential: entry.credential, desc: entry.description, grant: entry.grant })
}

void init()
