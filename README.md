# Symphony

An interactive 3D studio where you explore musical instruments and play them with
your hands. Step into the room, pick an instrument — it lifts off the floor,
levitates, and the camera flies in as you cross into the play view, where
Symphony's computer-vision model reads your hand to turn motion into music.

Built with **Three.js** (WebGL) + **GSAP**, bundled by **Vite**. No frameworks,
no asset downloads — the entire room and every instrument are generated in code.

## Design system: neo-brutalist

One set of rules for the 3D studio, the three players and the room itself.

| | |
| --- | --- |
| **Colour** | cream paper `#FBF6EA`, charcoal ink `#3A3633`, and four soft flat accents: yellow `#FFDF6B` (piano), pink `#FF8FA9` (bass), blue `#74A9FF` (drums), green `#63D490` (band / live). Text on an accent is always charcoal. |
| **Type** | Archivo Black (display, huge, line-height 0.86) · Space Grotesk (body) · Space Mono (labels, numbers) |
| **Borders** | `--bw` 2px / `--bw-lg` 3px solid charcoal, zero radius, everywhere |
| **Shadows** | solid charcoal, zero blur, always down-right: `--sh-sm` 3px, `--sh` 4px, `--sh-lg` 6px |
| **Press** | hover lifts up-left and the shadow grows; press drops into the shadow. 120 ms, linear |
| **Never** | gradients, blur, glow, soft shadows, rounded corners, emoji icons |

Patterns (grid paper, dots) are SVG tiles rather than CSS gradients. The room follows
the same rules in 3D (`src/world/Room.js`): unlit flat colour, a pale yellow floor
with a faint grid, posters and the rug each sitting on an offset charcoal block, and
the instruments' real shadows falling down-right.

**The one exception is the intro** (`.intro` in `src/style.css`): a title card in
rounded Nunito with a soft clay button and a cream vignette, played over a camera
move. The camera starts high above the room looking down at the rug, descends for
4 s until it sits just above it, and hovers; "Enter the studio" fades the card out
and flies to the room overview. The shot's numbers are `INTRO` in `src/config.js`,
the moves are `standby()` / `hover()` / `enter()` in
`src/interaction/FocusController.js`.

The tokens live in three places that must stay in sync: `src/config.js` (`PALETTE`,
used by the 3D room), `src/style.css` (studio HUD) and `public/play/harmonic.css`
(the players). `public/play/harmonic-ui.js` holds the players' shared behaviour.
The older `public/play/styles.css`, `app.js` and `sheet_renderer.js` are no longer
loaded by any page. Add `?camera=demo` to a player URL to see it with a generated
test picture instead of the webcam.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173  (site only)
npm run build    # production bundle in dist/
npm run preview  # serve the production build

