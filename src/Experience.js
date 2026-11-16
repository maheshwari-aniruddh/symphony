import * as THREE from 'three'
import Sizes from './core/Sizes.js'
import Time from './core/Time.js'
import Camera from './core/Camera.js'
import Renderer from './core/Renderer.js'
import World from './world/World.js'
import Overlay from './ui/Overlay.js'
import Picker from './interaction/Picker.js'
import FocusController from './interaction/FocusController.js'
import { Jam, normalizeCode } from './jam.js'

let instance = null

/**
 * App orchestrator (singleton). Owns the scene graph, the render loop, and the
 * shared app `state` machine: intro -> entering -> browsing -> focusing -> releasing.
 */
export default class Experience {
  constructor(canvas) {
    if (instance) return instance
    instance = this
    if (import.meta.env.DEV) window.experience = this // debug handle

    this.canvas = canvas
    this.state = 'intro'
    this.pointer = new THREE.Vector2() // normalised device coords (-1..1)

    this.scene = new THREE.Scene()
    this.sizes = new Sizes()
    this.time = new Time()
    this.camera = new Camera(this)
    this.renderer = new Renderer(this)
    this.world = new World(this)
    this.overlay = new Overlay(this)
    this.picker = new Picker(this)
    this.focus = new FocusController(this)

    window.addEventListener('pointermove', (e) => {
      this.toNdc(e.clientX, e.clientY, this.pointer)
    })

    this.sizes.on('resize', () => this.resize())
    this.time.on('tick', () => this.update())

    // Browser "Back" out of a player can restore this page from the back/forward
    // cache exactly as we left it: faded to black, mid-focus, picker disabled.
    // Reload straight into the room instead of showing a dead black screen.
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) location.replace(`${location.pathname}?studio=1`)
    })

    // Returning from a player (?studio) drops straight into the room; a fresh
    // visit plays the cinematic "Symphony" intro and flies into the room on Enter.
    // An invite link (?jam=CODE) also goes straight in, already in that jam.
    const params = new URLSearchParams(location.search)
    const invited = normalizeCode(params.get('jam'))
    if (invited) {
      const fresh = Jam.code !== invited // false when just hopping back from a player
      Jam.join(invited)
      this.overlay.setJam(invited)
      // keep the code out of the address bar / history once it has been taken
      history.replaceState(null, '', `${location.pathname}?studio=1`)
      if (fresh) setTimeout(() => this.overlay.toast(`You're in jam ${invited}. Pick your instrument`), 900)
    }
    if (invited || params.has('studio')) {
      this.focus.enterDirect()
    } else {
      this.focus.standby()
    }

    // Compile every material's shader up front (behind the walnut curtain) so the
    // first frames and the first focus fly-in don't hitch, then lift the curtain.
    this.renderer.instance.compile(this.scene, this.camera.instance)
    this.overlay.reveal()
  }

  /** Screen pixel -> normalised device coords (-1..1), into `out` (defaults to a new vec). */
  toNdc(clientX, clientY, out = new THREE.Vector2()) {
    out.x = (clientX / this.sizes.width) * 2 - 1
    out.y = -(clientY / this.sizes.height) * 2 + 1
    return out
  }

  resize() {
    this.camera.resize()
    this.renderer.resize()
    this.focus.reframe()
  }

  update() {
    if (document.hidden) return // pause the loop in a background tab to save resources
    this.camera.update()
    this.world.update()
    this.focus.update()
    this.picker.update()
    this.overlay.update(this.time.delta)
    this.renderer.update()
  }
}
