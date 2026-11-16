/**
 * HarmonicTracker: camera + hand tracking for the three players, tuned for the
 * shortest path from a moving finger to a sound.
 *
 *   await HarmonicTracker.start(videoEl, onResults)
 *
 * onResults({ multiHandLandmarks, multiHandedness, time }) is called once per
 * camera frame, as soon as that frame has been tracked:
 *   multiHandLandmarks  [[{x, y, z} x 21], ...]  x is already mirrored to match the selfie view
 *   multiHandedness     [{ label: 'Left' | 'Right' }, ...]
 *   time                capture time of the frame in ms. Use THIS for velocities, not
 *                       performance.now(): results can arrive unevenly, frames do not.
 *
 * What keeps the lag down:
 *   - Tracking runs in a worker (hand-worker.js) on frames taken straight off the
 *     camera track, so it never waits for the page to paint and never blocks it.
 *     Only the newest frame is kept; a frame that arrives while one is still being
 *     tracked replaces any older one waiting.
 *   - The camera is asked for 60 fps at 640x480. Most webcams only reach 60 fps
 *     at lower resolution, and the tracker downsamples internally anyway.
 *   - Camera and model start in parallel.
 * Browsers without MediaStreamTrackProcessor (Firefox, Safari) fall back to
 * tracking on the page, driven by requestVideoFrameCallback.
 *
 * start() rejects with the getUserMedia error if the camera can't be opened, and
 * can be called again (the "Enable camera" retry).
 */
