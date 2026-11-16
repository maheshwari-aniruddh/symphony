/**
 * Central tunables. Keeping palette, timings, the instrument registry, and the
 * floor layout in one place means the rest of the code reads like a story and
 * the whole experience can be re-skinned from here.
 */

/**
 * Neo-brutalist palette, turned down: warm cream paper, charcoal instead of
 * black, and four soft flat accents, one per instrument. Still no gradients.
 * The same values are mirrored as CSS custom properties in src/style.css and
 * public/play/harmonic.css, keep the three in sync.
 */
export const PALETTE = {
  paper: '#fbf6ea',
  ink: '#3a3633',
  yellow: '#ffdf6b',
  pink: '#ff8fa9',
  blue: '#74a9ff',
  green: '#63d490',
}

// All durations in seconds. The 3D moves are the only long transitions in the
// product; every HUD state change is ~120 ms (see --fast in the stylesheets).
export const TIMING = {
  intro: 1.6, // "Enter the studio": fly from the intro's hover into the room
  focus: 0.9,
  release: 0.8,
}

// The intro shot: the camera starts high above the room looking down at the
// rug, descends to just above it while the view levels out, then hovers there
// until "Enter the studio".
export const INTRO = {
  from: { x: 0, y: 26, z: 18 },
  rug: { x: 0.6, y: 0, z: 3.1 }, // where the rug lies (see Room.buildRug): the first look-at point
  land: { base: { x: 0, y: 2.3, z: 10 }, target: { x: 0, y: 0.9, z: 1.5 } },
  descend: 4, // seconds, power2.inOut
  hover: { amp: 0.3, period: 2.4 }, // ±metres on y, seconds per swing, sine.inOut
}

// The browsing "home" camera pose; release() returns to it after a focus.
// Pulled back enough that all four instruments sit in frame with clean margins.
export const HOME = {
  base: { x: 0.3, y: 1.75, z: 7.6 }, // close enough that the instruments are the subject
  target: { x: 0.3, y: 0.95, z: 0 },
}

// The levitate/zoom feel, tune the whole interaction from here.
export const FOCUS = {
  liftBase: 0.7, // metres an instrument floats, plus...
  liftPerHeight: 0.25, // ...this much of its own height
  bobAmp: 0.07, // gentle vertical bob amplitude
  bobFreq: 1.6, // bob speed
  spinRate: 0.55, // idle rotation speed while lifted (rad/s)
  framePad: 0.6, // extra metres so the framed instrument isn't edge-to-edge
}

// Camera feel while browsing: how far the view leans with the pointer, and how
// quickly it eases there (higher = snappier, lower = floatier).
export const PARALLAX = { x: 0.35, y: 0.2, damping: 6 }

// The four playable experiences. `accent` drives per-instrument theming across
// the body colour, the hover label and the setlist: a pink bass, a black piano
// with yellow trim, blue drums, and a green band-mode stage.
export const INSTRUMENTS = [
  { id: 'bass', name: 'Bass', tagline: 'Four strings. Zero frets.', accent: PALETTE.pink, player: 'play/bass.html' },
  { id: 'piano', name: 'Piano', tagline: 'Ten fingers. Ten notes.', accent: PALETTE.yellow, player: 'play/piano-player.html', learn: true },
  { id: 'drums', name: 'Drums', tagline: 'Four pads. No sticks.', accent: PALETTE.blue, player: 'play/drums-player.html' },
  // no player page of its own: it opens the Band Mode sheet (start / join a live jam)
  { id: 'band', name: 'Band Mode', tagline: 'Everyone. At once.', accent: PALETTE.green, player: null },
]

/**
 * FIXED stage layout (metres, +Z is toward the camera, ry = facing in radians).
 * This composition is pinned to the approved reference: drums on the left, the
 * grand piano centre, the guitar right, and the Band-Mode stage far right.
 * It is deliberately the same on every load, no randomisation.
 */
export const LAYOUT = {
  drums: { x: -3.25, z: -0.2, ry: 0.2 },
  piano: { x: -0.1, z: 0.7, ry: 0.0 },
  bass: { x: 2.7, z: -0.55, ry: -0.24 },
  band: { x: 4.05, z: 1.05, ry: -0.42 },
}
