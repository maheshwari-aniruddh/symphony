/**
 * Hand-tracking worker (classic worker; started by hand-tracker.js).
 *
 * Runs the MediaPipe HandLandmarker OFF the main thread, on camera frames that
 * arrive straight from the camera track (a ReadableStream of VideoFrames from
 * MediaStreamTrackProcessor). That removes the two delays the old in-page loop
 * had: frames no longer wait for the page's next animation frame, and a busy
 * page (drawing, layout, audio) can no longer hold tracking up, or vice versa.
 *
 * Messages in:
 *   { type: 'init', vision, wasm, model }     load the model (GPU, falling back to CPU)
 *   { type: 'stream', readable }              start reading frames (replaces any earlier stream)
 *   { type: 'pause', value }                  skip detection while the page is hidden
 * Messages out:
 *   { type: 'ready', delegate }
 *   { type: 'error', error }
 *   { type: 'hands', data, labels, t, ms }    per camera frame:
 *        data    Float32Array, 63 numbers per hand (21 landmarks x [x, y, z], image space)
 *        labels  ['Left' | 'Right', ...]      MediaPipe's handedness, one per hand
 *        t       capture time of the frame in ms (for velocity maths)
 *        ms      how long detection took
 */
'use strict';

var landmarker = null;
var reader = null;
var generation = 0;
var paused = false;
var lastTs = 0;

self.onmessage = function (e) {
    var m = e.data || {};
    if (m.type === 'init') init(m);
    else if (m.type === 'stream') pump(m.readable);
    else if (m.type === 'pause') paused = !!m.value;
};

async function init(m) {
    try {
        // dynamic import: static `import` isn't available in a classic worker, and
        // MediaPipe's wasm loader needs importScripts(), which module workers lack
        var vision = await import(m.vision);
        var fileset = await vision.FilesetResolver.forVisionTasks(m.wasm);
        var options = function (delegate) {
            return {
                baseOptions: { modelAssetPath: m.model, delegate: delegate },
                runningMode: 'VIDEO',
                numHands: 2
            };
        };
        var delegate = 'GPU';
        try {
            landmarker = await vision.HandLandmarker.createFromOptions(fileset, options('GPU'));
        } catch (gpuError) { // some machines have no usable GPU delegate
            delegate = 'CPU';
            landmarker = await vision.HandLandmarker.createFromOptions(fileset, options('CPU'));
        }
        self.postMessage({ type: 'ready', delegate: delegate });
    } catch (err) {
        self.postMessage({ type: 'error', error: String((err && err.message) || err) });
    }
}

async function pump(readable) {
    var mine = ++generation;
    if (reader) { try { reader.cancel(); } catch (e) { /* already closed */ } }
    reader = readable.getReader();

    for (;;) {
        var result;
        try { result = await reader.read(); } catch (e) { break; }
        if (result.done) break;
        var frame = result.value;
        if (mine !== generation) { frame.close(); break; } // a newer stream took over

        if (paused || !landmarker) { frame.close(); continue; }

        var t0 = performance.now();
        // detectForVideo needs a strictly increasing timestamp
        var ts = t0 > lastTs ? t0 : lastTs + 1;
        lastTs = ts;
        // the frame's own timestamp (microseconds) is the honest clock for velocities
        var captured = typeof frame.timestamp === 'number' ? frame.timestamp / 1000 : t0;

        var res = null;
        try { res = landmarker.detectForVideo(frame, ts); } catch (e) { res = null; }
        frame.close(); // frames hold camera memory: always release them

        var hands = (res && res.landmarks) || [];
        var data = new Float32Array(hands.length * 63);
        var labels = [];
        for (var h = 0; h < hands.length; h++) {
            var lm = hands[h];
            for (var i = 0; i < 21; i++) {
                var o = h * 63 + i * 3;
                data[o] = lm[i].x;
                data[o + 1] = lm[i].y;
                data[o + 2] = lm[i].z;
            }
            var hd = res.handednesses && res.handednesses[h];
            labels.push((hd && hd[0] && hd[0].categoryName) || 'Right');
        }
        self.postMessage(
            { type: 'hands', data: data, labels: labels, t: captured, ms: performance.now() - t0 },
            [data.buffer]
        );
    }
}