(function () {
    'use strict';

    var BASE = new URL('.', (document.currentScript && document.currentScript.src) || location.href);
    var VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18';
    var WASM = VISION + '/wasm';
    var MODEL = new URL('hand_landmarker.task', BASE).href;

    // frame rate first: it is the biggest single piece of latency we can influence
    var CAMERA = {
        facingMode: 'user',
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 60 }
    };

    var stats = {
        mode: '',        // 'worker' | 'page'
        delegate: '',    // 'GPU' | 'CPU'
        fps: 0,          // camera frames tracked per second
        detectMs: 0,     // time to track one frame (smoothed)
        width: 0,
        height: 0
    };

    var onResults = null;
    var stream = null;
    var enginePromise = null;   // resolves to 'worker' or 'page' once the model is ready
    var worker = null;
    var pageLandmarker = null;
    var pageLoopVideo = null;
    var frames = 0;
    var statsListeners = [];

    function deliver(hands, labels, time, ms) {
        frames++;
        stats.detectMs = stats.detectMs ? stats.detectMs * 0.85 + ms * 0.15 : ms;
        if (onResults) {
            onResults({
                multiHandLandmarks: hands,
                multiHandedness: labels.map(function (label) { return { label: label }; }),
                time: time
            });
        }
    }

    setInterval(function () {
        stats.fps = frames;
        frames = 0;
        for (var i = 0; i < statsListeners.length; i++) statsListeners[i](stats);
    }, 1000);

    /* ---------------- engine A: worker ---------------- */
    function bootWorker() {
        return new Promise(function (resolve, reject) {
            if (typeof Worker === 'undefined' || typeof MediaStreamTrackProcessor === 'undefined') {
                reject(new Error('no worker pipeline in this browser'));
                return;
            }
            // ?tracker=page forces the on-page fallback (for comparing / diagnosing)
            if (new URLSearchParams(location.search).get('tracker') === 'page') {
                reject(new Error('forced by ?tracker=page'));
                return;
            }
            var w;
            try { w = new Worker(new URL('hand-worker.js', BASE)); } catch (e) { reject(e); return; }
            var timer = setTimeout(function () { reject(new Error('tracking worker timed out')); }, 30000);

            w.onmessage = function (e) {
                var m = e.data;
                if (m.type === 'hands') {
                    // unpack 63 floats per hand, mirroring x to match the selfie view
                    var hands = [];
                    for (var h = 0; h < m.labels.length; h++) {
                        var pts = new Array(21);
                        for (var i = 0; i < 21; i++) {
                            var o = h * 63 + i * 3;
                            pts[i] = { x: 1 - m.data[o], y: m.data[o + 1], z: m.data[o + 2] };
                        }
                        hands.push(pts);
                    }
                    deliver(hands, m.labels, m.t, m.ms);
                } else if (m.type === 'ready') {
                    clearTimeout(timer);
                    worker = w;
                    stats.mode = 'worker';
                    stats.delegate = m.delegate;
                    resolve('worker');
                } else if (m.type === 'error') {
                    clearTimeout(timer);
                    w.terminate();
                    reject(new Error(m.error));
                }
            };
            w.onerror = function (e) {
                clearTimeout(timer);
                reject(new Error(e.message || 'tracking worker failed'));
            };
            w.postMessage({ type: 'init', vision: VISION, wasm: WASM, model: MODEL });
        });
    }

    /* ---------------- engine B: on the page (fallback) ---------------- */
    function bootPage() {
        return import(VISION).then(function (vision) {
            return vision.FilesetResolver.forVisionTasks(WASM).then(function (fileset) {
                var options = function (delegate) {
                    return {
                        baseOptions: { modelAssetPath: MODEL, delegate: delegate },
                        runningMode: 'VIDEO',
                        numHands: 2
                    };
                };
                return vision.HandLandmarker.createFromOptions(fileset, options('GPU'))
                    .then(function (lm) { stats.delegate = 'GPU'; return lm; })
                    .catch(function () {
                        stats.delegate = 'CPU';
                        return vision.HandLandmarker.createFromOptions(fileset, options('CPU'));
                    });
            });
        }).then(function (lm) {
            pageLandmarker = lm;
            stats.mode = 'page';
            return 'page';
        });
    }

    function startPageLoop(video) {
        if (pageLoopVideo === video) return; // already looping on this element
        pageLoopVideo = video;
        var lastTs = 0;
        var lastMediaTime = -1;

        function track(captureTime) {
            if (document.hidden || !pageLandmarker || video.readyState < 2) return;
            var t0 = performance.now();
            var ts = t0 > lastTs ? t0 : lastTs + 1;
            lastTs = ts;
            var res = null;
            try { res = pageLandmarker.detectForVideo(video, ts); } catch (e) { res = null; }
            if (!res) return;
            var hands = (res.landmarks || []).map(function (h) {
                return h.map(function (p) { return { x: 1 - p.x, y: p.y, z: p.z }; });
            });
            var labels = (res.handednesses || []).map(function (h) {
                return (h && h[0] && h[0].categoryName) || 'Right';
            });
            deliver(hands, labels, captureTime || t0, performance.now() - t0);
        }

        if (typeof video.requestVideoFrameCallback === 'function') {
            // fires once per NEW camera frame, as soon as it is ready to show
            var onFrame = function (now, meta) {
                track(meta && meta.captureTime ? meta.captureTime : now);
                video.requestVideoFrameCallback(onFrame);
            };
            video.requestVideoFrameCallback(onFrame);
        } else {
            var poll = function () {
                if (video.currentTime !== lastMediaTime) {
                    lastMediaTime = video.currentTime;
                    track(0);
                }
                requestAnimationFrame(poll);
            };
            requestAnimationFrame(poll);
        }
    }

    function bootEngine() {
        if (!enginePromise) {
            enginePromise = bootWorker().catch(function (err) {
                console.warn('[tracker] worker pipeline unavailable, tracking on the page instead:', err.message);
                return bootPage();
            });
            // a failed boot shouldn't poison later retries
            enginePromise.catch(function () { enginePromise = null; });
        }
        return enginePromise;
    }

    /* ---------------- camera ---------------- */
    function cameraIsLive() {
        return !!stream && stream.getVideoTracks().some(function (t) { return t.readyState === 'live'; });
    }

    /**
     * ?camera=demo: a generated test picture instead of the webcam. Lets the whole
     * player be looked at (and screenshotted) without ever opening a real camera.
     */
    function demoStream() {
        var c = document.createElement('canvas');
        c.width = 640;
        c.height = 480;
        var x = c.getContext('2d');
        var n = 0;
        setInterval(function () {
            n++;
            x.fillStyle = '#8f8f8f';
            x.fillRect(0, 0, 640, 480);
            x.fillStyle = '#b5b5b5';
            x.fillRect(0, 330, 640, 150);
            x.fillStyle = '#d6d6d6';
            x.fillRect(250 + Math.sin(n / 30) * 60, 150, 140, 180);
            x.fillStyle = '#000';
            x.font = '700 20px monospace';
            x.fillText('DEMO PICTURE / NO CAMERA', 20, 40);
        }, 33);
        return c.captureStream(30);
    }

    function openCamera() {
        if (cameraIsLive()) return Promise.resolve(stream);
        var opening = new URLSearchParams(location.search).get('camera') === 'demo'
            ? Promise.resolve(demoStream())
            : navigator.mediaDevices.getUserMedia({ video: CAMERA, audio: false });
        return opening.then(function (s) {
            stream = s;
            var settings = s.getVideoTracks()[0].getSettings();
            stats.width = settings.width || 0;
            stats.height = settings.height || 0;
            return s;
        });
    }

    function feedWorker() {
        // a clone, so the worker's reader and the <video> each own a track
        var track = stream.getVideoTracks()[0].clone();
        var processor = new MediaStreamTrackProcessor({ track: track, maxBufferSize: 1 }); // newest frame only
        worker.postMessage({ type: 'stream', readable: processor.readable }, [processor.readable]);
    }

    document.addEventListener('visibilitychange', function () {
        if (worker) worker.postMessage({ type: 'pause', value: document.hidden });
    });

    /* ---------------- public API ---------------- */
    window.HarmonicTracker = {
        stats: stats,

        /** fn(stats) once a second: { mode, delegate, fps, detectMs, width, height }. */
        onStats: function (fn) { statsListeners.push(fn); },

        start: function (video, handler) {
            onResults = handler;
            var engine = bootEngine();           // model...
            engine.catch(function () { });       // (handled below; avoid an unhandled rejection if the camera fails first)
            var hadCamera = cameraIsLive();
            return openCamera().then(function (s) { // ...and camera, in parallel
                if (video.srcObject !== s) video.srcObject = s;
                return Promise.all([video.play(), engine]);
            }).then(function (r) {
                if (r[1] === 'worker') {
                    if (!hadCamera) feedWorker();
                } else {
                    startPageLoop(video);
                }
            });
        }
    };

    // Start loading the model right away: by the time the camera prompt is answered
    // it is usually ready.
    bootEngine().catch(function () { });
})();
