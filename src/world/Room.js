import * as THREE from 'three'
import { PALETTE } from '../config.js'
import { paint } from './materials.js'

const { paper: PAPER, ink: INK, yellow: YELLOW, pink: PINK, blue: BLUE, green: GREEN } = PALETTE

/** Unlit, so the colour on screen is exactly the token, like a flat fill in CSS. */
const flat = (color, map = null) => new THREE.MeshBasicMaterial({ color: map ? '#ffffff' : color, map })

/**
 * The stage, built by the same rules as the interface: flat fills, thick black
 * lines, hard offset shadows.
 *   - a yellow floor ruled with a black grid (the "visible grid", in 3D)
 *   - paper walls, a dotted back wall, black skirting and corner posts as borders
 *   - three posters and the SYMPHONY rug, each with a solid black block offset
 *     behind it, the 3D version of `box-shadow: 6px 6px 0 #000`
 *   - one invisible plane that catches the instruments' real shadows as solid
 *     black shapes (ShadowMaterial), falling down-right like every UI shadow
 */
export default class Room {
  constructor(experience) {
    this.scene = experience.scene
    this.group = new THREE.Group()
    this.scene.add(this.group)

    this.buildFloor()
    this.buildWalls()
    this.buildPosters()
    this.buildRug()
    this.buildProps()
    this.buildShadowCatcher()
  }

  plane(w, h, material) {
    return new THREE.Mesh(new THREE.PlaneGeometry(w, h), material)
  }

  buildFloor() {
    const floor = this.plane(26, 24, flat(YELLOW, gridTexture()))
    floor.rotation.x = -Math.PI / 2
    floor.position.set(0.3, 0, 0.5)
    this.group.add(floor)
  }

  buildWalls() {
    const back = this.plane(20, 8, flat(PAPER, dotTexture()))
    back.position.set(0.3, 4, -6)
    this.group.add(back)

    const left = this.plane(14, 8, flat(PAPER))
    left.rotation.y = Math.PI / 2
    left.position.set(-9, 4, 0.5)
    this.group.add(left)

    const right = this.plane(14, 8, flat(PAPER))
    right.rotation.y = -Math.PI / 2
    right.position.set(9, 4, 0.5)
    this.group.add(right)

    // black skirting + corner posts: the room's "borders"
    const ink = flat(INK)
    const skirtBack = new THREE.Mesh(new THREE.BoxGeometry(18, 0.09, 0.05), ink)
    skirtBack.position.set(0, 0.045, -5.97)
    this.group.add(skirtBack)
    for (const sx of [-1, 1]) {
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.09, 14), ink)
      skirt.position.set(sx * 8.97, 0.045, 0.5)
      this.group.add(skirt)

