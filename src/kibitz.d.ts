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

/** One person waiting at the door, as the host sees them. */
export interface Knock {
  id: string
  name: string
  avatar: string
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
}

export interface MountedWidget {
  unmount(): void
  broadcast(data: unknown): void
  /** Send an opaque message to ONE participant by id — peer-to-peer (no one relays it). */
  sendTo(participantId: string, data: unknown): void
  /** Subscribe to messages (with the sender's id). Additive; returns an unsubscribe. */
  onMessage(cb: (data: unknown, from: string) => void): () => void
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
