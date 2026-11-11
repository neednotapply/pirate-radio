/* A stand-in for pirate-websdr, the bridge on the router: the whole of the
   wire protocol (feed/utils/pirate-websdr/DESIGN.md, Part 1) with a simulated
   band (siggen.js) for a radio. For the engine's tests, and for trying the
   Listen page with no router:

     node tests/sdr/mock-bridge.js [--port 8073] [--host 127.0.0.1] [--linger SECONDS]
                                   [--drop N] [--absent hackrf|rtlsdr] [--verbose]

   It listens on this computer only (127.0.0.1) unless given another --host
   (0.0.0.0 for every address, to reach it from another device). --drop N
   loses every Nth frame on purpose (a poor network); --absent makes a radio
   one that will not open.

   It behaves as the real one does: one radio at a time, shared by whoever
   opens it; `info` and `status` in the order the protocol promises; frames
   by the clock, numbered, and dropped for a client that is not taking them.
   What it does not have is the real one's care for a real radio (the pause
   between closing and opening): there is no radio to upset. */
"use strict";

const path = require("path");
const { createServer } = require("./ws-lite.js");
const SigGen = require(path.join(__dirname, "../../feed/utils/pirate-radio-ui/files/sdr/siggen.js"));

const PROTO = 1, MAX_CLIENTS = 4, MAX_TEXT = 512, DEFAULT_FREQ = 98000000, DEFAULT_RATE = 2400000;

// The radios, as pirate-websdr --sim describes them
const RADIOS = {
	hackrf: {
		name: "HackRF", label: "Simulated HackRF", rates: [2400000, 4800000, 9600000], range: [1e6, 6e9],
		gains: [{ name: "LNA", min: 0, max: 40, step: 8, value: 24 }, { name: "AMP", min: 0, max: 14, step: 14, value: 0 },
			{ name: "VGA", min: 0, max: 62, step: 2, value: 20 }]
	},
	rtlsdr: {
		name: "RTL-SDR", label: "Simulated RTL-SDR", rates: [240000, 960000, 1200000, 1920000, 2400000], range: [24e6, 1766e6],
		gains: [{ name: "TUNER", min: 0, max: 49.6, step: 0, value: 29.8 }]
	}
};

function frameSamples(rate) { return Math.min(rate / 50, 48000); }

/* startMockBridge({ port, host, linger, dropEvery, absent, verbose, seed })
   resolves to the bridge: { port, close(), commands, connections, device(),
   kick(reason), fail(), stall(on) }. */
