/**
 * Band Mode, the studio's side: which jam (if any) this tab is in, plus starting
 * or looking up one (two small HTTP calls when a jam server is running, nothing
 * at all when the site is hosted statically). The live part (the connection, the
 * roster, other players' sound) lives with the players in public/play/jam-core.js.
 *
 * The current jam is kept in sessionStorage, so it survives hopping between the
 * room and the instrument pages but ends when the tab closes.
 */
const KEY = 'harmonic.jam'

/** Room codes as the server knows them: upper-case letters and digits only. */
export function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
}

// Where the jam server might be: same-origin /jam (the Vite proxy) first, then the
// server's own port on this host (only reachable from a plain-http page).
function bases() {
  const list = [`${location.origin}/jam`]
  if (location.protocol === 'http:') list.push(`http://${location.hostname || 'localhost'}:8502`)
  return list
}

// The server's room-code alphabet (no look-alikes such as 0/O, 1/I, 5/S).
const ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679'

/** A fresh six-character room code, made here when there is no server to ask. */
function localCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

/** Testing switch: localStorage 'harmonic.jam.via' = 'p2p' ignores the server (see jam-core.js). */
function direct() {
  try {
    return localStorage.getItem('harmonic.jam.via') === 'p2p'
  } catch {
    return false
  }
}

async function request(path, init) {
  if (direct()) throw new Error('jam server skipped')
  for (const base of bases()) {
    try {
      const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(4000) })
      if (res.ok) return await res.json()
    } catch {
      // unreachable at this address, try the next one
    }
  }
  throw new Error('jam server unreachable')
}

export const Jam = {
  /** The code of the jam this tab is in, or '' when playing solo. */
  get code() {
    try {
      return normalizeCode(sessionStorage.getItem(KEY))
    } catch {
      return ''
    }
  },

  join(code) {
    const clean = normalizeCode(code)
    try {
      if (clean) sessionStorage.setItem(KEY, clean)
    } catch {
      // storage blocked: the jam still works for this page load via the URL
    }
    return clean
  },

  leave() {
    try {
      sessionStorage.removeItem(KEY)
    } catch {
      // nothing to clear
    }
  },

  /**
   * A fresh room code. From the jam server when one is running; otherwise made
   * right here, because without a server a room is nothing but its code: the
   * players who share it find each other directly (see jam-core.js).
   */
  async create() {
    try {
      const { room_id } = await request('/create_room', { method: 'POST' })
      return normalizeCode(room_id) || localCode()
    } catch {
      return localCode()
    }
  },

  /**
   * -> { exists, players, full }. Without a server there is nobody to ask whether
   * a room exists, so any well-formed code is accepted: you simply land in it.
   */
  async check(code) {
    try {
      return await request(`/check_room/${encodeURIComponent(normalizeCode(code))}`)
    } catch {
      return { exists: true, players: null, full: false, direct: true }
    }
  },

  /** A link that drops someone straight into the room, already in this jam. */
  inviteUrl(code = this.code) {
    return `${location.origin}${location.pathname}?jam=${encodeURIComponent(code)}`
  },
}
