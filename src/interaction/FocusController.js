import * as THREE from 'three'
import gsap from 'gsap'
import { TIMING, HOME, FOCUS, INTRO } from '../config.js'
import { Jam } from '../jam.js'

/**
 * Orchestrates the camera and the signature "levitate + zoom" on select.
 *
 *  standby()     plays the intro shot (descend to the rug, hover).
 *  enter()       leaves the intro and flies to the room overview.
 *  enterDirect() skips the intro and starts browsing immediately.
 *  focus(i)      lifts and frames the instrument, then either offers a mode
 *                choice (piano) or launches its player straight away.
 *  launch(i,m)   fades out and opens the instrument's player in the chosen mode.
 *  release()     reverses back to browsing (Back, or instruments with no player).
 *  update()      applies the live levitation transform each frame.
 */
export default class FocusController {
  constructor(experience) {
    this.experience = experience
    this.camera = experience.camera
    this.overlay = experience.overlay

    this.focused = null
    this.lift = 0 // 0..1 levitation amount (tweened)
    this.spin = 0 // accumulated rotation while lifted
    this.prefetched = new Set()

    // honour reduced-motion, and keep honouring it if the user toggles it live
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    this.reduced = mq.matches
    mq.addEventListener('change', (e) => (this.reduced = e.matches))
  }

  dur(seconds) {
    return this.reduced ? 0 : seconds
  }

  /** Ask the browser to fetch something we're about to need, once, at idle priority. */
  prefetch(href, as) {
    if (this.prefetched.has(href)) return
    this.prefetched.add(href)
    const link = document.createElement('link')
    link.rel = 'prefetch'
    link.href = href
    if (as) link.as = as
    document.head.append(link)
  }

