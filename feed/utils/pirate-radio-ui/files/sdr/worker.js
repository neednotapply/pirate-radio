/* Pirate Radio: the receiver's engine.

   Runs in a Web Worker, started by the Listen page (receiver.js). It owns
   the WebSocket to pirate-websdr on the router, so the radio's samples never
   touch the page's own thread; it puts them through the signal processing
   (dsp.js) and posts what comes out: spectrum lines, audio, the meter. In
   the web UI's demo mode there is no socket: a simulated band (siggen.js)
   stands in for the radio, paced by the clock.

   Both ends are set out in feed/utils/pirate-websdr/DESIGN.md: Part 1 is
   what goes over the socket, Part 2 the messages to and from the page.

   The engine never reconnects by itself: opening and closing the radio in
   quick succession upsets a HackRF, so after any failure it says what
   happened and waits to be started again.

   Node loads this file too (the tests, tests/sdr/): there an Engine is made
   by hand, with its own WebSocket and a function to post to. */
(function (root) {
	"use strict";

	const MODES = ["wfm", "nfm", "am", "usb", "lsb", "cw"];
	const DSP_KEYS = ["vfo", "mode", "bw", "squelch", "agc", "deemph", "cwPitch", "audio", "fftSize", "fps"];
	const OPEN_TIMEOUT = 8000;     // ms for the bridge to answer and the radio to open
	const TUNE_EVERY = 50;         // ms between tuning commands, when the dial is being dragged
	const LATE_SHED = 400;         // ms behind the radio's clock at which frames start being skipped
	const LATE_OK = 100;           // and behind which they are processed again
	const LATE_GIVE_UP = 1000;     // ms of skipping after which "behind" is taken to be how things are

	// The two radios, as pirate-websdr describes them (DESIGN.md): what the
	// demo's radio says of itself, and which sample rates may be asked for
	// when a real one is opened
	const RADIOS = {
		hackrf: {
			label: "Simulated HackRF", rates: [2400000, 4800000, 9600000], range: [1000000, 6000000000],
			gains: [{ name: "LNA", min: 0, max: 40, step: 8, value: 24 }, { name: "AMP", min: 0, max: 14, step: 14, value: 0 },
				{ name: "VGA", min: 0, max: 62, step: 2, value: 20 }]
		},
		rtlsdr: {
			label: "Simulated RTL-SDR", rates: [240000, 960000, 1200000, 1920000, 2400000], range: [24000000, 1766000000],
			gains: [{ name: "TUNER", min: 0, max: 49.6, step: 0, value: 29.8 }]
		}
	};

	function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
	function isNum(v) { return typeof v === "number" && isFinite(v); }

	class Engine {
		/* env: { post(message, transfer), WebSocket, DSP, SigGen } and,
		   optionally, now() in ms and the timer functions */
		constructor(env) {
			this.post = env.post;
			this.WebSocket = env.WebSocket;
			this.DSP = env.DSP;
			this.SigGen = env.SigGen;
			// (the timer functions through wrappers: called as a method of
			// anything but the global object, a browser's own refuse)
			this.now = env.now || function () { return performance.now(); };
			this.setTimeout = env.setTimeout || function (f, ms) { return setTimeout(f, ms); };
			this.clearTimeout = env.clearTimeout || function (t) { clearTimeout(t); };
			this.setInterval = env.setInterval || function (f, ms) { return setInterval(f, ms); };
			this.clearInterval = env.clearInterval || function (t) { clearInterval(t); };
			// What the page has asked for (the radio may be elsewhere: see hw)
			this.want = {
				center: 98000000, rate: 2400000, gains: {}, vfo: null, mode: "wfm", bw: null, squelch: null,
				agc: true, deemph: 75, cwPitch: 700, audio: true, fftSize: 4096, fps: 20
			};
			this.radio = "hackrf";
			this.demo = false;
			this.ws = null;
			this.state = "idle";       // idle, connecting, open (socket up, radio not yet), streaming
			this.hw = null;            // the radio as it is: { radio, label, center, rate, rates, range, gains: [...], sim }
			this.rx = null;
			this.gen = null;
			this.timers = {};
			this._zero();
		}

		_zero() {
			this.seq = null;
			this.dropped = 0;
			this.clients = 1;
			this.overflows = 0;
			this.busy = 0;             // ms the processing took since the last meter reading
			this.span = 0;             // ms of signal that was
			this.load = 0;
			this.first = true;         // no samples yet
			this.t0 = 0;
			this.signal = 0;           // ms of signal received
			this.lagMin = Infinity;
			this.shed = false;
			this.shedMs = 0;
			this.gap = false;
		}

		/* ---------- from the page ---------- */

		handle(m) {
			try {
				if (!m || typeof m !== "object") return;
				if (m.type === "start") this._start(m);
				else if (m.type === "stop") this._stop();
				else if (m.type === "set") this._set(m);
			} catch (e) {
				this._error(String((e && e.message) || e));
			}
		}

		_start(m) {
			this._end();
			if (m.settings) this._take(m.settings);
			if (m.radio !== "hackrf" && m.radio !== "rtlsdr") {
				this._conn("error", "no such radio: " + m.radio);
				return;
			}
			this.radio = m.radio;
			this.demo = !!m.demo;
			this._zero();
			if (this.demo) this._startDemo();
			else this._connect(String(m.url || ""));
		}

		_stop() {
			if (this.state === "idle") return;
			if (this.ws && this.state !== "connecting") this._send({ cmd: "close" });
			this._end();
			this._conn("closed", "stopped");
		}

		_set(m) {
			const s = this._take(m);
			if (!this.hw) return;       // not running: it is kept for the start
			if ("center" in s) this._tune(s.center);
			if ("rate" in s) this._rate(s.rate);
			if (s.gains) this._gains(s.gains);
			const d = {};
			let any = false;
			for (let i = 0; i < DSP_KEYS.length; i++) if (DSP_KEYS[i] in s) { d[DSP_KEYS[i]] = s[DSP_KEYS[i]]; any = true; }
			if (any && this.rx) this.rx.set(d);
		}

		// Settings as they came: what is sound is kept (in this.want) and
		// returned; what is not is said, and left out
		_take(o) {
			const s = {}, w = this.want, self = this;
			function bad(k, why) { self._error("setting \"" + k + "\": " + why); }
			if ("center" in o) { if (isNum(o.center) && o.center > 0) s.center = Math.round(o.center); else bad("center", "not a frequency"); }
			if ("rate" in o) { if (isNum(o.rate) && o.rate > 0) s.rate = Math.round(o.rate); else bad("rate", "not a sample rate"); }
			if ("gains" in o) {
				if (o.gains && typeof o.gains === "object") {
					s.gains = {};
					for (const k in o.gains) { if (isNum(o.gains[k])) s.gains[k] = o.gains[k]; else bad("gains." + k, "not a number"); }
				} else bad("gains", "not a set of gains");
			}
			if ("vfo" in o) { if (isNum(o.vfo) && o.vfo > 0) s.vfo = Math.round(o.vfo); else bad("vfo", "not a frequency"); }
			if ("mode" in o) { if (MODES.indexOf(o.mode) >= 0) s.mode = o.mode; else bad("mode", "one of " + MODES.join(", ")); }
			if ("bw" in o) { if (isNum(o.bw) && o.bw > 0) s.bw = o.bw; else bad("bw", "not a width"); }
			if ("squelch" in o) { if (o.squelch === null || isNum(o.squelch)) s.squelch = o.squelch; else bad("squelch", "a level in dBFS, or null"); }
			if ("agc" in o) s.agc = !!o.agc;
			if ("deemph" in o) { if (o.deemph === 75 || o.deemph === 50 || o.deemph === 0) s.deemph = o.deemph; else bad("deemph", "75, 50 or 0"); }
			if ("cwPitch" in o) { if (isNum(o.cwPitch)) s.cwPitch = clamp(o.cwPitch, 200, 1500); else bad("cwPitch", "not a pitch"); }
			if ("audio" in o) s.audio = !!o.audio;
			if ("fftSize" in o) {
				const n = o.fftSize;
				if (isNum(n) && n >= 1024 && n <= 32768 && !(n & (n - 1))) s.fftSize = n;
				else bad("fftSize", "a power of two, 1024 to 32768");
			}
			if ("fps" in o) { if (isNum(o.fps)) s.fps = clamp(o.fps, 5, 40); else bad("fps", "not a number"); }
			// A mode without a width takes the mode's own
			if ("mode" in s && !("bw" in s) && s.mode !== w.mode) w.bw = null;
			for (const k in s) {
				if (k === "gains") for (const g in s.gains) w.gains[g] = s.gains[g];
				else w[k] = s[k];
			}
			return s;
		}

		/* ---------- to the page ---------- */

		_conn(state, message, code) {
			const m = { type: "conn", state: state };
			if (message) m.message = message;
			if (code) m.code = code;
			this.post(m);
		}
		_error(message, code) {
			const m = { type: "error", message: message };
			if (code) m.code = code;
			this.post(m);
		}
		_info() {
			const h = this.hw;
			this.post({
				type: "info", radio: h.radio, label: h.label, center: h.center, rate: h.rate, rates: h.rates.slice(), range: h.range.slice(),
				gains: h.gains.map(function (g) { return { name: g.name, min: g.min, max: g.max, step: g.step, value: g.value }; }), sim: !!h.sim
			});
		}

		/* ---------- the receiver ---------- */

		// Where the dial is: where the page put it, or a little right of the
		// radio's centre until it does
		_vfo() { return this.want.vfo !== null ? this.want.vfo : this.hw.center + this.hw.rate / 8; }

		_makeRx() {
			const w = this.want, self = this, o = {
				rate: this.hw.rate, center: this.hw.center, vfo: this._vfo(), mode: w.mode, squelch: w.squelch, agc: w.agc,
				deemph: w.deemph, cwPitch: w.cwPitch, audio: w.audio, fftSize: w.fftSize, fps: w.fps,
				onFft: function (bins, center, rate) { self.post({ type: "fft", bins: bins, center: center, rate: rate }, [bins.buffer]); },
				onAudio: function (samples) { self.post({ type: "audio", samples: samples, rate: self.DSP.AUDIO_RATE }, [samples.buffer]); },
				onMeter: function (m) { self._meter(m); }
			};
			if (w.bw !== null) o.bw = w.bw;
			this.rx = new this.DSP.Receiver(o);
		}

		// The radio moved (or changed its rate): the receiver follows
		_follow() {
			if (this.rx) this.rx.set({ rate: this.hw.rate, center: this.hw.center, vfo: this._vfo() });
		}

		_meter(m) {
			if (this.span > 0) this.load = this.load ? 0.5 * this.load + 0.5 * this.busy / this.span : this.busy / this.span;
			this.busy = 0;
			this.span = 0;
			this.post({
				type: "meter", level: m.level, squelched: m.squelched, outside: m.outside,
				dropped: this.dropped, load: Math.round(this.load * 1000) / 1000, clients: this.clients, overflows: this.overflows
			});
		}

		// n samples (I and Q in turn) from the radio, real or not
		_samples(iq, n, gap, took) {
			if (!this.rx) return;
			if (this.first) {
				this.first = false;
				this.state = "streaming";
				this._conn("streaming");
			}
			const t = this.now();
			this.rx.process(iq, n, gap);
			this.busy += this.now() - t + (took || 0);
			this.span += n / this.hw.rate * 1000;
		}

		/* ---------- the socket to pirate-websdr ---------- */

		_connect(url) {
			const self = this;
			let ws;
			this.state = "connecting";
			this._conn("connecting");
			try {
				ws = new this.WebSocket(url);
			} catch (e) {
				this._end();
				this._conn("error", "could not open " + url + ": " + String((e && e.message) || e));
				return;
			}
			ws.binaryType = "arraybuffer";
			this.ws = ws;
			ws.onopen = function () {
				if (self.ws !== ws) return;
				self.state = "open";
				self._conn("open");
				self._timer("open", OPEN_TIMEOUT, function () { self._fail("the router's receiver did not answer"); });
			};
			ws.onmessage = function (ev) {
				if (self.ws !== ws) return;
				try {
					if (typeof ev.data === "string") self._text(ev.data);
					else self._frame(ev.data);
				} catch (e) {
					self._broke(e);
				}
			};
			ws.onerror = function () {};
			ws.onclose = function () {
				if (self.ws !== ws) return;
				const never = self.state === "connecting";
				self.ws = null;
				self._end();
				self._conn("error", never ? "could not reach the receiver on the router (" + url + "): is it switched on?" :
					"the connection to the router was lost");
			};
		}

		_send(o) {
			if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o));
		}

		// Give up: say why, and wait to be started again
		_fail(message, code) {
			this._end();
			this._conn("error", message, code);
		}
		// Something in here threw while samples were coming: better stopped,
		// and said, than thrown again at every frame
		_broke(e) {
			this._fail("the receiver stopped: " + String((e && e.message) || e));
		}

		_text(text) {
			let m;
			try { m = JSON.parse(text); } catch (e) { return; }
			if (!m || typeof m !== "object") return;
			switch (m.type) {
			case "hello": {
				if (m.proto !== 1) { this._fail("the router's receiver speaks another version of this (" + m.proto + "): reload the page"); return; }
				// The radio is asked for where the page wants it. (A radio
				// someone else is on is taken as it is: the bridge heeds the
				// frequency and rate only when the radio is ours to set. And
				// it refuses to open at a rate that radio does not have: one
				// kept from the other radio is left out, for the bridge's own.)
				const o = { cmd: "open", radio: this.radio };
				if (this.want.center >= 1) o.freq = this.want.center;
				if (RADIOS[this.radio].rates.indexOf(this.want.rate) >= 0) o.rate = this.want.rate;
				this.sim = !!m.sim;
				this._send(o);
				this._timer("open", OPEN_TIMEOUT, this._fail.bind(this, "the radio did not open"));
				break;
			}
			case "info": this._bridgeInfo(m); break;
			case "status": this._bridgeStatus(m); break;
			case "error":
				// Before the radio is open, an error is why it will not; after, a setting it refused
				if (!this.hw || m.code === "toomany") this._fail(String(m.message || "the radio would not open"), m.code);
				else this._error(String(m.message || "the radio refused that"), m.code);
				break;
			case "closed":
				this._end();
				this._conn("closed", String(m.reason || "the radio was closed"));
				break;
			}
		}

		_bridgeInfo(m) {
			const firstTime = !this.hw, old = this.hw;
			this._untimer("open");
			this.hw = {
				radio: m.radio, label: String(m.label || m.radio), center: m.freq, rate: m.rate, rates: (m.rates || [m.rate]).slice(),
				range: (m.range || [0, Infinity]).slice(), gains: (m.gains || []).map(function (g) {
					return { name: g.name, min: g.min, max: g.max, step: g.step, value: g.value };
				}), sim: this.sim
			};
			if (firstTime) {
				this._makeRx();
				// The gains the page came with go to the radio now
				this._gains(this.want.gains, true);
			} else if (old.rate !== this.hw.rate || old.center !== this.hw.center) this._follow();
			this._info();
		}

		_bridgeStatus(m) {
			const h = this.hw;
			if (!h) return;
			let changed = false;
			if (isNum(m.clients)) this.clients = m.clients;
			if (isNum(m.overflows)) this.overflows = m.overflows;
			if (isNum(m.freq) && m.freq !== h.center) { h.center = m.freq; changed = true; }
			if (isNum(m.rate) && m.rate !== h.rate) { h.rate = m.rate; changed = true; }
			// The frames from here on are at these settings (DESIGN.md's ordering rule)
			if (changed) this._follow();
			if (m.gains) {
				for (let i = 0; i < h.gains.length; i++) {
					const v = m.gains[h.gains[i].name];
					if (isNum(v) && v !== h.gains[i].value) { h.gains[i].value = v; changed = true; }
				}
			}
			if (changed) this._info();
		}

		// A binary frame: eight bytes of header, then the samples
		_frame(buf) {
			if (!(buf instanceof ArrayBuffer) || buf.byteLength < 10 || !this.hw) return;
			const h = new Uint8Array(buf, 0, 8);
			if (h[0] !== 1) return;
			const seq = (h[4] | h[5] << 8 | h[6] << 16 | h[7] << 24) >>> 0, n = (buf.byteLength - 8) >> 1;
			let gap = (h[1] & 1) !== 0, lost = 0;
			if (this.seq !== null) {
				lost = (seq - this.seq - 1) >>> 0;
				if (lost > 0 && lost < 0x40000000) { this.dropped += lost; gap = true; }
				else lost = 0;
			}
			this.seq = seq;
			if (this._late(n / this.hw.rate * 1000, lost)) {
				this.gap = true;
				this.dropped++;
				return;
			}
			gap = gap || this.gap;
			this.gap = false;
			this._samples(new Int8Array(buf, 8, 2 * n), n, gap, 0);
		}

		// Is this frame (ms long, after `lost` that never came) too late to be
		// worth hearing? The frames' own count of time is held against the
		// clock: when this end has fallen behind (the computer cannot keep
		// up, or the page was asleep and a backlog is arriving in a rush),
		// frames are let go until it has caught up, rather than everything
		// being heard later and later.
		_late(ms, lost) {
			const t = this.now();
			if (this.first) { this.t0 = t; this.signal = 0; this.lagMin = Infinity; this.shed = false; }
			this.signal += (lost + 1) * ms;
			const lag = t - this.t0 - this.signal;
			// How far behind is measured from the least it has been (which
			// creeps up, for a radio whose clock runs a little slow)
			this.lagMin = lag < this.lagMin ? lag : this.lagMin + ms * 0.001;
			if (!this.shed) {
				if (lag - this.lagMin <= LATE_SHED) return false;
				this.shed = true;
				this.shedMs = 0;
			}
			this.shedMs += ms;
			// Caught up; or a second has gone by without catching up, which is
			// no backlog but the radio itself having paused: this is "now" again
			if (lag - this.lagMin > LATE_OK && this.shedMs <= LATE_GIVE_UP) return true;
			if (this.shedMs > LATE_GIVE_UP) this.lagMin = lag;
			this.shed = false;
			return false;
		}

		/* ---------- to the radio ---------- */

		_tune(center) {
			const h = this.hw, c = clamp(center, h.range[0], h.range[1]), self = this;
			if (this.demo) {
				if (c === h.center) return;
				h.center = c;
				this.gen.tune(c, h.rate);
				this._follow();
				this._info();
				return;
			}
			// Dragging the display asks many times a second: the radio is told
			// at once, then at most every so often, and always of the last one
			this.pendingCenter = c;
			if (this.timers.tune) return;
			this._send({ cmd: "freq", hz: c });
			this.sentCenter = c;
			this._timer("tune", TUNE_EVERY, function () {
				if (self.pendingCenter !== self.sentCenter) self._tune(self.pendingCenter);
			});
		}

		_rate(rate) {
			const h = this.hw;
			if (h.rates.indexOf(rate) < 0) {
				this._error("the " + h.label + " does not do " + rate + " samples a second");
				return;
			}
			if (!this.demo) { this._send({ cmd: "rate", hz: rate }); return; }
			if (rate === h.rate) return;
			h.rate = rate;
			this.gen.tune(h.center, rate);
			this._follow();
			this._pace();
			this._info();
		}

		// A gain as the radio can set it: within its range, on one of its steps
		_snap(g, v) {
			v = clamp(v, g.min, g.max);
			return g.step > 0 ? clamp(g.min + Math.round((v - g.min) / g.step) * g.step, g.min, g.max) : v;
		}

		// quiet: these are the gains the page started with, perhaps another
		// radio's: what this one does not have is passed over, not complained of
		_gains(gains, quiet) {
			const h = this.hw;
			let changed = false;
			for (let i = 0; i < h.gains.length; i++) {
				const g = h.gains[i];
				if (!(g.name in gains)) continue;
				const v = this._snap(g, gains[g.name]);
				if (v === g.value) continue;
				if (this.demo) { g.value = v; changed = true; }
				else this._send({ cmd: "gain", name: g.name, value: v });
			}
			if (!quiet) for (const k in gains) {
				if (!h.gains.some(function (g) { return g.name === k; })) this._error("the " + h.label + " has no gain called " + k);
			}
			if (changed) {
				this._demoGain();
				this._info();
			}
		}

		/* ---------- the demo: a radio that is not there ---------- */

		_startDemo() {
			const d = RADIOS[this.radio], w = this.want, self = this;
			this.state = "connecting";
			this._conn("connecting");
			this.hw = {
				radio: this.radio, label: d.label, rates: d.rates.slice(), range: d.range.slice(), sim: true,
				center: clamp(w.center, d.range[0], d.range[1]), rate: d.rates.indexOf(w.rate) >= 0 ? w.rate : 2400000,
				gains: d.gains.map(function (g) { return { name: g.name, min: g.min, max: g.max, step: g.step, value: g.value }; })
			};
			this.gen = new this.SigGen.Generator({ seed: 1, center: this.hw.center, rate: this.hw.rate });
			// The gains the page came with, where this radio has them
			this.hw.gains.forEach(function (g) { if (g.name in w.gains) g.value = self._snap(g, w.gains[g.name]); });
			this._demoGain();
			this.state = "open";
			this._conn("open");
			this._makeRx();
			this._info();
			this._pace();
			this.timers.demo = this.setInterval(function () {
				try { self._demoTick(); } catch (e) { self._broke(e); }
			}, 10);
		}

		// The simulated radio's level follows its gains: everything up or down
		// by as much as they add up to, against where they start
		_demoGain() {
			const d = RADIOS[this.radio].gains;
			let db = 0;
			for (let i = 0; i < d.length; i++) db += this.hw.gains[i].value - d[i].value;
			this.gen.setGain(db);
		}

		// Frames are made by the clock: so many are due by now
		_pace() {
			const n = Math.min(this.hw.rate / 50, 48000);
			this.frame = n;
			this.frameMs = n / this.hw.rate * 1000;
			this.buf = new Int8Array(2 * n);
			this.t0 = this.now();
			this.made = 0;
		}

		_demoTick() {
			let due = Math.floor((this.now() - this.t0) / this.frameMs) - this.made, gap = false;
			if (due <= 0) return;
			if (due > 10) {
				// Far behind (the page was asleep, or this computer cannot
				// keep up): what is past is let go, as lost frames would be
				this.dropped += due - 1;
				this.made += due - 1;
				due = 1;
				gap = true;
			}
			if (due > 4) due = 4;
			for (let i = 0; i < due; i++) {
				const t = this.now();
				this.gen.generate(this.buf, this.frame);
				this.made++;
				this._samples(this.buf, this.frame, gap && i === 0, this.now() - t);
			}
		}

		/* ---------- housekeeping ---------- */

		_timer(name, ms, fn) {
			const self = this;
			this._untimer(name);
			this.timers[name] = this.setTimeout(function () {
				delete self.timers[name];
				fn();
			}, ms);
		}
		_untimer(name) {
			if (this.timers[name] == null) return;
			if (name === "demo") this.clearInterval(this.timers[name]);
			else this.clearTimeout(this.timers[name]);
			delete this.timers[name];
		}

		// Everything let go, quietly: the socket, the timers, the receiver
		_end() {
			const ws = this.ws;
			for (const k in this.timers) this._untimer(k);
			this.ws = null;
			if (ws) {
				try { ws.close(1000); } catch (e) {}
			}
			this.rx = null;
			this.hw = null;
			this.gen = null;
			this.gap = false;
			this.state = "idle";
		}
	}

	if (typeof module === "object" && module.exports) {
		module.exports = { Engine: Engine, RADIOS: RADIOS };
	} else if (typeof importScripts === "function") {
		// In the worker: the other two files load with the version this one was asked for
		const q = (root.location && root.location.search) || "";
		importScripts("dsp.js" + q, "siggen.js" + q);
		const engine = new Engine({
			post: function (m, transfer) { root.postMessage(m, transfer || []); },
			WebSocket: root.WebSocket, DSP: root.PirateDSP, SigGen: root.PirateSigGen
		});
		root.onmessage = function (ev) { engine.handle(ev.data); };
	}
})(typeof self !== "undefined" ? self : this);
