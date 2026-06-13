// Ambient types for the global `Kibitz` that the vendored widget.js exposes
// (loaded via <script> in sidepanel.html). The side-panel app drives the engine
// through this global instead of bundling it, so this code builds standalone — no
// monorepo needed. Source of truth for the real shapes: the Kibitz repo's
// src/widget (kept deliberately small here, like Whist's own KibitzController).

export interface Participant {
  id: string
  isSelf: boolean
  name: string
  avatar: string
  camOn: boolean
  speaking: boolean
  stream: MediaStream | null
  meta: Record<string, unknown>
  mirror?: boolean
  /** Self only: the video lane is a screen/tab share, not the camera. */
  sharing?: boolean
  /** 'host' for the room authority, else 'guest'. */
  role: 'host' | 'guest'
}

/** A participant's capability grant — what it may perceive (content flowing to it) and act (what
 *  it emits). Humans default to full; agents (meta.role='agent') to read-only. The engine enforces
 *  it per-peer. Mirrors src/core/capabilities.ts (kept local so the extension builds standalone). */
export type Perceive = 'see-screen' | 'hear-audio' | 'read-chat' | 'read-roster' | 'receive-directed'
export type Act = 'send-chat' | 'speak' | 'act'
export interface Grant {
  perceive: Perceive[]
  act: Act[]
  /** Disclosure (agents): the model/backend it routes to — shown, not enforced. */
  backend?: string
  /** Disclosure (agents): does what it perceives leave the E2EE room? */
  egress?: boolean
  /** Auto-revoke at this epoch-seconds time. */
  expiresAt?: number
}

/** One local capability-audit event (host-visible; nothing stored or sent). */
export interface AuditEntry {
  ts: number
  id: string
  kind: 'blocked' | 'granted'
  detail: string
}

/** One person waiting at the door, as the host sees them. */
export interface Knock {
  id: string
  name: string
  avatar: string
}

/** An app self-describing the shape of its messages / shared view, so an agent can discover how
 *  to read them. Published over the data mesh; attributed to its publisher by the roster. */
export interface SchemaInfo {
  /** Publisher's participant id (matches the roster). */
  from: string
  /** A stable identifier for the schema (e.g. 'whist.view'). */
  name: string
  /** The schema's own version, app-defined (e.g. '1.0.0'). */
  version: string
  /** The schema document — a JSON Schema, an example payload, or any structured-clone-able shape. */
  schema: unknown
}

/** Our own knock state as a joiner: held, refused, turned away (locked), or nothing. */
export type LobbyJoinerStatus = 'waiting' | 'denied' | 'locked' | null

export interface CallState {
  inCall: boolean
  micOn: boolean
  camOn: boolean
  sharing: boolean
  self: Participant | null
  isHost: boolean
  lobbyOn: boolean
  locked: boolean
  lobbyStatus: LobbyJoinerStatus
  /** Verified identity is configured for this room. */
  identityEnabled: boolean
  /** Our own verified email once signed in (null until then). */
  selfEmail: string | null
  /** Verified-roster: active, may content flow, off-roster peer present. */
  rosterActive: boolean
  rosterCanShare: boolean
  rosterCompromised: boolean
}

export interface MountOptions {
  room: string
  name?: string
  startOpen?: boolean
  preview?: boolean
  headless?: boolean
  identity?: string
  meta?: Record<string, unknown>
  signalHost?: string
  turnHost?: string
  licenseKey?: string
  grant?: string
  /** Opt-in verified identity (peer-to-peer, no server) — a "Continue with Google"
   *  button in the lobby; verified peers get a ✓ badge bound to their encrypted
   *  connection. Omit to stay account-free. See §2a of the docs. */
  verifyIdentity?: {
    provider: 'google'
    /** Your OAuth client_id (register a Web client; add your origin to Authorized JS origins). */
    clientId: string
    /** Override the accepted issuer(s) / discovery issuer for non-Google OIDC providers. */
    issuer?: string | string[]
    discoveryIssuer?: string
    /** Require a verified identity to stay — the lobby blocks Join until you sign in,
     *  and the host removes anyone unverified. The host can also toggle this live. */
    require?: boolean
    /** With `require`, restrict to these email domains (e.g. ['acme.com']); matches the
     *  email domain or the Google Workspace `hd` claim. */
    allowedDomains?: string[]
    /** With `require`, restrict to these exact verified emails (a per-person guest list,
     *  e.g. ['alice@acme.com']). Combined with `allowedDomains` as a union; both empty →
     *  any verified identity is allowed. */
    allowedEmails?: string[]
  }
  /** A verified-room gate descriptor (decoded from a link's `?g/gc/gk/gm` params) — drives
   *  the authority's admission gate + the verified-roster mutual pre-share. */
  joinGate?: {
    mode: 'open' | 'names' | 'code' | 'email' | 'google' | 'invite'
    names?: string[]
    pubKey?: JsonWebKey
    manifest?: string
    clientId?: string
  }
  /** This peer's own signed invite token, for an invite-mode gate. */
  joinCredential?: string
  /** Absolute base URL of the Kibitz email-code backend (issuer + /api/email/jwks). The side
   *  panel runs on chrome-extension://, so it must point email-method verification at
   *  https://kibitz.chat rather than its own origin. */
  apiBase?: string
  /** Privacy: force media/data through TURN (`iceTransportPolicy:'relay'`) so peers never see your
   *  IP — only the relay does. Fail-closed (no TURN ⇒ no connection, never a direct leak). */
  relayOnly?: boolean
}