  /**
   * While someone is looking around the room, quietly fetch what every player
   * needs (shared styles/script + the 7.8 MB hand-tracking model), so stepping
   * into an instrument starts the camera instead of a download.
   */
  warmPlayers() {
    const run = () => {
      this.prefetch('/play/harmonic.css', 'style')
      this.prefetch('/play/harmonic-ui.js', 'script')
      this.prefetch('/play/hand_landmarker.task', 'fetch')
    }
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 4000 })
    else setTimeout(run, 1200)
  }

  /**
   * INTRO. Plays on load, before the room can be touched: the camera starts
   * far above the room looking down at the rug, descends until it sits just
   * above it, and hovers there. The position and the look-at point are tweened
   * as two separate vectors (Camera.update aims at `target` every frame), so
   * the view levels out as it lands: a dolly, not a cut.
   */
  standby() {
    const { base, target } = this.camera
    const { from, rug, land, descend } = INTRO
    base.set(from.x, from.y, from.z)
    target.set(rug.x, rug.y, rug.z)
    this.overlay.showIntro()

    const move = { duration: this.dur(descend), ease: 'power2.inOut' }
    gsap.to(target, { ...land.target, ...move })
    gsap.to(base, { ...land.base, ...move, onComplete: () => this.hover() })
  }

  /** Landed: bob gently on y, forever (until Enter kills it). */
  hover() {
    if (this.reduced || this.experience.state !== 'intro') return
    const { base } = this.camera
    const { amp, period } = INTRO.hover
    const y = INTRO.land.base.y
    this.hoverTween = gsap
      .timeline()
      .to(base, { y: y + amp, duration: period / 2, ease: 'sine.out' }) // ease up out of the landing
      .to(base, { y: y - amp, duration: period, ease: 'sine.inOut', yoyo: true, repeat: -1 })
  }

  /** INTRO -> ROOM. "Enter the studio": drop the title card and fly to the room overview. */
  enter() {
    if (this.experience.state !== 'intro') return
    this.experience.state = 'entering'
    this.hoverTween?.kill()
    gsap.killTweensOf(this.camera.base) // the descent, if Enter was pressed before it landed
    gsap.killTweensOf(this.camera.target)
    this.overlay.hideIntro()
    gsap.to(this.camera.base, { ...HOME.base, duration: this.dur(TIMING.intro), ease: 'power3.inOut' })
    gsap.to(this.camera.target, {
      ...HOME.target,
      duration: this.dur(TIMING.intro),
      ease: 'power3.inOut',
      onComplete: () => {
        this.experience.state = 'browsing'
        this.experience.picker.setEnabled(true)
        this.overlay.showHint()
        this.warmPlayers()
      },
    })
  }

  /** Drop straight into browsing (used when returning from a player via ?studio). */
  enterDirect() {
    this.camera.base.set(HOME.base.x, HOME.base.y, HOME.base.z)
    this.camera.target.set(HOME.target.x, HOME.target.y, HOME.target.z)
    this.experience.state = 'browsing'
    this.experience.picker.setEnabled(true)
    this.overlay.showHint()
    this.warmPlayers()
  }

  focus(instrument) {
    if (this.experience.state !== 'browsing') return
    this.experience.state = 'focusing'
    this.focused = instrument
    // the fly-in takes ~1.2s: use it to fetch the page we're about to open
    if (instrument.player) this.prefetch(`/${instrument.player}`, 'document')

    this.experience.picker.setEnabled(false)
    gsap.killTweensOf(instrument.group.position) // hand vertical control to update()
    this.overlay.hideHint()

    const { camPos, target } = this.framing(instrument)
    const tl = gsap.timeline({
      onComplete: () => {
        if (instrument.learn) {
          // piano: let the player pick Composer or Music Learning
          this.overlay.showModeChoice(instrument)
        } else if (instrument.player) {
          this.launch(instrument, 'composer') // others go straight to free play
        } else {
          // Band Mode stage: start or join a live jam (or see the code if in one)
          this.overlay.showJamSheet()
        }
      },
    })
    const d = this.dur(TIMING.focus)
    tl.to(this.camera.base, { ...camPos, duration: d, ease: 'power3.inOut' }, 0)
    tl.to(this.camera.target, { ...target, duration: d, ease: 'power3.inOut' }, 0)
    tl.to(this, { lift: 1, duration: d * 0.92, ease: 'power2.out' }, 0.08)
  }

  /** Fade out and open the instrument's live camera player in the chosen mode. */
  launch(instrument, mode) {
    if (!instrument || !instrument.player) return
    const composer = mode === 'composer' && instrument.id === 'piano'
    // In a jam, every instrument opens connected to it (see public/play/jam-core.js).
    const jam = Jam.code ? `&jamRoom=${encodeURIComponent(Jam.code)}` : ''
    const url = `/${instrument.player}?from=studio${composer ? '&mode=composer' : ''}${jam}`
    this.overlay.hideModeChoice()
    this.overlay.fadeOut(() => {
      window.location.href = url
    })
  }

  release() {
    // ignore repeat triggers (double-click on Back, Back + Esc) while already flying home
    if (!this.focused || this.experience.state === 'releasing') return
    this.experience.state = 'releasing'
    this.overlay.hideModeChoice()
    this.overlay.hideJamSheet()

    const tl = gsap.timeline({
      onComplete: () => {
        this.focused = null
        this.experience.state = 'browsing'
        this.experience.picker.setEnabled(true)
        this.overlay.showHint()
      },
    })
    const d = this.dur(TIMING.release)
    tl.to(this.camera.base, { ...HOME.base, duration: d, ease: 'power3.inOut' }, 0)
    tl.to(this.camera.target, { ...HOME.target, duration: d, ease: 'power3.inOut' }, 0)
    tl.to(this, { lift: 0, duration: d * 0.8, ease: 'power2.in' }, 0)
    tl.to(this, { spin: 0, duration: d, ease: 'power3.inOut' }, 0) // ease rotation home
  }

  /** Keep the focused instrument framed when the viewport aspect changes. */
  reframe() {
    if (!this.focused) return
    const { camPos, target } = this.framing(this.focused)
    this.camera.base.set(camPos.x, camPos.y, camPos.z)
    this.camera.target.set(target.x, target.y, target.z)
  }

  /** Camera position + look-at that frames the instrument's bounding sphere. */
  framing(instrument) {
    const c = instrument.basePosition
    const centerY = this.liftHeight(instrument) + instrument.size.y * 0.5
    const s = instrument.size
    const radius = 0.5 * Math.hypot(s.x, s.y, s.z)
    const vFov = THREE.MathUtils.degToRad(this.camera.instance.fov)
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.instance.aspect)
    const distance = radius / Math.sin(Math.min(vFov, hFov) / 2) + FOCUS.framePad
    return {
      camPos: { x: c.x, y: centerY + s.y * 0.12, z: c.z + distance },
      target: { x: c.x, y: centerY, z: c.z },
    }
  }

  liftHeight(instrument) {
    // taller things float a touch higher so they clear the floor cleanly
    return FOCUS.liftBase + instrument.size.y * FOCUS.liftPerHeight
  }

  update() {
    const instrument = this.focused
    if (!instrument) return

    const { elapsed, delta } = this.experience.time
    // spin while engaging; release() eases `spin` back to 0 itself.
    if (!this.reduced && this.experience.state === 'focusing') {
      this.spin += delta * FOCUS.spinRate * this.lift
    }
    const bob = this.reduced ? 0 : Math.sin(elapsed * FOCUS.bobFreq) * FOCUS.bobAmp * this.lift

    instrument.group.position.y =
      instrument.basePosition.y + this.lift * this.liftHeight(instrument) + bob
    instrument.group.rotation.y = instrument.baseRotationY + this.spin
  }
}