# site + Python backend (song library + multiplayer jam) together:
npm run dev:all      # Vite :5173 + API :8766 + jam :8502  (best-effort Python)
npm run start:all    # same, on the production build (:4173)
```

The webcam instrument play is fully in-browser and needs **no backend**; `dev:all`
just adds the optional song/jam servers (see `backend/README.md`).

## Pieces & flow

Symphony is one site with three layers that hand off cleanly:

1. **Milpitas pitch page** (`public/milpitas.html`) — the partner-facing page for the
   Milpitas Community Education Foundation / STEAM. Its "Project Harmonic → Learn More"
   button links into the hero.
2. **The hero studio** (this Vite app, `/`) — the 3D room where you pick an instrument.
3. **The CV players** (`public/play/{bass,piano-player,drums-player}.html`) — the real
   in-browser, MediaPipe hand-tracking + Web Audio instruments. Selecting an instrument
   in the hero and hitting "Enable camera & play" opens the matching player, which
   **auto-starts the webcam + hand-tracking on load** (a friendly retry overlay appears
   if the camera is blocked); its **Back** returns to the studio via `/?studio=1`.

The Python computer-vision/music **backend** lives in `backend/` and is **optional** —
single-player works fully in the browser. See `backend/README.md`.

## Input latency (how the players stay responsive)

The path from a moving finger to a sound is: camera frame -> hand tracking -> note
detection -> audio. The players shorten every step they control:

- **Tracking runs in a worker** (`public/play/hand-worker.js`), fed frames straight
  from the camera track (`MediaStreamTrackProcessor`), newest frame only. It never
  waits for the page to paint and never blocks it. `public/play/hand-tracker.js` is the
  page-side API (`HarmonicTracker.start(video, onResults)`); browsers without that
  pipeline fall back to tracking on the page via `requestVideoFrameCallback`
  (force it with `?tracker=page` to compare).
- **The camera is asked for 60 fps at 640x480.** Frame rate is the largest piece of
  latency we can influence; most webcams only reach 60 fps at lower resolution.
- **Notes fire straight from the tracking result**, not on the next animation frame,
  and velocities use each frame's capture time. Drums sound on the frame a fingertip
  enters a pad (they used to wait for the finger to slow down inside it).
- **Audio starts in the same task as the detection**: samples are decoded up front,
  leading silence in a recording is skipped (`HarmonicUI.onset`), and the attack is 3 ms.

The rail shows the live numbers, e.g. `60 fps · 10 ms` (camera frames tracked per
second, time to track one). Two things the page cannot fix, and says so when it sees
them: a webcam in a dim room drops to 10-15 fps, and Bluetooth audio adds 150-250 ms.

The 3D room holds its frame rate too: `src/core/Renderer.js` lowers the render
resolution when frames run long (and raises it again), and redraws the shadow map
every other frame while nothing is flying.

## Band Mode (live jam)

Several people, each on their own instrument, hearing each other as they play.

1. In the room, open the **Band Mode** stage (or `04 Band Mode` in the index).
2. **Start a jam** to get a six-character code, or **Join a jam** with someone's code.
   The bar at the top right shows the jam you are in, with **Copy invite** and **Leave**.
3. Pick any instrument. It opens connected to the jam: the rail shows who else is
   playing (their chip kicks on every note), and "Studio" brings you back to the room
   still in the jam, so you can swap instruments.

An invite link (`/?jam=CODE`) drops a visitor straight into the room, already in the jam.

How it works: `backend/session_server.py` keeps the rooms and relays each player's
notes to the others over a WebSocket. `public/play/jam-core.js` connects, draws the
roster, and voices every *remote* note through its own small sampler, so each player
page can sound piano, bass and drums without owning their code. The studio side
(`src/jam.js`, the sheet in `src/ui/Overlay.js`) only starts/joins and remembers the code.

It needs the jam server, so run `npm run dev:all` (or `start:all`) rather than plain
`npm run dev`. The browser reaches it same-origin at `/jam` through the proxy in
`vite.config.js`, so one port carries everything. To jam **across devices**, the other
devices need the site over HTTPS (browsers only allow the camera on `https://` or
`localhost`): point one HTTPS tunnel at the site's port and share that address.
Rooms hold up to 8 players and live in memory (they vanish when the server restarts).

