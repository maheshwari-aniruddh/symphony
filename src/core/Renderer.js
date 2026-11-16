import * as THREE from 'three'

// Adaptive resolution: if frames are taking too long, render fewer pixels (the
// canvas is still stretched to the full window by CSS), and creep back up when
// there is headroom. A slightly softer room at 60 fps beats a sharp one that judders.
const SLOW_FRAME_MS = 21 // sustained average above this (under ~48 fps) -> drop a step
const FAST_FRAME_MS = 17.2 // sustained average below this (a solid 60 fps) -> may rise a step
const WINDOW = 40 // frames per measurement window
const MIN_SCALE = 0.55 // never go below this fraction of the device pixel ratio

/**
 * WebGL renderer, clean, no post-processing passes. Hard-edged shadow maps and
 * PBR-neutral tone mapping keep the flat brutalist colours true to their tokens.
 */
export default class Renderer {
  constructor(experience) {
    this.experience = experience
    this.sizes = experience.sizes
    this.scene = experience.scene
    this.camera = experience.camera

    this.instance = new THREE.WebGLRenderer({
      canvas: experience.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    })
    this.instance.shadowMap.enabled = true
    this.instance.shadowMap.type = THREE.PCFShadowMap // crisp edges: the room's shadows are solid black blocks
    // We decide when the shadow map is redrawn (see update()): it is the most
    // expensive pass in the frame and most of what casts shadows barely moves.
    this.instance.shadowMap.autoUpdate = false
    this.instance.shadowMap.needsUpdate = true
    this.instance.toneMapping = THREE.NeutralToneMapping // keeps colours vivid + clean
    this.instance.toneMappingExposure = 1.0

    this.scale = 1 // current fraction of the device pixel ratio
    this.frame = 0
    this.acc = 0 // frame-time accumulator for the current window
    this.count = 0
    this.calmWindows = 0 // consecutive fast windows (needed before scaling back up)
    this.avgBeforeDrop = 0 // frame time just before the last step down (to check it helped)
    this.locked = false // true once we learn resolution isn't what is slow
    this.resize()
  }

  resize() {
    this.instance.setPixelRatio(this.sizes.pixelRatio * this.scale)
    this.instance.setSize(this.sizes.width, this.sizes.height)
    this.instance.shadowMap.needsUpdate = true
  }

  /** Watch real frame times and step the render resolution down / up to hold 60 fps. */
  adapt() {
    const ms = this.experience.time.rawDelta * 1000
    // ignore the first frames (shader warm-up) and stalls that aren't about rendering
    // (tab switched away, window dragged, a background-tab throttle)
    if (this.locked || this.frame < 30 || ms > 120) return
    this.acc += ms
    if (++this.count < WINDOW) return

    const avg = this.acc / this.count
    this.acc = 0
    this.count = 0

    // Did the last step down actually help? If frames are just as slow with fewer
    // pixels, resolution isn't the bottleneck (a 30 Hz display, a busy CPU): put the
    // sharpness back and stop adapting rather than blur the room for nothing.
    if (this.avgBeforeDrop) {
      const helped = avg < this.avgBeforeDrop * 0.9
      this.avgBeforeDrop = 0
      if (!helped) {
        this.scale = 1
        this.locked = true
        this.resize()
        return
      }
    }

    if (avg > SLOW_FRAME_MS && this.scale > MIN_SCALE) {
      this.avgBeforeDrop = avg
      this.scale = Math.max(MIN_SCALE, this.scale - 0.15)
      this.calmWindows = 0
      this.resize()
    } else if (avg < FAST_FRAME_MS && this.scale < 1) {
      // only climb after several calm windows in a row, so it doesn't oscillate
      if (++this.calmWindows >= 6) {
        this.scale = Math.min(1, this.scale + 0.1)
        this.calmWindows = 0
        this.resize()
      }
    } else {
      this.calmWindows = 0
    }
  }

  update() {
    this.frame++
    this.adapt()

    // Shadows: every frame while something is flying or levitating, every other
    // frame while the room is just idling (the cymbal sway and hover lifts are
    // slow enough that half-rate shadows are indistinguishable).
    const state = this.experience.state
    const moving = state === 'focusing' || state === 'releasing' || state === 'entering'
    if (moving || (this.frame & 1) === 0) this.instance.shadowMap.needsUpdate = true

    this.instance.render(this.scene, this.camera.instance)
  }
}