export interface MountedWidget {
  unmount(): void
  broadcast(data: unknown): void
  /** Send an opaque message to ONE participant by id — peer-to-peer (no one relays it). */
  sendTo(participantId: string, data: unknown): void
  /** Subscribe to messages (with the sender's id). Additive; returns an unsubscribe. */
  onMessage(cb: (data: unknown, from: string) => void): () => void
  /** Publish a schema for your messages / shared view so an agent can self-discover them.
   *  Re-broadcast to late joiners; re-publishing a `name` replaces it. No-op until in the call. */
  registerSchema(name: string, version: string, schema: unknown): void
  /** Every schema currently known — yours and every peer's, attributed by publisher id. */
  getSchemas(): readonly SchemaInfo[]
  /** Subscribe to schemas as peers publish them. Returns an unsubscribe function. */
  onSchema(cb: (s: SchemaInfo) => void): () => void
  getState(): CallState
  getParticipants(): Participant[]
  join(opts?: { mic?: boolean; cam?: boolean }): Promise<boolean>
  leave(): void
  toggleMic(): void
  toggleCam(): Promise<void>
  shareScreen(): Promise<boolean>
  shareTrack(track: MediaStreamTrack): Promise<boolean>
  stopShare(): void
  setName(name: string): void
  setAvatar(avatar: string): void
  setMeta(meta: Record<string, unknown>): void
  // Lobby / knock-to-admit.
  getKnocks(): Knock[]
  setLobby(on: boolean): void
  admit(id: string): void
  deny(id: string): void
  /** Remove a call member by participant id (host only); they're told to leave and
   *  blocked from rejoining this room. */
  remove(id: string): void
  /** Lock / unlock the room (host only) — sealed to new members. */
  setLocked(on: boolean): void
  /** Reset the room (host only) — clear everyone's ephemeral chat. */
  resetRoom(): void
  knock(name: string, avatar: string): void
  /** Verified rooms: render the provider's sign-in into `container` (Google button, or the
   *  email→code form for `method:'email'`); on success the cert-bound token is broadcast. */
  signInIdentity(container: HTMLElement, method?: 'google' | 'email'): Promise<boolean>
  /** The cert-bound nonce an EXTERNAL sign-in surface must echo so its minted token binds to
   *  THIS connection. Null until the cert is ready. The side panel passes it to the kibitz.chat
   *  verify popup; the returned token comes back via `provideIdentityToken`. */
  identityNonce(): Promise<string | null>
  /** Adopt a cert-bound token minted out-of-page (signed against `identityNonce()`). */
  provideIdentityToken(jwt: string): Promise<boolean>
  /** A participant's effective capability grant (what it may perceive/act). Host-side consent UI. */
  getCapabilityGrant(id: string): Grant
  /** Set (null clears) a participant's capability override; the engine enforces it. Host action. */
  setCapabilityGrant(id: string, grant: Grant | null): void
  /** Recent local capability-audit events for a participant — blocked acts + grant changes. */
  getAgentAudit(id: string): readonly AuditEntry[]
  on(event: 'participants', cb: (people: Participant[]) => void): () => void
  on(event: 'join' | 'leave', cb: (p: Participant) => void): () => void
  on(event: 'speaking', cb: (ids: string[]) => void): () => void
  on(
    event: 'state',
    cb: (s: {
      inCall: boolean
      micOn: boolean
      camOn: boolean
      sharing: boolean
      isHost: boolean
      lobbyOn: boolean
      locked: boolean
      lobbyStatus: LobbyJoinerStatus
      identityEnabled: boolean
      selfEmail: string | null
      rosterActive: boolean
      rosterCanShare: boolean
      rosterCompromised: boolean
    }) => void,
  ): () => void
  on(event: 'knocks', cb: (knocks: Knock[]) => void): () => void
  on(event: 'lobby', cb: (status: LobbyJoinerStatus) => void): () => void
}

/** The global the vendored widget.js installs on `window`. Typed locally and read
 *  via a cast in sidepanel.ts (no `Window` augmentation, so it never clashes with
 *  the engine's own declaration when this file lives inside the monorepo). */
export interface KibitzGlobal {
  mount(opts: MountOptions): MountedWidget
}