**Without the server (the hosted site).** A static host such as Vercel cannot run
`session_server.py`, so there Band Mode connects the players to each other directly:
`public/play/jam-core.js` asks `/jam/health`, and when nothing answers it joins the room
browser to browser over WebRTC (`P2PJamManager`), using public relays only to find the
other players. The room code is made in the browser (`src/jam.js`) and any well-formed
code can be joined. The library is [trystero](https://github.com/dmotz/trystero) 0.27.0,
committed as one bundled file at `public/play/vendor/trystero.js` (it is not an npm
dependency of the site; to rebuild it, install trystero somewhere and run
`esbuild <path>/trystero/dist/index.mjs --bundle --format=esm --minify --outfile=public/play/vendor/trystero.js`).
Two players behind strict firewalls may fail to connect, since there is no TURN relay.

**Bandmates' cameras.** In a jam, each instrument page shows a small box per bandmate
on the left: their camera, tagged with the instrument they are on (`startCams()` in
`jam-core.js`, `.band-cams` in `harmonic.css`). The picture always travels browser to
browser, even when the notes go through the server, and what is sent is a clone of the
hand tracker's camera track squeezed to about 320x240 at 15 fps so it does not cost the
instrument its frame rate. "Cam on" in the jam bar stops sharing.
To force this route on a machine that does have the server:
`localStorage.setItem('harmonic.jam.via', 'p2p')`.

## The experience

1. **Intro** — plays on load: the camera drops from above the room to just over
   the rug while SYMPHONY lands a letter at a time, then "Enter the studio" appears.
2. **Enter** — the button flies the camera to the room overview and hands over control.
3. **Browse** — instruments sit on a fixed, composed stage (the same every load).
   Hover for a cursor-following label; the camera gives a gentle pointer parallax.
4. **Focus** — click an instrument and it lifts, slowly spins, and levitates while
   the camera flies in close (the signature "zoom + levitate" move).
5. **Play** — a themed, glass play screen as a placeholder for the live
   computer-vision view (scanning viewport + hand-landmark skeleton). `Back` /
   `Esc` reverses it all.

## Architecture

A small, Bruno-Simon-style "Experience" core. One render loop, one renderer, a
clean separation between the engine, the world, interaction, and the HUD.

```
src/
  main.js              entry point
  Experience.js        singleton orchestrator + app state machine
  config.js            palette, timings, instrument registry, fixed LAYOUT
  style.css            the HTML HUD layer

  core/
    EventEmitter.js    tiny pub/sub
    Sizes.js           viewport + capped pixel ratio  (emits "resize")
    Time.js            the single rAF loop            (emits "tick")
    Camera.js          driven perspective camera + browse parallax / intro drift
    Renderer.js        WebGLRenderer + EffectComposer (MSAA, bloom, ACES)

  world/
    World.js           assembles the room, places instruments on fixed marks
    Environment.js     image-based lighting + key/fill lights + fog
    Room.js            procedural studio (floor, walls, art, window, rug, props)
    instruments/
      Instrument.js    BASE CLASS / contract (see below)
      Bass.js  Piano.js  Drums.js  BandStation.js

  interaction/
    Picker.js          raycast hover/click -> routes to focus
    FocusController.js  all camera moves + the levitate/zoom/release sequence

  ui/
    Overlay.js         landing, instrument index, hint, hover label, piano mode
                       sheet, grain + vignette, page curtain
```

**App state machine** (owned by `Experience.state`):
`intro → entering → browsing → focusing → playing → releasing → browsing`.

### The instrument contract

Every playable object extends `Instrument`. Subclasses implement only `build()`
(and optionally `update()`); the base class handles raycast tagging, shadows, and
bounding-box measurement used to frame the camera. To add an instrument: drop a
new subclass in `instruments/`, register it in `config.js` and the `FACTORY` map
in `World.js`. That's the whole surface area.

## Look (realism without ray tracing)

True real-time path tracing isn't practical in a browser at this framerate, so the
"ray-traced" feel comes from techniques that are: **image-based lighting** (a
procedural `RoomEnvironment` baked via `PMREMGenerator` gives every PBR material
real reflections), **clearcoat physical materials** for wet piano lacquer / glossy
guitar / chrome / brass, soft directional shadows, and an `EffectComposer` pass
chain (multisampled HDR render → bloom on emissives only → ACES tone-mapping).

## Performance notes (it's judged on this)

- One `WebGLRenderer`, one `requestAnimationFrame` loop, device pixel ratio capped at 2.
- Bloom uses a high threshold so only true glows (the halo, the window) bloom — never
  the lit walls — keeping the post pass cheap and the image crisp.
- Static room meshes freeze their matrices (`matrixAutoUpdate = false`).
- The raycaster only runs on actual pointer movement, against a flat `pickables`
  list — never the whole scene graph.
- A single shadow-casting light with a tight frustum; IBL supplies the rest of the fill.
- Instruments are procedural primitives kept to a modest triangle budget.
- `prefers-reduced-motion` collapses all transition durations to zero and stills the float.

## Extension points

- **Real room asset:** `Room.js` builds into `this.group`. Swap the `build*()`
  calls for a single GLTF load into that group for a pixel-exact scene — nothing
  else changes.
- **The backend:** wire the vision/audio pipeline into `ui/PlayScreen.js` where
  the placeholder viewport lives; it already receives the selected instrument.
