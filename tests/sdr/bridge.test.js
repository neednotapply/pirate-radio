/* The receiver's two halves together: the engine (worker.js), as the Listen
   page runs it, with pirate-websdr itself at the other end of a real socket:
   the bridge built for this machine, its simulated radio for a radio.

   engine.test.js has the engine against a mock of the bridge, and
   tests/websdr/ has the bridge against a client of the test's own. Here the
   bridge's simulated stations (a tone on wide FM, on AM, on narrow FM, at
   fixed places in every megahertz: source_sim.c) have to come out of the
   engine's loudspeaker as the tones they are.

     node tests/sdr/bridge.test.js --bin <pirate-websdr>        (tests/websdr/run.sh does this)
     node tests/sdr/bridge.test.js --url ws://127.0.0.1:8073/   (one already running with --sim)

   Node 20, no packages. ONLY=<regexp> runs the tests whose name matches. */
"use strict";

const path = require("path"), net = require("net"), { spawn } = require("child_process");
const SDR = path.join(__dirname, "../../feed/utils/pirate-radio-ui/files/sdr/");
const DSP = require(SDR + "dsp.js"), SigGen = require(SDR + "siggen.js"), Engine = require(SDR + "worker.js").Engine;
const { WebSocket } = require("./ws-lite.js");
const { test, run, ok, equal, near, atLeast } = require("./harness.js");

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

let URL_ = arg("--url"), child = null;

// An engine, as the page has one, and everything it posts
function page() {
	const got = { all: [], conn: [], info: [], fft: [], audio: [], meter: [], error: [] };
	got.engine = new Engine({
		post: function (m) { got.all.push(m); got[m.type].push(m); },
		WebSocket: WebSocket, DSP: DSP, SigGen: SigGen
	});
	got.send = function (m) { got.engine.handle(m); };
	got.states = function () { return got.conn.map(function (c) { return c.state; }).join(" "); };
	got.until = async function (fn, what, ms) {
		const t0 = Date.now();
		while (!fn()) {
			if (Date.now() - t0 > (ms || 6000)) throw new Error("waited in vain for " + what + " (conn: " + got.states() +
				(got.error.length ? "; errors: " + got.error.map(function (e) { return e.message; }).join(" | ") : "") +
				(got.conn.length && got.conn[got.conn.length - 1].message ? "; " + got.conn[got.conn.length - 1].message : "") + ")");
			await sleep(10);
		}
	};
	got.last = function (type) { return got[type][got[type].length - 1]; };
	got.start = async function (radio, settings) {
		got.send({ type: "start", radio: radio, url: URL_, settings: settings });
		await got.until(function () { return got.meter.length > 0; }, "the stream");
	};
	got.stop = function () { got.send({ type: "stop" }); };
	// The pitch of what is heard, Hz, over `seconds` of sound from now on
	// (after `settle` for a change to take), by its zero crossings
	got.pitch = async function (seconds, settle) {
		await sleep((settle == null ? 0.5 : settle) * 1000);
		const from = got.audio.length;
		await got.until(function () {
			let n = 0;
			for (let i = from; i < got.audio.length; i++) n += got.audio[i].samples.length;
			return n >= seconds * 48000;
		}, seconds + " s of sound", 8000);
		let zc = 0, n = 0, prev = 0, peak = 0;
		for (let i = from; i < got.audio.length; i++) {
			const s = got.audio[i].samples;
			for (let k = 0; k < s.length; k++) {
				if ((s[k] >= 0) !== (prev >= 0)) zc++;
				if (Math.abs(s[k]) > peak) peak = Math.abs(s[k]);
				prev = s[k];
				n++;
			}
		}
		return { hz: zc / 2 / (n / 48000), peak: peak };
	};
	return got;
}

