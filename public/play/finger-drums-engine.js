/**
 * Shared finger-drums engine: hand tracking (HarmonicTracker) + Web Audio.
 * Index fingers only. A pad sounds the instant a fingertip ENTERS it; keeping the
 * finger there repeats the hit.
 * Call FingerDrumsEngine.init(...) with element IDs.
 */
var FingerDrumsEngine = (function () {
    // Pad colours are the four accents of the shared palette (harmonic.css).
    var PADS = [
        { id: 'kick', label: 'Kick', x: 0.18, y: 0.76, radius: 0.19, color: '#ff8fa9', file: 'drum_sounds/kick-01.wav' },
        { id: 'hihat', label: 'Hi-Hat', x: 0.82, y: 0.76, radius: 0.18, color: '#ffdf6b', file: 'drum_sounds/hihat-open.wav' },
        { id: 'tom1', label: 'Tom', x: 0.18, y: 0.22, radius: 0.18, color: '#63d490', file: 'drum_sounds/tom-01.wav' },
        { id: 'snare', label: 'Snare', x: 0.82, y: 0.22, radius: 0.18, color: '#74a9ff', file: 'drum_sounds/snare-03.wav' },
    ];
    var PAPER = '#fbf6ea';
    var INK = '#3a3633';
    var PAD_SHADOW = 9; // px: how far a pad sits above its hard shadow

    var INDEX_TIP = 8;
    // Triggering. The old engine waited until the fingertip had SLOWED DOWN inside
    // a pad, so a quick strike only sounded one to three camera frames (30-100 ms)
    // after it landed. Now the hit fires on the frame the fingertip crosses in.
    var EXIT_SCALE = 1.12;      // must clear the pad by this much to count as "out" (edge jitter)
    var RETRIGGER_MS = 70;      // minimum gap between hits on one pad
    var LOST_GRACE_MS = 80;     // tracking dropped a frame: don't treat it as leaving + re-entering
    var REPEAT_DELAY_MS = 400;  // hold this long inside a pad before it starts repeating
    var REPEAT_INTERVAL_MS = 350;
    var HIT_MS = 320;           // how long a pad's strike ring lasts

    var audioCtx = null;
    var buffers = {};
    var padState = {};

    PADS.forEach(function (p) {
        padState[p.id] = { inside: false, enteredAt: 0, lastRepeat: 0, lastHit: 0, lostAt: 0, hitAt: 0 };
    });

    function setStatus(state) {
        if (window.HarmonicUI) window.HarmonicUI.setStatus(state);
    }

    async function loadSounds() {
        if (!audioCtx) { // reuse across retries instead of leaking contexts
            audioCtx = window.HarmonicUI ? window.HarmonicUI.audioContext()
                : new (window.AudioContext || window.webkitAudioContext)();
            if (!audioCtx) throw new Error('Web Audio not supported');
        }
        var seen = {};
        var jobs = [];
        PADS.forEach(function (pad) {
            if (seen[pad.file] || buffers[pad.file]) return;
            seen[pad.file] = true;
            jobs.push(
                fetch(pad.file)
                    .then(function (r) { if (!r.ok) throw new Error(pad.file + ' HTTP ' + r.status); return r.arrayBuffer(); })
                    .then(function (a) { return audioCtx.decodeAudioData(a); })
                    .then(function (b) { buffers[pad.file] = b; })
            );
        });
        await Promise.all(jobs);
    }

    function playSound(pad, isRemote) {
        padState[pad.id].hitAt = performance.now(); // drives the strike ring
        var buffer = buffers[pad.file];
        if (!audioCtx || !buffer) return;
        if (audioCtx.state === 'suspended') audioCtx.resume();
        var s = audioCtx.createBufferSource();
        s.buffer = buffer;
        if (pad.rate) s.playbackRate.value = pad.rate;
        s.connect(audioCtx.destination);
        // skip any dead air at the start of the recording: it would be heard as lag
        s.start(0, window.HarmonicUI ? window.HarmonicUI.onset(buffer) : 0);

        // Broadcast drum hit to jam session (only for local hits, not remote)
        if (!isRemote && window.jamSessionManager && window.jamSessionManager.connected) {
            window.jamSessionManager.sendNote(pad.id, 0.8);
        }
    }

    function buildLegend(containerId) {
        var el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML = '';
        PADS.forEach(function (p) {
            el.innerHTML += '<div class="legend-chip"><div class="dot" style="background:' + p.color + '"></div><span>' + p.label + '</span></div>';
        });
    }

    /**
     * The on-camera view: keeps the canvas matched to the frame, turns tracking
     * results into hits, and draws pads + fingertips. Created once per page.
     */
    function createView(canvasId, infoId) {
        var canvas = document.getElementById(canvasId);
        var info = document.getElementById(infoId);
        var wrap = canvas.parentElement;
        var ctx = canvas.getContext('2d');
        var dpr = 1;
        var tips = [];
        var drawing = false;

        // The frame is sized in CSS (harmonic.css) to the camera's own aspect ratio;
        // keep the canvas BUFFER matched to it at device resolution.
        function resize() {
            dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.max(1, Math.round((wrap.clientWidth || 960) * dpr));
            canvas.height = Math.max(1, Math.round((wrap.clientHeight || 720) * dpr));
        }
        resize();
        new ResizeObserver(resize).observe(wrap);

        // ---- Detection: called by HarmonicTracker for every tracked camera frame ----
        function handleResults(results) {
            var W = canvas.width / dpr, H = canvas.height / dpr, minDim = Math.min(W, H);
            var now = performance.now();

            var allHands = results.multiHandLandmarks || [];
            var next = [];
            for (var h = 0; h < allHands.length; h++) {
                var lm = allHands[h][INDEX_TIP];
                next.push({ x: lm.x * W, y: lm.y * H });
            }
            tips = next;

            PADS.forEach(function (pad) {
                var px = pad.x * W, py = pad.y * H, r = pad.radius * minDim;
                var ps = padState[pad.id];
                var reach = ps.inside ? r * EXIT_SCALE : r;
                var inside = false;
                for (var i = 0; i < tips.length; i++) {
                    var dx = tips[i].x - px, dy = tips[i].y - py;
                    if (dx * dx + dy * dy <= reach * reach) { inside = true; break; }
                }

                if (inside) {
                    ps.lostAt = 0;
                    if (!ps.inside) {
                        // leading edge: sound on the frame the fingertip arrives
                        ps.inside = true;
                        ps.enteredAt = now;
                        ps.lastRepeat = now;
                        if (now - ps.lastHit >= RETRIGGER_MS) { ps.lastHit = now; playSound(pad); }
                    } else if (now - ps.enteredAt >= REPEAT_DELAY_MS && now - ps.lastRepeat >= REPEAT_INTERVAL_MS) {
                        ps.lastRepeat = now;
                        ps.lastHit = now;
                        playSound(pad);
                    }
                } else if (ps.inside) {
                    if (tips.length === 0) {
                        // the hand vanished for a frame (tracking blip): hold the state briefly
                        if (!ps.lostAt) ps.lostAt = now;
                        if (now - ps.lostAt > LOST_GRACE_MS) { ps.inside = false; ps.enteredAt = 0; ps.lostAt = 0; }
                    } else {
                        ps.inside = false; ps.enteredAt = 0; ps.lostAt = 0;
                    }
                }
            });

            if (info) {
                if (tips.length > 0) {
                    info.style.display = 'block';
                    info.textContent = tips.length + ' index finger' + (tips.length > 1 ? 's' : '') + ' tracked';
                } else { info.style.display = 'none'; }
            }
        }

        // ---- Drawing: every animation frame, independent of the camera's rate ----
        function draw() {
            requestAnimationFrame(draw);
            var W = canvas.width / dpr, H = canvas.height / dpr, minDim = Math.min(W, H);
            var perf = performance.now();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, W, H);

            // Pads are neo-brutalist keys: a flat disc with a black outline, sitting above
            // a solid black shadow. A hit (or a held finger) presses the disc down INTO
            // its shadow, exactly like the buttons in the rest of the interface.
            PADS.forEach(function (pad) {
                var cx = pad.x * W, cy = pad.y * H, r = pad.radius * minDim;
                var ps = padState[pad.id], held = ps.inside;
                var since = perf - ps.hitAt;
                var hit = since < HIT_MS ? 1 - since / HIT_MS : 0; // 1 at the strike, back to 0
                var down = held ? 1 : (since < 110 ? 1 : 0);       // pressed for 110 ms after a hit
                var lift = PAD_SHADOW * (1 - down);                 // 0 = fully pressed in
                var px = cx - lift, py = cy - lift;                  // the disc sits up-left of its shadow

                // strike ring punching outward
                if (hit > 0) {
                    var ease = 1 - hit * hit * hit;
                    ctx.beginPath(); ctx.arc(cx, cy, r + 6 + ease * 30, 0, Math.PI * 2);
                    ctx.strokeStyle = INK; ctx.lineWidth = 2 + hit * 8; ctx.stroke();
                }

                // shadow, then the disc
                ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.fillStyle = INK; ctx.fill();
                ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
                ctx.fillStyle = down ? INK : pad.color; ctx.fill();
                ctx.lineWidth = 4; ctx.strokeStyle = INK; ctx.stroke();
                if (down) { // pressed: black disc with a ring of its colour
                    ctx.beginPath(); ctx.arc(px, py, r - 9, 0, Math.PI * 2);
                    ctx.lineWidth = 6; ctx.strokeStyle = pad.color; ctx.stroke();
                }

                ctx.fillStyle = down ? pad.color : INK;
                ctx.font = '400 ' + Math.max(15, r * 0.3) + 'px "Archivo Black", "Arial Black", sans-serif';
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(pad.label.toUpperCase(), px, py + 1);

                // hold-to-repeat: a paper arc winding round the pad
                if (held && ps.enteredAt > 0) {
                    var hold = perf - ps.enteredAt;
                    if (hold > 200) {
                        var prog = Math.min(1, (hold - 200) / (REPEAT_DELAY_MS - 200));
                        ctx.beginPath(); ctx.arc(px, py, r + 10, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
                        ctx.strokeStyle = INK; ctx.lineWidth = 9; ctx.stroke();
                        ctx.strokeStyle = PAPER; ctx.lineWidth = 3; ctx.stroke();
                    }
                }
            });

            // Fingertips: paper dots with a fat black outline (readable on any feed)
            for (var i = 0; i < tips.length; i++) {
                ctx.beginPath(); ctx.arc(tips[i].x, tips[i].y, 11, 0, Math.PI * 2);
                ctx.fillStyle = PAPER; ctx.fill();
                ctx.lineWidth = 4; ctx.strokeStyle = INK; ctx.stroke();
            }
        }

        return {
            handleResults: handleResults,
            startDrawing: function () { if (!drawing) { drawing = true; requestAnimationFrame(draw); } }
        };
    }

    var view = null;

    return {
        PADS: PADS,
        init: function (videoId, canvasId, btnId, overlayId, infoId, legendId, statusId) {
            buildLegend(legendId);
            var btn = document.getElementById(btnId);
            if (!btn) return;
            btn.addEventListener('click', async function () {
                btn.disabled = true;
                btn.textContent = 'Loading...';
                setStatus('loading');

                var video = document.getElementById(videoId);
                if (!view) view = createView(canvasId, infoId);

                // sounds, camera and tracking model all start together
                var sounds = loadSounds();
                sounds.catch(function () { });
                try {
                    await window.HarmonicTracker.start(video, view.handleResults);
                } catch (e) {
                    console.error('[CV] camera/tracking failed', e);
                    btn.disabled = false; btn.textContent = 'Camera denied, Retry'; return;
                }
                try { await sounds; } catch (e) {
                    btn.disabled = false; btn.textContent = 'Retry, ' + e.message; return;
                }

                var ov = document.getElementById(overlayId);
                if (ov) ov.style.display = 'none';
                if (statusId) { var s = document.getElementById(statusId); if (s) s.textContent = 'Playing'; }
                setStatus('live'); // rail status dot + label, and fades the camera feed in
                view.startDrawing();
            });
        },
        /** Ring a pad without sound (Band Mode: another drummer hit it; jam-core.js plays the audio). */
        flashPad: function (padId) {
            var id = String(padId || '').toLowerCase();
            if (id === 'tom') id = 'tom1';
            if (padState[id]) padState[id].hitAt = performance.now();
        },
        playRemoteNote: function (padId) {
            var pad = PADS.find(function (p) { return p.id === padId || p.id === (padId || '').toLowerCase(); });
            if (pad) playSound(pad, true); // playSound stamps hitAt, which draws the strike ring
        }
    };
})();
