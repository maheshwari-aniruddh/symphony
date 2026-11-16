import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { PALETTE } from '../config.js'

/**
 * Lighting for a flat, graphic room. The floor and walls are unlit colour fields
 * (see Room.js), so lights only shape the instruments and cast their shadows.
 *   - a hemisphere + a frontal fill keep every instrument evenly, brightly lit
 *   - one shadow-casting light sits BEHIND and to the left, so shadows fall
 *     toward the viewer and to the right: down-right on screen, the same
 *     direction as every hard shadow in the interface
 *   - a little image-based light gives lacquer and chrome something to reflect
 */
export default class Environment {
  constructor(experience) {
    this.scene = experience.scene
    this.renderer = experience.renderer.instance

    this.scene.background = new THREE.Color(PALETTE.paper)

    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environmentIntensity = 0.3
    pmrem.dispose()

    this.scene.add(new THREE.HemisphereLight('#ffffff', '#fff4c2', 1.15))

    // frontal fill: no shadows, just keeps the faces toward the camera bright
    const fill = new THREE.DirectionalLight('#ffffff', 1.5)
    fill.position.set(1.5, 5, 10)
    this.scene.add(fill)

    // the shadow caster: back-left and high, so shadows land down-right on screen
    const key = new THREE.DirectionalLight('#ffffff', 0.9)
    key.position.set(-5, 10, -4.5)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.near = 1
    key.shadow.camera.far = 34
    key.shadow.camera.left = -11
    key.shadow.camera.right = 11
    key.shadow.camera.top = 11
    key.shadow.camera.bottom = -11
    key.shadow.bias = -0.0004
    key.shadow.normalBias = 0.02
    key.shadow.radius = 1 // hard edge
    key.target.position.set(0.3, 0.4, 0.6)
    this.scene.add(key, key.target)
  }
}
