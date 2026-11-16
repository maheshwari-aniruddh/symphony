/**
 * Symphony Band Mode, the players' side.
 *
 * Loaded by bass.html, piano-player.html and drums-player.html. When the page URL
 * carries ?jamRoom=CODE this file, on its own:
 *
 *   1. joins that room: on the jam server (session_server.py) over a WebSocket when
 *      one is running, or straight from browser to browser when there is none
 *      (a static host such as Vercel),
 *   2. shows who else is in the band in the page rail (and an invite button),
 *   3. plays every OTHER player's notes through a small built-in sampler, so any
 *      instrument page can voice piano, bass and drums without owning their code,
 *   4. exposes `window.jamSessionManager.sendNote(note, velocity)`, which the page's
 *      own instrument code already calls whenever the local player makes a sound.
 *
 * Without ?jamRoom it does nothing, and the page is the normal solo player.
 *
 * The server is reached same-origin at /jam (the Vite dev/preview proxy), falling
 * back to :8502 on the same host for setups without the proxy.
 */
(function () {
    'use strict';

    var INSTRUMENTS = {
        piano: { label: 'Piano', color: '#ffdf6b' },
        bass: { label: 'Bass', color: '#ff8fa9' },
        drums: { label: 'Drums', color: '#74a9ff' }
    };
    // everything this file fetches lives next to it in /play/
    var BASE = new URL('.', (document.currentScript && document.currentScript.src) || location.href);

    /** Where the jam server might be, best candidate first. */
    function endpoints() {
        var secure = location.protocol === 'https:';
        var list = [{
            http: location.origin + '/jam',
            ws: (secure ? 'wss://' : 'ws://') + location.host + '/jam'
        }];
        // direct port: only possible from an http page (a browser blocks ws:// from https)
        if (!secure) {
            var host = location.hostname || 'localhost';
            list.push({ http: 'http://' + host + ':8502', ws: 'ws://' + host + ':8502' });
        }
        return list;
    }

    function cleanRoom(code) {
        return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    }

    /* ------------------------------------------------------------------
       Connection
       ------------------------------------------------------------------ */
    function JamSessionManager() {
        this.ws = null;
        this.roomId = null;
        this.playerId = null;
        this.instrument = 'piano';
        this.connected = false;
        this.state = 'idle';       // idle | connecting | live | offline | full
        this.players = [];         // everyone ELSE in the room: [{ player_id, instrument }]
        this.onRemoteNote = null;  // ({ note, velocity, instrument, player_id })
        this.onRoster = null;      // (players)
        this.onState = null;       // (state)
        this.onPlayerJoined = null;
        this.onPlayerLeft = null;
        this._endpoints = endpoints();
        this._ep = 0;
        this._attempts = 0;
        this._everOpened = false;
        this._closedByUs = false;
    }

    JamSessionManager.prototype.connect = function (roomId, playerId, instrument) {
        this.roomId = cleanRoom(roomId);
        this.playerId = playerId;
        this.instrument = INSTRUMENTS[instrument] ? instrument : 'piano';
        this._closedByUs = false;
        this._attempts = 0;
        this._open();
    };

    JamSessionManager.prototype._setState = function (state) {
        if (this.state === state) return;
        this.state = state;
        this.connected = state === 'live';
        if (this.onState) this.onState(state);
    };

    JamSessionManager.prototype._open = function () {
        if (!this.roomId || !this.playerId) return;
        var self = this;
        var ep = this._endpoints[this._ep];
        var url = ep.ws + '/ws/' + encodeURIComponent(this.roomId) + '/' + encodeURIComponent(this.playerId);
        var opened = false;
        if (this.state !== 'offline') this._setState('connecting');

        var ws;
        try { ws = new WebSocket(url); } catch (e) { this._retry(false); return; }
        this.ws = ws;

        ws.onopen = function () {
            opened = true;
            self._everOpened = true;
            self._attempts = 0;
            self._setState('live');
            ws.send(JSON.stringify({ type: 'join', instrument: self.instrument }));
        };

        ws.onmessage = function (event) {
            var data;
            try { data = JSON.parse(event.data); } catch (e) { return; }
            if (!data || typeof data !== 'object') return;

            if (data.type === 'note') {
                if (data.player_id !== self.playerId && self.onRemoteNote) self.onRemoteNote(data);
            } else if (data.type === 'roster') {
                self.players = (data.players || []).filter(function (p) { return p.player_id !== self.playerId; });
                if (self.onRoster) self.onRoster(self.players);
            } else if (data.type === 'player_joined') {
                if (data.player_id !== self.playerId && self.onPlayerJoined) self.onPlayerJoined(data);
            } else if (data.type === 'player_left') {
                if (data.player_id !== self.playerId && self.onPlayerLeft) self.onPlayerLeft(data);
            } else if (data.type === 'room_full') {
                self._closedByUs = true; // don't hammer a full room
                self._setState('full');
            }
        };

        ws.onclose = function () {
            if (self.ws === ws) self.ws = null;
            if (self._closedByUs) return;
            self.players = [];
            if (self.onRoster) self.onRoster(self.players);
            self._retry(opened);
        };
        ws.onerror = function () { /* onclose follows and handles it */ };
    };

    JamSessionManager.prototype._retry = function (wasOpen) {
        var self = this;
        // Never got through on this address and haven't anywhere yet: try the next address at once.
        if (!wasOpen && !this._everOpened && this._ep < this._endpoints.length - 1) {
            this._ep++;
            this._open();
            return;
        }
        this._setState('offline');
        this._attempts++;
        if (!this._everOpened && this._attempts > 3) { this._ep = 0; } // start over from the first address
        var wait = Math.min(1000 * Math.pow(1.6, this._attempts - 1), 8000); // 1s, 1.6s, 2.6s ... 8s
        clearTimeout(this._timer);
        this._timer = setTimeout(function () { if (!self._closedByUs) self._open(); }, wait);
    };

    JamSessionManager.prototype.sendNote = function (note, velocity) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({
            type: 'note',
            instrument: this.instrument,
            note: String(note),
            velocity: typeof velocity === 'number' ? velocity : 0.8
        }));
        if (window.HarmonicJam) window.HarmonicJam.stats.sent++;
    };

    JamSessionManager.prototype.disconnect = function () {
        this._closedByUs = true;
        clearTimeout(this._timer);
        if (this.ws) { try { this.ws.close(); } catch (e) { /* already closed */ } this.ws = null; }
        this._setState('idle');
    };

    window.JamSessionManager = JamSessionManager;

    /* ------------------------------------------------------------------
       Connection without a server: players link up browser to browser.

       A static host (the Vercel copy of the site) has no jam server behind it.
       There the players in a room find each other through public relays and
       then talk directly over WebRTC (vendor/trystero.js). Notes never pass
       through a server at all. Same interface as JamSessionManager above, so
       the rest of this file does not care which one it is holding.
       ------------------------------------------------------------------ */
    var APP_ID = 'github.com/lalubalu/airjam11'; // keeps our rooms apart from other apps on the same relays
    var MAX_PLAYERS = 8;                         // same cap as the server's rooms

    function P2PJamManager() {
        this.room = null;
        this.roomId = null;
        this.playerId = null;
        this.instrument = 'piano';
        this.connected = false;
        this.state = 'idle';
        this.players = [];
        this.onRemoteNote = null;
        this.onRoster = null;
        this.onState = null;
        this.onPlayerJoined = null;
        this.onPlayerLeft = null;
        this.onRoom = null;    // (room) once the direct link exists
        this._peers = {};      // peerId -> { player_id, instrument }
        this._note = null;
        this._liveAt = 0;
        this._closedByUs = false;
    }

    P2PJamManager.prototype._setState = JamSessionManager.prototype._setState;

    P2PJamManager.prototype._roster = function () {
        var peers = this._peers;
        this.players = Object.keys(peers).map(function (id) { return peers[id]; });
        if (this.onRoster) this.onRoster(this.players);
    };

    P2PJamManager.prototype.connect = function (roomId, playerId, instrument) {
        var self = this;
        this.roomId = cleanRoom(roomId);
        this.playerId = playerId;
        this.instrument = INSTRUMENTS[instrument] ? instrument : 'piano';
        this._closedByUs = false;
        this._setState('connecting');

        // if the relays can't be reached, say so instead of "Joining" forever
        clearTimeout(this._slow);
        this._slow = setTimeout(function () { if (self.state === 'connecting') self._setState('offline'); }, 15000);

        import(new URL('vendor/trystero.js', BASE).href).then(function (lib) {
            if (self._closedByUs) return;
            // identity 'none': every page load is its own player (two tabs = two players)
            var room = self.room = lib.joinRoom({ appId: APP_ID, identity: 'none', maxUsers: MAX_PLAYERS }, 'band-' + self.roomId);
            var hello = room.makeAction('hello');
            var note = room.makeAction('note');
            var quiet = function () { /* a peer that just left: nothing to do */ };
            var me = function () { return { player_id: self.playerId, instrument: self.instrument }; };

            // introduce ourselves to everyone we meet; they do the same
            room.onPeerJoin(function (peer) { hello.send(me(), { target: peer.peerId }).catch(quiet); });

            hello.onMessage(function (data, ctx) {
                if (!data || typeof data !== 'object') return;
                var isNew = !self._peers[ctx.peerId];
                var player = self._peers[ctx.peerId] = {
                    player_id: String(data.player_id || ctx.peerId).slice(0, 48),
                    instrument: INSTRUMENTS[data.instrument] ? data.instrument : 'piano'
                };
                self._roster();
                // announce people who arrive AFTER us, not everyone already here when we walked in
                if (isNew && self.onPlayerJoined && self._liveAt && Date.now() - self._liveAt > 6000) self.onPlayerJoined(player);
            });

            room.onPeerLeave(function (peer) {
                var player = self._peers[peer.peerId];
                if (!player) return;
                delete self._peers[peer.peerId];
                self._roster();
                if (self.onPlayerLeft) self.onPlayerLeft(player);
            });

            note.onMessage(function (data, ctx) {
                if (!data || typeof data !== 'object' || !self.onRemoteNote) return;
                var player = self._peers[ctx.peerId];
                self.onRemoteNote({
                    type: 'note',
                    player_id: player ? player.player_id : ctx.peerId,
                    // the note carries its instrument, so it still sounds right if it beats the hello here
                    instrument: INSTRUMENTS[data.i] ? data.i : (player ? player.instrument : 'piano'),
                    note: String(data.n),
                    velocity: typeof data.v === 'number' ? data.v : 0.8
                });
            });

            room.onError(function (err) {
                if (err && err.code === 'room-full' && !Object.keys(self._peers).length) {
                    self._setState('full');
                    self.disconnect(true);
                }
            });

            self._note = note;
            if (self.onRoom) self.onRoom(room); // the bandmates' cameras ride on the same link
            var live = function () {
                if (self._closedByUs) return;
                self._liveAt = Date.now();
                self._setState('live');
            };
            // "ready" = our identity and the relays are set up; from here others can find us
            Promise.resolve(room.ready).then(live, function (e) {
                console.warn('[Jam] could not reach the relays', e);
                self._setState('offline');
            });
        }).catch(function (e) {
            console.warn('[Jam] direct connection unavailable', e);
            self._setState('offline');
        });
    };

    P2PJamManager.prototype.sendNote = function (note, velocity) {
        if (!this.connected || !this._note) return;
        this._note.send({ n: String(note), v: typeof velocity === 'number' ? velocity : 0.8, i: this.instrument })
            .catch(function () { /* nobody listening right now */ });
        if (window.HarmonicJam) window.HarmonicJam.stats.sent++;
    };

    P2PJamManager.prototype.disconnect = function (keepState) {
        this._closedByUs = true;
        clearTimeout(this._slow);
        this._note = null;
        if (this.room) { try { this.room.leave().catch(function () { }); } catch (e) { /* already gone */ } this.room = null; }
        if (!keepState) this._setState('idle');
    };

    window.P2PJamManager = P2PJamManager;

    /**
     * Is there a jam server here? Yes on a machine running the Python stack; no on
     * a static host, where players connect to each other directly instead.
     * (localStorage 'harmonic.jam.via' = 'p2p' forces the direct route, for testing.)
     */
    function serverAvailable() {
        var forced = null;
        try { forced = localStorage.getItem('harmonic.jam.via'); } catch (e) { /* storage blocked */ }
        if (forced === 'p2p') return Promise.resolve(false);
        var list = endpoints();
        var probe = function (i) {
            if (i >= list.length) return Promise.resolve(false);
            return fetch(list[i].http + '/health', { signal: AbortSignal.timeout(1500) })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (body) { return body && body.ok === true ? true : probe(i + 1); })
                .catch(function () { return probe(i + 1); });
        };
        return probe(0);
    }

    /* ------------------------------------------------------------------
       Remote voices: a tiny sampler for the OTHER players' notes.
       Separate from each page's own instrument engine on purpose, so the
       local instrument's timing and sound are untouched by Band Mode.
       ------------------------------------------------------------------ */
    var PIANO_FILES = {
        'C': 'sounds/c1.wav', 'C#': 'sounds/c1s.wav', 'D': 'sounds/d1.wav', 'D#': 'sounds/d1s.wav',
        'E': 'sounds/e1.wav', 'F': 'sounds/f1.wav', 'F#': 'sounds/f1s.wav', 'G': 'sounds/g1.wav',
        'G#': 'sounds/g1s.wav', 'A': 'sounds/a1.wav', 'A#': 'sounds/a1s.wav', 'B': 'sounds/b1.wav'
    };
    var BASS_FILES = {
        'E2': 'Bass sounds/e2-bass.wav', 'A2': 'Bass sounds/a2-bass.wav',
        'D2': 'Bass sounds/d-bass.wav', 'G2': 'Bass sounds/g-bass.wav'
    };
    var DRUM_FILES = {
        'kick': 'drum_sounds/kick-01.wav', 'hihat': 'drum_sounds/hihat-open.wav',
        'tom1': 'drum_sounds/tom-01.wav', 'tom': 'drum_sounds/tom-01.wav', 'snare': 'drum_sounds/snare-03.wav'
    };
    var BANKS = { piano: PIANO_FILES, bass: BASS_FILES, drums: DRUM_FILES };

    var voices = {
        ctx: null,
        out: null,
        buffers: { piano: {}, bass: {}, drums: {} },
        loading: {},

        context: function () {
            if (!this.ctx) {
                var AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return null;
                this.ctx = new AC();
                this.out = this.ctx.createGain();
                this.out.gain.value = 0.8; // sit just under the local instrument
                this.out.connect(this.ctx.destination);
            }
            return this.ctx;
        },

        /** Browsers only start audio after a gesture on the page; keep trying until it runs. */
        unlock: function () {
            var ctx = this.context();
            if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () { });
            return !!ctx && ctx.state === 'running';
        },

        /** Fetch + decode one instrument's samples (once; callers share the promise). */
        load: function (instrument) {
            var self = this;
            if (!BANKS[instrument]) return Promise.resolve();
            if (this.loading[instrument]) return this.loading[instrument];
            var ctx = this.context();
            if (!ctx) return Promise.resolve();
            var seen = {};
            var jobs = Object.keys(BANKS[instrument]).map(function (key) {
                var file = BANKS[instrument][key];
                if (!seen[file]) {
                    seen[file] = fetch(new URL(file, BASE))
                        .then(function (r) { if (!r.ok) throw new Error(file + ' HTTP ' + r.status); return r.arrayBuffer(); })
                        .then(function (a) { return ctx.decodeAudioData(a); });
                }
                return seen[file]
                    .then(function (buf) { self.buffers[instrument][key] = buf; })
                    .catch(function (e) { console.warn('[Jam] sample failed', file, e); });
            });
            this.loading[instrument] = Promise.all(jobs);
            return this.loading[instrument];
        },

        play: function (instrument, note, velocity) {
            var self = this;
            var ctx = this.context();
            if (!ctx || !BANKS[instrument]) return;
            this.unlock();
            this.load(instrument).then(function () {
                var buf = null, rate = 1;
                if (instrument === 'piano') {
                    // "C#5" -> the C# sample (recorded at octave 4), shifted by octaves
                    var m = String(note).toUpperCase().match(/^([A-G]#?)(\d+)?$/);
                    if (!m) return;
                    buf = self.buffers.piano[m[1]];
                    rate = Math.pow(2, (m[2] ? parseInt(m[2], 10) : 4) - 4);
                } else if (instrument === 'bass') {
                    buf = self.buffers.bass[String(note).toUpperCase()];
                } else {
                    buf = self.buffers.drums[String(note).toLowerCase()];
                }
                if (!buf) return;

                var t = ctx.currentTime;
                var src = ctx.createBufferSource();
                src.buffer = buf;
                src.playbackRate.value = rate;
                var gain = ctx.createGain();
                var peak = Math.max(0.15, Math.min(1, velocity || 0.8));
                if (instrument === 'drums') {
                    gain.gain.value = peak; // percussion keeps its own envelope
                } else {
                    gain.gain.setValueAtTime(0.0001, t);
                    gain.gain.exponentialRampToValueAtTime(peak, t + 0.012);
                    gain.gain.exponentialRampToValueAtTime(0.0001, t + (instrument === 'bass' ? 1.8 : 1.4));
                }
                src.connect(gain);
                gain.connect(self.out);
                // skip dead air at the start of the recording, like the local instruments do
                src.start(t, window.HarmonicUI && window.HarmonicUI.onset ? window.HarmonicUI.onset(buf) : 0);
                jam.stats.played++;
            });
        }
    };

    /* ------------------------------------------------------------------
       Small notifications (also used for join / leave)
       ------------------------------------------------------------------ */
    function toast(message) {
        if (window.HarmonicUI) window.HarmonicUI.toast(message); // styled in harmonic.css (.hm-toast)
    }
    JamSessionManager.prototype.showToast = toast; // kept for older callers

    /* ------------------------------------------------------------------
       Band Mode on this page
       ------------------------------------------------------------------ */
    var jam = window.HarmonicJam = {
        room: null,
        instrument: null,
        manager: null,
        voices: voices,
        stats: { sent: 0, received: 0, played: 0 },
        inviteUrl: function () { return location.origin + '/?jam=' + encodeURIComponent(jam.room); }
    };

    var room = cleanRoom(new URLSearchParams(location.search).get('jamRoom'));
    var instrument = Object.keys(INSTRUMENTS).filter(function (i) {
        return document.body.classList.contains('hm--' + i);
    })[0];
    if (!room || !instrument) return; // solo: nothing else to do

    jam.room = room;
    jam.instrument = instrument;
    document.body.classList.add('is-jamming');

    // "Studio" keeps you in the same jam, so you can swap instruments mid-session.
    Array.prototype.forEach.call(document.querySelectorAll('a[data-leave]'), function (a) {
        a.href = '/?studio=1&jam=' + encodeURIComponent(room);
    });

    // ---- the jam bar in the rail ----
    var bar = document.createElement('div');
    bar.className = 'jam';
    bar.dataset.state = 'connecting';
    bar.innerHTML =
        '<span class="jam__dot" aria-hidden="true"></span>' +
        '<span class="jam__code"><span class="jam__k">Jam</span><span class="jam__room"></span></span>' +
        '<span class="jam__roster" aria-live="polite"></span>' +
        '<button type="button" class="jam__copy">Copy invite</button>';
    bar.querySelector('.jam__room').textContent = room;
    var rosterEl = bar.querySelector('.jam__roster');
    var copyBtn = bar.querySelector('.jam__copy');
    var meta = document.querySelector('.rail__meta');
    if (meta) meta.insertBefore(bar, meta.firstChild);

    var STATE_TEXT = { idle: 'Joining', connecting: 'Joining', offline: 'Reconnecting', full: 'Room is full' };

    function renderRoster(players) {
        rosterEl.textContent = '';
        var state = bar.dataset.state;
        if (state !== 'live') {
            var s = document.createElement('span');
            s.className = 'jam__alone';
            s.textContent = STATE_TEXT[state] || '';
            rosterEl.appendChild(s);
            return;
        }
        if (!players.length) {
            var alone = document.createElement('span');
            alone.className = 'jam__alone';
            alone.textContent = 'Just you so far';
            rosterEl.appendChild(alone);
            return;
        }
        players.forEach(function (p) {
            var info = INSTRUMENTS[p.instrument] || { label: 'Joining', color: '#fbf6ea' };
            var chip = document.createElement('span');
            chip.className = 'jam__player';
            chip.dataset.id = p.player_id;
            chip.style.setProperty('--c', info.color);
            chip.textContent = info.label;
            rosterEl.appendChild(chip);
            if (INSTRUMENTS[p.instrument]) voices.load(p.instrument); // warm their samples before they play
        });
    }

    function flashPlayer(playerId) {
        var id = String(playerId).replace(/"/g, '');
        // their chip in the bar, and their camera box if they are sharing one
        var marks = document.querySelectorAll('.jam__player[data-id="' + id + '"], .bandcam[data-id="' + id + '"]');
        Array.prototype.forEach.call(marks, function (el) {
            el.classList.add('is-playing');
            clearTimeout(el._t);
            el._t = setTimeout(function () { el.classList.remove('is-playing'); }, 160);
        });
    }

    /* ------------------------------------------------------------------
       Bandmates' cameras: a small box per player, stacked on the left, each
       tagged with the instrument they are on.

       The picture goes straight from browser to browser over `link` (a direct
       room, see P2PJamManager). What we send is a clone of the camera track the
       hand tracker is already using, squeezed small on the way out, so sharing
       it never costs the instrument its frame rate. "Cam on" in the jam bar
       turns it off.
       ------------------------------------------------------------------ */
    function startCams(link, playerId) {
        var say = link.makeAction('cam');   // "this is me, on this instrument, camera on/off"
        var quiet = function () { };
        var sharing = true;
        var out = null;                     // the stream we send, once the camera is running
        var tiles = {};                     // peerId -> { info, stream, el }
        var source = document.querySelector('#playerVideo, #cam-video, #bassVideo');

        var box = document.createElement('div');
        box.className = 'band-cams';
        box.setAttribute('aria-label', 'Your bandmates');
        document.body.appendChild(box);

        var camBtn = document.createElement('button');
        camBtn.type = 'button';
        camBtn.className = 'jam__copy jam__cam';
        camBtn.title = 'Show or hide your camera to the band';
        bar.appendChild(camBtn);
        function paintBtn() {
            camBtn.textContent = sharing ? 'Cam on' : 'Cam off';
            camBtn.setAttribute('aria-pressed', String(sharing));
        }
        paintBtn();

        function me() { return { player_id: playerId, instrument: instrument, on: sharing && !!out }; }
        function announce(target) { say.send(me(), target ? { target: target } : {}).catch(quiet); }

        /** Draw (or remove) one bandmate's box from what we currently know about them. */
        function render(peerId) {
            var t = tiles[peerId];
            if (!t) return;
            var show = !!t.stream && !(t.info && t.info.on === false);
            if (!show) {
                if (t.el) { t.el.remove(); t.el = null; }
                return;
            }
            if (!t.el) {
                t.el = document.createElement('figure');
                t.el.className = 'bandcam';
                var v = document.createElement('video');
                v.autoplay = true; v.muted = true; v.playsInline = true;
                t.el.appendChild(v);
                t.el.appendChild(document.createElement('figcaption'));
                box.appendChild(t.el);
            }
            var video = t.el.firstChild;
            if (video.srcObject !== t.stream) {
                video.srcObject = t.stream;
                video.play().catch(quiet);
            }
            var kind = INSTRUMENTS[t.info && t.info.instrument];
            t.el.dataset.id = (t.info && t.info.player_id) || peerId;
            t.el.style.setProperty('--c', kind ? kind.color : '#fbf6ea');
            t.el.lastChild.textContent = kind ? kind.label : 'Bandmate';
        }

        say.onMessage(function (data, ctx) {
            if (!data || typeof data !== 'object') return;
            var t = tiles[ctx.peerId] || (tiles[ctx.peerId] = {});
            t.info = { player_id: String(data.player_id || '').slice(0, 48), instrument: data.instrument, on: data.on !== false };
            if (!t.info.on) t.stream = null; // they turned their camera off
            render(ctx.peerId);
        });

        link.onPeerStream(function (stream, ctx) {
            var t = tiles[ctx.peerId] || (tiles[ctx.peerId] = {});
            t.stream = stream;
            render(ctx.peerId);
        });

        link.onPeerJoin(function (peer) {
            announce(peer.peerId);
            if (out && sharing) send(peer.peerId);
        });

        link.onPeerLeave(function (peer) {
            var t = tiles[peer.peerId];
            if (t && t.el) t.el.remove();
            delete tiles[peer.peerId];
        });

        /** Keep the outgoing picture small and slow: a thumbnail, not a video call. */
        function squeeze() {
            var peers = link.getPeers();
            Object.keys(peers).forEach(function (id) {
                var pc = peers[id].connection;
                if (!pc || !pc.getSenders) return;
                pc.getSenders().forEach(function (sender) {
                    if (!sender.track || sender.track.kind !== 'video') return;
                    try {
                        var p = sender.getParameters();
                        if (!p.encodings || !p.encodings.length) return; // not negotiated yet; a later pass gets it
                        p.encodings[0].maxBitrate = 180000;
                        p.encodings[0].maxFramerate = 15;
                        p.encodings[0].scaleResolutionDownBy = 2;
                        sender.setParameters(p).catch(quiet);
                    } catch (e) { /* this browser can't tune the sender: it still works, just bigger */ }
                });
            });
        }

        function send(target) {
            if (!out) return;
            link.addStream(out, target ? { target: target } : {}).then(function () {
                squeeze();
                setTimeout(squeeze, 1500);
                setTimeout(squeeze, 5000);
            }).catch(quiet);
        }

        /** Wait for the page's camera to be running, then share a clone of its track. */
        var waiting = null;
        function begin() {
            clearInterval(waiting);
            waiting = setInterval(function () {
                if (!sharing) { clearInterval(waiting); return; }
                var stream = source && source.srcObject;
                var track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
                if (!track || track.readyState !== 'live') return;
                clearInterval(waiting);
                var clone = track.clone();
                clone.addEventListener('ended', function () { // the page restarted its camera
                    if (!out || out.getVideoTracks()[0] !== clone) return;
                    out = null;
                    if (sharing) begin();
                });
                out = new MediaStream([clone]);
                send();
                announce();
                try {
                    if (!sessionStorage.getItem('harmonic.jam.camnote')) {
                        sessionStorage.setItem('harmonic.jam.camnote', '1');
                        toast('The band can see your camera. "Cam on" in the jam bar turns it off.');
                    }
                } catch (e) { /* storage blocked: skip the note */ }
            }, 600);
        }

        camBtn.addEventListener('click', function () {
            sharing = !sharing;
            paintBtn();
            if (sharing) { begin(); return; }
            clearInterval(waiting);
            if (out) {
                try { link.removeStream(out); } catch (e) { /* nobody had it */ }
                out.getTracks().forEach(function (t) { t.stop(); }); // the clone only; tracking keeps its own
                out = null;
            }
            announce();
        });

        begin();
    }

    copyBtn.addEventListener('click', function () {
        var url = jam.inviteUrl();
        var done = function (ok) {
            copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
            clearTimeout(copyBtn._t);
            copyBtn._t = setTimeout(function () { copyBtn.textContent = 'Copy invite'; }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
        } else {
            done(false);
        }
    });

    renderRoster([]);

    // ---- connect: through the jam server when there is one, directly otherwise ----
    serverAvailable().then(function (hasServer) {
    jam.transport = hasServer ? 'server' : 'direct';
    var manager = jam.manager = window.jamSessionManager = hasServer ? new JamSessionManager() : new P2PJamManager();

    // Swapping instruments mid-jam means this tab's previous page is still hanging
    // up while this one connects. Remember that old id so we don't list (or announce
    // the departure of) our own earlier self.
    var PID_KEY = 'harmonic.jam.pid';
    var previousId = null;
    try { previousId = sessionStorage.getItem(PID_KEY); } catch (e) { /* storage blocked */ }
    var playerId = instrument + '_' + Math.random().toString(36).slice(2, 8);
    try { sessionStorage.setItem(PID_KEY, playerId); } catch (e) { /* storage blocked */ }
    var notMe = function (p) { return p.player_id !== previousId; };

    manager.onState = function (state) {
        bar.dataset.state = state;
        renderRoster(manager.players.filter(notMe));
        if (state === 'full') toast('That jam is full');
    };
    manager.onRoster = function (players) { renderRoster(players.filter(notMe)); };
    manager.onPlayerJoined = function (p) {
        toast((INSTRUMENTS[p.instrument] ? INSTRUMENTS[p.instrument].label : 'Someone') + ' joined the jam');
    };
    manager.onPlayerLeft = function (p) {
        if (!notMe(p)) return;
        toast((INSTRUMENTS[p.instrument] ? INSTRUMENTS[p.instrument].label : 'Someone') + ' left the jam');
    };
    manager.onRemoteNote = function (data) {
        jam.stats.received++;
        voices.play(data.instrument, data.note, data.velocity);
        flashPlayer(data.player_id);
        // pages may add their own visual (a pad ring, a string twang) without making sound
        window.dispatchEvent(new CustomEvent('harmonic:remote-note', { detail: data }));
    };

    // audio needs a gesture on THIS page; listen until the context is actually running
    var GESTURES = ['pointerdown', 'keydown', 'touchstart'];
    function unlock() {
        if (voices.unlock()) GESTURES.forEach(function (ev) { document.removeEventListener(ev, unlock); });
    }
    GESTURES.forEach(function (ev) { document.addEventListener(ev, unlock); });
    voices.unlock();

    // Cameras always travel browser to browser. Without a server they share the
    // link the notes use; with one, a direct link is opened just for them.
    if (hasServer) {
        import(new URL('vendor/trystero.js', BASE).href).then(function (lib) {
            startCams(lib.joinRoom({ appId: APP_ID, identity: 'none', maxUsers: MAX_PLAYERS }, 'band-' + room), playerId);
        }).catch(function (e) { console.warn('[Jam] cameras unavailable', e); });
    } else {
        manager.onRoom = function (link) { startCams(link, playerId); };
    }

    manager.connect(room, playerId, instrument);
    });
})();