// A bare client of the bridge: what it says to somebody who only looks
function hello() {
	return new Promise(function (done, bad) {
		const ws = new WebSocket(URL_);
		const t = setTimeout(function () { bad(new Error("no hello from the bridge")); }, 3000);
		ws.onmessage = function (ev) {
			if (typeof ev.data !== "string") return;
			clearTimeout(t);
			ws.close();
			done(JSON.parse(ev.data));
		};
		ws.onerror = function (e) { clearTimeout(t); bad(new Error(e.message)); };
	});
}

const FM = { center: 98000000, rate: 2400000, vfo: 98400000, mode: "wfm" };

test("the bridge's wide FM station is heard: its 1 kHz tone, in real time, nothing lost", async function () {
	const p = page();
	try {
		await p.start("hackrf", FM);
		await p.until(function () { return p.meter.length >= 6; }, "six meter readings");
		equal(p.states(), "connecting open streaming", "conn states");
		const i = p.info[0];
		ok(i.sim === true && i.radio === "hackrf" && i.center === 98000000 && i.rate === 2400000, "info: " + JSON.stringify(i).slice(0, 200));
		equal(i.gains.map(function (g) { return g.name; }).join(), "LNA,AMP,VGA", "the radio's gain stages");
		equal(i.rates.join(), "2400000,4800000,9600000", "the spans it offers");
		ok(p.fft.length >= 16 && p.fft.every(function (f) { return f.center === 98000000 && f.rate === 2400000 && f.bins.length === 4096; }),
			"spectrum lines: " + p.fft.length);
		// The station stands well clear of the noise, where the dial is
		const f = p.last("fft").bins, bin = Math.round((98400000 - (98000000 - 1200000)) / (2400000 / 4096));
		let peak = -200, floor = 0;
		for (let k = bin - 60; k <= bin + 60; k++) if (f[k] > peak) peak = f[k];
		for (let k = 100; k < 300; k++) floor += f[k] / 200;
		atLeast(peak - floor, 20, "the station over the noise, dB");
		const t = await p.pitch(1.0);
		near(t.hz, 1000, 25, "the tone heard on wide FM, Hz");
		atLeast(t.peak, 0.05, "and it is not silence");
		const m = p.last("meter");
		ok(m.clients === 1 && m.dropped === 0 && m.outside === false, "one listener, nothing lost: " + JSON.stringify(m));
	} finally { p.stop(); }
});

test("the dial moves along the band: AM's 400 Hz tone, narrow FM's 1 kHz", async function () {
	const p = page();
	try {
		await p.start("hackrf", FM);
		// (the simulated radio makes the four signals nearest its centre: of
		// AM and narrow FM, those are the ones below it)
		p.send({ type: "set", vfo: 97700000, mode: "am", bw: 8000 });
		near((await p.pitch(1.0)).hz, 400, 15, "the tone heard on AM, Hz");
		p.send({ type: "set", vfo: 97850000, mode: "nfm", bw: 12500 });
		near((await p.pitch(1.0)).hz, 1000, 25, "the tone heard on narrow FM, Hz");
		equal(p.error.length, 0, "errors: " + p.error.map(function (e) { return e.message; }).join(" | "));
	} finally { p.stop(); }
});

test("the page moves the radio itself: centre, gain, span, and the radio's answers come back", async function () {
	const p = page();
	try {
		await p.start("hackrf", FM);
		// the centre: the next megahertz has the same stations
		p.send({ type: "set", center: 99000000, vfo: 99400000 });
		await p.until(function () { return p.last("info").center === 99000000; }, "the radio to say it moved");
		await p.until(function () { return p.last("fft").center === 99000000; }, "lines from the new centre");
		near((await p.pitch(0.8)).hz, 1000, 25, "the tone, a megahertz up, Hz");
		// a gain: the radio says what it took, and the station is as much stronger
		const before = p.last("meter").level;
		p.send({ type: "set", gains: { VGA: 30 } });
		await p.until(function () {
			return p.last("info").gains.some(function (g) { return g.name === "VGA" && g.value === 30; });
		}, "the radio to say its VGA is at 30");
		await sleep(700);
		near(p.last("meter").level - before, 10, 3, "10 dB more gain, in the channel's level, dB");
		// the span: twice as wide, the sound goes on
		p.send({ type: "set", rate: 4800000 });
		await p.until(function () { return p.last("info").rate === 4800000; }, "the radio to say its rate");
		await p.until(function () { const f = p.last("fft"); return f.rate === 4800000 && f.center === 99000000; }, "lines at the new rate");
		near((await p.pitch(0.8)).hz, 1000, 25, "the tone at the wider span, Hz");
		equal(p.error.length, 0, "errors: " + p.error.map(function (e) { return e.message; }).join(" | "));
	} finally { p.stop(); }
});

