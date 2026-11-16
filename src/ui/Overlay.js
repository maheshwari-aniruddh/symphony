import { Jam, normalizeCode } from '../jam.js'

const HINT_SOLO = matchMedia('(hover: none)').matches ? 'Tap an instrument' : 'Point. Click. Play.'
const HINT_JAM = 'In a jam. Pick your instrument.'
// Starting or joining a jam no longer needs a server (see src/jam.js), so this
// only shows if something unexpected goes wrong.
const SERVER_OFF = "Couldn't open a room. Try again."
const INTRO_FADE_MS = 350 // matches the .intro opacity transition in style.css

// the title's letters, in the order their colours cycle
const TITLE = 'SYMPHONY'
const TITLE_COLOURS = ['#e4402f', '#efb13f', '#3b7ddd', '#b65be0', '#e4402f', '#efb13f', '#e4402f', '#3b7ddd']

/**
 * The HTML HUD over the 3D room (neo-brutalist; see style.css for the rules).
 *
 *   intro     the title card that plays on load, over the camera's descent
 *             into the room: the name drops in a letter at a time, then a
 *             line of copy and the "Enter the studio" button fade up.
 *   room HUD  the brand block, the setlist (a visible, keyboard-operable list
 *             of instruments), a hint tag and the cursor label.
 *   sheets    piano mode, Band Mode.
 *   plus      the "in a jam" bar, a toast, and the black page wipe.
 *
 * Elements live under #ui and are toggled by class.
 */
export default class Overlay {
  constructor(experience) {
    this.experience = experience
    this.root = document.getElementById('ui')
    this.root.insertAdjacentHTML('beforeend', this.markup())

    this.hintPill = this.root.querySelector('.hint')
    this.hint = this.root.querySelector('.hint__text')
    this.tooltip = this.root.querySelector('.tooltip')
    this.tooltipCard = this.root.querySelector('.tooltip__card')
    this.tooltipName = this.root.querySelector('.tooltip__name')
    this.tooltipTag = this.root.querySelector('.tooltip__tag')
    this.fade = this.root.querySelector('.pagefade')
    this.toastEl = this.root.querySelector('.toast')
    this.choice = this.root.querySelector('.choice')
    this.choiceTitle = this.root.querySelector('.choice__title')
    this.intro = this.root.querySelector('.intro')
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)')

