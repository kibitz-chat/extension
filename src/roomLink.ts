// Parse whatever a user pastes into the extension's "join" box into the three things a
// mount needs: the room id, the link-carried gate descriptor, and this peer's own invite
// credential. The side panel is opened from the toolbar (no deep-link), so a verified room
// made elsewhere reaches it ONLY as pasted text — a bare id, a `#room` fragment, or a full
// `https://kibitz.chat/?g=…#room` URL. We accept all three and decode the gate from the SAME
// link params the web app uses, so "open a link someone else produced" works identically.
//
// Pure (no DOM / no chrome.*) so it unit-tests standalone; reuses the core decoders.
import { decodeGateParams, type GateDescriptor } from '../core/joinGateLink'
import { normalizeRoom } from '../core/transport'

export interface ParsedRoomLink {
  /** Normalized broker-safe room id (`''` if the input carried none). */
  room: string
  /** The admission gate read off the link — `{ mode: 'open' }` when ungated. */
  gate: GateDescriptor
  /** This peer's own signed invite token (`?gt=`), for an invite-mode gate. */
  credential?: string
  /** Human room label (`?d=`), display-only. */
  description?: string
  /** Sponsor room-grant (`?grant=`) baked in by a premium opener — sponsors this joiner's relay
   *  AND verification emails. Adopted from the link, presented to /api/turn + /api/email. */
  grant?: string
}

/** Identity config a `google`-mode verified link implies (mirrors the web's `effectiveIdCfg`):
 *  the OAuth client id is public and rides the link, and a gated room always `require`s it. */
export interface DerivedIdentity {
  provider: 'google'
  clientId: string
  require: true
}

/**
 * Split a pasted string into a room id + gate params. Handles a full URL (gate params in the
 * search, room in the hash — how the web builds links), gate-after-hash (`#room?g=…`), a bare
 * `#room`, or a plain id. Best-effort: a corrupt link still resolves to a room + an open gate
 * rather than throwing.
 */
export function parseRoomLink(input: string): ParsedRoomLink {
  const raw = (input ?? '').trim()
  let hash = ''
  let search = ''
  try {
    const u = new URL(raw)
    hash = u.hash
    search = u.search
    // Some links carry the gate AFTER the hash (`…/#room?g=…`); URL keeps that whole tail in
    // `hash`, so peel the query off it.
    if (!search && hash.includes('?')) {
      const i = hash.indexOf('?')
      search = hash.slice(i)
      hash = hash.slice(0, i)
    }
  } catch {
    // Not a URL — a bare fragment: `#room`, `room`, or `room?g=…`.
    let s = raw.replace(/^#/, '')
    const i = s.indexOf('?')
    if (i >= 0) {
      search = s.slice(i)
      s = s.slice(0, i)
    }
    hash = s
  }
  const room = normalizeRoom(hash.replace(/^#/, ''))
  const params = new URLSearchParams(search)
  const gate = decodeGateParams(params)
  const credential = params.get('gt') ?? undefined
  const description = (params.get('d') ?? '').slice(0, 80) || undefined
  const grant = params.get('grant') ?? undefined
  return {
    room,
    gate,
    ...(credential ? { credential } : {}),
    ...(description ? { description } : {}),
    ...(grant ? { grant } : {}),
  }
}

/** Derive the verified-identity mount config a `google`-mode link implies (else none). */
export function identityFromGate(gate: GateDescriptor): DerivedIdentity | undefined {
  return gate.mode === 'google' && gate.clientId
    ? { provider: 'google', clientId: gate.clientId, require: true }
    : undefined
}
