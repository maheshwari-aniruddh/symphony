import * as THREE from 'three'
import { PARALLAX } from '../config.js'

/**
 * A driven camera (no OrbitControls). The FocusController tweens `base` and
 * `target`; this class only applies them, plus a gentle pointer parallax while
 * the user is browsing so the room feels alive.
 *
 * The parallax offset and the narrow-screen dolly are both EASED toward their
 * goals rather than applied raw, so the view glides after the pointer and never
 * jumps when the app state changes (e.g. browsing -> focusing).
 */
export default class Camera {
  constructor(experience) {
    this.experience = experience
    this.sizes = experience.sizes
    this.scene = experience.scene

    this.base = new THREE.Vector3(0, 3.6, 11) // framing position, owned by FocusController
    this.target = new THREE.Vector3(0, 1.1, 0) // look-at point

    this.lean = new THREE.Vector2() // current (eased) parallax offset
    this.dolly = 0 // current (eased) extra pull-back for narrow screens

    this.instance = new THREE.PerspectiveCamera(
      48,
      this.sizes.width / this.sizes.height,
      0.1,
      100,
    )
    this.instance.position.copy(this.base)
    this.scene.add(this.instance)
  }

  resize() {
    this.instance.aspect = this.sizes.width / this.sizes.height
    this.instance.updateProjectionMatrix()
  }

  update() {
    const { delta } = this.experience.time
    const browsing = this.experience.state === 'browsing'
    const intro = this.experience.state === 'intro'

    // where the lean WANTS to be
    let leanX = 0
    let leanY = 0
    if (browsing) {
      // gentle pointer parallax while exploring
      leanX = this.experience.pointer.x * PARALLAX.x
      leanY = this.experience.pointer.y * PARALLAX.y
    }
    // (during the intro the FocusController's tweens are the whole move: no lean)

    // On narrow / portrait screens, dolly back so the whole ensemble stays in
    // frame. Only while browsing/intro, focus() does its own aspect framing.
    let dolly = 0
    if (browsing || intro) {
      const hHalf = Math.tan(THREE.MathUtils.degToRad(this.instance.fov) / 2) * this.instance.aspect
      dolly = Math.max(0, 5.2 / hHalf - this.base.z) // distance that keeps ±5.2 units of width visible
    }

    // frame-rate independent easing toward those goals
    const k = 1 - Math.exp(-delta * PARALLAX.damping)
    this.lean.x += (leanX - this.lean.x) * k
    this.lean.y += (leanY - this.lean.y) * k
    this.dolly += (dolly - this.dolly) * k

    this.instance.position.set(this.base.x + this.lean.x, this.base.y + this.lean.y, this.base.z + this.dolly)
    this.instance.lookAt(this.target)
  }
}
