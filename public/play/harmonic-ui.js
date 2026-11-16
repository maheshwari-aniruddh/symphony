/**
 * Shared UI glue for the three Symphony players (bass / piano / drums).
 * Loaded as a classic script before each page's own code. It owns the things the
 * pages would otherwise each reinvent:
 *
 *   1. Camera status   HarmonicUI.setStatus('loading' | 'live' | 'blocked')
 *                      -> <body data-cam="..."> (CSS shows the loader, fades the
 *                      feed in, colours the status dot) + the rail label.
 *   2. Camera aspect   once the stream reports its real size, the frame adopts that
 *                      aspect ratio (--ar) so the video is never cropped and the
 *                      landmark dots sit exactly on the fingers.
 *   3. Leaving         links marked [data-leave] run the black page wipe before
 *                      navigating, matching the studio's own wipe.
 *   4. Low-latency audio helpers
 *                      HarmonicUI.audioContext()   a context asked for the smallest buffer
 *                      HarmonicUI.onset(buffer)    seconds of dead air at the start of a
 *                                                  sample, to skip when playing it
 *   5. Responsiveness readout
 *                      camera frame rate + tracking time in the rail, and a one-time
 *                      hint when something outside the page is adding lag (a webcam
 *                      slowed by low light, Bluetooth audio).
 *   6. HarmonicUI.toast(message)
 */
(function () {
    'use strict';

    var LABELS = { loading: 'Waking camera', live: 'Camera live', blocked: 'Camera blocked' };

    function setStatus(state) {
        if (!LABELS[state]) return;
        document.body.dataset.cam = state;
        var label = document.querySelector('#camStatus span');
        if (label) label.textContent = LABELS[state];
    }

    /* ---------- toast ---------- */
    function toast(message, ms) {
        var el = document.getElementById('hm-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'hm-toast';
            el.className = 'hm-toast';
            el.setAttribute('role', 'status');
            document.body.appendChild(el);
        }
        el.textContent = message;
        void el.offsetWidth; // so a repeat toast re-runs the transition
        el.classList.add('is-on');
        clearTimeout(el._t);
        el._t = setTimeout(function () { el.classList.remove('is-on'); }, ms || 2600);
    }

    /* ---------- 2. adopt the real camera aspect ratio ---------- */
    document.querySelectorAll('.cam-frame video').forEach(function (video) {
        var adopt = function () {
            if (!video.videoWidth || !video.videoHeight) return;
            var frame = video.closest('.cam-frame');
            if (frame) frame.style.setProperty('--ar', (video.videoWidth / video.videoHeight).toFixed(4));
        };
        video.addEventListener('loadedmetadata', adopt);
        video.addEventListener('resize', adopt);
    });

    /* ---------- 3. curtain down, then go ---------- */
    document.addEventListener('click', function (e) {
        var link = e.target.closest && e.target.closest('a[data-leave]');
        if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        document.documentElement.classList.add('is-leaving');
        setTimeout(function () { window.location.href = link.href; }, 240);
    });
    // if the browser restores this page from the back/forward cache, lift the curtain again
    window.addEventListener('pageshow', function (e) {
        if (e.persisted) document.documentElement.classList.remove('is-leaving');
    });

    /* ---------- 4. low-latency audio helpers ---------- */
    var contexts = [];

    /** An AudioContext asked for the smallest output buffer the device allows. */
    function audioContext() {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        var ctx;
        try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
        contexts.push(ctx);
        return ctx;
    }

    /**
     * Seconds of near-silence at the start of a decoded sample. Recordings often
     * begin with a few (sometimes tens of) milliseconds of dead air; played from 0,
     * that is heard as lag on every note. Callers start playback from this offset:
     *     source.start(when, HarmonicUI.onset(buffer))
     */
    function onset(buffer) {
        if (!buffer || !buffer.length) return 0;
        if (typeof buffer._onset === 'number') return buffer._onset; // measured once per buffer
        var peak = 0, c, i, data;
        for (c = 0; c < buffer.numberOfChannels; c++) {
            data = buffer.getChannelData(c);
            for (i = 0; i < data.length; i += 4) {
                var v = data[i] < 0 ? -data[i] : data[i];
                if (v > peak) peak = v;
            }
        }
        var first = buffer.length;
        if (peak > 0) {
            var threshold = peak * 0.02;
            for (c = 0; c < buffer.numberOfChannels; c++) {
                data = buffer.getChannelData(c);
                for (i = 0; i < first; i++) {
                    if (data[i] > threshold || data[i] < -threshold) { first = i; break; }
                }
            }
        }
        if (first >= buffer.length) first = 0;
        // keep 1 ms of lead-in so the attack isn't clipped into a click
        var seconds = Math.max(0, first / buffer.sampleRate - 0.001);
        buffer._onset = seconds;
        return seconds;
    }

    /* ---------- 5. responsiveness readout ---------- */
    var chip = null;
    var hinted = {};
    var slowSeconds = 0;

    function hintOnce(key, message) {
        if (hinted[key]) return;
        hinted[key] = true;
        toast(message, 7000);
    }

    function onTrackerStats(s) {
        if (document.body.dataset.cam !== 'live' || document.hidden) return;
        if (!chip) {
            var meta = document.querySelector('.rail__meta');
            if (!meta) return;
            chip = document.createElement('span');
            chip.className = 'perf';
            meta.appendChild(chip);
        }
        chip.textContent = s.fps + ' fps · ' + Math.round(s.detectMs) + ' ms';
        chip.title = 'Camera frames tracked per second · time to track each frame' +
            ' (' + s.width + '×' + s.height + ', ' + s.delegate + ', ' + s.mode + ')';
        var slow = s.fps > 0 && s.fps < 24;
        chip.classList.toggle('is-slow', slow);

        // A webcam in a dim room lengthens its exposure and drops to 10-20 frames a
        // second. Nothing in the page can undo that, so say so (once).
        slowSeconds = slow ? slowSeconds + 1 : 0;
        if (slowSeconds >= 4) {
            hintOnce('light', 'Your camera is only sending ' + s.fps + ' frames a second. More light on your hands makes it faster');
        }

        // Bluetooth speakers / headphones buffer 150-250 ms of audio.
        for (var i = 0; i < contexts.length; i++) {
            var out = contexts[i].outputLatency || 0;
            if (contexts[i].state === 'running' && out > 0.09) {
                hintOnce('audio', 'Your speakers add about ' + Math.round(out * 1000) + ' ms of delay (Bluetooth?). Wired or built-in audio is much snappier');
            }
        }
    }
    if (window.HarmonicTracker) window.HarmonicTracker.onStats(onTrackerStats);

    window.HarmonicUI = {
        setStatus: setStatus,
        toast: toast,
        audioContext: audioContext,
        onset: onset
    };
})();