      const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 8, 0.05), ink)
      post.position.set(sx * 8.95, 4, -5.95)
      this.group.add(post)
    }
  }

  buildPosters() {
    const z = -5.9
    this.addPoster(-4.7, 3.5, 2.5, 2.9, z, posterTexture(0))
    this.addPoster(0.3, 3.75, 2.9, 3.3, z, posterTexture(1)) // larger central focal piece
    this.addPoster(5.3, 3.5, 2.5, 2.9, z, posterTexture(2))
  }

  /** A poster = hard black shadow block, black frame, flat art. */
  addPoster(x, y, w, h, z, tex) {
    const ink = flat(INK)
    const border = 0.06

    const shadow = this.plane(w + border * 2, h + border * 2, ink)
    shadow.position.set(x + 0.13, y - 0.13, z - 0.03)
    this.group.add(shadow)

    const frame = this.plane(w + border * 2, h + border * 2, ink)
    frame.position.set(x, y, z)
    this.group.add(frame)

    const art = this.plane(w, h, flat(PAPER, tex))
    art.position.set(x, y, z + 0.02)
    this.group.add(art)
  }

  buildRug() {
    const place = (mesh, dx, dz, y) => {
      mesh.rotation.x = -Math.PI / 2
      mesh.rotation.z = -0.08
      mesh.position.set(0.6 + dx, y, 3.1 + dz)
      this.group.add(mesh)
    }
    // the rug's hard shadow: a black slab, offset down-right
    place(this.plane(6.8, 3.6, flat(INK)), 0.12, 0.12, 0.006)
    place(this.plane(6.8, 3.6, flat(PAPER, rugTexture(2048, 1084))), 0, 0, 0.012)
  }

  buildProps() {
    // a pink bench and a blue plinth: solid blocks of the palette
    const bench = new THREE.Group()
    const pink = paint(PINK, { rough: 0.8 })
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.14, 0.5), pink)
    top.position.y = 0.5
    bench.add(top)
    for (const sx of [-0.68, 0.68]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.5, 0.46), paint(INK, { rough: 0.8 }))
      leg.position.set(sx, 0.25, 0)
      bench.add(leg)
    }
    bench.position.set(-5.6, 0, 2.7)
    bench.rotation.y = 0.5
    bench.traverse((o) => { if (o.isMesh) o.castShadow = true })
    this.group.add(bench)

    const plinth = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.95, 1.2), paint(BLUE, { rough: 0.8 }))
    plinth.position.set(-6.4, 0.475, 0.1)
    plinth.castShadow = true
    this.group.add(plinth)
  }

  /**
   * Shadows as solid black shapes. The floor and rug are unlit (flat colour), so
   * they can't receive shadows themselves; this transparent plane sits a hair
   * above them and draws ONLY the shadow, at full opacity.
   */
  buildShadowCatcher() {
    // a clear shadow, not a black blob that hides the instrument
    const catcher = this.plane(26, 24, new THREE.ShadowMaterial({ color: INK, opacity: 0.32 }))
    catcher.rotation.x = -Math.PI / 2
    catcher.position.set(0.3, 0.02, 0.5)
    catcher.receiveShadow = true
    this.group.add(catcher)
  }
}

/* ----------------------------- textures ----------------------------- */

function canvasTexture(w, h, draw, { repeat = null, anisotropy = 8 } = {}) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const x = c.getContext('2d')
  draw(x, w, h)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = anisotropy
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.repeat.set(repeat[0], repeat[1])
  }
  return { texture: t, context: x }
}

// Floor: a PALE yellow, ruled into 2 m squares with a thin grey line. Kept quiet
// on purpose, so the instruments standing on it are what the eye goes to.
function gridTexture() {
  return canvasTexture(256, 256, (x, w, h) => {
    x.fillStyle = '#fff4c4'
    x.fillRect(0, 0, w, h)
    x.fillStyle = 'rgba(58, 54, 51, 0.3)'
    x.fillRect(0, 0, w, 3)
    x.fillRect(0, 0, 3, h)
  }, { repeat: [13, 12], anisotropy: 16 }).texture
}

// Back wall: paper with a faint dot grid.
function dotTexture() {
  return canvasTexture(128, 128, (x, w, h) => {
    x.fillStyle = PAPER
    x.fillRect(0, 0, w, h)
    x.fillStyle = 'rgba(58, 54, 51, 0.22)'
    x.beginPath()
    x.arc(w / 2, h / 2, 4.5, 0, Math.PI * 2)
    x.fill()
  }, { repeat: [40, 16] }).texture
}