function startMockBridge(o) {
	o = o || {};
	const clients = [], bridge = { commands: [], connections: 0 };
	let dev = null, lingerT = null, lastStatus = 0;

	function log() {
		if (o.verbose) console.error.apply(console, ["mock-bridge:"].concat(Array.prototype.slice.call(arguments)));
	}
	function streaming() { return clients.filter(function (c) { return c.streaming; }); }

	/* --- what goes to a client --- */

	function send(c, m) { c.conn.send(JSON.stringify(m)); }
	function error(c, code, message) { send(c, { type: "error", code: code, message: message }); }
	function info(c) {
		send(c, {
			type: "info", radio: dev.radio, label: dev.label, freq: dev.freq, rate: dev.rate, frame: dev.frame,
			rates: dev.rates, range: dev.range, gains: dev.gains
		});
	}
	function status(c) {
		const g = {};
		dev.gains.forEach(function (x) { g[x.name] = x.value; });
		send(c, { type: "status", freq: dev.freq, rate: dev.rate, gains: g, clients: streaming().length, dropped: c.dropped, overflows: dev.overflows });
	}
	function statusAll() { streaming().forEach(status); }

	/* --- the radio --- */

	function gainOver() {
		// How far the gains are from where they start, in dB: the simulated band's level
		const d = RADIOS[dev.radio].gains;
		let db = 0;
		dev.gains.forEach(function (g, i) { db += g.value - d[i].value; });
		return db;
	}
	function retime() {
		dev.frame = frameSamples(dev.rate);
		dev.buf = new Int8Array(2 * dev.frame);
		dev.out = Buffer.alloc(8 + 2 * dev.frame);
		dev.t0 = Date.now();
		dev.made = 0;
		dev.gen.tune(dev.freq, dev.rate);
	}
	function deviceOpen(radio, freq, rate) {
		const r = RADIOS[radio];
		dev = {
			radio: radio, label: r.label, rates: r.rates, range: r.range, freq: Math.min(r.range[1], Math.max(r.range[0], freq)), rate: rate,
			gains: r.gains.map(function (g) { return { name: g.name, min: g.min, max: g.max, step: g.step, value: g.value }; }),
			seq: 0, overflows: 0, gen: new SigGen.Generator({ seed: o.seed == null ? 1 : o.seed }), stalled: false
		};
		retime();
		log(radio + ": opened at " + dev.freq + " Hz, " + dev.rate + " samples a second");
	}
	function deviceClose(why) {
		if (!dev) return;
		log(dev.radio + ": closed (" + why + ")");
		dev = null;
		if (lingerT) { clearTimeout(lingerT); lingerT = null; }
	}
	// Every listener is told, and the radio let go
	function deviceDrop(reason) {
		if (!dev) return;
		streaming().forEach(function (c) {
			c.streaming = false;
			send(c, { type: "closed", reason: reason });
		});
		deviceClose(reason);
	}
	function left() {
		// Nobody on the radio: it is kept a while (a page reloading comes
		// straight back), then closed
		if (!dev || streaming().length) return;
		if (lingerT) clearTimeout(lingerT);
		if (o.linger > 0) lingerT = setTimeout(function () { lingerT = null; if (!streaming().length) deviceClose("nobody listening"); }, o.linger * 1000);
		else deviceClose("nobody listening");
	}
	function changed(rateToo) {
		// A new centre or rate: what follows is at it, and says so first
		dev.gen.tune(dev.freq, dev.rate);
		if (rateToo) { retime(); streaming().forEach(info); }
		streaming().forEach(function (c) { c.discont = true; });
		statusAll();
	}

	/* --- commands --- */

	function command(c, text) {
		let m;
		try { m = JSON.parse(text); } catch (e) { m = null; }
		const flat = m && typeof m === "object" && !Array.isArray(m) && Object.keys(m).every(function (k) {
			return m[k] === null || typeof m[k] !== "object";
		});
		if (!flat) return error(c, "badrequest", "a command is one flat JSON object");
		bridge.commands.push(m);
		log(c.id + ": " + text);
		if (typeof m.cmd !== "string") return error(c, "badrequest", "a command has a cmd");
		switch (m.cmd) {
		case "open": return open(c, m);
		case "freq":
			if (!c.streaming) return error(c, "badrequest", "freq: open a radio first");
			if (typeof m.hz !== "number" || !(m.hz >= 1)) return error(c, "badrequest", "freq: hz is a frequency in Hz");
			if (m.hz < dev.range[0] || m.hz > dev.range[1]) return error(c, "failed", "that frequency is outside what the radio tunes");
			dev.freq = m.hz;
			return changed(false);
		case "rate":
			if (!c.streaming) return error(c, "badrequest", "rate: open a radio first");
			if (dev.rates.indexOf(m.hz) < 0) return error(c, "badrequest", "rate: hz is one of the radio's rates");
			dev.rate = m.hz;
			return changed(true);
		case "gain": {
			if (!c.streaming) return error(c, "badrequest", "gain: open a radio first");
			if (typeof m.name !== "string" || typeof m.value !== "number") return error(c, "badrequest", "gain: name is a gain element, value its dB");
			const g = dev.gains.filter(function (x) { return x.name === m.name; })[0];
			if (!g) return error(c, "badrequest", "gain: the radio has no such gain element");
			let v = Math.min(g.max, Math.max(g.min, m.value));
			if (g.step > 0) v = Math.min(g.max, g.min + Math.round((v - g.min) / g.step) * g.step);
			g.value = v;
			dev.gen.setGain(gainOver());
			return statusAll();
		}
		case "close":
			if (c.streaming) {
				c.streaming = false;
				left();
			}
			return send(c, { type: "closed", reason: "closed, as asked" });
		case "ping":
			return send(c, { type: "pong", t: m.t });
		default:
			return error(c, "badrequest", "unknown cmd");
		}
	}

	function open(c, m) {
		const r = RADIOS[m.radio];
		if (typeof m.radio !== "string" || !r) return error(c, "badrequest", "open: radio is \"hackrf\" or \"rtlsdr\"");
		if ("freq" in m && (typeof m.freq !== "number" || !(m.freq >= 1))) return error(c, "badrequest", "open: freq is a frequency in Hz");
		if ("rate" in m && r.rates.indexOf(m.rate) < 0) return error(c, "badrequest", "open: rate is not one that radio offers");
		const others = streaming().length - (c.streaming ? 1 : 0);
		if (dev && dev.radio !== m.radio) {
			if (others > 0) return error(c, "busy", "the " + RADIOS[dev.radio].name + " is in use here: one radio at a time");
			// Nobody else is on the other radio: it goes, the one asked for comes
			c.streaming = false;
			deviceClose("the other radio is asked for");
		}
		if (!dev) {
			if ((o.absent || []).indexOf(m.radio) >= 0) return error(c, "nodevice", "the " + r.name + ": no such radio on USB (says the mock)");
			deviceOpen(m.radio, m.freq || DEFAULT_FREQ, m.rate || DEFAULT_RATE);
		} else if (others === 0) {
			// Open, and nobody else on it: this client's to set
			if (lingerT) { clearTimeout(lingerT); lingerT = null; }
			if (m.freq) dev.freq = Math.min(dev.range[1], Math.max(dev.range[0], m.freq));
			if (m.rate) dev.rate = m.rate;
			retime();
		}
		if (!c.streaming) { c.streaming = true; c.dropped = 0; }
		c.discont = true;
		info(c);
		statusAll();
	}

	/* --- the samples, by the clock --- */

	function tick() {
		const now = Date.now(), on = streaming();
		if (!dev || !on.length || dev.stalled) return;
		let due = Math.floor((now - dev.t0) * dev.rate / 1000 / dev.frame) - dev.made;
		if (due > 25) {
			// This process was held up: the radio's own buffer would have overflowed
			dev.made += due - 1;
			dev.seq = (dev.seq + due - 1) >>> 0;
			dev.overflows++;
			due = 1;
			on.forEach(function (c) { c.discont = true; });
		}
		for (; due > 0; due--) {
			dev.gen.generate(dev.buf, dev.frame);
			dev.made++;
			const out = dev.out, seq = dev.seq;
			dev.seq = (dev.seq + 1) >>> 0;
			out[0] = 1; out[2] = 0; out[3] = 0;
			out.writeUInt32LE(seq, 4);
			Buffer.from(dev.buf.buffer, dev.buf.byteOffset, dev.buf.byteLength).copy(out, 8);
			const lost = o.dropEvery && seq % o.dropEvery === o.dropEvery - 1, room = Math.max(262144, dev.rate * 2 * 0.15);
			for (let i = 0; i < on.length; i++) {
				const c = on[i];
				// A client that is not taking the frames loses them: nobody waits for it
				if (lost || c.conn.buffered > room) { c.dropped++; c.discont = true; continue; }
				out[1] = c.discont ? 1 : 0;
				c.discont = false;
				c.conn.send(out);
			}
		}
		if (now - lastStatus >= 1000) { lastStatus = now; statusAll(); }
	}

	/* --- the server --- */

	const server = createServer({
		plain: { status: 426, reason: "Upgrade Required", text: "pirate-websdr (mock): this port speaks WebSocket, to the web UI's Listen page\n" },
		verify: function (req) {
			// A page from elsewhere may not listen in: its Origin must be this host
			const origin = req.headers.origin;
			if (origin) {
				let from = "", here = String(req.headers.host || "").replace(/:\d+$/, "");
				try { from = new URL(origin).hostname; } catch (e) { from = ""; }
				if (from.replace(/^\[|\]$/g, "") !== here.replace(/^\[|\]$/g, "")) return { status: 403, reason: "Forbidden", text: "not from this router's own pages\n" };
			}
			if (clients.length >= MAX_CLIENTS) return { status: 503, reason: "Service Unavailable", text: "too many listeners\n" };
			return null;
		},
		onConnection: function (conn, req) {
			const c = { conn: conn, streaming: false, dropped: 0, discont: false, id: req.socket.remoteAddress + ":" + req.socket.remotePort };
			clients.push(c);
			bridge.connections++;
			log(c.id + ": connected");
			send(c, { type: "hello", proto: PROTO, server: "pirate-websdr mock", sim: true, open: dev && streaming().length ? dev.radio : null });
			conn.onmessage = function (data, binary) {
				if (binary) return conn.close(1003);
				if (Buffer.byteLength(data) > MAX_TEXT) return conn.close(1009);
				command(c, data);
			};
			conn.onclose = function () {
				clients.splice(clients.indexOf(c), 1);
				log(c.id + ": gone");
				if (c.streaming) { c.streaming = false; left(); }
			};
		}
	});
	const timer = setInterval(tick, 4);

	// What the tests reach for
	bridge.device = function () {
		return dev ? { radio: dev.radio, freq: dev.freq, rate: dev.rate, gains: dev.gains.map(function (g) { return { name: g.name, value: g.value }; }), listeners: streaming().length } : null;
	};
	bridge.kick = function (reason) { deviceDrop(reason || "the radio was handed to another job"); };   // as SIGUSR1 does
	bridge.fail = function () { deviceDrop("the radio stopped answering"); };
	bridge.stall = function (on) { if (dev) { dev.stalled = on; if (!on) { dev.t0 = Date.now(); dev.made = 0; } } };
	bridge.hangup = function () { clients.slice().forEach(function (c) { c.conn.socket.destroy(); }); };
	bridge.close = function () {
		clearInterval(timer);
		if (lingerT) clearTimeout(lingerT);
		clients.slice().forEach(function (c) { c.conn.socket.destroy(); });
		return new Promise(function (done) { server.close(function () { done(); }); });
	};

	return new Promise(function (ok, bad) {
		server.once("error", bad);
		server.listen(o.port || 0, o.host || "127.0.0.1", function () {
			bridge.port = server.address().port;
			ok(bridge);
		});
	});
}

module.exports = { startMockBridge, RADIOS };

if (require.main === module) {
	const a = process.argv.slice(2), o = { port: 8073, linger: 5, verbose: false };
	for (let i = 0; i < a.length; i++) {
		if (a[i] === "--port") o.port = +a[++i];
		else if (a[i] === "--host") o.host = a[++i];
		else if (a[i] === "--linger") o.linger = +a[++i];
		else if (a[i] === "--drop") o.dropEvery = +a[++i];
		else if (a[i] === "--absent") o.absent = (o.absent || []).concat(a[++i]);
		else if (a[i] === "--verbose") o.verbose = true;
		else { console.error("usage: node mock-bridge.js [--port 8073] [--host 127.0.0.1] [--linger SECONDS] [--drop N] [--absent hackrf|rtlsdr] [--verbose]"); process.exit(2); }
	}
	startMockBridge(o).then(function (b) {
		console.error("mock-bridge: a simulated radio on ws://" + (o.host || "127.0.0.1") + ":" + b.port + "/ (Ctrl-C to stop)");
	}, function (e) {
		console.error("mock-bridge: " + e.message);
		process.exit(1);
	});
}