test("the RTL-SDR at its narrowest span: narrow FM's tone from 240000 samples a second", async function () {
	const p = page();
	try {
		await p.start("rtlsdr", { center: 100820000, rate: 240000, vfo: 100850000, mode: "nfm", bw: 12500 });
		const i = p.info[0];
		ok(i.radio === "rtlsdr" && i.rate === 240000 && i.rates.indexOf(240000) >= 0, "info: " + JSON.stringify(i).slice(0, 200));
		near((await p.pitch(1.0)).hz, 1000, 25, "the tone heard, Hz");
		equal(p.last("meter").dropped, 0, "frames lost");
	} finally { p.stop(); }
});

test("two pages share the radio: one tunes it, the other follows", async function () {
	const a = page(), b = page();
	try {
		await a.start("hackrf", FM);
		await b.start("hackrf", { center: 433000000, rate: 2400000, mode: "nfm" });   // it joins: the radio stays where it is
		equal(b.info[0].center, 98000000, "the one who joins finds the radio as it is");
		await a.until(function () { return a.last("meter").clients === 2; }, "the first to hear of the second");
		b.send({ type: "set", center: 101000000 });
		await a.until(function () { return a.last("info").center === 101000000; }, "the first to follow the second's tuning");
		await a.until(function () { return a.last("fft").center === 101000000; }, "its lines from the new centre");
	} finally { a.stop(); b.stop(); }
});

test("stop lets go of the radio, and nothing more is said", async function () {
	const p = page();
	await p.start("hackrf", FM);
	equal((await hello()).open, "hackrf", "the bridge has the HackRF open while a page listens");
	p.stop();
	equal(p.last("conn").state, "closed", "conn after stop");
	const n = p.all.length;
	await sleep(400);
	equal(p.all.length, n, "messages after stop");
	equal((await hello()).open, null, "and nobody has it once the page has stopped");
});

/* ---------- the bridge to test: one given, or one started here ---------- */

function freePort() {
	return new Promise(function (done, bad) {
		const s = net.createServer();
		s.on("error", bad);
		s.listen(0, "127.0.0.1", function () { const p = s.address().port; s.close(function () { done(p); }); });
	});
}

async function startBridge(bin) {
	const port = await freePort();
	let said = "";
	child = spawn(bin, ["--sim", "--port", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
	child.stderr.on("data", function (d) { said += d; });
	child.on("exit", function (code) { if (child) { child.gone = true; child.code = code; } });
	URL_ = "ws://127.0.0.1:" + port + "/";
	for (let i = 0; i < 50; i++) {
		if (child.gone) break;
		try { await hello(); return; } catch (e) { await sleep(100); }
	}
	throw new Error("the bridge did not come up" + (child.gone ? " (it exited with " + child.code + ")" : "") + ": " + said.trim());
}

(async function () {
	const bin = arg("--bin");
	if (!bin === !URL_) {
		console.error("usage: node tests/sdr/bridge.test.js --bin <pirate-websdr> | --url ws://host:port/");
		process.exit(2);
	}
	let failed = 1;
	try {
		if (bin) await startBridge(bin);
		failed = await run("the engine against the bridge (" + (bin ? "pirate-websdr --sim" : URL_) + ")");
	} catch (e) {
		console.log("FAIL - " + String(e.message || e));
	}
	if (child && !child.gone) child.kill();
	console.log(failed ? "FAILED: " + failed : "all passed");
	process.exit(failed ? 1 : 0);
})();