// The rug: paper, a fat black border, and the wordmark in the display face with
// one syllable knocked out on a yellow block. Canvas text can only use a font
// once it has loaded, so the texture is painted immediately (fallback face) and
// repainted when the web font arrives.
function rugTexture(W, H) {
  const { texture, context: x } = canvasTexture(W, H, () => {})

  const draw = () => {
    x.fillStyle = PAPER
    x.fillRect(0, 0, W, H)
    x.lineWidth = 22
    x.strokeStyle = INK
    x.strokeRect(11, 11, W - 22, H - 22)

    const size = H * 0.29 // small enough that the whole word survives the room's perspective crop
    x.font = `400 ${size}px "Archivo Black", "Arial Black", sans-serif`
    x.textBaseline = 'alphabetic'
    x.textAlign = 'left'
    const parts = ['SYM', 'PHO', 'NY']
    const widths = parts.map((p) => x.measureText(p).width)
    const total = widths.reduce((a, b) => a + b, 0)
    let cursor = (W - total) / 2
    const base = H * 0.58

    parts.forEach((part, i) => {
      if (i === 1) {
        // the yellow block behind "PHO", with its own border
        const pad = size * 0.06
        x.fillStyle = YELLOW
        x.fillRect(cursor - pad, base - size * 0.82, widths[i] + pad * 2, size * 0.98)
        x.lineWidth = 10
        x.strokeStyle = INK
        x.strokeRect(cursor - pad, base - size * 0.82, widths[i] + pad * 2, size * 0.98)
      }
      x.fillStyle = INK
      x.fillText(part, cursor, base)
      cursor += widths[i]
    })

    x.font = `700 ${H * 0.06}px "Space Mono", "Courier New", monospace`
    x.textAlign = 'center'
    x.fillStyle = INK
    x.fillText('NO KEYS  /  NO STRINGS  /  NO STICKS', W / 2, H * 0.78)

    texture.needsUpdate = true
  }

  draw()
  const repaint = () =>
    Promise.all([
      document.fonts.load('400 120px "Archivo Black"'),
      document.fonts.load('700 40px "Space Mono"'),
    ])
      .then(draw)
      .catch(() => {})
  repaint()
  window.addEventListener('load', repaint, { once: true })
  return texture
}

// Three posters: flat colour fields, fat black outlines, nothing subtle.
function posterTexture(variant) {
  const W = 512
  const H = 600
  return canvasTexture(W, H, (x) => {
    const stroke = () => {
      x.lineWidth = 9
      x.strokeStyle = INK
      x.lineJoin = 'miter'
      x.stroke()
    }
    if (variant === 0) {
      // pink: a black disc, a yellow quarter, a paper bar
      x.fillStyle = PINK
      x.fillRect(0, 0, W, H)
      x.fillStyle = INK
      x.beginPath(); x.arc(190, 200, 120, 0, Math.PI * 2); x.fill()
      x.fillStyle = YELLOW
      x.beginPath(); x.moveTo(512, 600); x.lineTo(512, 300); x.arc(512, 600, 300, -Math.PI / 2, Math.PI, true); x.closePath(); x.fill(); stroke()
      x.fillStyle = PAPER
      x.beginPath(); x.rect(60, 420, 250, 90); x.fill(); stroke()
    } else if (variant === 1) {
      // blue: a paper starburst and a yellow dot
      x.fillStyle = BLUE
      x.fillRect(0, 0, W, H)
      x.fillStyle = PAPER
      x.beginPath()
      for (let i = 0; i < 16; i++) {
        const r = i % 2 ? 105 : 210
        const a = (Math.PI * 2 * i) / 16 - Math.PI / 2
        const px = 256 + Math.cos(a) * r
        const py = 270 + Math.sin(a) * r
        i ? x.lineTo(px, py) : x.moveTo(px, py)
      }
      x.closePath(); x.fill(); stroke()
      x.fillStyle = YELLOW
      x.beginPath(); x.arc(256, 270, 62, 0, Math.PI * 2); x.fill(); stroke()
      x.fillStyle = INK
      x.fillRect(60, 520, 392, 26)
    } else {
      // green: black bars and a pink half-moon
      x.fillStyle = GREEN
      x.fillRect(0, 0, W, H)
      x.fillStyle = INK
      for (let i = 0; i < 4; i++) x.fillRect(60, 70 + i * 62, 392 - i * 70, 34)
      x.fillStyle = PINK
      x.beginPath(); x.arc(256, 560, 190, Math.PI, 0); x.closePath(); x.fill(); stroke()
    }
  }, { anisotropy: 4 }).texture
}