    // mode sheet (piano): launch the chosen mode, or fly back on Back / Esc
    this.choice.querySelectorAll('[data-mode]').forEach((b) =>
      b.addEventListener('click', () =>
        this.experience.focus.launch(this.experience.focus.focused, b.dataset.mode),
      ),
    )
    this.choice.querySelector('[data-back]').addEventListener('click', () => this.experience.focus.release())
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      if (this.choice.classList.contains('is-on') || this.jamSheet.classList.contains('is-on')) {
        this.experience.focus.release()
      }
    })

    this.buildJam()

    this.intro.querySelector('[data-enter]').addEventListener('click', () => this.experience.focus.enter())

    this.buildIndex()

    // Hover label: remember where the cursor is; update() eases the label toward it.
    this.tip = { x: 0, y: 0, tx: 0, ty: 0, seen: false }
    window.addEventListener('pointermove', (e) => {
      this.tip.tx = e.clientX
      this.tip.ty = e.clientY
      if (!this.tip.seen) {
        this.tip.x = e.clientX
        this.tip.y = e.clientY
        this.tip.seen = true
      }
    })
  }

  /**
   * The setlist: a real, visible list of buttons. Hovering or focusing a row
   * lifts the matching instrument in the room; activating it steps inside.
   * Mouse, keyboard and screen-reader users all get the same control.
   */
  buildIndex() {
    this.index = this.root.querySelector('.index')
    this.indexRows = {}
    const list = this.index.querySelector('ol')
    const picker = () => this.experience.picker

    this.experience.world.instruments.forEach((instrument, i) => {
      const li = document.createElement('li')
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'index__item'
      btn.style.setProperty('--accent', instrument.accentHex)
      btn.setAttribute('aria-label', `${instrument.name}. ${instrument.tagline}`)
      btn.innerHTML = `
        <span class="index__no">${String(i + 1).padStart(2, '0')}</span>
        <span>
          <span class="index__name"></span>
          <span class="index__tag"></span>
        </span>
        ${ICON_ARROW.replace('<svg', '<svg class="index__go"')}`
      btn.querySelector('.index__name').textContent = instrument.name
      btn.querySelector('.index__tag').textContent = instrument.tagline

      btn.addEventListener('pointerenter', () => picker().forceHover(instrument))
      btn.addEventListener('pointerleave', () => picker().forceHover(null))
      btn.addEventListener('focus', () => picker().forceHover(instrument))
      btn.addEventListener('blur', () => picker().forceHover(null))
      btn.addEventListener('click', () => this.experience.focus.focus(instrument))

      li.append(btn)
      list.append(li)
      this.indexRows[instrument.id] = btn
    })
    this.index.inert = true // enabled only while browsing
  }

  /* ------------------------------------------------------------------
     Band Mode. Being "in a jam" is a state of the whole room, not a page:
     start or join one from the Band Mode stage, then pick ANY instrument and
     it opens connected to that jam. The bar in the top-right shows the code.
     ------------------------------------------------------------------ */
  buildJam() {
    const $ = (sel) => this.root.querySelector(sel)
    this.jamSheet = $('.choice--jam')
    this.jamMenu = $('.jamsheet__menu')
    this.jamOpen = $('.jamsheet__open')
    this.jamCodeEl = $('.jamsheet__code')
    this.jamStatus = $('.jamsheet__status')
    this.jamInput = $('.jamcode__input')
    this.jamBar = $('.jambar')
    this.jamBarCode = $('.jambar__code')
    this.topbar = $('.topbar')

    // keep the code field to what a code can contain, as it is typed
    this.jamInput.addEventListener('input', () => {
      this.jamInput.value = normalizeCode(this.jamInput.value).slice(0, 6)
      this.setJamStatus('')
    })

    // 1 · open a room on the server
    $('[data-jam-start]').addEventListener('click', async (e) => {
      const btn = e.currentTarget
      btn.disabled = true
      this.setJamStatus('Opening a room')
      try {
        this.setJam(Jam.join(await Jam.create()))
        this.setJamStatus('')
        this.renderJamSheet()
        this.jamOpen.querySelector('[data-jam-pick]').focus({ preventScroll: true })
      } catch {
        this.setJamStatus(SERVER_OFF, true)
      } finally {
        btn.disabled = false
      }
    })

    // 2 · join an existing room by code
    $('[data-jam-join]').addEventListener('submit', async (e) => {
      e.preventDefault()
      const code = normalizeCode(this.jamInput.value)
      if (code.length < 4) {
        this.setJamStatus('Type the code first', true)
        this.jamInput.focus()
        return
      }
      this.setJamStatus('Looking for it')
      try {
        const room = await Jam.check(code)
        if (!room.exists) return this.setJamStatus(`No jam called ${code}`, true)
        if (room.full) return this.setJamStatus('That jam is full', true)
        this.setJam(Jam.join(code))
        this.setJamStatus('')
        this.experience.focus.release()
        this.toast(`You're in ${code}. Pick an instrument.`)
      } catch {
        this.setJamStatus(SERVER_OFF, true)
      }
    })

    $('[data-jam-pick]').addEventListener('click', () => this.experience.focus.release())
    $('[data-jam-back]').addEventListener('click', () => this.experience.focus.release())

    this.root.querySelectorAll('[data-jam-copy]').forEach((btn) => {
      const label = btn.textContent
      btn.addEventListener('click', async () => {
        let ok = true
        try {
          await navigator.clipboard.writeText(Jam.inviteUrl())
        } catch {
          ok = false
        }
        btn.textContent = ok ? 'Copied' : 'Copy failed'
        clearTimeout(btn._t)
        btn._t = setTimeout(() => (btn.textContent = label), 1600)
      })
    })

    $('[data-jam-leave]').addEventListener('click', () => {
      Jam.leave()
      this.setJam('')
      this.toast('You left the jam.')
    })

    this.setJam(Jam.code)
  }

  /** Reflect the current jam (or none) in the bar, the hint and the Band Mode sheet. */
  setJam(code) {
    const on = !!code
    this.jamBar.hidden = !on
    this.jamBarCode.textContent = code
    this.topbar.classList.toggle('is-jamming', on)
    this.hint.textContent = on ? HINT_JAM : HINT_SOLO
    this.renderJamSheet()
  }

  setJamStatus(text, alert = false) {
    this.jamStatus.textContent = text
    this.jamStatus.classList.toggle('is-alert', alert && !!text)
  }

  /** The sheet has two faces: start / join, or (once in a jam) the code to share. */
  renderJamSheet() {
    const code = Jam.code
    this.jamMenu.hidden = !!code
    this.jamOpen.hidden = !code
    // one cell per character
    this.jamCodeEl.textContent = ''
    this.jamCodeEl.setAttribute('aria-label', code.split('').join(' '))
    for (const ch of code) {
      const cell = document.createElement('span')
      cell.textContent = ch
      cell.setAttribute('aria-hidden', 'true')
      this.jamCodeEl.append(cell)
    }
  }

  showJamSheet() {
    this.setJamStatus('')
    this.renderJamSheet()
    this.jamSheet.classList.add('is-on')
    this.jamSheet.inert = false
    const first = Jam.code ? this.jamOpen.querySelector('[data-jam-pick]') : this.jamMenu.querySelector('[data-jam-start]')
    first.focus({ preventScroll: true })
  }
  hideJamSheet() {
    if (!this.jamSheet.classList.contains('is-on')) return
    this.jamSheet.classList.remove('is-on')
    this.jamSheet.inert = true
  }

  /** Called every frame: ease the hover label toward the cursor (no layout, transform only). */
  update(delta) {
    if (!this.tooltip.classList.contains('is-on')) return
    const k = 1 - Math.exp(-delta * 26)
    this.tip.x += (this.tip.tx - this.tip.x) * k
    this.tip.y += (this.tip.ty - this.tip.y) * k
    this.tooltip.style.transform = `translate3d(${this.tip.x.toFixed(1)}px, ${this.tip.y.toFixed(1)}px, 0)`
  }

  showHint() {
    this.hintPill.classList.add('is-on')
    this.index.classList.add('is-on')
    this.index.inert = false
  }
  hideHint() {
    this.hintPill.classList.remove('is-on')
    this.index.classList.remove('is-on')
    this.index.inert = true
  }

  /* ---------------- intro ---------------- */

  /** Start the title card (its letters, copy and button run on CSS delays from here). */
  showIntro() {
    this.root.classList.add('is-intro')
    this.intro.classList.remove('is-hidden')
    this.intro.classList.add('is-playing')
  }

  /** Enter: fade the card out, then take it out of the page for good. */
  hideIntro() {
    const el = this.intro
    this.root.classList.remove('is-intro') // the room's own chrome fades in as the card fades out
    if (!el || !el.isConnected) return
    el.classList.add('is-leaving')
    el.inert = true
    setTimeout(() => el.remove(), this.reduced.matches ? 0 : INTRO_FADE_MS)
  }

  /**
   * Reflect the hovered instrument in the HUD. `viaIndex` means the hover came
   * from the setlist itself, where the cursor label would just be noise.
   */
  setHover(instrument, { viaIndex = false } = {}) {
    for (const [id, row] of Object.entries(this.indexRows)) {
      row.classList.toggle('is-active', !!instrument && instrument.id === id)
    }
    if (instrument && !viaIndex) {
      this.tooltipName.textContent = instrument.name
      this.tooltipTag.textContent = instrument.tagline
      this.tooltipCard.style.setProperty('--accent', instrument.accentHex)
      if (this.tip.seen && !this.tooltip.classList.contains('is-on')) {
        // appear AT the cursor rather than sliding in from wherever it last was
        this.tip.x = this.tip.tx
        this.tip.y = this.tip.ty
        this.tooltip.style.transform = `translate3d(${this.tip.x}px, ${this.tip.y}px, 0)`
      }
      this.tooltip.classList.add('is-on')
    } else {
      this.tooltip.classList.remove('is-on')
    }
  }

  /** Piano mode sheet. */
  showModeChoice(instrument) {
    this.choiceTitle.textContent = instrument.name
    this.choice.classList.add('is-on')
    this.choice.inert = false
    this.choice.querySelector('[data-mode]').focus({ preventScroll: true })
  }
  hideModeChoice() {
    if (!this.choice.classList.contains('is-on')) return
    this.choice.classList.remove('is-on')
    this.choice.inert = true
  }

  /** Pull the black wipe off once the first frames are on screen. */
  reveal() {
    requestAnimationFrame(() => requestAnimationFrame(() => this.fade.classList.remove('is-on')))
  }

  /** Wipe to black, then run cb (used when stepping into a player). */
  fadeOut(cb) {
    this.fade.classList.add('is-on')
    setTimeout(cb, 240)
  }

  /** Brief message (a jam joined or left, and so on). */
  toast(message) {
    this.toastEl.textContent = message
    this.toastEl.classList.add('is-on')
    clearTimeout(this._toastT)
    this._toastT = setTimeout(() => this.toastEl.classList.remove('is-on'), 2400)
  }

  markup() {
    const letters = [...TITLE]
      .map((ch, i) => `<span aria-hidden="true" style="--i:${i};--c:${TITLE_COLOURS[i % TITLE_COLOURS.length]}">${ch}</span>`)
      .join('')

    return `
      <header class="topbar">
        <span class="brand"><span class="brand__mark" aria-hidden="true"></span>Symphony</span>
        <span class="topbar__note label">Est. for loud little hands</span>
        <div class="jambar label" hidden>
          <span class="jambar__label"><i class="jambar__dot" aria-hidden="true"></i><span>In jam</span> <b class="jambar__code"></b></span>
          <button class="jambar__btn" data-jam-copy type="button">Copy invite</button>
          <button class="jambar__btn" data-jam-leave type="button">Leave</button>
        </div>
      </header>

      <section class="intro is-hidden">
        <h1 class="intro__title" aria-label="Symphony">${letters}</h1>
        <p class="intro__sub">A 3D music room you play with your hands.</p>
        <div class="intro__go">
          <button class="intro__enter" data-enter type="button">Enter the studio <span aria-hidden="true">›</span></button>
        </div>
      </section>

      <nav class="index" aria-label="Choose an instrument to play">
        <div class="index__head label"><span>Setlist</span><span>01-04</span></div>
        <ol></ol>
      </nav>

      <div class="hint label">
        <span class="hint__dot" aria-hidden="true"></span>
        <span class="hint__text"></span>
      </div>

      <div class="tooltip" role="tooltip" aria-hidden="true">
        <div class="tooltip__card">
          <span class="tooltip__name"></span>
          <span class="tooltip__tag label"></span>
        </div>
      </div>

      <div class="choice" role="dialog" aria-modal="true" aria-label="Choose how to play" inert>
        <div class="choice__card">
          <span class="choice__tab label">Pick a mode</span>
          <div class="choice__head">
            <h2 class="choice__title"></h2>
          </div>
          <div class="choice__opts">
            <button class="choice__opt" data-mode="composer" type="button">
              <span class="choice__opt-key" aria-hidden="true">A</span>
              <span class="choice__opt-name">Composer</span>
              <span class="choice__opt-desc">Every finger is a note. Make something up.</span>
              ${ICON_ARROW.replace('<svg', '<svg class="choice__opt-go"')}
            </button>
            <button class="choice__opt" data-mode="learn" type="button">
              <span class="choice__opt-key" aria-hidden="true">B</span>
              <span class="choice__opt-name">Music Learning</span>
              <span class="choice__opt-desc">Follow a song. One note at a time.</span>
              ${ICON_ARROW.replace('<svg', '<svg class="choice__opt-go"')}
            </button>
          </div>
          <div class="choice__foot">
            <button class="choice__back label" data-back type="button">${ICON_BACK} Back to the room</button>
          </div>
        </div>
      </div>

      <div class="choice choice--jam" role="dialog" aria-modal="true" aria-label="Band Mode" inert>
        <div class="choice__card">
          <span class="choice__tab label">Play together, live</span>
          <div class="choice__head">
            <h2 class="choice__title">Band Mode</h2>
          </div>

          <div class="jamsheet__menu">
            <button class="jam-start" data-jam-start type="button">
              <span class="jam-start__no" aria-hidden="true">1</span>
              <span>
                <span class="jam-start__name">Start a jam</span>
                <span class="jam-start__desc">Get a code. Send it to the band.</span>
              </span>
              ${ICON_ARROW}
            </button>
            <form class="jam-join" data-jam-join novalidate>
              <span class="jam-join__no" aria-hidden="true">2</span>
              <label class="jam-join__name" for="jamCode">Got a code?</label>
              <span class="jamcode">
                <input id="jamCode" class="jamcode__input" name="code" autocomplete="off"
                  autocapitalize="characters" spellcheck="false" maxlength="6" placeholder="ABC123" />
                <button class="jamcode__go" type="submit">Join</button>
              </span>
            </form>
          </div>

          <div class="jamsheet__open" hidden>
            <p class="label">Your jam code</p>
            <p class="jamsheet__code"></p>
            <p class="jamsheet__help">Send it to the band. Then everybody picks an instrument and you hear each other play.</p>
            <div class="jamsheet__actions">
              <button class="cta cta--sm press" data-jam-pick type="button">Pick an instrument ${ICON_ARROW}</button>
              <button class="ghost press" data-jam-copy type="button">Copy invite link</button>
            </div>
          </div>

          <div class="choice__foot">
            <button class="choice__back label" data-jam-back type="button">${ICON_BACK} Back to the room</button>
            <span class="jamsheet__status label" role="status"></span>
          </div>
        </div>
      </div>

      <div class="toast label" role="status"></div>
      <div class="pagefade is-on" aria-hidden="true"></div>
    `
  }
}

const ICON_ARROW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M3 12h16"/><path d="M13 5l7 7-7 7"/></svg>`
const ICON_BACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M21 12H5"/><path d="M11 5l-7 7 7 7"/></svg>`
