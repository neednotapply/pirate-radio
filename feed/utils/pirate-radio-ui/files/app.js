/* Pirate Radio web UI. A tiny single-page app that talks to the router's rpcd/ubus
   methods (pirate.recon, pirate.sdr) over /ubus with a root session.
   No framework. Served by uhttpd at the web root (/).

   Demo mode: open with ?demo=1 (or from a file:// path) to render built-in
   sample data without a router, for previewing the design. */
(function () {
	"use strict";

	var UBUS = "/ubus";
	// rpcd's unauthenticated session: 32 zeros, no dashes. A UUID-style id is an
	// unknown session to uhttpd, so every call (login included) is denied.
	var NULL_SID = "00000000000000000000000000000000";
	var DEMO = /[?&]demo=1/.test(location.search) || location.protocol === "file:";
	var SID = null;

	/* ---------- ubus JSON-RPC client ---------- */

	function rpc(method, params) {
		return fetch(UBUS, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params })
		}).then(function (r) { return r.json(); }).then(function (j) {
			if (j.error) {
				var e = new Error(j.error.message || "rpc error");
				e.code = j.error.code;
				throw e;
			}
			return j.result;
		});
	}

	function dropSession() {
		SID = null;
		try { sessionStorage.removeItem("pirate_sid"); } catch (e) {}
	}

	// ubus "call" returns [status, data]; status 0 == ok, 6 == permission. An
	// expired or unknown session comes back as JSON-RPC error -32002 instead,
	// and an object nothing has registered (its service not installed or not
	// running) as -32000, "Object not found": the views know that as status 4.
	function callm(object, method, params) {
		return rpc("call", [SID || NULL_SID, object, method, params || {}]).catch(function (e) {
			if (e.code === -32002) { dropSession(); throw new Error("unauthorized"); }
			if (e.code === -32000) throw new Error("ubus status 4");
			throw e;
		}).then(function (r) {
			if (!Array.isArray(r)) throw new Error("bad ubus reply");
			if (r[0] === 6) { dropSession(); throw new Error("unauthorized"); }
			if (r[0] !== 0) throw new Error("ubus status " + r[0]);
			return r[1] || {};
		});
	}

	// keep === false: don't remember the session across reloads (the first-run
	// probe, whose session must not outlive an unset password).
	function login(user, pass, keep) {
		return rpc("call", [NULL_SID, "session", "login",
			{ username: user, password: pass, timeout: 3600 }]).then(function (r) {
			if (!Array.isArray(r) || r[0] !== 0 || !r[1] || !r[1].ubus_rpc_session)
				throw new Error("login failed");
			SID = r[1].ubus_rpc_session;
			if (keep !== false) rememberSession();
			return SID;
		});
	}
	function rememberSession() {
		try { sessionStorage.setItem("pirate_sid", SID); } catch (e) {}
	}

	// call(): the one entry point the views use; serves demo data when offline.
	function call(object, method, params) {
		if (DEMO) {
			var d = MOCK[object + ":" + method];
			if (typeof d === "function") d = d(params || {});
			// An answer that takes a while, as a radio's request does
			if (d && typeof d.then === "function")
				return d.then(function (v) { return JSON.parse(JSON.stringify(v != null ? v : {})); });
			return Promise.resolve(JSON.parse(JSON.stringify(d != null ? d : {})));
		}
		return callm(object, method, params || {});
	}

	/* ---------- demo data ---------- */

	function iso(secAgo) { return new Date(Date.now() - secAgo * 1000).toISOString(); }
	function stamp(secAgo) { return new Date(Date.now() - secAgo * 1000).toISOString().replace("T", " ").replace(/\..*/, ""); }
	function pad(s, n) { s = String(s); while (s.length < n) s += " "; return s; }

	// Mutable demo job table so "Use the radio" visibly switches jobs in demo.
	var DEMO_JOBS = [
		{ name: "soapy", type: "soapy", radio: "hackrf", state: "running" },
		{ name: "adsb", type: "adsb", radio: "rtlsdr", state: "running" },
		{ name: "survey", type: "hackrf_sweep", radio: "hackrf", state: "stopped" },
		{ name: "ism", type: "rtl_433", radio: "rtlsdr", state: "off" },
		{ name: "ais", type: "rtl_ais", radio: "rtlsdr", state: "off" },
		{ name: "rtltcp", type: "rtl_tcp", radio: "rtlsdr", state: "off" }
	];
	function demoStatus() {
		var head = "pirate-radio\n  microSD:  mounted /mnt/sdcard (PIRATERADIO, 29.7G free)\n" +
			"  RTL-SDR:  present (Realtek RTL2838U, serial 00000001)\n" +
			"  HackRF:   present (serial 457863)\n\n  job        type           radio    state\n";
		return head + DEMO_JOBS.map(function (j) {
			return "  " + pad(j.name, 10) + " " + pad(j.type, 14) + " " + pad(j.radio, 8) + " " + j.state;
		}).join("\n");
	}

	// A MeshCore radio, for the Messenger page
	var DEMO_MC = (function () {
		var now = Math.floor(Date.now() / 1000), seq = 20, id = 0;
		function key(b) { var s = ""; for (var i = 0; i < 32; i++) s += b; return s; }
		var mc = {
			seq: seq, name: "🏴‍☠️ Pirate Radio", gps: false, share: true, read: {},
			contacts: [
				{ key: key("a1"), conv: "ca1a1a1a1a1a1", name: "Alice", type: "chat", hops: 1, path: [{ id: "c2", name: "Hilltop Repeater" }],
					last_advert: now - 900, lat: 37.4302, lon: -122.0712, favorite: true },
				{ key: key("b0"), conv: "cb0b0b0b0b0b0", name: "Bob", type: "chat", flood: true, last_advert: now - 7200 },
				{ key: key("d4"), conv: "cd4d4d4d4d4d4", name: "🦜 Polly", type: "chat", hops: 0, last_advert: now - 2400 },
				{ key: key("e5"), conv: "ce5e5e5e5e5e5", name: "Kiwi 🇳🇿", type: "chat", hops: 3,
					path: [{ id: "c2", name: "Hilltop Repeater" }, { id: "4f" }, { id: "9a" }], last_advert: now - 2100 },
				{ key: key("c2"), conv: "cc2c2c2c2c2c2", name: "Hilltop Repeater", type: "repeater", hops: 0, last_advert: now - 300, favorite: true }
			],
			channels: [
				{ index: 0, conv: "#0", name: "Public", secret: "8b3387e9c5cdea6ac9e5edbaa115cd72" },
				{ index: 1, conv: "#1", name: "#test", secret: "9cd8fcf22a47333b591d96a2b848b73f" },
				{ index: 4, conv: "#4", name: "#wardriving", secret: "e3c26491e9cd321e3a6be50d57d54acf" }
			],
			msgs: []
		};
		function add(m) { m.id = ++id; m.seq = ++mc.seq; mc.msgs.push(m); return m; }
		function said(conv, from, text, ago, snr, hops) {
			return add({ conv: conv, out: false, from: from, text: text, ts: now - ago, rx: now - ago, snr: snr, hops: hops });
		}
		function mine(conv, text, ago, status, more) {
			var m = { conv: conv, out: true, from: mc.name, text: text, ts: now - ago, rx: now - ago, status: status };
			for (var k in more || {}) m[k] = more[k];
			return add(m);
		}
		said("#0", "Bob", "anyone on tonight?", 90000, -5.5, 2);
		mine("#0", "here, from the van", 89900, "sent");
		said("#0", "🦜 Polly", "morning all", 2400, 6.25, 0);
		var ridge = said("#0", "🦜 Polly", "the repeater on the ridge is back", 2370, 6, 0);
		said("#0", "🦜 Polly", "hearing it at -88 from town", 2340, 5.75, 0);
		var kiwi = said("#0", "Kiwi 🇳🇿", "@[🦜 Polly] nice, it reaches the harbour too", 2100, -2.5, 3);
		kiwi.reply = ridge.id;
		// Reactions, as MeshCore One sends them (their hashes stand-ins here)
		function reacted(to, from, emoji, ago) {
			var me = from === null, ch = to.conv.charAt(0) === "#";
			return add({ conv: to.conv, out: me, from: me ? mc.name : from, text: (ch ? "@[" + to.from + "]" : "") + emoji + "\nb45pc4ek",
				emoji: emoji, react: to.id, ts: now - ago, rx: now - ago, status: me ? "sent" : undefined });
		}
		reacted(ridge, "Bob", "👍", 2330);
		reacted(ridge, "Alice", "👍", 2320);
		reacted(ridge, "Alice", "👍", 2318);   // passed on twice: one
		reacted(ridge, null, "❤️", 2300);
		reacted(kiwi, "🦜 Polly", "😂", 2050);
		mine("#0", "great news", 1500, "sent");
		var drive = mine("#0", "I'll drive up on saturday and check its battery", 1480, "sent");
		var alice = said("#0", "Alice", "@[" + mc.name + "] count me in", 1200, 9.5, 1);
		alice.reply = drive.id;
		// A reply whose client prepended a ">"-quote of what it answers; the body
		// shows only the new words (the quote is dropped, shown above).
		var quoted = said("#0", "Bob", "@[Alice]\n>count me i..\nnice, i'll bring the spare antenna", 1100, -4.5, 2);
		quoted.reply = alice.id;
		// A trailing bracketed mention: renders as an "@Name" chip, not literal.
		said("#0", "Alice", "welcome to the mesh @[Bob]", 1040, 9.5, 1);
		var read0 = alice.id;
		said("#0", "Bob", "same, if the weather holds", 600, -6, 2);
		said("#0", "🦜 Polly", "https://giphy.com/gifs/8kejjglzkEprO", 560, 6, 0);
		said("#0", "Alice", "the route's on the map: https://www.openstreetmap.org/#map=13/37.4220/-122.0840 (via the ridge)", 520, 9.5, 1);
		said("#0", "Kiwi 🇳🇿", "g:8kejjglzkEprO", 480, -2.5, 3);
		// MCOimg: a skull and crossbones, 16×20, made by MCO Advanced's own encoder; a v4 drawing
		said("#0", "🦜 Polly", "im3:qLMcgdEQ`M}.*BtB%BKthdRJGquU?WHO^vW$0%>=|^Lm&%(C", 440, 6.5, 0);
		said("#0", "Kiwi 🇳🇿", "im4:6FYA", 420, -2.5, 3);
		said("ca1a1a1a1a1a1", "Alice", "the repeater on the hill is back up", 1800, 10, 1);
		var readA = mine("ca1a1a1a1a1a1", "great, hearing it at -92", 1700, "delivered", { trip_ms: 850 }).id;
		mine("cb0b0b0b0b0b0", "still on for saturday?", 3600, "unconfirmed", { flood: true });
		said("#1", "Carol", "test from the bridge", 120, 4.25, 3);
		// MeshMapper's wardriving pings (made-up tags): Bob's, as they come; Kiwi
		// broadcasting where they are
		said("#4", "Bob", "MM:Xq3vR7tLpA", 900, -4, 6);
		said("#4", "Bob", "MM:k2Hd9wQz_m", 840, -7.5, 5);
		said("#4", "Bob", "MM:fG8sLwP1rB", 780, -10, 7);
		said("#4", "Kiwi 🇳🇿", "MM:Tn0aY4c-Ue:37.39876,-122.05432", 300, 2.25, 3);
		mc.read["#0"] = read0;
		mc.read["ca1a1a1a1a1a1"] = readA;
		mc.add = add;
		// Its settings (as the settings page sets them), repeaters logged in to, packets heard
		mc.cfg = { freq: 910525, bw: 62500, sf: 7, cr: 5, tx: 22, tel: 26, autoAdd: true, aa: 0x1e, hops: 0, acks: 0, rx: 0, af: 1000,
			lat: null, lon: null, since: Date.now() };
		mc.logins = {};
		mc.pkts = [];
		mc.pktSeq = mc.pktAt = 0;
		if (/[?&]mcbig\b/.test(location.search)) demoMcBig(mc, now);
		return mc;
	})();
	/* The demo's packets, built as MeshCore's are, from its contacts: adverts
	   (who, what kind, where), channels' and direct messages, acks, paths,
	   requests, over a hop or two */
	function demoHex(n) { var s = ""; for (var i = 0; i < n; i++) s += ("0" + Math.floor(Math.random() * 256).toString(16)).slice(-2); return s; }
	function demoLe32(v) { var s = ""; for (var i = 0; i < 4; i++) s += ("0" + (v >>> 8 * i & 255).toString(16)).slice(-2); return s; }
	function demoUtf8(t) {
		return unescape(encodeURIComponent(t)).split("").map(function (c) { return ("0" + c.charCodeAt(0).toString(16)).slice(-2); }).join("");
	}
	function demoMcPacket(at) {
		var mc = DEMO_MC, cs = mc.contacts, c = cs[Math.floor(Math.random() * cs.length)], r = Math.random();
		var hops = Math.floor(Math.random() * 3), flood = Math.random() < 0.6, reps = ["c2", "4f", "9a", "e1"], path = "", i;
		for (i = 0; i < hops; i++) path += reps[(i + c.key.charCodeAt(1)) % reps.length];
		function hdr(type) { return ("0" + (type << 2 | (flood ? 1 : 2)).toString(16)).slice(-2) + ("0" + hops.toString(16)).slice(-2) + path; }
		var hex;
		if (r < 0.25) {
			var f = 0x80 | (c.type === "repeater" ? 2 : 1) | (c.lat != null ? 0x10 : 0);
			hex = hdr(4) + c.key + demoLe32(at - 30) + demoHex(64) + ("0" + f.toString(16)).slice(-2) +
				(c.lat != null ? demoLe32(Math.round(c.lat * 1e6) >>> 0) + demoLe32(Math.round(c.lon * 1e6) >>> 0) : "") + demoUtf8(c.name);
		} else if (r < 0.45) hex = hdr(5) + mcChanHash(mc.channels[0].secret) + demoHex(2) + demoHex(16 + Math.floor(Math.random() * 40));
		else if (r < 0.65) hex = hdr(2) + c.key.slice(0, 2) + cs[Math.floor(Math.random() * cs.length)].key.slice(0, 2) + demoHex(2) + demoHex(16 + Math.floor(Math.random() * 24));
		else if (r < 0.8) hex = hdr(3) + demoHex(4);
		else if (r < 0.9) hex = hdr(8) + c.key.slice(0, 2) + cs[0].key.slice(0, 2) + demoHex(2) + demoHex(12);
		else hex = hdr(0) + c.key.slice(0, 2) + "e7" + demoHex(2) + demoHex(16);
		return { snr: Math.round((Math.random() * 20 - 8) * 4) / 4, rssi: -60 - Math.floor(Math.random() * 60), raw: hex };
	}
	// After a moment, as an answer over the mesh comes
	function demoLater(ms, v) { return new Promise(function (res) { setTimeout(function () { res(v); }, ms); }); }
	// Sharing turned off: its location telemetry, if for anyone, down to the contacts you allow (as the router's)
	function demoTelPrivate(t) { return (t >> 2 & 3) === 2 ? t & ~12 | 4 : t; }
	function demoMcSettings() {
		var c = DEMO_MC.cfg;
		return { name: DEMO_MC.name, key: "e7f3a91c0d5b2846" + "aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55", protocol: 14, cli: true, stats: true,
			radio: { freq_khz: c.freq, bw_hz: c.bw, sf: c.sf, cr: c.cr, tx_power: c.tx, max_tx_power: 22 },
			position: !DEMO_MC.gps && c.lat != null ? { lat: c.lat, lon: c.lon } : undefined, gps: DEMO_MC.gps,
			share_location: DEMO_MC.share, auto_add: c.autoAdd, extra_acks: c.acks,
			telemetry: { base: c.tel & 3, location: c.tel >> 2 & 3, environment: c.tel >> 4 & 3 },
			autoadd: { overwrite_oldest: !!(c.aa & 1), chat: !!(c.aa & 2), repeater: !!(c.aa & 4), room: !!(c.aa & 8), sensor: !!(c.aa & 16),
				any_distance: !c.hops, max_hops: c.hops ? c.hops - 1 : undefined },
			tuning: { rx_delay: c.rx / 1000, airtime_factor: c.af / 1000 } };
	}
	function demoMcCli(cmd) {
		var c = DEMO_MC.cfg, m;
		if (cmd === "ver") return "v1.18.0 (Build: 15-Oct-2026)";
		if (cmd === "board") return "LilyGo T-Echo";
		if (cmd === "get name") return "> " + DEMO_MC.name;
		if (cmd === "get radio") return "> " + mcMHz(c.freq) + "," + mcKHz(c.bw) + "," + c.sf + "," + c.cr;
		if (cmd === "get tx") return "> " + c.tx;
		if ((m = /^set tx (-?\d+)$/.exec(cmd))) { c.tx = Math.max(-9, Math.min(22, +m[1])); return "OK"; }
		if ((m = /^set name (.+)$/.exec(cmd))) { DEMO_MC.name = m[1]; return "OK"; }
		if (cmd === "reboot") return "";
		return "Unknown command";
	}
	function demoMcRemoteCli(cmd) {
		var r = {
			"ver": "MeshCore v1.18.0 (Build: 12-Oct-2026)",
			"clock": "06:12 - 8/11/2026 UTC",
			"neighbors": "4f22a81c:12:-6.25\n9a07e13d:340:2.50\ne1b9c004:1820:-11.75",
			"stats-core": "{\"battery_mv\":3950,\"uptime_secs\":86400,\"errors\":0,\"queue_len\":1}",
			"stats-radio": "{\"noise_floor\":-105,\"last_rssi\":-70,\"last_snr\":10.00,\"tx_air_secs\":3000,\"rx_air_secs\":9000}",
			"stats-packets": "{\"recv\":5000,\"sent\":4800,\"flood_tx\":2000,\"direct_tx\":2800,\"flood_rx\":3500,\"direct_rx\":1500}",
			"get radio": "> 910.525,62.5,7,5", "get tx": "> 22", "get name": "> Hilltop Repeater", "get role": "> repeater",
			"advert": "OK - Advert sent"
		};
		return r[cmd] != null ? r[cmd] : "Unknown command";
	}
	function demoMcConv(c) {
		var unread = 0, last = 0, upto = DEMO_MC.read[c.conv] || 0;
		DEMO_MC.msgs.forEach(function (m) {
			if (m.conv !== c.conv || m.emoji) return;   // a reaction is no news
			last = m.rx || m.ts;
			if (!m.out && m.id > upto) unread++;
		});
		var o = JSON.parse(JSON.stringify(c));
		o.unread = unread;
		if (last) o.last_message = last;
		return o;
	}
	// ?demo=1&mcbig=1: a radio as busy as a real one, to try the Messenger at
	// scale: 40 channels (all its slots), 350 contacts (full), 500-odd messages
	// on Public over three days, others' news in a dozen channels
	function demoMcBig(mc, now) {
		var r = 7, i, k, used = {};
		function rnd(n) { r = (Math.imul(r, 1103515245) + 12345) >>> 0; return (r >>> 12) % n; }
		var A = ["Ridge", "Harbor", "Coyote", "Nomad", "Basalt", "Kestrel", "Juniper", "Static", "Quartz", "Tumble",
			"Mesa", "Cinder", "Granite", "Willow", "Falcon", "Drift", "Ember", "Hollow", "Pike", "Sable", "Otter", "Larkspur"];
		var B = ["Rover", "Base", "Mobile", "Shack", "Peak", "Node", "Van", "Camp", "Hill", "Truck", "Lookout", "Deck"];
		var E = ["🦊", "🐢", "🌵", "⚡", "🛰️", "🏔️", "🐙", "🌊", "🔭", "🚐", "🍄", "🐝", "🦉", "🔥"];
		var T = ["anyone hearing the ridge repeater?", "copy, loud and clear from the valley", "SNR is way up since the new antenna",
			"heading out to the trailhead, will check in at the top", "morning mesh", "who's running the bot on #bots?",
			"rain moving in from the west", "repeater on Mesa Peak is back after the storm", "nice, 4 hops to the coast now",
			"testing from the truck", "that path went the long way round", "flood advert sent", "solar's keeping up, barely",
			"anyone near the harbor? need a relay", "back online", "the old mast is down for maintenance till friday",
			"got it", "thanks!", "same here", "👍", "on my way", "can someone confirm they got this?", "battery at 40%, signing off",
			"new node up on the hill, say hi", "lots of traffic tonight", "is there a net on sunday?", "73"];
		function name() {
			var s;
			do s = (rnd(4) === 0 ? E[rnd(E.length)] + " " : "") + A[rnd(A.length)] + " " + B[rnd(B.length)] + (rnd(3) ? "" : " " + (10 + rnd(90)));
			while (used[s]);
			used[s] = 1;
			return s;
		}
		function key(n) {
			var s = ("0000000" + (Math.imul(n, 2654435761) >>> 0).toString(16)).slice(-8) + ("000" + n.toString(16)).slice(-4);
			while (s.length < 64) s += "ab";
			return s;
		}
		var reps = [];
		for (i = 0; i < 345; i++) {
			var type = i < 38 ? "chat" : i < 316 ? "repeater" : "room", kk = key(0x5000 + i), flood = rnd(7) === 0;
			var c = { key: kk, conv: "c" + kk.slice(0, 12), name: type === "repeater" ? "RPT " + name() : name(), type: type,
				last_advert: now - rnd(86400 * 25) };
			if (flood) c.flood = true; else c.hops = rnd(5);
			if (rnd(3) === 0) { c.lat = 37.35 + rnd(2000) / 10000; c.lon = -122.2 + rnd(3000) / 10000; }
			mc.contacts.push(c);
			if (type === "repeater") reps.push(c);
		}
		// Routes through the repeaters heard
		mc.contacts.forEach(function (c) {
			if (!c.hops || c.path) return;
			c.path = [];
			for (k = 0; k < c.hops; k++) {
				var rp = reps[rnd(reps.length)];
				c.path.push(rnd(5) ? { id: rp.key.slice(0, 2), name: rp.name } : { id: rp.key.slice(0, 2) });
			}
		});
		var CH = ["#sf", "#bayarea", "#emergency", "#weather", "#hiking", "#ham", "#repeaters", "#testing", "#bots", "#alerts",
			"#earthquake", "#events", "#marine", "#aviation", "#roads", "#fire", "#coffee", "#offgrid", "#solar", "#antennas",
			"#firmware", "#trading", "#music", "#photos", "#lost-and-found", "#local", "#north", "#south", "#east", "#west",
			"Crew", "Family", "Base Camp", "Ops", "Night Shift", "Search and Rescue", "Garage", "Book Club"];
		for (i = 0; i < CH.length; i++) mc.channels.push({ index: i + 2, conv: "#" + (i + 2), name: CH[i], secret: key(0x900 + i).slice(32) });
		var people = mc.contacts.filter(function (c) { return c.type === "chat"; }), gen = [];
		function talk(conv, n, from, span) {
			var t = now - span, list = [];
			while (list.length < n && t < now - 120) {
				var mine = rnd(11) === 0, p = people[rnd(people.length)], run = rnd(4) === 0 ? 2 + rnd(3) : 1;
				t += 40 + rnd(Math.floor(span / n * 1.6));
				for (k = 0; k < run && list.length < n; k++) {
					var m = mine ? { conv: conv, out: true, from: mc.name, text: T[rnd(T.length)], ts: t + k * 25, status: "sent" }
						: { conv: conv, out: false, from: p.name, text: T[rnd(T.length)], ts: t + k * 25, snr: (rnd(64) - 32) / 4, hops: rnd(5) };
					if (k === 0 && list.length > 6 && rnd(7) === 0) {
						m.re = list[list.length - 1 - rnd(6)];
						m.text = "@[" + m.re.from + "] " + m.text;
					}
					m.rx = m.ts;
					list.push(m);
				}
				// Now and then, reactions to something said lately
				if (list.length > 4 && rnd(5) === 0) {
					var to = list[list.length - 1 - rnd(4)], nr = 1 + rnd(3);
					if (to.emoji) to = list[list.length - 1];
					for (k = 0; k < nr && !to.emoji; k++) {
						var rp = people[rnd(people.length)], em = ["👍", "❤️", "😂", "🔥", "👀", "🙏"][rnd(6)];
						list.push({ conv: conv, out: false, from: rp.name, emoji: em, rto: to, ts: t + 30 + k * 7, rx: t + 30 + k * 7,
							text: (conv.charAt(0) === "#" ? "@[" + to.from + "]" : "") + em + "\nb45pc4ek" });
					}
				}
			}
			gen = gen.concat(list);
		}
		talk("#0", 520, null, 86400 * 3);
		for (i = 0; i < 12; i++) talk("#" + (2 + rnd(38)), 5 + rnd(40), null, 86400 * 2);
		for (i = 0; i < 9; i++) talk(people[i].conv, 3 + rnd(12), null, 86400 * 4);
		gen.forEach(function (m) { if (!m.out && m.conv.charAt(0) === "c") m.from = mc.contacts.filter(function (c) { return c.conv === m.conv; })[0].name; });
		// All in time order, numbered afresh, replies pointing at theirs
		var all = mc.msgs.concat(gen).sort(function (a, b) { return a.ts - b.ts; }), oldIds = {};
		mc.msgs = [];
		all.forEach(function (m) { var was = m.id; mc.add(m); if (was) oldIds[was] = m; });
		all.forEach(function (m) {
			if (m.re) { m.reply = m.re.id; delete m.re; }
			else if (m.reply && oldIds[m.reply] && oldIds[m.reply] !== m) m.reply = oldIds[m.reply].id;
			if (m.rto) { m.react = m.rto.id; delete m.rto; }
			else if (m.react && oldIds[m.react]) m.react = oldIds[m.react].id;
		});
		// Read up to a few from the end, here and there: news to show
		mc.read = {};
		mc.channels.concat(mc.contacts).forEach(function (c) {
			var mine = all.filter(function (m) { return m.conv === c.conv; }), back = rnd(3) ? 0 : 1 + rnd(14);
			if (c.conv === "#0") back = 23;
			if (mine.length) mc.read[c.conv] = mine[Math.max(0, mine.length - 1 - back)].id;
		});
	}
	// A trace, a route found, telemetry: answered a moment later, as a radio's are
	function demoMcAsk(p, kind) {
		var c = DEMO_MC.contacts.filter(function (x) { return x.key.indexOf(String(p.key || "")) === 0 || x.conv === p.key; })[0];
		return new Promise(function (done) {
			setTimeout(function () { done(demoMcAnswer(c, kind)); }, kind === "trace" ? 900 : 1700);
		});
	}
	function demoMcAnswer(c, kind) {
		if (!c) return { error: "no such contact" };
		if (kind === "trace") {
			var hops = c.path || [], rep = c.type === "repeater";
			if (c.flood) return { error: "no route known to trace: discover one first" };
			if (!rep && !hops.length) return { error: "heard directly: there's no repeater between you to trace" };
			if (c.name === "Kiwi 🇳🇿") return { error: "no answer: the trace didn't come back (a repeater on the way may be out of reach)" };
			var way = hops.concat(rep ? [{ id: c.key.slice(0, 2), name: c.name }] : []).concat(hops.slice(0, rep ? hops.length : hops.length - 1).reverse());
			return { ok: true, ms: 640 + way.length * 210, snr_back: 4.75, hops: way.map(function (h, i) {
				return { id: h.id, name: h.name, snr: Math.round((9.5 - i * 3.25) * 4) / 4 };
			}) };
		}
		if (kind === "discover") {
			var rpt = DEMO_MC.contacts.filter(function (x) { return x.type === "repeater"; })[0];
			var path = [{ id: rpt.key.slice(0, 2), name: rpt.name }];
			c.path = path; c.hops = 1; delete c.flood;
			return { ok: true, ms: 2300, out: path, "in": path, kept: true };
		}
		if (c.type !== "chat" || c.flood) return { error: "no answer: they may not share telemetry with you, or be out of reach" };
		var r = [{ channel: 1, kind: "voltage", value: 3.98, unit: "V" }, { channel: 1, kind: "temperature", value: 18.5, unit: "°C" }];
		if (c.lat != null) r.push({ channel: 1, kind: "gps", lat: c.lat + 0.0021, lon: c.lon - 0.0013, alt: 41 });
		return { ok: true, ms: 1400, readings: r };
	}
	// A message as the daemon gives it: a reply with what it answers
	function demoMcMsg(m) {
		var o = JSON.parse(JSON.stringify(m)), r;
		if (m.reply && (r = DEMO_MC.msgs.filter(function (x) { return x.id === m.reply; })[0])) {
			o.reply_from = r.from; o.reply_text = r.text;
			if (r.out) o.reply_out = true;
		}
		return o;
	}
	function demoMcPos() {
		var t = Date.now() / 1000;
		return { lat: 37.421925 + Math.sin(t / 7) * 0.000004, lon: -122.084102 + Math.cos(t / 9) * 0.000004 };
	}
	var DEMO_ADB = { on: true };
	var DEMO_ACCESS = {
		port: 22, passwords: true, term: true,
		keys: [
			{ type: "ssh-ed25519", comment: "pirate-radio@NV-FRACTAL", fingerprint: "SHA256:iAz+d0Ubhxwu5AWxrSZcHcuftUXHrXB5uRb9s8fnSO0" },
			{ type: "ssh-rsa", comment: "laptop key", fingerprint: "SHA256:sNIAzx6YYwB8XVn4c9avCjnUWWgXtXTT3ki7q9gzo/s" }
		],
		sessions: [
			{ kind: "ssh", pid: 6042, from: "192.168.1.23", age: 1260, how: "key", key: "SHA256:iAz+d0Ubhxwu5AWxrSZcHcuftUXHrXB5uRb9s8fnSO0" },
			{ kind: "terminal", pid: 7120, from: "192.168.1.23", age: 95, how: "password" }
		]
	};
	function demoAccess() {
		var now = Math.floor(Date.now() / 1000);
		return { running: true, port: DEMO_ACCESS.port, passwords: DEMO_ACCESS.passwords,
			keys: DEMO_ACCESS.keys.slice(),
			host_keys: [
				{ type: "ssh-ed25519", fingerprint: "SHA256:fWwYR2TCym4ZOauPytQjwxHNhyadH+lGpEXmecFzits" },
				{ type: "ssh-rsa", fingerprint: "SHA256:IAuM2rOta+8o07whdCPUIWWkPKKAi82FYtp3/y5Y3/k" }
			],
			sessions: DEMO_ACCESS.sessions.slice(),
			recent: [
				{ time: now - 95, event: "in", how: "terminal" },
				{ time: now - 600, event: "refused", from: "192.168.1.99", how: "password" },
				{ time: now - 1260, event: "in", from: "192.168.1.23", how: "key", key: "SHA256:iAz+d0Ubhxwu5AWxrSZcHcuftUXHrXB5uRb9s8fnSO0" },
				{ time: now - 7200, event: "out", from: "192.168.1.23" },
				{ time: now - 9000, event: "in", from: "192.168.1.23", how: "password" }
			] };
	}
	var DEMO_CAP = {
		running: false, iface: "", filter: "", file: "", start: 0,
		files: [
			{ name: "cap-20261029-1355.pcap", size: 5242880, mtime: "2026-10-29 13:55" },
			{ name: "dns-cap-20261029-1402.pcap0", size: 3145728, mtime: "2026-10-29 14:02" }
		]
	};
	var DEMO_HS = {
		running: false, phy: "", channel: "", file: "", start: 0,
		files: [ { name: "home-hs-ch6-20261029-1310.pcap", size: 28672, mtime: "2026-10-29 13:10" } ]
	};
	var DEMO_FW = { staged: false, size: 0, verified: false };
	var DEMO_DP = { enabled: true, service: "ppp", dial_tone: true, dcnow: true, dmz: false };
	var DEMO_DCNOW = { name: "Unnamed_2bec1b", id: "2bec1b43c9a2c523e3bcbeac146109088a0643419e1b39837057632447d93082", as_pi: false };
	function demoDreampi() {
		var s = { installed: true, local_ip: "192.168.169.1", dreamcast_ip: "192.168.169.2", wan_ip: "192.168.1.185",
			modems: [{ device: "/dev/ttyACM0", id: "0572:1340", name: "Conexant USB modem (Dell NW147, Lenovo RD02-D400, TRENDnet TFM-561U)" }],
			state: DEMO_DP.enabled ? "connected" : "off", call_service: "ppp", number: "5551234",
			since: Math.round(Date.now() / 1000) - 754, link: DEMO_DP.enabled, rx_bytes: 482113, tx_bytes: 2310442,
			lookup: "dc.dreamcastlive.net", dcnow_name: DEMO_DCNOW.name, dcnow_id: DEMO_DCNOW.id, dcnow_as_dreampi: DEMO_DCNOW.as_pi };
		for (var k in DEMO_DP) s[k] = DEMO_DP[k];
		return s;
	}

	var DEMO_USB = { enabled: true, card: false, password: false, ejected: false };
	var DEMO_USB_FILES = {
		"": [{ name: "Music", dir: true }, { name: "Photos", dir: true }, { name: "notes.txt", size: 2048 },
			{ name: "pirate-radio-backup.tar.gz", size: 48213 }],
		"Music": [{ name: "mixtape.mp3", size: 7340032 }],
		"Photos": [{ name: "2026", dir: true }, { name: "slate.jpg", size: 2516582 }],
		"Photos/2026": [{ name: "dreamcast.jpg", size: 1887436 }]
	};
	var DEMO_CARD_FILES = {
		"": [{ name: "pirate-radio", dir: true }, { name: "recon", dir: true }, { name: "survey", dir: true }]
	};
	function demoUsb() {
		var drives = DEMO_USB.ejected ? [] : [{ name: "KINGSTON", device: "sdb1", disk: "sdb", label: "KINGSTON", fs: "exfat",
			model: "Kingston DataTraveler 3.0", size: 30943995904, used: 13207024435, free: 17736971469, readonly: false, card: false }];
		if (DEMO_USB.card) drives.push({ name: "microSD", device: "sda1", disk: "sda", label: "PIRATERADIO", fs: "exfat",
			model: "microSD card", size: 61847109632, used: 40960000, free: 61806149632, readonly: false, card: true });
		return { installed: true, enabled: DEMO_USB.enabled, sharing: DEMO_USB.enabled && drives.length > 0, user: "pirate",
			password: DEMO_USB.password, host: "PirateRadio", http_port: 8082, card: DEMO_USB.card, card_in: true, drives: drives };
	}

	/* The Phone page's demo: a Pixel whose USB mode can be switched, with a
	   few files and every mode supported so the page can be seen whole. */
	var DEMO_PHONE = { present: true, mode: "charge", tetherUp: false, webcamOn: false };
	var DEMO_PHONE_FILES = {
		"/sdcard": [{ name: "DCIM", dir: true }, { name: "Download", dir: true }, { name: "Music", dir: true },
			{ name: "Pictures", dir: true }, { name: "readme.txt", size: 1234 }],
		"/sdcard/DCIM": [{ name: "Camera", dir: true }],
		"/sdcard/DCIM/Camera": [{ name: "PXL_20261101_120000.jpg", size: 3812456 }, { name: "PXL_20261102_party.mp4", size: 48213556 }],
		"/sdcard/Download": [{ name: "pirate-radio.bin", size: 9123456 }, { name: "song.flac", size: 28217344 }],
		"/sdcard/Music": [{ name: "mixtape.mp3", size: 7340032 }],
		"/sdcard/Pictures": []
	};
	function demoPhone() {
		return {
			adb_installed: true, present: DEMO_PHONE.present,
			vendor_id: "18d1", product_id: "4ee7", vendor: "Google",
			mode: DEMO_PHONE.mode,
			supports: { tether: true, midi: true, webcam: true },
			tether: DEMO_PHONE.tetherUp ? { up: true, iface: "usb0", wan_ip: "192.168.42.101" } : undefined,
			webcam_stream: DEMO_PHONE.webcamOn ? { running: true, port: 8083 } : undefined
		};
	}

	/* The Flipper page's demo: a few files, and a menu on its screen */
	var DEMO_FZ = { seq: 1, item: 0 };
	var DEMO_FZ_FILES = {
		"/": [{ name: "any", dir: true }, { name: "int", dir: true }, { name: "ext", dir: true }],
		"/int": [{ name: ".bt.settings", size: 52 }],
		"/ext": [{ name: "badusb", dir: true }, { name: "infrared", dir: true }, { name: "nfc", dir: true },
			{ name: "subghz", dir: true }, { name: "notes.txt", size: 14 }],
		"/ext/badusb": [{ name: "hello.txt", size: 88 }],
		"/ext/infrared": [{ name: "TV.ir", size: 1204 }],
		"/ext/nfc": [],
		"/ext/subghz": [{ name: "garage.sub", size: 412 }]
	};
	var DEMO_FZ_MENU = ["Sub-GHz", "RFID", "NFC", "Infrared", "GPIO", "iButton", "Bad USB"];
	// The screen as the Flipper sends it: 128x64, a byte for 8 rows of a column
	function demoFlipperFrame() {
		var c = document.createElement("canvas"), g, px, bytes = new Uint8Array(1024), x, y, i, top;
		c.width = 128; c.height = 64;
		g = c.getContext("2d");
		g.fillStyle = "#fff"; g.fillRect(0, 0, 128, 64);
		g.fillStyle = "#000"; g.font = "bold 10px monospace"; g.textBaseline = "top";
		top = Math.max(0, Math.min(DEMO_FZ.item - 1, DEMO_FZ_MENU.length - 4));
		for (i = 0; i < 4; i++) {
			var n = top + i;
			if (n === DEMO_FZ.item) { g.fillRect(2, 2 + i * 15, 118, 14); g.fillStyle = "#fff"; }
			g.fillText(DEMO_FZ_MENU[n], 8, 4 + i * 15);
			g.fillStyle = "#000";
		}
		g.fillRect(124, 2 + Math.round(DEMO_FZ.item * 58 / DEMO_FZ_MENU.length), 3, 8);
		px = g.getImageData(0, 0, 128, 64).data;
		for (y = 0; y < 64; y++)
			for (x = 0; x < 128; x++)
				if (px[(y * 128 + x) * 4] < 128) bytes[(y >> 3) * 128 + x] |= 1 << (y & 7);
		var s = "";
		for (i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
		return btoa(s);
	}
	function demoFzEntry(path) {
		var dir = path.replace(/\/[^/]*$/, "") || "/", name = path.replace(/^.*\//, "");
		var list = DEMO_FZ_FILES[dir];
		return { list: list, dir: dir, name: name, i: list ? list.map(function (f) { return f.name; }).indexOf(name) : -1 };
	}

	var MOCK = {
		"pirate.flipper:status": { state: "ready", device: "/dev/ttyACM0", name: "Pirate", model: "Flipper Zero",
			firmware: "1.3.4", branch: "release", build_date: "04-11-2026", commit: "a1b2c3d4", battery: 87,
			charging: "charging", protobuf: "0.25", sd: true, sd_total: 31914983424, sd_free: 30120000000 },
		"pirate.flipper:info": {
			info: { hardware_model: "Flipper Zero", hardware_name: "Pirate", hardware_region: "1",
				hardware_otp_ver: "2", firmware_version: "1.3.4", firmware_branch: "release",
				firmware_commit: "a1b2c3d4", firmware_build_date: "04-11-2026", radio_alive: "true",
				radio_stack_major: "1", radio_stack_minor: "20" },
			power: { charge_level: "87", charge_state: "charging", battery_voltage: "4.05", battery_health: "100" }
		},
		"pirate.flipper:screen": function (p) {
			if (p.seq === DEMO_FZ.seq) return { state: "ready", seq: DEMO_FZ.seq };
			return { state: "ready", seq: DEMO_FZ.seq, frame: demoFlipperFrame(), orientation: "horizontal" };
		},
		"pirate.flipper:input": function (p) {
			if (/short|repeat/.test(p.type || "click") || p.type === "click") {
				if (p.key === "up") DEMO_FZ.item = (DEMO_FZ.item + DEMO_FZ_MENU.length - 1) % DEMO_FZ_MENU.length;
				if (p.key === "down") DEMO_FZ.item = (DEMO_FZ.item + 1) % DEMO_FZ_MENU.length;
				DEMO_FZ.seq++;
			}
			return { ok: true };
		},
		"pirate.flipper:list": function (p) {
			var list = DEMO_FZ_FILES[p.path];
			if (!list) return { error: "no such file or folder" };
			return { path: p.path, files: list.map(function (f) { return { name: f.name, dir: !!f.dir, size: f.size || 0 }; }) };
		},
		"pirate.flipper:read": function (p) {
			var e = demoFzEntry(p.path), f = e.i >= 0 ? e.list[e.i] : null, text;
			if (!f || f.dir) return { error: "no such file or folder" };
			text = "Pirate Radio demo: " + p.path + "\n";
			if (p.offset == null) return { ready: true, size: text.length };
			return { size: text.length, offset: 0, data: btoa(text), more: false };
		},
		"pirate.flipper:write": function (p) {
			var e = demoFzEntry(p.path), n = Math.floor((p.data || "").length * 3 / 4);
			if (!p.more && e.list && e.i < 0) e.list.push({ name: e.name, size: (p.offset || 0) + n });
			return p.more ? { ok: true, received: (p.offset || 0) + n } : { ok: true, size: (p.offset || 0) + n };
		},
		"pirate.flipper:mkdir": function (p) {
			var e = demoFzEntry(p.path);
			if (!e.list) return { error: "no such file or folder" };
			if (e.i >= 0) return { error: "already exists" };
			e.list.push({ name: e.name, dir: true });
			DEMO_FZ_FILES[p.path] = [];
			return { ok: true };
		},
		"pirate.flipper:delete": function (p) {
			var e = demoFzEntry(p.path);
			if (e.i < 0) return { error: "no such file or folder" };
			if (e.list[e.i].dir && (DEMO_FZ_FILES[p.path] || []).length && !p.recursive) return { error: "the folder isn't empty" };
			e.list.splice(e.i, 1);
			delete DEMO_FZ_FILES[p.path];
			return { ok: true };
		},
		"pirate.flipper:rename": function (p) {
			var e = demoFzEntry(p.path), t = demoFzEntry(p.to);
			if (e.i < 0) return { error: "no such file or folder" };
			if (t.i >= 0) return { error: "already exists" };
			e.list[e.i].name = t.name;
			if (DEMO_FZ_FILES[p.path]) { DEMO_FZ_FILES[p.to] = DEMO_FZ_FILES[p.path]; delete DEMO_FZ_FILES[p.path]; }
			return { ok: true };
		},
		"pirate.flipper:alert": { ok: true },
		"pirate.flipper:time": { ok: true },
		"pirate.flipper:reboot": { ok: true },
		"pirate.usb:status": demoUsb,
		"pirate.usb:list": function (p) {
			var files = p.name === "KINGSTON" && !DEMO_USB.ejected ? DEMO_USB_FILES : p.name === "microSD" && DEMO_USB.card ? DEMO_CARD_FILES : null;
			if (!files) return { error: "no such drive" };
			var list = files[p.path || ""];
			if (!list) return { error: "no such folder" };
			var t = Math.round(Date.now() / 1000) - 86400;
			return { path: p.path || "", total: list.length, truncated: false, entries: list.map(function (f, i) {
				return { name: f.name, dir: !!f.dir, size: f.size || 0, mtime: t - i * 3600 };
			}) };
		},
		"pirate.usb:eject": function (p) {
			if (p.name === "microSD" && DEMO_USB.card) return { error: "the microSD card can't be ejected here: turn off sharing it instead" };
			if (p.name !== "KINGSTON" || DEMO_USB.ejected) return { error: "no such drive" };
			DEMO_USB.ejected = true;
			setTimeout(function () { DEMO_USB.ejected = false; }, 15000);   // "plugged in again"
			return { ok: true, name: p.name };
		},
		"pirate.usb:set": function (p) {
			if ("enabled" in p) DEMO_USB.enabled = !!p.enabled;
			if ("card" in p) DEMO_USB.card = !!p.card;
			return demoUsb();
		},
		"pirate.usb:set_password": function (p) {
			if (p.password && p.password.length < 5) return { error: "use at least 5 characters" };
			DEMO_USB.password = !!p.password;
			return demoUsb();
		},
		"pirate.phone:status": demoPhone,
		"pirate.phone:set_mode": function (p) {
			DEMO_PHONE.mode = p.mode === "ncm" ? "tether" : p.mode;
			if (DEMO_PHONE.mode !== "tether") DEMO_PHONE.tetherUp = false;
			if (DEMO_PHONE.mode !== "webcam") DEMO_PHONE.webcamOn = false;
			return demoPhone();
		},
		"pirate.phone:adb_wifi": function () { return { ok: true, ip: "10.69.4.175" }; },
		"pirate.phone:files": function (p) {
			var path = p.path || "/sdcard", e = DEMO_PHONE_FILES[path];
			if (!e) return { error: "no such folder" };
			return { path: path, entries: e.map(function (x) { return { dir: !!x.dir, size: x.size || 0, name: x.name }; }) };
		},
		"pirate.phone:pull": function (p) {
			var n = String(p.path || "").split("/").pop();
			return { ok: true, name: n, url: "data:text/plain,demo%20download", size: 123456 };
		},
		"pirate.phone:tether": function (p) { DEMO_PHONE.tetherUp = p.action === "up"; return demoPhone(); },
		"pirate.phone:webcam": function (p) { DEMO_PHONE.webcamOn = p.action === "start"; return { ok: true, port: 8083, path: "/stream" }; },
		"pirate.phone:midi": function () { return { ports: [{ name: "midiC1D0" }] }; },
		"pirate.recon:dashboard": {
			uplink: { ssid: "NoInternetHere-5", iface: "phy0-sta0",
				subnet: "192.168.1.0/24", gateway: "192.168.1.1", online: true },
			hosts: { count: 5, scanned: "2026-10-29 14:02" },
			survey: { count: 38 },
			threats: { count: 1, high: 1 },
			gps: { installed: true, running: true },
			radios: [
				{ iface: "mon0", mode: "Monitor", ssid: "", channel: 10 },
				{ iface: "phy0-ap0", mode: "Master", ssid: "Pirate Radio", channel: 36 },
				{ iface: "phy0-sta0", mode: "Client", ssid: "NoInternetHere-5", channel: 36 }
			],
			sdr: { present: true, running: 3 }
		},
		"pirate.recon:uplink": { ssid: "NoInternetHere-5", iface: "phy0-sta0", self: "192.168.1.185",
			subnet: "192.168.1.0/24", gateway: "192.168.1.1", gateway_mac: "a4:2b:b0:11:22:33" },
		"pirate.recon:hosts": {
			scanned: "2026-10-29T14:02:11Z",
			hosts: [
				{ ip: "192.168.1.1", mac: "a4:2b:b0:11:22:33", vendor: "Netgear", gateway: true },
				{ ip: "192.168.1.10", mac: "b8:27:eb:aa:bb:cc", vendor: "Raspberry Pi Foundation" },
				{ ip: "192.168.1.23", mac: "3c:22:fb:12:34:56", vendor: "Apple, Inc." },
				{ ip: "192.168.1.42", mac: "dc:a6:32:77:88:99", vendor: "Raspberry Pi Trading" },
				{ ip: "192.168.1.185", mac: "e4:5f:01:ab:cd:ef", vendor: "(Unknown)", self: true }
			]
		},
		"pirate.recon:ports": function (p) {
			return { target: p.target, ports: [
				{ port: 22, proto: "tcp", service: "ssh" },
				{ port: 80, proto: "tcp", service: "http" },
				{ port: 443, proto: "tcp", service: "https" }
			] };
		},
		"pirate.recon:survey_networks": function () {
			return { total: 38, networks: [
				{ ssid: "Pirate Radio", bssid: "a4:2b:b0:aa:00:01", channel: 36, security: "WPA3", best_signal: -31, count: 210, last: iso(20), lat: 37.42193, lon: -122.08400 },
				{ ssid: "NoInternetHere-5", bssid: "a4:2b:b0:11:22:34", channel: 6, security: "WPA3", best_signal: -44, count: 142, last: iso(45), lat: 37.42191, lon: -122.08411 },
				{ ssid: "CoffeeShop", bssid: "aa:bb:cc:00:11:22", channel: 1, security: "Open", best_signal: -58, count: 31, last: iso(240), lat: 37.42210, lon: -122.08455 },
				{ ssid: "xfinitywifi", bssid: "06:1d:ac:31:aa:10", channel: 11, security: "Open", best_signal: -73, count: 9, last: iso(1800) },
				{ ssid: "", bssid: "e8:de:27:44:55:66", channel: 11, security: "WPA", best_signal: -81, count: 4, last: iso(7200) }
			] };
		},
		"pirate.recon:survey_gps": { installed: true, running: true, device: "/dev/ttyACM0",
			fix: "3D", lat: 37.421925, lon: -122.084102, sats_used: 9, sats: 12 },
		"pirate.recon:survey_scan": { phy: "phy1", found: 6, total: 38, gps: true, saved: true },
		"pirate.recon:survey_clear": {},
		"pirate.recon:threats_rogue": {
			total_networks: 38,
			protected: ["Pirate Radio", "NoInternetHere-5"],
			threats: [{
				type: "evil_twin", severity: "high", ssid: "CoffeeShop",
				detail: "\"CoffeeShop\" is advertised both open and secured — a classic evil-twin setup.",
				bssids: [
					{ bssid: "aa:bb:cc:00:11:22", security: "Open", signal: -58, channel: 1 },
					{ bssid: "aa:bb:cc:00:11:23", security: "WPA", signal: -66, channel: 6 }
				]
			}]
		},
		"pirate.recon:threats_deauth": function (p) {
			var secs = Number(p.secs) || 15;
			return { alert: false, total: 4, window_s: secs, channel: 6, deauth: 3, disassoc: 1,
				sources: [{ mac: "de:ad:be:ef:00:01", count: 3 }, { mac: "de:ad:be:ef:00:02", count: 1 }] };
		},
		"pirate.recon:scan": function (p) {
			if (p.profile === "ping")
				return { profile: "ping", target: p.target, saved: "scan-ping-20261029-1405.txt",
					hosts: [{ ip: "192.168.1.1" }, { ip: "192.168.1.10" }, { ip: "192.168.1.23" }, { ip: "192.168.1.42" }] };
			var svc = p.profile === "service";
			return { profile: p.profile, target: p.target, saved: "scan-" + p.profile + "-20261029-1405.txt",
				hosts: [{ ip: (/^[0-9.]+$/.test(p.target || "") ? p.target : "192.168.1.10"), ports: [
					{ port: 22, proto: "tcp", service: "ssh", version: svc ? "OpenSSH 9.6" : "" },
					{ port: 80, proto: "tcp", service: "http", version: svc ? "nginx 1.26" : "" },
					{ port: 443, proto: "tcp", service: "https", version: svc ? "nginx 1.26" : "" },
					{ port: 8080, proto: "tcp", service: "http-proxy", version: "" }
				] }] };
		},
		"pirate.sdr:use": function (p) {
			var job = DEMO_JOBS.filter(function (j) { return j.name === p.job; })[0];
			var stopped = [];
			if (job) {
				DEMO_JOBS.forEach(function (j) {
					if (j.radio === job.radio && j.name !== job.name && j.state === "running") { j.state = "off"; stopped.push(j.name); }
				});
				job.state = "running";
			}
			return { job: p.job, radio: job ? job.radio : "", switched: true, stopped: stopped };
		},
		"pirate.sdr:devices": function () {
			return { now: Math.floor(Date.now() / 1000), enabled: true,
				frequencies: ["433.92M", "315M", "915M"], hop_interval: 600, decoded: 212,
				devices: [
					{ model: "Acurite-Tower", id: 12345, channel: "A", first: stamp(9000), last: stamp(28), count: 96, freq: "433.92M", readings: { temperature_C: 21.4, humidity: 48, battery_ok: 1 } },
					{ model: "LaCrosse-TX141THBv2", id: 88, channel: 2, last: stamp(140), count: 41, freq: "915M", readings: { temperature_C: 19.8, humidity: 55 } },
					{ model: "Toyota-TPMS", id: "8fa21c", last: stamp(600), count: 6, freq: "315M", readings: { pressure_PSI: 32.1, temperature_C: 27.0 } },
					{ model: "Honeywell-Door", id: 7781, last: stamp(3600), count: 3, freq: "345M", readings: { state: "open", battery_ok: 1 } }
				] };
		},
		"pirate.router:status": {
			hostname: "pirate-radio", model: "GL.iNet GL-AR750S (NAND)", firmware: "OpenWrt 25.12.6",
			uptime: 48212, load: "0.42",
			memory: { total: 124416, free: 38160, available: 51232 },
			flash: { total: 98304, free: 72960 }, online: true, lan_ip: "192.168.8.1"
		},
		"pirate.router:clients": {
			clients: [
				{ mac: "b8:27:eb:aa:bb:cc", ip: "192.168.1.10", host: "raspberrypi" },
				{ mac: "3c:22:fb:12:34:56", ip: "192.168.1.23", host: "nicks-iphone" },
				{ mac: "dc:a6:32:77:88:99", ip: "192.168.1.42", host: "octoprint" },
				{ mac: "e4:5f:01:ab:cd:ef", ip: "192.168.1.185", host: "-" }
			]
		},
		"pirate.router:adblock": function (p) {
			if (p && (p.enabled === true || p.enabled === 1 || p.enabled === "1" || p.enabled === "true")) DEMO_ADB.on = true;
			else if (p && (p.enabled === false || p.enabled === 0 || p.enabled === "0" || p.enabled === "false")) DEMO_ADB.on = false;
			return { installed: true, enabled: DEMO_ADB.on, running: DEMO_ADB.on, domains: 58781 };
		},
		"pirate.router:wifi_status": { configured: true, ssid: "NoInternetHere-5", encryption: "psk2", connected: true, live_ssid: "NoInternetHere-5", signal: -58 },
		"pirate.router:wifi_scan": {
			networks: [
				{ ssid: "NoInternetHere-5", bssid: "78:d2:94:75:db:ca", channel: 36, signal: -58, enc: "wpa2" },
				{ ssid: "CoffeeShop", bssid: "aa:bb:cc:00:11:22", channel: 1, signal: -67, enc: "open" },
				{ ssid: "Neighbor-5G", bssid: "e8:de:27:44:55:66", channel: 149, signal: -74, enc: "wpa3" },
				{ ssid: "", bssid: "12:34:56:78:9a:bc", channel: 6, signal: -81, enc: "wpa2" }
			]
		},
		"pirate.router:wifi_join": function (p) {
			if (!p.ssid) return { error: "no SSID" };
			var e = p.enc === "open" ? "none" : (p.enc === "wpa3" ? "sae" : "psk2");
			if (e !== "none" && !p.key) return { error: "this network needs a password" };
			return { ok: true, ssid: p.ssid, encryption: e };
		},
		"pirate.router:set_password": function (p) {
			if (!p.password) return { error: "empty password" };
			if (p.password.length < 5) return { error: "use at least 5 characters" };
			if (!p.proof) return { error: "enter the current password to change it" };
			return { ok: true };
		},
		"pirate.router:ports": {
			ethernet: [
				{ port: 1, name: "WAN", iface: "eth0.2", link: false },
				{ port: 2, name: "LAN 1", iface: "eth0.1", link: true, speed: 1000, full_duplex: true },
				{ port: 3, name: "LAN 2", iface: "eth0.1", link: false }
			],
			radios: [
				{ phy: "phy0", band: "5 GHz", chip: "QCA9887", driver: "ath10k_pci", usb: false, interfaces: [
					{ name: "phy0-sta0", type: "managed", channel: 36, ssid: "NoInternetHere-5" },
					{ name: "phy0-ap0", type: "AP", channel: 36, ssid: "Pirate Radio" }
				] },
				{ phy: "phy1", band: "2.4 GHz", chip: "QCA9563", driver: "ath9k", usb: false, interfaces: [
					{ name: "mon0", type: "monitor", channel: 10 }
				] }
			],
			usb: [ { id: "0483:5740", name: "Flipper Devices Inc. Pirate" } ],
			card: { present: true, device: "sda" }
		},
		"pirate.access:ssh_status": function () { return demoAccess(); },
		"pirate.access:ssh_set": function (p) {
			var port = Number(p.port);
			if (!port || port < 1 || port > 65535) return { error: "port: a number, 1 to 65535" };
			if (!p.passwords && !DEMO_ACCESS.keys.length) return { error: "add a key first: with passwords off and no key, nobody could sign in over SSH" };
			DEMO_ACCESS.port = port; DEMO_ACCESS.passwords = !!p.passwords;
			return { ok: true, port: port, passwords: !!p.passwords };
		},
		"pirate.access:ssh_key_add": function (p) {
			var f = String(p.key || "").trim().split(/\s+/);
			if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+)$/.test(f[0])) return { error: "key: paste a public key's line, such as ssh-ed25519 AAAA… you@computer" };
			if (!f[1] || f[1].length < 60) return { error: "key: that isn't a whole public key" };
			var fp = "SHA256:" + f[1].slice(-43);
			DEMO_ACCESS.keys.push({ type: f[0], comment: f.slice(2).join(" ") || undefined, fingerprint: fp });
			return { ok: true, fingerprint: fp };
		},
		"pirate.access:ssh_key_remove": function (p) {
			if (DEMO_ACCESS.keys.length === 1 && !DEMO_ACCESS.passwords) return { error: "that's the last key, and SSH takes no passwords: turn passwords on first" };
			DEMO_ACCESS.keys = DEMO_ACCESS.keys.filter(function (k) { return k.fingerprint !== p.fingerprint; });
			return { ok: true };
		},
		"pirate.access:session_end": function (p) {
			DEMO_ACCESS.sessions = DEMO_ACCESS.sessions.filter(function (s) { return s.pid !== p.pid; });
			return { ok: true };
		},
		"pirate.access:term_status": function () { return { installed: true, enabled: DEMO_ACCESS.term, running: DEMO_ACCESS.term, port: 7681, sessions: [] }; },
		"pirate.access:term_set": function (p) { DEMO_ACCESS.term = !!p.enabled; return MOCK["pirate.access:term_status"](); },
		"pirate.meshcore:status": function () {
			var unread = 0, p = demoMcPos();
			DEMO_MC.channels.concat(DEMO_MC.contacts).forEach(function (c) { unread += demoMcConv(c).unread; });
			return { state: "ready", seq: DEMO_MC.seq, meta: 1, device: "/dev/ttyACM0", model: "LilyGo T-Echo",
				firmware: "v1.18.0", build: "15-Oct-2026", protocol: 9, max_contacts: 350, max_channels: 40,
				name: DEMO_MC.name, key: "e7f3a91c0d5b2846" + "aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55",
				share_location: DEMO_MC.share, radio: { freq_khz: DEMO_MC.cfg.freq, bw_hz: DEMO_MC.cfg.bw, sf: DEMO_MC.cfg.sf, cr: DEMO_MC.cfg.cr,
					tx_power: DEMO_MC.cfg.tx, max_tx_power: 22 },
				battery_mv: 4012, storage_used_kb: 128, storage_total_kb: 4096,
				contacts: DEMO_MC.contacts.length, channels: DEMO_MC.channels.length, unread: unread,
				gps: { available: true, enabled: DEMO_MC.gps, live: DEMO_MC.gps, lat: p.lat, lon: p.lon, age: 3 } };
		},
		"pirate.meshcore:position": function () {
			var p = demoMcPos();
			return DEMO_MC.gps ? { state: "ready", available: true, enabled: true, live: true, lat: p.lat, lon: p.lon, source: "LilyGo T-Echo" }
				: { state: "ready", available: true, enabled: false, live: false, source: "LilyGo T-Echo" };
		},
		"pirate.meshcore:contacts": function () { return { loaded: true, contacts: DEMO_MC.contacts.map(demoMcConv) }; },
		"pirate.meshcore:channels": function () {
			var used = DEMO_MC.channels.map(function (c) { return c.index; }), free = 0;
			while (used.indexOf(free) >= 0) free++;
			return { channels: DEMO_MC.channels.map(demoMcConv), free: free < 40 ? free : undefined };
		},
		// The newest (limit, 100 if none), or those before one: a page, as the daemon gives them
		"pirate.meshcore:messages": function (p) {
			var all = DEMO_MC.msgs.filter(function (m) { return m.conv === p.conv && (!p.before || m.id < p.before); });
			var start = Math.max(0, all.length - Math.min(p.limit || 100, 200));
			return { seq: DEMO_MC.seq, more: start > 0, messages: all.slice(start).map(demoMcMsg) };
		},
		"pirate.meshcore:poll": function (p) {
			return { state: "ready", seq: DEMO_MC.seq, meta: false,
				messages: DEMO_MC.msgs.filter(function (m) { return m.seq > (p.since || 0); }).map(demoMcMsg) };
		},
		"pirate.meshcore:read": function (p) {
			var last = 0;
			DEMO_MC.msgs.forEach(function (m) { if (m.conv === p.conv) last = m.id; });
			DEMO_MC.read[p.conv] = last;
			return { ok: true };
		},
		"pirate.meshcore:send": function (p) {
			var conv = p.to.charAt(0) === "#" ? p.to : "c" + p.to.replace(/^c/, "").slice(0, 12);
			var re = p.reply && DEMO_MC.msgs.filter(function (x) { return x.id === p.reply && x.conv === conv; })[0];
			if (p.reply && !re) return { error: "reply: a message in that conversation" };
			var now = Math.floor(Date.now() / 1000), m = DEMO_MC.add({ conv: conv,
				out: true, from: DEMO_MC.name, text: (re ? "@[" + re.from + "] " : "") + p.text, ts: now, rx: now, status: "queued" });
			if (re) m.reply = re.id;
			DEMO_MC.read[m.conv] = m.id;
			setTimeout(function () { m.status = "sent"; m.seq = ++DEMO_MC.seq; }, 600);
			if (m.conv.charAt(0) === "c") setTimeout(function () {
				m.status = m.conv === "ca1a1a1a1a1a1" ? "delivered" : "unconfirmed"; m.trip_ms = 910; m.seq = ++DEMO_MC.seq;
				if (m.conv === "ca1a1a1a1a1a1") setTimeout(function () {
					var t = Math.floor(Date.now() / 1000);
					DEMO_MC.add({ conv: m.conv, out: false, from: "Alice", text: "got it 👍", ts: t, rx: t, snr: 9.5, hops: 1 });
				}, 2500);
			}, 2200);
			return { ok: true, id: m.id, seq: DEMO_MC.seq };
		},
		"pirate.meshcore:react": function (p) {
			var t = DEMO_MC.msgs.filter(function (x) { return x.id === p.id && !x.emoji; })[0];
			if (!t) return { error: "id: a message (not a reaction)" };
			var now = Math.floor(Date.now() / 1000), ch = t.conv.charAt(0) === "#";
			if (t.out && !ch) return { error: "id: in a DM, one of their messages (meshcore-open can't show a reaction to your own)" };
			if (!p.emoji || /^[\x20-\x7e]*$/.test(p.emoji) || p.emoji.length > 16) return { error: "emoji: one emoji" };
			var m = DEMO_MC.add({ conv: t.conv, out: true, from: DEMO_MC.name, text: (ch ? "@[" + t.from + "]" : "") + p.emoji + "\nb45pc4ek",
				emoji: p.emoji, react: t.id, ts: now, rx: now, status: "sent" });
			DEMO_MC.read[m.conv] = m.id;
			return { ok: true, id: m.id, seq: DEMO_MC.seq };
		},
		"pirate.meshcore:resend": function (p) {
			var m = DEMO_MC.msgs.filter(function (x) { return x.id === p.id; })[0];
			if (!m) return { error: "id: a message you sent" };
			m.attempt = (m.attempt || 0) + 1; m.status = "sent"; m.seq = ++DEMO_MC.seq;
			setTimeout(function () { m.status = "unconfirmed"; m.seq = ++DEMO_MC.seq; }, 2500);
			return { ok: true };
		},
		"pirate.meshcore:trace": function (p) { return demoMcAsk(p, "trace"); },
		"pirate.meshcore:discover": function (p) { return demoMcAsk(p, "discover"); },
		"pirate.meshcore:telemetry": function (p) { return demoMcAsk(p, "telemetry"); },
		"pirate.meshcore:advert": { ok: true },
		"pirate.meshcore:set_name": function (p) { DEMO_MC.name = p.name; return { ok: true }; },
		"pirate.meshcore:gps": function (p) { DEMO_MC.gps = !!p.enabled; return { ok: true }; },
		"pirate.meshcore:set_location": function (p) {
			DEMO_MC.share = !!p.enabled;
			if (!p.enabled) DEMO_MC.cfg.tel = demoTelPrivate(DEMO_MC.cfg.tel);
			return { ok: true };
		},
		"pirate.meshcore:settings": function () { return demoMcSettings(); },
		"pirate.meshcore:set_radio": function (p) {
			var c = DEMO_MC.cfg;
			if (p.sf != null && (p.sf < 5 || p.sf > 12)) return { error: "sf: 5 to 12" };
			if (p.freq_khz != null) c.freq = p.freq_khz;
			if (p.bw_hz != null) c.bw = p.bw_hz;
			if (p.sf != null) c.sf = p.sf;
			if (p.cr != null) c.cr = p.cr;
			return { ok: true };
		},
		"pirate.meshcore:set_tx_power": function (p) {
			if (!(p.dbm >= -9 && p.dbm <= 22)) return { error: "dbm: -9 to 22" };
			DEMO_MC.cfg.tx = p.dbm;
			return { ok: true };
		},
		"pirate.meshcore:set_position": function (p) {
			if (DEMO_MC.gps) return { error: "its GPS is on, and says where it is: turn it off to set a position by hand" };
			DEMO_MC.cfg.lat = p.lat;
			DEMO_MC.cfg.lon = p.lon;
			return { ok: true };
		},
		"pirate.meshcore:set_params": function (p) {
			var c = DEMO_MC.cfg;
			if (p.auto_add != null) c.autoAdd = !!p.auto_add;
			if (p.extra_acks != null) c.acks = p.extra_acks;
			if (p.share_location != null) DEMO_MC.share = !!p.share_location;
			["telemetry_base", "telemetry_location", "telemetry_environment"].forEach(function (k, i) {
				if (p[k] != null) c.tel = c.tel & ~(3 << 2 * i) | p[k] << 2 * i;
			});
			if (p.share_location === false && p.telemetry_location == null) c.tel = demoTelPrivate(c.tel);
			return { ok: true };
		},
		"pirate.meshcore:set_autoadd": function (p) {
			var c = DEMO_MC.cfg;
			["overwrite_oldest", "chat", "repeater", "room", "sensor"].forEach(function (k, i) {
				if (p[k] != null) c.aa = p[k] ? c.aa | 1 << i : c.aa & ~(1 << i);
			});
			if (p.max_hops != null) c.hops = p.max_hops + 1;
			return { ok: true };
		},
		"pirate.meshcore:set_tuning": function (p) {
			if (p.rx_delay != null) DEMO_MC.cfg.rx = Math.round(p.rx_delay * 1000);
			if (p.airtime_factor != null) DEMO_MC.cfg.af = Math.round(p.airtime_factor * 1000);
			return { ok: true };
		},
		"pirate.meshcore:stats": function () {
			var up = 3 * 86400 + 4 * 3600 + Math.floor((Date.now() - DEMO_MC.cfg.since) / 1000);
			return demoLater(500, { ok: true, core: { battery_mv: 4012, uptime: up, errors: 0, queue: 0 },
				radio: { noise_floor: -112, last_rssi: -80, last_snr: 9.5, tx_air: 128, rx_air: 547 },
				packets: { received: 1234 + DEMO_MC.pktSeq, sent: 56, sent_flood: 40, sent_direct: 16, received_flood: 1000 + DEMO_MC.pktSeq,
					received_direct: 234, receive_errors: 7 } });
		},
		"pirate.meshcore:cli": function (p) { return demoLater(250, { ok: true, reply: demoMcCli(p.command) }); },
		"pirate.meshcore:reboot": { ok: true },
		"pirate.meshcore:login": function (p) {
			var c = DEMO_MC.contacts.filter(function (x) { return x.key.indexOf(p.key) === 0; })[0];
			if (!c || c.type === "chat") return { error: "only repeaters, rooms and sensors take a login" };
			if (p.password !== "password" && p.password !== "") return demoLater(1200, { error: "it refused the login: a wrong password, or not one it knows" });
			DEMO_MC.logins[c.key] = p.password ? 3 : 0;
			return demoLater(1200, { ok: true, ms: 1180, admin: !!p.password, role: p.password ? 3 : 0, firmware_level: 2 });
		},
		"pirate.meshcore:logout": function (p) {
			Object.keys(DEMO_MC.logins).forEach(function (k) { if (k.indexOf(p.key) === 0) delete DEMO_MC.logins[k]; });
			return { ok: true };
		},
		"pirate.meshcore:remote_status": function () {
			return demoLater(1400, { ok: true, ms: 1350, battery_mv: 3950, queue: 1, noise_floor: -105, last_rssi: -70, received: 5000, sent: 4800,
				air_secs: 3000, uptime: 86400 + 7200, sent_flood: 2000, sent_direct: 2800, received_flood: 3500, received_direct: 1500,
				errors: 0, last_snr: 10, direct_dups: 12, flood_dups: 340, rx_air_secs: 9000, receive_errors: 3 });
		},
		"pirate.meshcore:remote_cli": function (p) {
			var admin = Object.keys(DEMO_MC.logins).some(function (k) { return k.indexOf(p.key) === 0 && DEMO_MC.logins[k] === 3; });
			if (!admin) return demoLater(3000, { error: "no answer to that command (yet): log in as its admin first, or it's out of reach" });
			return demoLater(900, { ok: true, ms: 870, reply: demoMcRemoteCli(p.command) });
		},
		"pirate.meshcore:cli_log": function () { return { seq: 0, lines: [] }; },
		"pirate.meshcore:packets": function (p) {
			var mc = DEMO_MC, now = Math.floor(Date.now() / 1000), since = p.since || 0, k;
			// Heard since last asked: a packet every second or two (a minute's, at first)
			if (!mc.pktAt) mc.pktAt = now - 60;
			while (mc.pktAt < now) {
				mc.pktAt += 1 + Math.floor(Math.random() * 3);
				k = demoMcPacket(mc.pktAt);
				k.id = ++mc.pktSeq;
				k.rx = Math.min(mc.pktAt, now);
				mc.pkts.push(k);
				if (mc.pkts.length > 256) mc.pkts.shift();
			}
			return { seq: mc.pktSeq, packets: mc.pkts.filter(function (x) { return x.id > since; }).slice(-Math.min(p.limit || 100, 256)) };
		},
		"pirate.meshcore:channel_set": function (p) {
			DEMO_MC.channels = DEMO_MC.channels.filter(function (c) { return c.index !== p.index; });
			if (p.name) DEMO_MC.channels.push({ index: p.index, conv: "#" + p.index, name: p.name,
				secret: p.secret || "5f2e9a0c7b1d4e8f6a3c2b1d0e9f8a7b" });
			DEMO_MC.channels.sort(function (a, b) { return a.index - b.index; });
			return { ok: true };
		},
		"pirate.meshcore:contact_remove": function (p) {
			DEMO_MC.contacts = DEMO_MC.contacts.filter(function (c) { return c.key !== p.key; });
			return { ok: true };
		},
		"pirate.meshcore:contact_reset_path": function (p) {
			DEMO_MC.contacts.forEach(function (c) { if (c.key === p.key) { c.flood = true; delete c.hops; } });
			return { ok: true };
		},
		"pirate.meshcore:contact_favorite": function (p) {
			var c = DEMO_MC.contacts.filter(function (x) { return x.key === p.key; })[0];
			if (!c) return { error: "no such contact" };
			if (typeof p.favorite !== "boolean") return { error: "favorite: true or false" };
			if (p.favorite) c.favorite = true;
			else delete c.favorite;
			return { ok: true };
		},
		"pirate.meshcore:refresh": { ok: true },
		"pirate.capture:interfaces": {
			interfaces: [
				{ name: "br-lan", state: "up" },
				{ name: "eth0", state: "up" },
				{ name: "eth0.1", state: "up" },
				{ name: "eth0.2", state: "up" },
				{ name: "mon0", state: "unknown" },
				{ name: "phy0-ap0", state: "up" },
				{ name: "phy0-sta0", state: "up" }
			]
		},
		"pirate.capture:status": function () {
			if (!DEMO_CAP.running) return { running: false, iface: "", filter: "", file: "", size: 0, elapsed: 0 };
			var e = Math.floor(Date.now() / 1000) - DEMO_CAP.start;
			return { running: true, iface: DEMO_CAP.iface, filter: DEMO_CAP.filter,
				file: DEMO_CAP.file, size: 12000 + e * 2500, elapsed: e };
		},
		"pirate.capture:list": function () { return { files: DEMO_CAP.files.slice() }; },
		"pirate.capture:start": function (p) {
			DEMO_CAP.running = true; DEMO_CAP.iface = p.iface || "br-lan"; DEMO_CAP.filter = p.filter || "";
			DEMO_CAP.start = Math.floor(Date.now() / 1000);
			var ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
			DEMO_CAP.file = (p.name ? p.name + "-" : "") + "cap-" + ts + ".pcap";
			return MOCK["pirate.capture:status"]();
		},
		"pirate.capture:stop": function () {
			if (DEMO_CAP.running)
				DEMO_CAP.files.unshift({ name: DEMO_CAP.file, size: 12000 + (Math.floor(Date.now() / 1000) - DEMO_CAP.start) * 2500, mtime: "just now" });
			DEMO_CAP.running = false;
			return { stopped: true };
		},
		"pirate.handshake:radios": {
			radios: [ { phy: "phy0", monitor: true }, { phy: "phy1", monitor: true } ]
		},
		"pirate.handshake:status": function () {
			if (!DEMO_HS.running) return { running: false, phy: "", channel: "", file: "", size: 0, elapsed: 0, eapol: 0 };
			var e = Math.floor(Date.now() / 1000) - DEMO_HS.start;
			return { running: true, phy: DEMO_HS.phy, channel: DEMO_HS.channel, file: DEMO_HS.file,
				size: 4096 + e * 300, elapsed: e, eapol: e > 8 ? 4 : 0 };
		},
		"pirate.handshake:list": function () { return { files: DEMO_HS.files.slice() }; },
		"pirate.handshake:start": function (p) {
			DEMO_HS.running = true; DEMO_HS.phy = p.phy || "phy1"; DEMO_HS.channel = p.channel || "6";
			DEMO_HS.start = Math.floor(Date.now() / 1000);
			var ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
			DEMO_HS.file = (p.name ? p.name + "-" : "") + "hs-ch" + DEMO_HS.channel + "-" + ts + ".pcap";
			return MOCK["pirate.handshake:status"]();
		},
		"pirate.handshake:stop": function () {
			if (DEMO_HS.running) DEMO_HS.files.unshift({ name: DEMO_HS.file, size: 28000, mtime: "just now" });
			DEMO_HS.running = false;
			return { stopped: true };
		},
		"pirate.firmware:status": function () {
			return { model: "GL.iNet GL-AR750S (NAND)", firmware: "OpenWrt 25.12.6",
				staging_free: 61000, staged: DEMO_FW.staged, staged_size: DEMO_FW.size, verified: DEMO_FW.verified };
		},
		"pirate.firmware:verify": function () {
			if (!DEMO_FW.staged) return { ok: false, error: "no image staged" };
			DEMO_FW.verified = true;
			return { ok: true, message: "image is a valid upgrade for this device" };
		},
		"pirate.firmware:fetch": function (p) {
			if (!p.url) return { ok: false, error: "no URL" };
			DEMO_FW.staged = true; DEMO_FW.size = 7340032; DEMO_FW.verified = false;
			return { ok: true, size: DEMO_FW.size };
		},
		"pirate.firmware:backup": function () {
			return { ok: true, file: "/tmp/pirate-backup-20261030-101500.tar.gz", size: 48213 };
		},
		"pirate.firmware:apply": function () {
			if (!DEMO_FW.staged) return { ok: false, error: "no image staged" };
			if (!DEMO_FW.verified) return { ok: false, error: "image failed verification; not flashing" };
			return { ok: true, message: "flashing now; the device will reboot", mode: "keep" };
		},
		"pirate.firmware:clear": function () {
			DEMO_FW.staged = false; DEMO_FW.size = 0; DEMO_FW.verified = false;
			return { ok: true };
		},
		"pirate.dreampi:status": demoDreampi,
		"pirate.dreampi:set": function (p) {
			["enabled", "service", "dial_tone", "dcnow", "dmz"].forEach(function (k) { if (p[k] != null) DEMO_DP[k] = p[k]; });
			return demoDreampi();
		},
		"pirate.dreampi:dcnow": function () { return { id: DEMO_DCNOW.id, name: DEMO_DCNOW.name }; },
		"pirate.dreampi:dcnow_id": function (p) {
			if (p.id && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$|^[0-9a-f]{64}$/i.test(p.id))
				return { error: "enter a MAC address (B8:27:EB:12:34:56) or a 64-digit id, or nothing" };
			DEMO_DCNOW.as_pi = !!p.id;
			DEMO_DCNOW.id = p.id ? "45759ed22bbc324f6af24e849c045704a1b2c3d4e5f60718293a4b5c6d7e8f90" : "2bec1b43c9a2c523e3bcbeac146109088a0643419e1b39837057632447d93082";
			DEMO_DCNOW.name = p.id ? "NeedNotApply" : "Unnamed_2bec1b";
			return { id: DEMO_DCNOW.id, name: DEMO_DCNOW.name };
		},
		"pirate.dreampi:dcnow_name": function (p) {
			if (!p.name || /^\s|\s$/.test(p.name)) return { error: "enter a name without leading or trailing spaces" };
			DEMO_DCNOW.name = p.name;
			return { name: p.name };
		},
		"pirate.dreampi:log": { lines: [
			stamp(790) + " daemon.err dreampi[2210]: listening on /dev/ttyACM0",
			stamp(770) + " daemon.err dreampi[2210]: heard 5551234",
			stamp(768) + " user.notice dreampi: call to 5551234: ppp",
			stamp(760) + " daemon.err dreampi[2210]: answering (ppp)",
			stamp(741) + " daemon.err dreampi[2210]: CONNECT 33600",
			stamp(735) + " daemon.notice pppd[2290]: pppd 2.5.2 started by root, uid 0",
			stamp(731) + " daemon.notice pppd[2290]: PAP peer authentication succeeded for dream",
			stamp(730) + " daemon.notice pppd[2290]: local  IP address 192.168.169.1",
			stamp(730) + " daemon.notice pppd[2290]: remote IP address 192.168.169.2"
		] }
	};

	/* ---------- dom helpers ---------- */

	function el(tag, attrs) {
		var n = document.createElement(tag), k;
		if (attrs) for (k in attrs) {
			if (k === "class") n.className = attrs[k];
			else if (k === "text") n.textContent = attrs[k];
			else if (k === "html") n.innerHTML = attrs[k];
			else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
			else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
		}
		for (var i = 2; i < arguments.length; i++) {
			var c = arguments[i];
			if (c == null) continue;
			n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
		}
		return n;
	}
	function $(id) { return document.getElementById(id); }
	function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }

	function btn(label, o) {
		o = o || {};
		var b = el("button", { type: "button",
			class: "btn" + (o.primary ? " primary" : "") + (o.cls ? " " + o.cls : ""), text: label });
		if (o.onclick) b.addEventListener("click", o.onclick);
		if (o.title) b.title = o.title;
		return b;
	}
	function badge(text, cls) { return el("span", { class: "b " + (cls || ""), text: text }); }

	function tableEl(headers, rows) {
		var wrap = el("div", { class: "table-scroll" });
		var t = el("table", { class: "tbl" });
		var head = el("tr");
		headers.forEach(function (h) { head.appendChild(el("th", { text: h })); });
		t.appendChild(head);
		rows.forEach(function (r) {
			var tr = el("tr");
			r.forEach(function (c) {
				var td = el("td");
				if (c != null) td.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
				tr.appendChild(td);
			});
			t.appendChild(tr);
		});
		wrap.appendChild(t);
		return wrap;
	}
	function alertEl(kind, content) {
		var a = el("div", { class: "alert " + kind });
		(Array.isArray(content) ? content : [content]).forEach(function (c) {
			if (c != null) a.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
		});
		return a;
	}
	function ago(time) {
		var t = Date.parse(time), s = Math.max(0, Math.round((Date.now() - t) / 1000));
		if (isNaN(t)) return time || "-";
		if (s < 90) return s + " s ago";
		if (s < 5400) return Math.round(s / 60) + " min ago";
		if (s < 129600) return Math.round(s / 3600) + " h ago";
		return Math.round(s / 86400) + " days ago";
	}
	function dur(sec) {
		sec = +sec || 0;
		var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
		if (d) return d + "d " + h + "h";
		if (h) return h + "h " + m + "m";
		return m + "m";
	}
	function mb(kb) { return Math.round((+kb || 0) / 1024); }
	function size(b) {
		b = +b || 0;
		if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
		if (b >= 1024) return Math.round(b / 1024) + " KB";
		return b + " B";
	}
	function gb(b) {
		b = +b || 0;
		if (b >= 1073741824) return (b / 1073741824).toFixed(1) + " GB";
		return size(b);
	}
	function secClass(sec) {
		if (sec === "Open") return "sec-open";
		if (sec === "WEP" || sec === "WPA") return "sec-warn";
		if (sec === "WPA3") return "sec-ok";
		return "sec-neutral";
	}
	function sevClass(sev) {
		return sev === "high" ? "sev-high" : (sev === "medium" ? "sev-warn" : "sev-neutral");
	}

	/* ---------- the Slate's hardware: its ports and radios, by name ---------- */

	// A GL.iNet GL-AR750S: phy0 is its 5 GHz radio (QCA9887), phy1 its 2.4 GHz
	// one (the SoC's own); eth0.2 is the WAN jack and eth0.1 the two LAN jacks,
	// and br-lan those jacks with the Pirate Radio access point. pirate.router
	// "ports" says which interface is on which radio (a monitor's, a USB
	// adapter's); until it has answered, names go by those rules alone.
	var HW = { ifaces: {}, phys: {}, ports: null };
	var hwLoad = null;
	function hw() {
		if (!hwLoad) hwLoad = call("pirate.router", "ports").then(function (p) {
			HW.ports = p;
			(p.radios || []).forEach(function (r) {
				HW.phys[r.phy] = r;
				(r.interfaces || []).forEach(function (i) {
					HW.ifaces[i.name] = { band: r.band, type: i.type, usb: r.usb };
				});
			});
			return p;
		}).catch(function () { hwLoad = null; return null; });
		return hwLoad;
	}
	function bandOf(phy) {
		if (HW.phys[phy]) return HW.phys[phy].band;
		return phy === "phy0" ? "5 GHz" : phy === "phy1" ? "2.4 GHz" : "";
	}
	function phyLabel(phy) {
		var r = HW.phys[phy], b = bandOf(phy);
		if (r && r.usb) return "USB Wi-Fi adapter" + (b ? " (" + b + ")" : "");
		return b ? b + " radio" : phy;
	}
	var IF_FIXED = {
		"eth0.2": "WAN port", wan: "WAN port", "eth0.1": "LAN ports", eth0: "Ethernet switch",
		"br-lan": "Whole LAN", lan: "Whole LAN",
		lo: "loopback", any: "every interface"
	};
	function ifLabel(name) {
		if (!name) return "";
		if (IF_FIXED[name]) return IF_FIXED[name];
		if (/^ppp/.test(name)) return "Dreamcast call (PPP)";
		if (/^wg/.test(name)) return "WireGuard tunnel";
		var i = HW.ifaces[name], m = /^(phy\d+)-(ap|sta|mesh)\d+$/.exec(name);
		var type = i ? i.type : m ? { ap: "AP", sta: "managed", mesh: "mesh point" }[m[2]] : /^mon\d+$/.test(name) ? "monitor" : "";
		var band = i ? i.band : m ? bandOf(m[1]) : "";
		var role = { AP: "access point", managed: "uplink", monitor: "monitor", "mesh point": "mesh" }[type];
		if (!role) return name;
		return (i && i.usb ? "USB Wi-Fi" + (band ? " (" + band + ")" : "") : band || "Wi-Fi") + " " + role;
	}
	// The label, with the system's own name beside it, small
	function ifEl(name) {
		var l = ifLabel(name);
		return l === name ? el("span", { text: name }) : el("span", { title: name }, l + " ", el("span", { class: "ifname", text: name }));
	}
	// Serial devices (a GPS, a modem, a Flipper) are on the USB port here
	function devLabel(path) {
		return /^\/dev\/tty(ACM|USB)/.test(path || "") ? "the USB port (" + path + ")" : (path || "");
	}

	/* ---------- SDR helpers (status text, rtl_433 readings) ---------- */

	// rtl_433 key suffix -> unit shown after the value (from the LuCI ISM page).
	var UNITS = [
		[/_C$/, "°C"], [/_F$/, "°F"], [/_kPa$/, "kPa"], [/_hPa$/, "hPa"],
		[/_PSI$/i, "PSI"], [/_bar$/, "bar"], [/_km_h$/, "km/h"], [/_m_s$/, "m/s"],
		[/_mi_h$/, "mph"], [/_mm$/, "mm"], [/_in$/, "in"], [/_deg$/, "°"],
		[/_lux$/, "lux"], [/_V$/, "V"], [/_mV$/, "mV"], [/^humidity$|_humidity$|^moisture$/, "%"]
	];
	function reading(key, value) {
		if (key === "battery_ok") return value ? "battery OK" : "battery low";
		for (var i = 0; i < UNITS.length; i++)
			if (UNITS[i][0].test(key))
				return (key.replace(UNITS[i][0], "").replace(/_/g, " ") || key) + " " +
					((typeof value === "number") ? +value.toFixed(1) : value) + " " + UNITS[i][1];
		return key.replace(/_/g, " ") + " " + value;
	}
	function mhz(f) { return String(f).replace(/M$/i, "") + " MHz"; }
	function agoIsm(time) {
		return ago(/Z$|[+-]\d\d:?\d\d$/.test(time || "") ? time : time + "Z");
	}
	// "  adsb       adsb           rtlsdr   running" -> {name,type,radio,state}
	function parseJobs(status) {
		var jobs = [], re = /^ {2}(\S+) +(\S+) +(\S+) +(running|stopped|waiting|off) *$/mg, m;
		while ((m = re.exec(status || "")) !== null)
			jobs.push({ name: m[1], type: m[2], radio: m[3], state: m[4] });
		return jobs;
	}
	function fetchSdrStatus() {
		if (DEMO) return Promise.resolve(demoStatus());
		return fetch("/cgi-bin/pirate-radio", { cache: "no-store" }).then(function (r) {
			return r.ok ? r.text() : null;
		}).then(function (html) {
			var pre = html ? new DOMParser().parseFromString(html, "text/html").querySelector("pre") : null;
			return pre ? pre.textContent.replace(/^\n+|\s+$/g, "") : null;
		}).catch(function () { return null; });
	}
	var SDR_PAGES = [
		["Pirate Radio status", "http://%s/cgi-bin/pirate-radio", null],
		["Aircraft map", "http://%s:8080/", "adsb"],
		["Recorded data", "http://%s:8081/pirate-radio/", null]
	];
	var SDR_CLIENTS = [
		["SoapySDR (SDR++, GQRX, CubicSDR, SDRangel, GNU Radio)", "driver=remote,remote=tcp://%s:55132", "soapy"],
		["rtl_tcp (SDR#, SDR++, GQRX)", "%s:1234", "rtltcp"],
		["ADS-B, SBS", "%s:30003", "adsb"],
		["ADS-B, Beast", "%s:30005", "adsb"],
		["AIS, NMEA (OpenCPN)", "tcp://%s:10110", "ais"]
	];

	/* ---------- view scaffolding ---------- */

	var VIEW = $("view");
	function loading() { clear(VIEW).appendChild(el("div", { class: "loading", text: "Loading…" })); }
	// A page's title: in the strip at the top, the one place it's said, on
	// every page; what the page is for, on hovering it. Nothing in the page
	function viewHead(title, sub) {
		var t = $("top-title");
		t.textContent = title;
		t.title = sub || "";
		return document.createDocumentFragment();
	}
	function panel(title) {
		var p = el("div", { class: "panel" });
		if (title) p.appendChild(el("h3", { class: "sub-h", text: title }));
		return p;
	}

	/* ---------- Dashboard ---------- */

	function tile(o) {
		var t = el(o.tab ? "button" : "div", { class: "tile tone-" + (o.tone || "neutral") + (o.wide ? " span-2" : "") });
		if (o.tab) { t.type = "button"; t.addEventListener("click", function () { setTab(o.tab); }); }
		t.appendChild(el("span", { class: "k", text: o.k }));
		t.appendChild(el("span", { class: "v", text: String(o.v), title: String(o.v) }));
		if (o.s) t.appendChild(el("span", { class: "s", text: o.s }));
		return t;
	}

	function loadDashboard() {
		loading();
		return Promise.all([
			call("pirate.recon", "dashboard"),
			call("pirate.router", "status").catch(function () { return null; }),
			hw()
		]).then(function (r) { renderDashboard(r[0], r[1]); }).catch(onError);
	}

	function renderDashboard(d, sys) {
		clear(VIEW);
		VIEW.appendChild(viewHead("Dashboard", "where the Slate is and what it sees"));
		var up = d.uplink || {}, online = !!up.online;
		setNetPill(online, up.ssid);

		var grid = el("div", { class: "grid" });
		grid.appendChild(tile({ k: "Uplink", v: up.ssid || "—", tone: online ? "accent" : "bad", wide: true,
			s: online ? "online · " + (up.subnet || "") + (up.iface ? " · " + ifLabel(up.iface) : "") : "no internet route", tab: "uplink" }));
		grid.appendChild(tile({ k: "Hosts", v: d.hosts ? d.hosts.count : 0, tab: "hosts",
			s: d.hosts && d.hosts.scanned ? "last scan " + d.hosts.scanned : "on the joined network" }));
		grid.appendChild(tile({ k: "Wi-Fi survey", v: d.survey ? d.survey.count : 0, tab: "survey",
			s: "access points logged" }));
		var th = d.threats || { count: 0, high: 0 };
		grid.appendChild(tile({ k: "Threats", v: th.count || 0, tab: "threats",
			tone: th.high > 0 ? "bad" : (th.count > 0 ? "warn" : "ok"), s: (th.high || 0) + " high severity" }));
		var gps = d.gps || {};
		grid.appendChild(tile({ k: "GPS", v: gps.running ? "live" : (gps.installed ? "idle" : "none"),
			tone: gps.running ? "ok" : "neutral",
			s: gps.installed ? (gps.running ? "gpsd running" : "plug in a receiver") : "not installed", tab: "survey" }));
		var sdr = d.sdr;
		grid.appendChild(tile({ k: "SDR jobs", v: sdr && sdr.present ? (sdr.running || 0) : "—", tab: "receivers",
			tone: sdr && sdr.present && sdr.running ? "accent" : "neutral",
			s: sdr && sdr.present ? "receivers running" : "not installed" }));
		if (sys) {
			var m = sys.memory || {};
			grid.appendChild(tile({ k: "System", v: dur(sys.uptime), tab: "status",
				s: "up · load " + (sys.load || "?") + (m.total ? " · " + mb(m.available != null ? m.available : m.free) + " MB RAM free" : "") }));
		}
		VIEW.appendChild(grid);

		// The Wi-Fi interfaces: access point first, then the uplink, then monitors
		var ORDER = { master: 0, client: 1, monitor: 2 }, ROLE = { master: "Access point", client: "Uplink", monitor: "Monitor" };
		var radios = (d.radios || []).slice().sort(function (a, b) {
			function o(r) { var k = (r.mode || "").toLowerCase(); return k in ORDER ? ORDER[k] : 3; }
			return o(a) - o(b);
		});
		var p = panel("Wi-Fi");
		p.style.marginTop = "14px";
		var rows = el("div", { class: "rows" });
		if (!radios.length) rows.appendChild(el("div", { class: "row muted" }, "no radios reported"));
		radios.forEach(function (r) {
			var cls = (r.mode || "").toLowerCase();
			rows.appendChild(el("div", { class: "row" },
				el("span", { class: "tag " + cls, text: ROLE[cls] || r.mode || "?" }),
				el("span", { class: "grow", text: r.ssid || (cls === "monitor" ? "listening on every network" : "(no SSID)") }),
				el("span", { class: "muted", text: "ch " + (r.channel || "—") }),
				el("span", { class: "muted row-if" }, ifEl(r.iface || ""))));
		});
		p.appendChild(rows);
		VIEW.appendChild(p);
	}

	/* ---------- Hosts ---------- */

	function renderHosts() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Hosts", "what else is on the network the router joined (its uplink)"));

		var secScan = panel("On the uplink's network");
		var uplinkLine = el("p", { class: "descr", text: "Loading…" });
		secScan.appendChild(uplinkLine);
		var scanInfo = el("span", { class: "status" });
		var scanBtn = btn("Scan network", { primary: true, onclick: doDiscover });
		secScan.appendChild(el("div", { class: "toolbar" }, scanBtn, scanInfo));
		var tableWrap = el("div");
		tableWrap.appendChild(el("div", { class: "muted", text: "Loading…" }));
		secScan.appendChild(tableWrap);

		var portWrap = el("div");
		VIEW.appendChild(secScan); VIEW.appendChild(portWrap);

		function showUplink(u) {
			if (!u || u.error) { clear(uplinkLine).appendChild(el("em", { text: "Not joined to a network: see the Uplink page." })); return; }
			clear(uplinkLine);
			uplinkLine.appendChild(el("strong", { text: u.ssid || "wired" }));
			uplinkLine.appendChild(document.createTextNode(
				" (" + (u.subnet || "?") + "), through the " + (ifLabel(u.iface) || "uplink") +
				"; its gateway " + (u.gateway || "-") + (u.gateway_mac ? " (" + u.gateway_mac + ")" : "") +
				". This router is " + (u.self || "on it") + " there."));
			setNetPill(true, u.ssid);
			if (u.subnet && profTarget && !profTarget.value) profTarget.value = u.subnet;
		}
		function fillTable(data) {
			var list = (data && data.hosts) || [];
			if (data && data.error) { clear(tableWrap).appendChild(alertEl("warn", data.error)); return; }
			if (!list.length) { clear(tableWrap).appendChild(el("div", { class: "placeholder", html:
				"No scan yet. Click <b>Scan network</b>." })); return; }
			var rows = list.map(function (h) {
				var tags = el("span");
				if (h.gateway) tags.appendChild(badge("gateway", "sec-ok"));
				if (h.self) tags.appendChild(badge("this router", "sec-neutral"));
				return [
					el("strong", { text: h.ip }),
					h.mac || "-",
					(h.vendor && h.vendor !== "(Unknown)") ? h.vendor : "-",
					tags,
					btn("Ports", { cls: "small", onclick: function () { scanPorts(h.ip); } })
				];
			});
			clear(tableWrap).appendChild(tableEl(["Address", "MAC", "Vendor", "", "Scan"], rows));
			scanInfo.textContent = (data && data.scanned)
				? list.length + " hosts, scanned " + String(data.scanned).replace("T", " ").replace("Z", " UTC") : "";
		}
		function doDiscover() {
			scanBtn.disabled = true; scanInfo.textContent = "scanning the local segment…";
			call("pirate.recon", "discover").then(function (d) {
				fillTable(d);
				return call("pirate.recon", "uplink").then(showUplink);
			}).catch(function (e) { clear(tableWrap).appendChild(alertEl("warn", String(e.message || e))); })
				.then(function () { scanBtn.disabled = false; });
		}
		function scanPorts(ip) {
			var body = el("div", {}, el("em", { text: "Scanning " + ip + "…" }));
			clear(portWrap).appendChild(panel("Ports on " + ip)).appendChild(body);
			portWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
			call("pirate.recon", "ports", { target: ip }).then(function (res) {
				if (res.error) { clear(body).appendChild(alertEl("warn", res.error)); return; }
				var ports = res.ports || [];
				if (!ports.length) { clear(body).appendChild(el("p", { class: "muted", text: "No open ports in the top 100." })); return; }
				clear(body).appendChild(tableEl(["Port", "Proto", "Service"], ports.map(function (p) {
					return [el("strong", { text: String(p.port) }), p.proto || "-", p.service || "-"];
				})));
			}).catch(function (e) { clear(body).appendChild(alertEl("warn", String(e.message || e))); });
		}

		// Port & service scan profiles (nmap).
		var secProf = panel("Port & service scan");
		secProf.style.marginTop = "14px";
		var profTarget = el("input", { class: "inp", type: "text", placeholder: "host IP, name, or subnet (CIDR)" });
		var profSel = el("select", { class: "sel" },
			el("option", { value: "quick", text: "Quick — top 100 ports" }),
			el("option", { value: "top1000", text: "Top 1000 ports" }),
			el("option", { value: "ping", text: "Ping sweep (hosts up)" }));
		var profStatus = el("span", { class: "status" });
		var profWrap = el("div");
		secProf.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "Target" }), profTarget),
			el("label", {}, el("span", { class: "lbl", text: "Profile" }), profSel)));
		secProf.appendChild(el("div", { class: "toolbar" }, btn("Run scan", { primary: true, onclick: runProfile }), profStatus));
		secProf.appendChild(profWrap);
		secProf.appendChild(el("p", { class: "descr", text:
			"nmap against a host you name or the joined subnet, logged to the card under recon/. Longer profiles take a while on this hardware." }));
		VIEW.appendChild(secProf);

		function runProfile() {
			if (!profTarget.value) { profStatus.textContent = "enter a target"; return; }
			profStatus.textContent = "scanning… (this can take a while)";
			clear(profWrap);
			call("pirate.recon", "scan", { profile: profSel.value, target: profTarget.value }).then(function (r) {
				profStatus.textContent = r.saved ? "saved " + r.saved : "";
				if (r.error) { profWrap.appendChild(alertEl("warn", r.error)); return; }
				var hosts = r.hosts || [];
				if (!hosts.length) { profWrap.appendChild(el("div", { class: "placeholder", text: "No results." })); return; }
				if (profSel.value === "ping") {
					profWrap.appendChild(tableEl(["Hosts up"], hosts.map(function (h) { return [el("code", { text: h.ip })]; })));
					return;
				}
				hosts.forEach(function (h) {
					profWrap.appendChild(el("h4", { class: "sub-h2", text: h.ip }));
					var ports = h.ports || [];
					if (!ports.length) { profWrap.appendChild(el("div", { class: "muted", text: "no open ports" })); return; }
					profWrap.appendChild(tableEl(["Port", "Proto", "Service"], ports.map(function (p) {
						return [el("strong", { text: String(p.port) }), p.proto || "-", p.service || "-"];
					})));
				});
			}).catch(function (e) {
				profStatus.textContent = "";
				if (String(e.message || e) === "unauthorized") return onError(e);
				profWrap.appendChild(alertEl("warn", String(e.message || e)));
			});
		}

		hw().then(function () { return call("pirate.recon", "uplink"); }).then(showUplink).catch(function () { showUplink(null); });
		call("pirate.recon", "hosts").then(fillTable).catch(function (e) {
			if (String(e.message || e) === "unauthorized") return onError(e);
			clear(tableWrap).appendChild(alertEl("warn", String(e.message || e)));
		});
	}

	/* ---------- Wi-Fi Survey ---------- */

	function gpsText(g) {
		if (!g || g.installed === false) return "No GPS tools installed. Add a USB GPS and gpsd to tag sightings.";
		if (!g.running) return "No GPS plugged in. Plug in a USB GPS and gpsd starts by itself.";
		var where = g.device ? " on " + devLabel(g.device) : "";
		if (g.fix === "2D" || g.fix === "3D")
			return "GPS fix (" + g.fix + ")" + where + ": " + g.lat.toFixed(6) + ", " + g.lon.toFixed(6) +
				(g.sats_used != null ? " — " + g.sats_used + " of " + (g.sats || 0) + " satellites" : "");
		return "gpsd running" + where + " but no fix yet" + (g.sats != null ? " (" + g.sats + " satellites seen)" : "") + ".";
	}

	function renderSurvey() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Survey", "a wardriving-style log of the access points heard"));

		var sec = panel();
		var status = el("span", { class: "status" });
		var scanBtn = btn("Scan now", { primary: true, onclick: doScan });
		var clearBtn = btn("Clear log", { cls: "reset", onclick: doClear });
		sec.appendChild(el("div", { class: "toolbar" }, scanBtn, clearBtn, status));
		var tableWrap = el("div");
		tableWrap.appendChild(el("div", { class: "muted", text: "Loading…" }));
		sec.appendChild(tableWrap);

		var secGps = panel("Location");
		secGps.style.marginTop = "14px";
		var gpsLine = el("p", { class: "muted", text: "Loading…" });
		secGps.appendChild(gpsLine);
		secGps.appendChild(btn("Refresh GPS", { onclick: refreshGps }));

		VIEW.appendChild(sec); VIEW.appendChild(secGps);

		function fill(data) {
			if (data && data.error) { clear(tableWrap).appendChild(alertEl("warn", data.error)); return; }
			var nets = (data && data.networks) || [];
			var hasGps = nets.some(function (n) { return n.lat != null; });
			if (!nets.length) { clear(tableWrap).appendChild(el("div", { class: "placeholder", html:
				"No networks logged yet. Click <b>Scan now</b>." })); status.textContent = ""; return; }
			var headers = ["SSID", "BSSID", "Ch", "Security", "Signal", "Seen", "Last"];
			if (hasGps) headers.push("Location");
			var rows = nets.map(function (n) {
				var cells = [
					n.ssid ? el("strong", { text: n.ssid }) : el("em", { class: "muted", text: "(hidden)" }),
					el("code", { text: n.bssid }),
					String(n.channel),
					badge(n.security || "?", secClass(n.security)),
					n.best_signal != null ? n.best_signal + " dBm" : "-",
					String(n.count),
					ago(n.last)
				];
				if (hasGps) cells.push(n.lat != null ? n.lat.toFixed(5) + ", " + n.lon.toFixed(5) : "-");
				return cells;
			});
			clear(tableWrap).appendChild(tableEl(headers, rows));
			status.textContent = (data && data.total != null) ? data.total + " networks logged" : "";
		}
		function doScan() {
			scanBtn.disabled = true; status.textContent = "scanning on a free radio…";
			call("pirate.recon", "survey_scan").then(function (res) {
				if (res.error) throw new Error(res.error);
				return Promise.all([
					call("pirate.recon", "survey_networks").then(fill),
					call("pirate.recon", "survey_gps").then(function (g) { clear(gpsLine).appendChild(document.createTextNode(gpsText(g))); })
				]);
			}).catch(function (e) { status.textContent = ""; clear(tableWrap).appendChild(alertEl("warn", String(e.message || e))); })
				.then(function () { scanBtn.disabled = false; });
		}
		function doClear() {
			call("pirate.recon", "survey_clear").then(function () {
				return call("pirate.recon", "survey_networks").then(fill);
			}).catch(function (e) { clear(tableWrap).appendChild(alertEl("warn", String(e.message || e))); });
		}
		function refreshGps() {
			call("pirate.recon", "survey_gps").then(function (g) {
				clear(gpsLine).appendChild(document.createTextNode(gpsText(g)));
			}).catch(function (e) { clear(gpsLine).appendChild(document.createTextNode(String(e.message || e))); });
		}

		call("pirate.recon", "survey_networks").then(fill).catch(function (e) {
			if (String(e.message || e) === "unauthorized") return onError(e);
			clear(tableWrap).appendChild(alertEl("warn", String(e.message || e)));
		});
		refreshGps();
	}

	/* ---------- Threats ---------- */

	var THREAT_NAME = { evil_twin: "Evil twin", impersonation: "Impersonation", extra_bssid: "Extra access point" };

	function renderThreats() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Threats", "passive Wi-Fi threat detection — listen only"));

		var secRogue = panel("Rogue access points");
		secRogue.appendChild(el("p", { class: "descr", text:
			"Checks the access points the Wi-Fi Survey logged for an SSID advertised both open and secured (an evil twin), and for your own network names being impersonated." }));
		var rogueBtn = btn("Check now", { primary: true, onclick: checkRogue });
		secRogue.appendChild(el("div", { class: "toolbar" }, rogueBtn));
		var protLine = el("p", { class: "muted" });
		var rogueBox = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		secRogue.appendChild(protLine); secRogue.appendChild(rogueBox);

		var secDeauth = panel("Deauth watch");
		secDeauth.style.marginTop = "14px";
		secDeauth.appendChild(el("p", { class: "descr", text:
			"Listens on the 2.4 GHz monitor radio for the deauth/disassoc frames a jamming or handshake-capture attack floods the air with." }));
		var sel = el("select", { class: "sel" },
			el("option", { value: "15", text: "15 seconds" }),
			el("option", { value: "30", text: "30 seconds" }),
			el("option", { value: "60", text: "60 seconds" }));
		var deauthBtn = btn("Watch now", { onclick: function () { watchDeauth(sel.value); } });
		secDeauth.appendChild(el("div", { class: "toolbar" }, sel, deauthBtn));
		var deauthBox = el("div");
		secDeauth.appendChild(deauthBox);

		VIEW.appendChild(secRogue); VIEW.appendChild(secDeauth);

		function showRogue(data) {
			clear(protLine);
			if (data && data.protected && data.protected.length)
				protLine.textContent = "Protecting: " + data.protected.join(", ");
			clear(rogueBox);
			if (data && data.error) { rogueBox.appendChild(alertEl("warn", data.error)); return; }
			var threats = (data && data.threats) || [];
			if (!threats.length) {
				rogueBox.appendChild(alertEl("success",
					"No rogue access points in the " + ((data && data.total_networks) || 0) + " networks logged."));
				return;
			}
			threats.forEach(function (t) {
				var box = el("div", { class: "threat " + sevClass(t.severity) });
				box.appendChild(el("p", {}, badge((t.severity || "?").toUpperCase(), sevClass(t.severity)),
					document.createTextNode(" "), el("strong", { text: THREAT_NAME[t.type] || t.type }),
					document.createTextNode(" — "), el("strong", { text: t.ssid })));
				if (t.detail) box.appendChild(el("p", { class: "descr", text: t.detail }));
				box.appendChild(tableEl(["BSSID", "Security", "Signal", "Channel"], (t.bssids || []).map(function (b) {
					return [el("code", { text: b.bssid }), b.security || "-",
						b.signal != null ? b.signal + " dBm" : "-", "ch " + (b.channel != null ? b.channel : "?")];
				})));
				rogueBox.appendChild(box);
			});
		}
		function checkRogue() {
			rogueBtn.disabled = true;
			call("pirate.recon", "threats_rogue").then(showRogue)
				.catch(function (e) {
					if (String(e.message || e) === "unauthorized") return onError(e);
					clear(rogueBox).appendChild(alertEl("warn", String(e.message || e)));
				}).then(function () { rogueBtn.disabled = false; });
		}
		function watchDeauth(secs) {
			deauthBtn.disabled = true;
			clear(deauthBox).appendChild(el("p", {}, el("em", { text: "Listening for " + secs + " seconds…" })));
			call("pirate.recon", "threats_deauth", { secs: secs }).then(function (r) {
				clear(deauthBox);
				if (r.error) { deauthBox.appendChild(alertEl("warn", r.error)); return; }
				deauthBox.appendChild(r.alert
					? alertEl("danger", [badge("HIGH", "sev-high"), document.createTextNode(
						" Possible deauth attack: " + r.total + " frames in " + r.window_s + " s on channel " + r.channel + ".")])
					: alertEl("info", r.total + " deauth/disassoc frames in " + r.window_s + " s on channel " + r.channel + " — nothing unusual."));
				deauthBox.appendChild(el("p", { class: "descr", text: r.deauth + " deauthentication, " + r.disassoc + " disassociation." }));
				if ((r.sources || []).length)
					deauthBox.appendChild(tableEl(["Transmitter (SA)", "Frames"], r.sources.map(function (s) {
						return [el("code", { text: s.mac }), String(s.count)];
					})));
			}).catch(function (e) { clear(deauthBox).appendChild(alertEl("warn", String(e.message || e))); })
				.then(function () { deauthBtn.disabled = false; });
		}

		call("pirate.recon", "threats_rogue").then(showRogue).catch(function (e) {
			if (String(e.message || e) === "unauthorized") return onError(e);
			clear(rogueBox).appendChild(alertEl("warn", String(e.message || e)));
		});
	}

	/* ---------- Receivers: the SDR jobs and where to reach them ---------- */

	function renderReceivers() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Receivers", "the SDR jobs running on this router, and where to reach them"));
		var host = location.hostname || "192.168.1.1";

		var jobsPanel = panel("Jobs");
		jobsPanel.appendChild(el("p", { class: "descr", text:
			"Each radio runs one job at a time. Hand a radio to another job and the service switches it over. A job starts when its radio is plugged in and stops when it is removed." }));
		var jobsWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		jobsPanel.appendChild(jobsWrap);
		var raw = el("details", { class: "raw" }, el("summary", { text: "Raw status" }));
		var rawPre = el("pre", { class: "raw-pre" });
		raw.appendChild(rawPre);
		jobsPanel.appendChild(raw);

		var addrPanel = panel("Addresses");
		addrPanel.style.marginTop = "14px";
		var addrWrap = el("div");
		addrPanel.appendChild(addrWrap);

		VIEW.appendChild(jobsPanel); VIEW.appendChild(addrPanel);

		var jobsMap = {};
		function stateCls(s) { return s === "running" ? "sec-ok" : (s === "stopped" ? "sec-warn" : "sec-neutral"); }

		function fillAddresses() {
			function sb(job) {
				if (!job) return badge("always on", "sec-ok");
				var s = jobsMap[job] && jobsMap[job].state;
				if (s === "running") return badge("on", "sec-ok");
				if (s === "stopped") return badge("stopped", "sec-warn");
				if (s === "waiting") return badge("radio unplugged", "sec-neutral");
				if (s === "off") return badge("off", "sec-neutral");
				return badge("job " + job, "sec-neutral");
			}
			function fmt(s) { return s.replace("%s", host); }
			clear(addrWrap);
			addrWrap.appendChild(el("h4", { class: "sub-h2", text: "Web pages" }));
			addrWrap.appendChild(tableEl(["Page", "Address", "Runs when"], SDR_PAGES.map(function (p) {
				var u = fmt(p[1]);
				return [p[0], el("a", { href: u, target: "_blank", rel: "noopener", text: u }), sb(p[2])];
			})));
			addrWrap.appendChild(el("h4", { class: "sub-h2", text: "Connect from a computer" }));
			addrWrap.appendChild(tableEl(["Client", "Address", "Runs when"], SDR_CLIENTS.map(function (c) {
				return [c[0], el("code", { text: fmt(c[1]) }), sb(c[2])];
			})));
		}

		function fillJobs(status) {
			rawPre.textContent = status || "No answer from /cgi-bin/pirate-radio.";
			var jobs = parseJobs(status);
			jobsMap = {};
			jobs.forEach(function (j) { jobsMap[j.name] = j; });
			clear(jobsWrap);
			// "  note: ..." lines: a radio plugged in but in a mode it can't be used in.
			var note, noteRe = /^ {2}note: (.+)$/mg;
			while ((note = noteRe.exec(status || "")) !== null)
				jobsWrap.appendChild(alertEl("warn", note[1]));
			if (!jobs.length) {
				jobsWrap.appendChild(el("div", { class: "muted", text:
					"No job status reported (is pirate-radio installed on this device?)." }));
			} else {
				jobsWrap.appendChild(tableEl(["Job", "Radio", "Type", "State", ""], jobs.map(function (j) {
					var action = j.state === "running"
						? el("span", { class: "muted", text: "—" })
						: j.state === "waiting"
						? el("span", { class: "muted", text: "plug in " + (j.radio === "-" ? "an SDR" : "the " + j.radio) })
						: btn("Use " + j.radio, { cls: "small", onclick: function () { handTo(j.name); } });
					return [el("strong", { text: j.name }), j.radio, j.type, badge(j.state, stateCls(j.state)), action];
				})));
			}
			fillAddresses();
		}

		function handTo(job) {
			call("pirate.sdr", "use", { job: job }).then(function () {
				return fetchSdrStatus().then(fillJobs);
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				clear(jobsWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}

		fetchSdrStatus().then(fillJobs);
	}

	/* ---------- Sensors: what the ISM job has decoded ---------- */

	function renderSensors() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Sensors", "weather stations, tyre gauges, door sensors: what rtl_433 has decoded"));

		var ismPanel = panel("ISM sensors");
		var ismStatus = el("p", { class: "descr" });
		var ismWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		ismPanel.appendChild(el("div", { class: "toolbar" }, btn("Refresh", { onclick: load }),
			btn("Receivers", { onclick: function () { setTab("receivers"); } })));
		ismPanel.appendChild(ismStatus); ismPanel.appendChild(ismWrap);
		VIEW.appendChild(ismPanel);

		function fillIsm(data) {
			if (data.error) { ismStatus.textContent = String(data.error); clear(ismWrap); return; }
			ismStatus.textContent = data.frequencies
				? "Listening on " + data.frequencies.map(mhz).join(", ") + ", switching every " + data.hop_interval + " s."
				: "";
			var devs = (data.devices || []).slice().sort(function (a, b) { return String(b.last).localeCompare(String(a.last)); });
			if (!devs.length) {
				clear(ismWrap).appendChild(el("div", { class: "placeholder", text: data.enabled
					? "Nothing decoded yet — rtl_433 hops bands, so give it a few minutes."
					: "Nothing decoded yet, and the ISM job is not running: hand it the RTL-SDR on the Receivers page." }));
				return;
			}
			clear(ismWrap).appendChild(tableEl(["Device", "ID", "Latest readings", "Band", "Heard", "Last"], devs.map(function (d) {
				var rd = Object.keys(d.readings || {}).map(function (k) { return reading(k, d.readings[k]); }).join(", ") || "-";
				var idch = ((d.id != null) ? String(d.id) : "-") + ((d.channel != null) ? " / ch " + d.channel : "");
				return [el("strong", { text: String(d.model) }), idch, rd, (d.freq != null ? mhz(d.freq) : "-"), String(d.count), agoIsm(d.last)];
			})));
		}
		function load() {
			call("pirate.sdr", "devices").then(fillIsm).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				ismStatus.textContent = String(e.message || e);
			});
		}
		load();
	}

	/* ---------- Status: the router itself, its jacks, radios and slots ---------- */

	function kvEl(pairs) {
		var dl = el("dl", { class: "kv" });
		pairs.forEach(function (p) {
			if (p[1] == null || p[1] === "") return;
			dl.appendChild(el("dt", { text: p[0] }));
			dl.appendChild(typeof p[1] === "object" ? el("dd", {}, p[1]) : el("dd", { text: String(p[1]) }));
		});
		return dl;
	}
	function loadingEl() { return el("div", { class: "muted", text: "Loading…" }); }
	function warnEl(e) { return alertEl("warn", String((e && e.message) || e)); }

	function renderStatus() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Status", "the router itself: its system, jacks, radios and slots"));

		var sysPanel = panel("System");
		var sysWrap = el("div", {}, loadingEl());
		sysPanel.appendChild(sysWrap);
		var portsPanel = panel("Ports and radios");
		portsPanel.style.marginTop = "14px";
		var portsWrap = el("div", {}, loadingEl());
		portsPanel.appendChild(portsWrap);
		VIEW.appendChild(sysPanel); VIEW.appendChild(portsPanel);

		call("pirate.router", "status").then(function (s) {
			var m = s.memory || {}, f = s.flash || {};
			clear(sysWrap).appendChild(kvEl([
				["Model", s.model],
				["Firmware", s.firmware],
				["Hostname", s.hostname],
				["Up for", dur(s.uptime)],
				["Load", s.load],
				["RAM", m.total ? (mb(m.available != null ? m.available : m.free) + " MB free of " + mb(m.total) + " MB") : null],
				["Flash", f.total ? (mb(f.free) + " MB free of " + mb(f.total) + " MB") : null]
			]));
			setNetPill(!!s.online);
		}).catch(function (e) {
			if (String(e.message || e) === "unauthorized") return onError(e);
			clear(sysWrap).appendChild(warnEl(e));
		});

		hw().then(function (p) {
			if (!p) { clear(portsWrap).appendChild(el("div", { class: "muted", text: "The router didn't say." })); return; }
			clear(portsWrap);
			portsWrap.appendChild(el("h4", { class: "sub-h2", text: "Ethernet" }));
			portsWrap.appendChild(tableEl(["Jack", "Link", "Carries"], (p.ethernet || []).map(function (j) {
				var link = j.link
					? badge((j.speed ? j.speed + " Mb/s" : "up") + (j.full_duplex === false ? ", half duplex" : ""), "sec-ok")
					: badge("unplugged", "sec-neutral");
				return [el("strong", { text: j.name }), link,
					el("span", { class: "muted plain", text: j.name === "WAN" ? "the internet, over a cable" : "the router's own network, with its access point" })];
			})));
			portsWrap.appendChild(el("h4", { class: "sub-h2", text: "Wi-Fi radios" }));
			portsWrap.appendChild(tableEl(["Radio", "Chip", "Doing"], (p.radios || []).map(function (r) {
				var doing = el("div");
				(r.interfaces || []).forEach(function (i) {
					var role = ifLabel(i.name).replace(/^.*?(access point|uplink|monitor|mesh)$/, "$1");
					doing.appendChild(el("div", {},
						role + (i.ssid ? " · " + i.ssid : "") + (i.channel ? " · ch " + i.channel : "") + " ",
						el("span", { class: "ifname", text: i.name })));
				});
				if (!(r.interfaces || []).length) doing.appendChild(el("span", { class: "muted", text: "idle" }));
				return [el("strong", { text: phyLabel(r.phy) }),
					el("span", { class: "muted", text: (r.chip || "?") + (r.usb ? ", on USB" : ", built in") + " · " + r.phy }), doing];
			})));
			portsWrap.appendChild(el("h4", { class: "sub-h2", text: "USB and microSD" }));
			var usb = (p.usb || []).map(function (u) { return (u.name || "a device") + " (" + u.id + ")"; });
			portsWrap.appendChild(kvEl([
				["USB port", usb.length ? usb.join(", ") : "nothing plugged in"],
				["microSD slot", p.card && p.card.present ? "a card (" + p.card.device + ")" : "empty"]
			]));
			portsWrap.appendChild(el("p", { class: "descr", text:
				"A hub on the USB port shows what is plugged into it. The Drives, Flipper and DreamPi pages cover what they find there; the microSD card holds Pirate Radio's recordings." }));
		});
	}

	/* ---------- Uplink: the network the router joins for its internet ---------- */

	function renderUplink() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Uplink", "the network the router joins for its internet"));

		var netPanel = panel("Internet");
		var netWrap = el("div", {}, loadingEl());
		netPanel.appendChild(netWrap);

		var wifiPanel = panel("Wi-Fi uplink");
		wifiPanel.style.marginTop = "14px";
		var wifiStatus = el("div", { class: "muted", text: "Loading…" });
		var wifiScanWrap = el("div");
		var joinSsid = el("input", { class: "inp", type: "text", placeholder: "SSID" });
		var joinKey = el("input", { class: "inp", type: "password", placeholder: "password (blank if open)" });
		var joinStatus = el("span", { class: "status" });
		wifiPanel.appendChild(wifiStatus);
		wifiPanel.appendChild(el("div", { class: "toolbar" }, btn("Scan for networks", { onclick: wifiScan })));
		wifiPanel.appendChild(wifiScanWrap);
		wifiPanel.appendChild(el("h4", { class: "sub-h2", text: "Join a network" }));
		wifiPanel.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "SSID" }), joinSsid),
			el("label", {}, el("span", { class: "lbl", text: "Password" }), joinKey)));
		wifiPanel.appendChild(el("div", { class: "toolbar" },
			btn("Join", { primary: true, onclick: function () { doJoin(joinSsid.value, "", joinKey.value); } }), joinStatus));
		wifiPanel.appendChild(el("p", { class: "descr", text:
			"The 5 GHz radio joins it, beside the Pirate Radio access point. Changing it reloads Wi-Fi: the access point drops briefly and comes back, so you stay reachable on it even if the new network is wrong." }));

		VIEW.appendChild(netPanel); VIEW.appendChild(wifiPanel);

		function showWifi(s) {
			clear(wifiStatus);
			if (!s || s.configured === false) { wifiStatus.appendChild(el("span", { class: "muted", text: "No uplink configured." })); return; }
			var ok = !!s.connected;
			wifiStatus.appendChild(badge(ok ? "connected" : "down", ok ? "sec-ok" : "sec-neutral"));
			wifiStatus.appendChild(document.createTextNode(" " + (s.ssid || s.live_ssid || "—") +
				(ok && s.signal ? "  ·  " + s.signal + " dBm" : "") + (s.encryption ? "  ·  " + s.encryption : "")));
		}
		function encLabel(e) { return e === "open" ? "open" : (e === "wpa3" ? "WPA3" : (e === "wep" ? "WEP" : "WPA2")); }
		function wifiScan() {
			clear(wifiScanWrap).appendChild(el("div", { class: "muted", text: "scanning…" }));
			call("pirate.router", "wifi_scan").then(function (r) {
				var nets = (r && r.networks) || [];
				nets.sort(function (a, b) { return (b.signal || -999) - (a.signal || -999); });
				if (!nets.length) { clear(wifiScanWrap).appendChild(el("div", { class: "placeholder", text: "No networks found." })); return; }
				clear(wifiScanWrap).appendChild(tableEl(["Network", "Ch", "Signal", "Security", ""], nets.map(function (n) {
					return [
						n.ssid ? el("strong", { text: n.ssid }) : el("em", { class: "muted", text: "(hidden)" }),
						String(n.channel || "-"),
						(n.signal ? n.signal + " dBm" : "-"),
						badge(encLabel(n.enc), n.enc === "open" ? "sec-open" : (n.enc === "wpa3" ? "sec-ok" : "sec-warn")),
						n.ssid ? btn("Use", { cls: "small", onclick: function () {
							joinSsid.value = n.ssid; joinKey.value = "";
							if (n.enc === "open") doJoin(n.ssid, "open", "");
							else { joinKey.focus(); joinStatus.className = "status"; joinStatus.textContent = "enter the password, then Join"; }
						} }) : ""
					];
				})));
			}).catch(function (e) { clear(wifiScanWrap).appendChild(warnEl(e)); });
		}
		function doJoin(ssid, enc, key) {
			if (!ssid) { joinStatus.className = "status"; joinStatus.textContent = "enter an SSID"; return; }
			joinStatus.className = "status";
			joinStatus.textContent = "joining " + ssid + "… (Wi-Fi reloads)";
			call("pirate.router", "wifi_join", { ssid: ssid, enc: enc || "", key: key }).then(function (r) {
				if (r.error) { joinStatus.textContent = r.error; joinStatus.className = "status err"; return; }
				joinStatus.className = "status ok-text";
				joinStatus.textContent = "applied — joining " + r.ssid + " (" + r.encryption + "); give it a moment";
				setTimeout(function () { call("pirate.router", "wifi_status").then(showWifi).catch(function () {}); }, 6000);
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				joinStatus.textContent = String(e.message || e); joinStatus.className = "status err";
			});
		}

		call("pirate.router", "wifi_status").then(showWifi).catch(function () { clear(wifiStatus); });
		Promise.all([
			call("pirate.router", "status"),
			call("pirate.recon", "uplink").catch(function () { return null; }),
			hw()
		]).then(function (r) {
			var s = r[0], u = r[1];
			setNetPill(!!s.online, u && u.ssid);
			if (!u || u.error) { clear(netWrap).appendChild(el("div", { class: "muted", text: "Not joined to a network." })); return; }
			clear(netWrap).appendChild(kvEl([
				["Network", u.ssid || "wired"],
				["Through", u.iface ? ifEl(u.iface) : null],
				["Its address there", u.self],
				["Subnet", u.subnet],
				["Gateway", u.gateway ? (u.gateway + (u.gateway_mac ? " (" + u.gateway_mac + ")" : "")) : null],
				["Internet", s.online ? "reachable" : "no default route"]
			]));
		}).catch(function (e) {
			if (String(e.message || e) === "unauthorized") return onError(e);
			clear(netWrap).appendChild(warnEl(e));
		});
	}

	/* ---------- Clients: what is on the router's own network ---------- */

	function renderClients() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Clients", "what is on the router's own network: its LAN jacks and access point"));

		var cliPanel = panel("Clients");
		var cliWrap = el("div", {}, loadingEl());
		cliPanel.appendChild(cliWrap);
		var adbPanel = panel("Ad blocking");
		adbPanel.style.marginTop = "14px";
		var adbWrap = el("div", {}, loadingEl());
		adbPanel.appendChild(adbWrap);
		adbPanel.appendChild(el("p", { class: "descr", text:
			"Through the router's DNS, for every client: lists of ad and tracking domains go unanswered." }));
		VIEW.appendChild(cliPanel); VIEW.appendChild(adbPanel);

		function fillClients(data) {
			var list = (data && data.clients) || [];
			if (data && data.error) { clear(cliWrap).appendChild(alertEl("warn", data.error)); return; }
			if (!list.length) { clear(cliWrap).appendChild(el("div", { class: "placeholder", text: "No DHCP leases yet." })); return; }
			clear(cliWrap).appendChild(tableEl(["Host", "IP", "MAC"], list.map(function (c) {
				return [
					(c.host && c.host !== "-") ? el("strong", { text: c.host }) : el("em", { class: "muted", text: "(unknown)" }),
					el("code", { text: c.ip }), el("code", { text: c.mac })
				];
			})));
		}
		function fillAdb(a) {
			clear(adbWrap);
			if (a.error) { adbWrap.appendChild(alertEl("warn", a.error)); return; }
			if (!a.installed) { adbWrap.appendChild(el("div", { class: "muted", text: "Adblock is not installed in this image." })); return; }
			var on = !!a.enabled;
			adbWrap.appendChild(el("div", { class: "toolbar" },
				badge(on ? "on" : "off", on ? "sec-ok" : "sec-neutral"),
				el("span", { class: "status", text: a.domains ? a.domains.toLocaleString() + " domains blocked" : (on ? "enabled" : "disabled") }),
				btn(on ? "Disable" : "Enable", { cls: on ? "reset" : "", primary: !on, onclick: function () { toggleAdb(!on); } })));
		}
		function toggleAdb(to) {
			clear(adbWrap).appendChild(el("div", { class: "muted", text: to ? "Enabling…" : "Disabling…" }));
			call("pirate.router", "adblock", { enabled: to }).then(fillAdb).catch(function (e) { clear(adbWrap).appendChild(warnEl(e)); });
		}
		call("pirate.router", "clients").then(fillClients).catch(function (e) {
			if (String(e.message || e) === "unauthorized") return onError(e);
			clear(cliWrap).appendChild(warnEl(e));
		});
		call("pirate.router", "adblock").then(fillAdb).catch(function (e) { clear(adbWrap).appendChild(warnEl(e)); });
	}

	/* ---------- Access: the root password, SSH, who is signed in ---------- */

	// Sign in again with the root password, apart from this page's own session:
	// rpcd checks it, and the backend takes the fresh session as proof
	function proveRoot(pass) {
		if (DEMO) return pass === "wrong" ? Promise.reject(new Error("login failed")) : Promise.resolve("0123456789abcdef0123456789abcdef");
		return rpc("call", [NULL_SID, "session", "login", { username: "root", password: pass, timeout: 60 }]).then(function (r) {
			if (!Array.isArray(r) || r[0] !== 0 || !r[1] || !r[1].ubus_rpc_session) throw new Error("login failed");
			return r[1].ubus_rpc_session;
		});
	}

	function renderAccess() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Access", "the root password, SSH, and who is signed in"));
		var host = location.hostname || "pirateradio.local";
		var keyNames = {};

		function line(node, text, kind) { node.textContent = text; node.className = "status" + (kind ? " " + kind : ""); }

		// The root password
		var pwPanel = panel("Root password");
		var pw0 = el("input", { class: "inp", type: "password", autocomplete: "current-password", placeholder: "current password" });
		var pw1 = el("input", { class: "inp", type: "password", autocomplete: "new-password", placeholder: "at least 5 characters" });
		var pw2 = el("input", { class: "inp", type: "password", autocomplete: "new-password", placeholder: "again" });
		var pwStatus = el("span", { class: "status" });
		pwPanel.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "Current password" }), pw0),
			el("label", {}, el("span", { class: "lbl", text: "New password" }), pw1),
			el("label", {}, el("span", { class: "lbl", text: "New, again" }), pw2)));
		pwPanel.appendChild(el("div", { class: "toolbar" }, btn("Change password", { primary: true, onclick: setPassword }), pwStatus));
		pwPanel.appendChild(el("p", { class: "descr", text:
			"Root's password signs in to this page, to SSH and to the terminal. Changing it needs the current one: the router checks it before anything changes." }));

		function setPassword() {
			if (!pw0.value) return line(pwStatus, "enter the current password", "err");
			if (pw1.value.length < 5) return line(pwStatus, "use at least 5 characters", "err");
			if (pw1.value !== pw2.value) return line(pwStatus, "the two new entries differ", "err");
			if (/[\r\n]/.test(pw1.value)) return line(pwStatus, "a password can't have line breaks", "err");
			line(pwStatus, "checking the current password…");
			proveRoot(pw0.value).then(function (proof) {
				line(pwStatus, "changing it…");
				return call("pirate.router", "set_password", { password: pw1.value, proof: proof }).then(function (r) {
					if (r.error) return line(pwStatus, r.error, "err");
					pw0.value = pw1.value = pw2.value = "";
					line(pwStatus, "password changed", "ok-text");
				});
			}, function (e) {
				line(pwStatus, String(e.message || e) === "login failed" ? "the current password is wrong" : String(e.message || e), "err");
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				line(pwStatus, String(e.message || e), "err");
			});
		}

		// SSH: its port, passwords, and the router's own keys
		var sshPanel = panel("SSH");
		sshPanel.style.marginTop = "14px";
		var sshHead = el("div", {}, loadingEl());
		var portIn = el("input", { class: "inp", type: "number", min: "1", max: "65535" });
		var pwChk = el("input", { type: "checkbox" });
		var sshStatus = el("span", { class: "status" });
		var hostKeys = el("div");
		sshPanel.appendChild(sshHead);
		sshPanel.appendChild(el("div", { class: "form" }, el("label", {}, el("span", { class: "lbl", text: "Port" }), portIn)));
		sshPanel.appendChild(el("div", { class: "toolbar" },
			el("label", { class: "chkline" }, pwChk, "Take passwords (keys are always taken)"),
			btn("Save", { onclick: saveSsh }), sshStatus));
		sshPanel.appendChild(hostKeys);

		// The keys it takes
		var keysPanel = panel("SSH keys");
		keysPanel.style.marginTop = "14px";
		var keysWrap = el("div", {}, loadingEl());
		var keyIn = el("input", { class: "inp", type: "text", spellcheck: "false", autocapitalize: "off",
			placeholder: "ssh-ed25519 AAAA… you@computer" });
		var keyStatus = el("span", { class: "status" });
		keysPanel.appendChild(keysWrap);
		keysPanel.appendChild(el("h4", { class: "sub-h2", text: "Add a key" }));
		keysPanel.appendChild(el("div", { class: "form form-wide" },
			el("label", {}, el("span", { class: "lbl", text: "Public key" }), keyIn)));
		keysPanel.appendChild(el("div", { class: "toolbar" }, btn("Add key", { primary: true, onclick: addKey }), keyStatus));
		keysPanel.appendChild(el("p", { class: "descr", text:
			"A key signs in without a password. Paste the one line of your public key: the .pub file beside your private key (ssh-keygen -t ed25519 makes a pair). With a key here, passwords can go off." }));

		// Who is in now, and recent sign-ins
		var sesPanel = panel("Signed in now");
		sesPanel.style.marginTop = "14px";
		var sesWrap = el("div", {}, loadingEl());
		sesPanel.appendChild(sesWrap);
		sesPanel.appendChild(el("p", { class: "descr", text:
			"SSH and terminal sessions. Ending one closes it at once. This page's own sign-in isn't one of them." }));
		var recPanel = panel("Recent sign-ins");
		recPanel.style.marginTop = "14px";
		var recWrap = el("div", {}, loadingEl());
		recPanel.appendChild(recWrap);

		VIEW.appendChild(pwPanel); VIEW.appendChild(sshPanel); VIEW.appendChild(keysPanel);
		VIEW.appendChild(sesPanel); VIEW.appendChild(recPanel);

		function keyName(fp) { return keyNames[fp] || "a key"; }
		function show(s) {
			keyNames = {};
			(s.keys || []).forEach(function (k) { keyNames[k.fingerprint] = k.comment || (k.type + " key"); });

			clear(sshHead).appendChild(el("div", { class: "toolbar" },
				badge(s.running ? "running" : "stopped", s.running ? "sec-ok" : "sec-warn"),
				el("span", { class: "status", text: "port " + s.port + " · " + (s.passwords ? "passwords and keys" : "keys only") }),
				el("code", { text: "ssh root@" + host + (s.port !== 22 ? " -p " + s.port : "") })));
			portIn.value = s.port;
			pwChk.checked = !!s.passwords;
			clear(hostKeys);
			if ((s.host_keys || []).length) {
				hostKeys.appendChild(el("h4", { class: "sub-h2", text: "This router's keys" }));
				hostKeys.appendChild(kvEl(s.host_keys.map(function (k) { return [k.type, el("code", { text: k.fingerprint })]; })));
				hostKeys.appendChild(el("p", { class: "descr", text:
					"What SSH shows the first time it connects, to check it reached this router." }));
			}

			var keys = s.keys || [];
			clear(keysWrap).appendChild(keys.length ? tableEl(["Name", "Type", "Fingerprint", ""], keys.map(function (k) {
				return [el("strong", { text: k.comment || "(no name)" }), k.type, el("code", { text: k.fingerprint }),
					btn("Remove", { cls: "small reset", onclick: function () { removeKey(k); } })];
			})) : el("div", { class: "placeholder", text: "No keys yet: SSH takes root's password only." }));

			var ses = s.sessions || [];
			clear(sesWrap).appendChild(ses.length ? tableEl(["Session", "From", "Signed in with", "For", ""], ses.map(function (x) {
				var how = x.kind === "terminal"
					? (x.how === "waiting" ? "at the password prompt" : "password")
					: (x.how === "key" ? keyName(x.key) : x.how === "password" ? "password" : "—");
				return [el("strong", { text: x.kind === "terminal" ? "Terminal" : "SSH" }), x.from || "—", how,
					dur(x.age), btn("End", { cls: "small reset", onclick: function () { endSession(x); } })];
			})) : el("div", { class: "placeholder", text: "No one is signed in over SSH or the terminal." }));

			var rec = s.recent || [];
			clear(recWrap).appendChild(rec.length ? tableEl(["When", "", "What", "From"], rec.map(function (r) {
				var via = r.how === "terminal" ? "terminal: " : "SSH: ";
				var what = r.event === "out" ? "signed out"
					: r.event === "refused" ? (r.how === "user" ? "no such user" : "wrong password")
					: r.how === "key" ? "signed in with " + keyName(r.key)
					: r.how === "terminal" ? "signed in" : "signed in with the password";
				return [new Date(r.time * 1000).toLocaleString(),
					badge(r.event === "in" ? "in" : r.event === "out" ? "out" : "refused",
						r.event === "in" ? "sec-ok" : r.event === "out" ? "sec-neutral" : "sec-warn"),
					via + what, r.from || "—"];
			})) : el("div", { class: "placeholder", text: "No sign-ins in the log." }));
		}
		function load() {
			return call("pirate.access", "ssh_status").then(show).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				var msg = String(e.message || e) === "ubus status 4" ? "The access service isn't installed on this router yet." : String(e.message || e);
				clear(sshHead).appendChild(alertEl("warn", msg));
				clear(keysWrap); clear(sesWrap); clear(recWrap);
			});
		}
		function saveSsh() {
			var port = parseInt(portIn.value, 10);
			line(sshStatus, "saving…");
			call("pirate.access", "ssh_set", { port: isNaN(port) ? 0 : port, passwords: pwChk.checked }).then(function (r) {
				if (r.error) return line(sshStatus, r.error, "err");
				line(sshStatus, "saved: SSH restarts with it (sessions open now stay)", "ok-text");
				setTimeout(load, 2500);
			}).catch(function (e) { line(sshStatus, String(e.message || e), "err"); });
		}
		function addKey() {
			var k = keyIn.value.trim();
			if (!k) return line(keyStatus, "paste a public key first", "err");
			call("pirate.access", "ssh_key_add", { key: k }).then(function (r) {
				if (r.error) return line(keyStatus, r.error, "err");
				keyIn.value = "";
				line(keyStatus, "added: " + r.fingerprint, "ok-text");
				load();
			}).catch(function (e) { line(keyStatus, String(e.message || e), "err"); });
		}
		function removeKey(k) {
			if (!window.confirm("Remove the key " + (k.comment || k.fingerprint) + "? It won't sign in any more.")) return;
			call("pirate.access", "ssh_key_remove", { fingerprint: k.fingerprint }).then(function (r) {
				if (r.error) return line(keyStatus, r.error, "err");
				line(keyStatus, "removed", "ok-text");
				load();
			}).catch(function (e) { line(keyStatus, String(e.message || e), "err"); });
		}
		function endSession(x) {
			if (!window.confirm("End this " + (x.kind === "terminal" ? "terminal" : "SSH") + " session" + (x.from ? " from " + x.from : "") + "?")) return;
			call("pirate.access", "session_end", { pid: x.pid }).then(function (r) {
				if (r.error) window.alert(r.error);
				setTimeout(load, 500);
			}).catch(function (e) { window.alert(String(e.message || e)); });
		}
		load();
	}

	/* ---------- Terminal: a shell on the router, in the page ---------- */

	function renderTerminal() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Terminal", "a shell on the router, in this page"));
		var p = panel();
		var wrap = el("div", {}, loadingEl());
		p.appendChild(wrap);
		p.appendChild(el("p", { class: "descr", text:
			"Root's shell, as over SSH: it asks for root's password. Only the router's own network (its LAN jacks and the Pirate Radio access point) reaches it, and only its own page can open it; two at a time. Who is in: the Access page." }));
		VIEW.appendChild(p);

		function show(t) {
			clear(wrap);
			if (!t.installed) {
				wrap.appendChild(el("div", { class: "placeholder" },
					el("b", { text: "The terminal (ttyd) isn't installed on this router." }),
					el("div", { text: "apk add ttyd, then reload this page. Images built from now on bring it." })));
				return;
			}
			if (!t.enabled || !t.running) {
				wrap.appendChild(el("div", { class: "toolbar" },
					badge("off", "sec-neutral"),
					el("span", { class: "status", text: "The terminal is off: nothing listens for it." }),
					btn("Turn it on", { primary: true, onclick: function () { set(true); } })));
				return;
			}
			var url = "http://" + location.hostname + ":" + t.port + "/";
			var frame = DEMO
				? el("pre", { class: "term term-demo", text: "\nPirateRadio login: root\nPassword: " })
				: el("iframe", { class: "term", src: url, title: "Terminal" });
			wrap.appendChild(el("div", { class: "toolbar" },
				btn("New session", { onclick: function () { if (!DEMO) frame.src = url; } }),
				el("a", { class: "btn", href: url, target: "_blank", rel: "noopener", text: "Open in a new tab" }),
				btn("Turn it off", { cls: "reset", onclick: function () {
					if (window.confirm("Turn the terminal off? Open terminals end.")) set(false);
				} })));
			if (location.protocol === "https:")
				wrap.appendChild(alertEl("warn", "This page came over HTTPS and the terminal is plain HTTP: browsers won't show it here. Open it in a new tab."));
			wrap.appendChild(frame);
		}
		function set(on) {
			clear(wrap).appendChild(el("div", { class: "muted", text: on ? "Turning it on…" : "Turning it off…" }));
			call("pirate.access", "term_set", { enabled: on }).then(function (t) {
				if (t.error) { clear(wrap).appendChild(alertEl("warn", t.error)); return; }
				// ttyd takes a moment to listen
				setTimeout(function () { show(t); }, on ? 800 : 0);
			}).catch(function (e) { clear(wrap).appendChild(warnEl(e)); });
		}
		call("pirate.access", "term_status").then(show).catch(function (e) {
			if (String(e.message || e) === "unauthorized") return onError(e);
			clear(wrap).appendChild(alertEl("warn", String(e.message || e) === "ubus status 4"
				? "The access service isn't installed on this router yet." : String(e.message || e)));
		});
	}

	/* ---------- Messenger: a MeshCore radio on the USB port ---------- */

	function mcTime(t) {
		if (!t) return "";
		var d = new Date(t * 1000), now = new Date();
		var hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + hm;
	}
	function mcBattery(mv) {
		if (!mv) return "";
		var pct = Math.max(0, Math.min(100, Math.round((mv - 3300) / 9)));
		return pct + "% (" + (mv / 1000).toFixed(2) + " V)";
	}
	// UTF-8 bytes, as the radio counts them
	function utf8len(s) {
		var n = 0, i, c;
		for (i = 0; i < s.length; i++) {
			c = s.charCodeAt(i);
			n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c < 0xdc00) ? (i++, 4) : 3;
		}
		return n;
	}

	/* Who said it, at a glance: a colour of their own, from their name (the
	   same in every conversation, on every visit), and a picture: the first
	   emoji in the name, or else its first letter. Thirteen hues, each light
	   or deep: 26 colours, so few in one thread share one. Amber is left
	   out: it's yours. */
	var MC_HUES = [352, 12, 80, 110, 140, 165, 185, 203, 222, 248, 275, 300, 325];
	function mcHue(name) {
		var h = 0x811c9dc5, i;
		for (i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
		// FNV's low bits are poorly mixed, and they pick the colour: mix them (murmur3's finish)
		h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
		h = (h >>> 0) % (MC_HUES.length * 2);
		return { h: MC_HUES[h >> 1], deep: !!(h & 1) };
	}
	function mcColour(node, name) {
		var c = mcHue(name || "");
		node.style.setProperty("--h", String(c.h));
		if (c.deep) node.classList.add("deep");
	}
	function mcRe(src) { try { return new RegExp(src, "u"); } catch (e) { return null; } }
	var MC_PRES = mcRe("\\p{Emoji_Presentation}"), MC_PICT = mcRe("\\p{Extended_Pictographic}"),
		MC_WORD = mcRe("[\\p{L}\\p{N}]") || /[A-Za-z0-9]/;
	// A name's characters as one sees them: an emoji whole, with its skin
	// tone, its joins (a 🏴‍☠️ is three) and a flag's two letters
	var MC_SEG = window.Intl && Intl.Segmenter ? new Intl.Segmenter() : null;
	function mcGlyphs(s) {
		if (MC_SEG) return Array.from(MC_SEG.segment(s), function (g) { return g.segment; });
		var cps = Array.from(s), out = [], i, c, last;
		for (i = 0; i < cps.length; i++) {
			c = cps[i];
			last = out.length ? out[out.length - 1] : null;
			if (last !== null && (/^[‍︎️⃣̀-ͯ]$/.test(c) || /^\ud83c[\udffb-\udfff]$/.test(c) ||
				/^\udb40[\udc20-\udc7f]$/.test(c) || /‍$/.test(last) ||
				(/^\ud83c[\udde6-\uddff]$/.test(c) && /^\ud83c[\udde6-\uddff]$/.test(last))))
				out[out.length - 1] = last + c;
			else out.push(c);
		}
		return out;
	}
	function mcPicture(name) {
		var g = mcGlyphs(name || ""), i;
		if (MC_PRES) for (i = 0; i < g.length; i++)
			if (MC_PRES.test(g[i]) || /⃣/.test(g[i]) || (MC_PICT.test(g[i]) && /️/.test(g[i])))
				return { emoji: true, text: g[i] };
		for (i = 0; i < g.length; i++)
			if (MC_WORD.test(g[i])) return { emoji: false, text: g[i].toLocaleUpperCase() };
		return { emoji: false, text: "?" };
	}
	// A person's face: a circle in their hue (yours, amber); a channel's, a square
	function mcFace(name, mine, cls) {
		var p = mcPicture(name);
		var a = el("span", { class: "mc-av" + (p.emoji ? " emoji" : "") + (mine ? " mine" : "") + (cls ? " " + cls : ""),
			"aria-hidden": "true", text: p.text });
		if (!mine) mcColour(a, name);
		return a;
	}
	function mcTile(name, cls) {
		var p = mcPicture(name);
		return el("span", { class: "mc-av mc-tile" + (p.emoji ? " emoji" : "") + (cls ? " " + cls : ""), "aria-hidden": "true", text: p.text });
	}
	function mcHM(t) { return new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
	function mcSameDay(a, b) { return new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString(); }
	function mcDay(t) {
		var d = new Date(t * 1000), now = new Date();
		if (mcSameDay(t, now / 1000)) return "Today";
		if (mcSameDay(t, now / 1000 - 86400)) return "Yesterday";
		return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric",
			year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
	}

	/* Small icons, drawn here (no icon font), or an emoji where a drawing
	   this small wouldn't read */
	var MC_ICON = {
		hash: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M6.4 2 5.2 14M10.8 2 9.6 14M2.6 5.6h11.2M2.2 10.4h11.2" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>',
		lock: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M5.2 7V5.3a2.8 2.8 0 0 1 5.6 0V7" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="3.4" y="7" width="9.2" height="6.8" rx="1.4" fill="currentColor"/></svg>',
		// The emoji: a drawn one at this size looked like a sun
		gear: "&#x2699;&#xFE0F;",
		plus: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
		people: '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="6" cy="5.4" r="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1.6 13.6c.4-2.4 2.2-3.9 4.4-3.9s4 1.5 4.4 3.9M10.6 3.2a2.4 2.4 0 0 1 0 4.5M12.2 9.9c1.3.5 2.1 1.7 2.3 3.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
		chev: '<svg viewBox="0 0 12 12" width="10" height="10"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
		send: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M2.2 7.6 13.8 2.4 10.6 13.8 8.1 9.1Z" fill="currentColor"/></svg>',
		term: '<svg viewBox="0 0 16 16" width="16" height="16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.2 6.2 6.4 8l-2.2 1.8M8.2 10.4h3.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
		pkts: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M1.4 8.6h2.2l1.6-4.4 2.6 8.4 2.4-6.2 1.4 2.2h2.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
		down: '<svg viewBox="0 0 12 12" width="11" height="11"><path d="M6 2v8M2.6 6.6 6 10l3.4-3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
	};
	function mcIcon(name, cls) {
		var emoji = MC_ICON[name].charAt(0) !== "<";
		return el("span", { class: "mc-ic" + (emoji ? " mc-ic-e" : "") + (cls ? " " + cls : ""), "aria-hidden": "true", html: MC_ICON[name] });
	}
	// A channel: MeshCore's public one, a #hashtag one (its key from its
	// name: anyone can join), or private (a key given to those in it)
	var MC_PUBLIC_KEY = "8b3387e9c5cdea6ac9e5edbaa115cd72";
	function mcChanKind(c) { return c.secret === MC_PUBLIC_KEY ? "public" : c.name.charAt(0) === "#" ? "hashtag" : "private"; }
	function mcChanLabel(c) { return mcChanKind(c) === "hashtag" && c.name.length > 1 ? c.name.slice(1) : c.name; }
	/* MeshCore's suggested radio settings, region by region, as its app
	   offers them (from its app API's config, api.meshcore.nz/api/v1/config:
	   kept here so the page needs no internet). f in kHz, bw in Hz; hs: the
	   hop ids' size in bytes that mesh uses too, where it says */
	var MC_PRESETS = [
		{ t: "Australia", f: 915800, bw: 250000, sf: 10, cr: 5 },
		{ t: "Australia (Narrow)", f: 916575, bw: 62500, sf: 7, cr: 7 },
		{ t: "Australia (Mid)", f: 915075, bw: 125000, sf: 9, cr: 5 },
		{ t: "Australia: SA, WA", f: 923125, bw: 62500, sf: 8, cr: 8 },
		{ t: "Australia: QLD", f: 923125, bw: 62500, sf: 8, cr: 5 },
		{ t: "Brazil", f: 923125, bw: 62500, sf: 8, cr: 8 },
		{ t: "Canada", f: 910525, bw: 62500, sf: 7, cr: 5, hs: 3 },
		{ t: "Costa Rica", f: 910525, bw: 125000, sf: 11, cr: 5 },
		{ t: "EU/UK (Narrow)", f: 869618, bw: 62500, sf: 8, cr: 8 },
		{ t: "EU/UK (Deprecated)", f: 869525, bw: 250000, sf: 11, cr: 5 },
		{ t: "Czech Republic (Narrow)", f: 869432, bw: 62500, sf: 7, cr: 5, hs: 2 },
		{ t: "EU 433MHz (Long Range)", f: 433650, bw: 250000, sf: 11, cr: 5 },
		{ t: "EU 433MHz (Narrow)", f: 433650, bw: 62500, sf: 8, cr: 8 },
		{ t: "Hungary", f: 869618, bw: 62500, sf: 7, cr: 5, hs: 2 },
		{ t: "Netherlands", f: 869618, bw: 62500, sf: 7, cr: 5 },
		{ t: "Netherlands (Limburg)", f: 869618, bw: 62500, sf: 8, cr: 8, hs: 2 },
		{ t: "New Zealand (Narrow)", f: 917375, bw: 62500, sf: 7, cr: 5, hs: 2 },
		{ t: "New Zealand (Gisborne)", f: 917375, bw: 250000, sf: 11, cr: 5, hs: 1 },
		{ t: "Portugal 433", f: 433375, bw: 62500, sf: 9, cr: 6 },
		{ t: "Portugal 868", f: 869618, bw: 62500, sf: 7, cr: 6 },
		{ t: "Slovakia", f: 869618, bw: 62500, sf: 7, cr: 5, hs: 2 },
		{ t: "Switzerland", f: 869618, bw: 62500, sf: 8, cr: 8 },
		{ t: "Thailand", f: 921000, bw: 62500, sf: 7, cr: 5 },
		{ t: "USA", f: 910525, bw: 62500, sf: 7, cr: 5 },
		{ t: "USA - Southern California", f: 927875, bw: 62500, sf: 7, cr: 5, hs: 3 },
		{ t: "Vietnam (Narrow)", f: 920250, bw: 62500, sf: 8, cr: 5 },
		{ t: "Vietnam (Deprecated)", f: 920250, bw: 250000, sf: 11, cr: 5 }
	];
	// The LoRa bandwidths its radios have, in Hz
	var MC_BWS = [7800, 10400, 15600, 20800, 31250, 41700, 62500, 125000, 250000, 500000];
	function mcMHz(khz) { return (khz / 1000).toFixed(3).replace(/\.?0+$/, ""); }
	function mcKHz(hz) { return (hz / 1000).toFixed(2).replace(/\.?0+$/, ""); }
	// Which of MeshCore's presets a radio's settings are, if any (one with no
	// hop-id size of its own first: that's a setting a radio doesn't say)
	function mcPresetOf(r) {
		var m = MC_PRESETS.filter(function (p) { return p.f === r.freq_khz && p.bw === r.bw_hz && p.sf === r.sf && p.cr === r.cr; });
		m.sort(function (a, b) { return (a.hs ? 1 : 0) - (b.hs ? 1 : 0); });
		return m[0] || null;
	}
	// Seconds, as long as they've been: up 3 d 4 h; 12 min; 40 s
	function mcLong(s) {
		s = Math.max(0, Math.round(s || 0));
		if (s >= 86400) return Math.floor(s / 86400) + " d " + Math.floor(s % 86400 / 3600) + " h";
		if (s >= 3600) return Math.floor(s / 3600) + " h " + Math.floor(s % 3600 / 60) + " min";
		if (s >= 60) return Math.floor(s / 60) + " min " + (s % 60) + " s";
		return s + " s";
	}
	/* MeshCore's packets, as its radio hears them (its docs/packet_format.md):
	   a header (route, payload type, version), transport codes on a scoped
	   route, a path (its hops' ids, 1-3 bytes each), then the payload - an
	   advert in the clear (who, what kind, where), the rest addressed by
	   1-byte hashes of keys (or of a channel's) and encrypted */
	var MC_PKT_TYPES = ["request", "response", "message", "ack", "advert", "channel", "channel data",
		"anonymous request", "path", "trace", "multipart", "control", "type 12", "type 13", "type 14", "custom"];
	var MC_NODE_KINDS = ["", "person", "repeater", "room", "sensor"];
	function mcHexBytes(hex) {
		var b = [], i;
		for (i = 0; i + 1 < hex.length; i += 2) b.push(parseInt(hex.substr(i, 2), 16));
		return b;
	}
	function mcHex(b, from, to) {
		var s = "", i;
		for (i = from; i < to; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
		return s;
	}
	function mcLe32(b, i) { return (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0; }
	function mcDecodePacket(hex) {
		var b = mcHexBytes(hex), p = { size: b.length };
		if (b.length < 2) { p.short = true; return p; }
		var h = b[0], i = 1;
		p.route = h & 3;
		p.type = h >> 2 & 15;
		p.ver = h >> 6;
		p.typeName = MC_PKT_TYPES[p.type];
		p.flood = p.route < 2;
		p.scoped = p.route === 0 || p.route === 3;
		if (p.scoped) {
			if (b.length < i + 4) { p.short = true; return p; }
			p.scope = b[i] | b[i + 1] << 8;
			i += 4;
		}
		if (b.length < i + 1) { p.short = true; return p; }
		var pl = b[i++], hs = (pl >> 6) + 1;
		p.hops = pl & 63;
		p.hashSize = hs;
		p.path = [];
		if (hs > 3 || b.length < i + p.hops * hs) { p.short = true; return p; }
		for (var k = 0; k < p.hops; k++) p.path.push(mcHex(b, i + k * hs, i + (k + 1) * hs));
		i += p.hops * hs;
		var d = b.slice(i);
		p.payloadSize = d.length;
		if (p.ver !== 0) return p;      /* a payload version newer than MeshCore's first: not read here */
		switch (p.type) {
		case 4:                         /* advert: key, time, signature, then who it is */
			if (d.length < 101) { p.short = true; break; }
			p.key = mcHex(d, 0, 32);
			p.time = mcLe32(d, 32);
			var f = d[100], j = 101;
			p.kind = MC_NODE_KINDS[f & 15] || "kind " + (f & 15);
			if (f & 0x10) {
				if (d.length < j + 8) { p.short = true; break; }
				p.lat = (mcLe32(d, j) | 0) / 1e6;
				p.lon = (mcLe32(d, j + 4) | 0) / 1e6;
				j += 8;
			}
			if (f & 0x20) j += 2;
			if (f & 0x40) j += 2;
			if (f & 0x80) {
				var name = "";
				try { name = decodeURIComponent(escape(String.fromCharCode.apply(null, d.slice(j)))); }
				catch (e) { name = String.fromCharCode.apply(null, d.slice(j)); }
				p.name = name.replace(/\0[\s\S]*$/, "");
			}
			break;
		case 0: case 1: case 2: case 8: /* request, response, message, path: to, from */
			if (d.length < 4) { p.short = true; break; }
			p.dst = mcHex(d, 0, 1);
			p.src = mcHex(d, 1, 2);
			break;
		case 5: case 6:                 /* a channel's: its hash */
			if (d.length < 3) { p.short = true; break; }
			p.chan = mcHex(d, 0, 1);
			break;
		case 7:                         /* anonymous request (a login): to, and the sender's key */
			if (d.length < 35) { p.short = true; break; }
			p.dst = mcHex(d, 0, 1);
			p.key = mcHex(d, 1, 33);
			break;
		case 3:
			if (d.length >= 4) p.ack = mcHex(d, 0, 4);
			break;
		case 9:
			if (d.length >= 9) p.tag = mcHex(d, 0, 4);
			break;
		case 11:
			if (d.length) p.control = { 8: "discover request", 9: "discover response" }[d[0] >> 4] || "control " + (d[0] >> 4);
			break;
		}
		return p;
	}

	/* SHA-256, for channels' hashes (the router's page isn't on HTTPS, so
	   it has no crypto.subtle) */
	var MC_K256 = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
	function mcSha256(bytes) {
		var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
		var m = bytes.slice(), bits = bytes.length * 8, w = new Array(64), i, j;
		m.push(0x80);
		while (m.length % 64 !== 56) m.push(0);
		for (i = 7; i >= 0; i--) m.push(i > 3 ? 0 : bits >>> (8 * i) & 255);
		function rotr(x, n) { return x >>> n | x << (32 - n); }
		for (i = 0; i < m.length; i += 64) {
			for (j = 0; j < 16; j++) w[j] = m[i + 4 * j] << 24 | m[i + 4 * j + 1] << 16 | m[i + 4 * j + 2] << 8 | m[i + 4 * j + 3];
			for (j = 16; j < 64; j++) {
				var s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ w[j - 15] >>> 3;
				var s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ w[j - 2] >>> 10;
				w[j] = w[j - 16] + s0 + w[j - 7] + s1 | 0;
			}
			var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
			for (j = 0; j < 64; j++) {
				var t1 = k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + (e & f ^ ~e & g) + MC_K256[j] + w[j] | 0;
				var t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + (a & b ^ a & c ^ b & c) | 0;
				k = g; g = f; f = e; e = d + t1 | 0; d = c; c = b; b = a; a = t1 + t2 | 0;
			}
			h[0] = h[0] + a | 0; h[1] = h[1] + b | 0; h[2] = h[2] + c | 0; h[3] = h[3] + d | 0;
			h[4] = h[4] + e | 0; h[5] = h[5] + f | 0; h[6] = h[6] + g | 0; h[7] = h[7] + k | 0;
		}
		var out = [];
		for (i = 0; i < 8; i++) out.push(h[i] >>> 24 & 255, h[i] >>> 16 & 255, h[i] >>> 8 & 255, h[i] & 255);
		return out;
	}
	// A channel's hash, as its packets carry it: the first byte of the SHA-256 of its key
	function mcChanHash(secret) { return mcHex(mcSha256(mcHexBytes(secret)), 0, 1); }
	/* Links in a message, clickable; the ones known to be images (Giphy's
	   GIFs, as a page or as meshcore-open's "g:ID"; a link to an image
	   file) shown under it, as Discord does, loaded by the viewer's
	   browser: offline, or gone, the link stays */
	var MC_URL = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
	var MC_GIPHY_PAGE = /^https?:\/\/(?:www\.)?giphy\.com\/(?:gifs|stickers)\/(?:[^\/?#]*-)?([A-Za-z0-9_]+)\/?(?:[?#].*)?$/i;
	var MC_GIPHY_EMBED = /^https?:\/\/(?:www\.)?giphy\.com\/embed\/([A-Za-z0-9_]+)\/?(?:[?#].*)?$/i;
	var MC_GIPHY_MEDIA = /^https?:\/\/(?:media\d*|i)\.giphy\.com\/media\/([A-Za-z0-9_]+)\//i;
	var MC_IMAGE_FILE = /^https?:\/\/[^\/?#]+\/[^?#]*\.(?:gif|png|jpe?g|webp|avif|bmp)(?:[?#].*)?$/i;
	// Common media sites embedded like Discord: a player you press play on (so
	// nothing external loads until you do) or a card. The viewer's browser does
	// the loading, so it is offline-safe - gone or off-grid, the link stays.
	var MC_YOUTUBE = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i;
	var MC_VIMEO = /^https?:\/\/(?:www\.|player\.)?vimeo\.com\/(?:video\/)?(\d{6,})/i;
	var MC_SPOTIFY = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/i;
	var MC_SOUNDCLOUD = /^https?:\/\/(?:www\.|m\.)?soundcloud\.com\/[^\/?#]+\/[^\/?#]+/i;
	var MC_TWEET = /^https?:\/\/(?:www\.|mobile\.)?(twitter\.com|x\.com)\/([^\/?#]{1,20})\/status\/(\d+)/i;
	function mcGiphy(id) {
		return { src: "https://media.giphy.com/media/" + id + "/200.gif", fallback: "https://media.giphy.com/media/" + id + "/giphy.gif",
			page: "https://giphy.com/gifs/" + id, gif: true };
	}
	// What a link shows, if it's an image: its picture, a fallback, where it goes
	function mcMediaOf(url) {
		var g = MC_GIPHY_PAGE.exec(url) || MC_GIPHY_EMBED.exec(url) || MC_GIPHY_MEDIA.exec(url);
		if (g) return mcGiphy(g[1]);
		if (MC_IMAGE_FILE.test(url)) return { src: url, page: url, gif: /\.gif(?:[?#]|$)/i.test(url) };
		var m;
		if ((m = MC_YOUTUBE.exec(url))) return { type: "youtube", id: m[1], page: url };
		if ((m = MC_VIMEO.exec(url))) return { type: "vimeo", id: m[1], page: url };
		if ((m = MC_SPOTIFY.exec(url))) return { type: "spotify", kind: m[1], id: m[2], page: url };
		if (MC_SOUNDCLOUD.test(url)) return { type: "soundcloud", page: url };
		if ((m = MC_TWEET.exec(url))) return { type: "tweet", x: m[1] === "x.com", handle: m[2], page: url };
		return null;
	}
	// A message that's one image and nothing else: the image alone, as Discord shows it
	function mcOnlyMedia(text) {
		var t = String(text || "").trim(), g = /^g:([A-Za-z0-9_-]+)$/.exec(t);
		if (g) return mcGiphy(g[1]);
		if (/\s/.test(t) || !/^https?:\/\//i.test(t)) return null;
		return mcMediaOf(t);
	}
	function mcMediaLabel(text) {
		var t = String(text || "").trim(), only = mcOnlyMedia(t);
		if (MC_IMG.test(t)) return "Image";
		if (mcPlaceholder(t)) return "A message this can't read";
		if (mcMapperPing(t)) return "📡 ping";
		if (!only) return null;
		if (only.type === "youtube" || only.type === "vimeo") return "📺 video";
		if (only.type === "spotify" || only.type === "soundcloud") return "🎵 audio";
		if (only.type === "tweet") return only.x ? "𝕏 post" : "Tweet";
		return only.gif ? "GIF" : "Image";
	}

	/* MCOimg, MCO Advanced's one-packet images: "im3:" (v3), "im:" (v1, v2)
	   or "im4:" (v4) and its basE91, whole, by text or (the daemon writes it
	   so) come as channel data. Drawn by MCO Advanced's own decoder
	   (mcoimg/), loaded the first time one is shown; v4 has no JavaScript
	   decoder yet, so it's said, not drawn */
	var MC_IMG = /^im[34]?:[A-Za-z0-9!#$%&()*+,.\/:;<=>?@\[\]^_`{|}~"]+$/;
	var MC_UIV = (function () {
		var s = document.currentScript && document.currentScript.src, m = s && /[?&]v=([^&#]+)/.exec(s);
		return m ? m[1] : "";
	})();
	var mcoimgLoad = null, mcoimgDrawn = {};
	function mcoimgReady() {
		if (window.MCOImgBrowser && window.MCOImgV3) return Promise.resolve();
		if (!mcoimgLoad) {
			mcoimgLoad = ["mcoimg-codec.global.js", "mcoimg-v3-codec.global.js", "mcoimg-browser.global.js"].reduce(function (p, f) {
				return p.then(function () {
					return new Promise(function (ok, bad) {
						var s = document.createElement("script");
						s.src = "mcoimg/" + f + (MC_UIV ? "?v=" + MC_UIV : "");
						s.onload = ok;
						s.onerror = function () { bad(new Error("MCOimg's decoder wouldn't load")); };
						document.head.appendChild(s);
					});
				});
			}, Promise.resolve());
			mcoimgLoad.catch(function () { mcoimgLoad = null; });
		}
		return mcoimgLoad;
	}
	// An image's PNG (made once), and its size from the PNG's header
	function mcoimgPng(text) {
		if (!mcoimgDrawn[text]) {
			var png = window.MCOImgBrowser.textToPngBytes(text);
			var w = ((png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19]) >>> 0;
			var h = ((png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23]) >>> 0;
			mcoimgDrawn[text] = { url: URL.createObjectURL(window.MCOImgBrowser.pngBytesToBlob(png)), w: w, h: h };
		}
		return mcoimgDrawn[text];
	}
	// Drawn sharp, at a whole multiple of its size (pixel art), 160px high at most
	function mcoimgEl(text, failed, swap) {
		var box = el("span", { class: "mc-mcoimg", title: "MCOimg, MCO Advanced's image" });
		if (/^im4:/.test(text)) {
			failed("An MCOimg v4 drawing: not drawn here yet");
			return null;
		}
		box.appendChild(el("span", { class: "mc-mcoimg-wait", text: "image…" }));
		mcoimgReady().then(function () {
			var d = mcoimgPng(text), k = Math.max(1, Math.floor(Math.min(160 / d.h, 320 / d.w)));
			var img = el("img", { class: "mc-mcoimg-img", src: d.url, alt: "an image (MCOimg, " + d.w + "×" + d.h + ")",
				width: String(d.w * k), height: String(d.h * k) });
			swap(function () { clear(box).appendChild(img); });
		}).catch(function () {
			swap(function () { if (box.parentNode) box.parentNode.removeChild(box); });
			failed("An MCOimg image this couldn't read");
		});
		return box;
	}
	// What MCO Advanced keeps for a kind it can't read, as it words it
	function mcPlaceholder(text) {
		var m = /^mcoapp-unknown:0x(0120|0100)(?::(\d+)\.(\d+))?$/.exec(String(text || "").trim());
		if (!m) return null;
		if (m[1] === "0100") return "A MeshCore Open message in a format this can't read";
		var kinds = { 1: "an image (MCOimg)", 2: "compressed text (MCMP)", 3: "text (MCOtxt)" };
		return "MCO Advanced's " + (kinds[m[2]] || "kind " + (m[2] || "?")) + (m[3] != null ? ", version " + m[3] : "") + ", in a form this can't read";
	}
	/* MeshMapper's wardriving pings, as its app sends them to #wardriving:
	   "MM:" and a 10-character tag (its session's and ping's, keyed: only
	   MeshMapper's server reads it), then ":lat,lon" when its user
	   broadcasts where they are. Shown as a ping: how it was heard is the news */
	var MC_MMAP = /^MM:([A-Za-z0-9_-]{10})(?::(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?))?$/;
	function mcMapperPing(text) {
		var m = MC_MMAP.exec(String(text || "").trim()), lat, lon;
		if (!m) return null;
		lat = +m[2];
		lon = +m[3];
		return { tag: m[1], pos: m[2] != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat: lat, lon: lon } : null };
	}
	function mcCount(s, c) { return s.split(c).length - 1; }
	// A bracketed mention "@[Name]" (some clients' form, also "@[Name#hash]")
	// rendered inline as an "@Name" chip, like a leading mention, so it reads as
	// a mention and not literal brackets. Everything else stays plain text.
	function mcMentionNodes(str, me) {
		var f = document.createDocumentFragment(), i = 0, mm, re = /@\[([^\]]+?)(?:#\d{10,16})?\]/g;
		while ((mm = re.exec(str))) {
			if (mm.index > i) f.appendChild(document.createTextNode(str.slice(i, mm.index)));
			var nm = mm[1];
			f.appendChild(el("span", { class: "mc-mention" + (me && nm === me ? " me" : ""), "data-mention": nm, role: "button", tabindex: "0", text: "@" + nm }));
			i = mm.index + mm[0].length;
		}
		if (i < str.length) f.appendChild(document.createTextNode(str.slice(i)));
		return f;
	}
	function mcLinkify(text, media, me) {
		var frag = document.createDocumentFragment(), last = 0, m;
		MC_URL.lastIndex = 0;
		while ((m = MC_URL.exec(text))) {
			var u = m[0], c;
			// Not the punctuation after it, nor a bracket it didn't open
			for (;;) {
				c = u.charAt(u.length - 1);
				if (".,;:!?'\"".indexOf(c) >= 0) u = u.slice(0, -1);
				else if (c === ")" && mcCount(u, "(") < mcCount(u, ")")) u = u.slice(0, -1);
				else if (c === "]" && mcCount(u, "[") < mcCount(u, "]")) u = u.slice(0, -1);
				else break;
			}
			if (!u || /^www\.$/i.test(u)) continue;
			if (m.index > last) frag.appendChild(mcMentionNodes(text.slice(last, m.index), me));
			var href = /^www\./i.test(u) ? "https://" + u : u, img = mcMediaOf(href);
			frag.appendChild(el("a", { class: "mc-link", href: href, target: "_blank", rel: "noopener noreferrer nofollow", text: u }));
			if (img && media && media.length < 3) media.push(img);
			last = m.index + u.length;
			MC_URL.lastIndex = last;
		}
		if (last < text.length) frag.appendChild(mcMentionNodes(text.slice(last), me));
		return frag;
	}
	// A link's embed: a player you press play on, a card for a tweet/track, or
	// an image/GIF. Gone (offline, say), the image ones fall back to the link.
	function mcEmbed(img, gone, loaded) {
		if (img.type === "youtube") return mcPlayer(img, "https://www.youtube-nocookie.com/embed/" + img.id + "?autoplay=1&rel=0", "https://i.ytimg.com/vi/" + img.id + "/hqdefault.jpg", "YouTube", "video", loaded);
		if (img.type === "vimeo") return mcPlayer(img, "https://player.vimeo.com/video/" + img.id + "?autoplay=1", null, "Vimeo", "video", loaded);
		if (img.type === "spotify") return mcPlayer(img, "https://open.spotify.com/embed/" + img.kind + "/" + img.id, null, "Spotify", "audio", loaded);
		if (img.type === "soundcloud") return mcPlayer(img, "https://w.soundcloud.com/player/?url=" + encodeURIComponent(img.page) + "&auto_play=true&visual=false&color=%23e0a040", null, "SoundCloud", "audio", loaded);
		if (img.type === "tweet") return mcCard(img, img.x ? "𝕏" : "🐦", "@" + img.handle, (img.x ? "X" : "Twitter") + " · view post");
		var a = el("a", { class: "mc-embed" + (img.gif ? " gif" : ""), href: img.page, target: "_blank", rel: "noopener noreferrer nofollow", title: img.page });
		var im = el("img", { class: "mc-img", src: img.src, alt: img.gif ? "a GIF" : "an image", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
		im.addEventListener("error", function () {
			if (img.fallback && im.getAttribute("src") !== img.fallback) { im.setAttribute("src", img.fallback); return; }
			if (a.parentNode) a.parentNode.removeChild(a);
			if (gone) gone();
		});
		if (loaded) im.addEventListener("load", loaded);
		a.appendChild(im);
		return a;
	}
	// Click-to-load player: a facade (service name, a thumbnail if there is one)
	// until you press play, then the iframe. Nothing external loads until then.
	function mcPlayer(img, src, thumb, label, kind, loaded) {
		var wrap = el("div", { class: "mc-embed mc-player mc-" + kind });
		function play() {
			clear(wrap);
			wrap.appendChild(el("iframe", { class: "mc-iframe", src: src, title: label, loading: "lazy",
				referrerpolicy: "no-referrer", allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: "" }));
			if (loaded) loaded();
		}
		var face = el("button", { type: "button", class: "mc-facade", title: "Play (" + label + ")", onclick: play });
		if (thumb) {
			var im = el("img", { class: "mc-img", src: thumb, alt: label, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
			im.addEventListener("error", function () { if (im.parentNode) im.parentNode.removeChild(im); face.classList.add("no-thumb"); });
			face.appendChild(im);
		} else face.classList.add("no-thumb");
		face.appendChild(el("span", { class: "mc-play", "aria-hidden": "true", text: "▶" }));
		face.appendChild(el("span", { class: "mc-pbadge", text: label }));
		wrap.appendChild(face);
		wrap.appendChild(el("a", { class: "mc-popen", href: img.page, target: "_blank", rel: "noopener noreferrer nofollow", title: "Open on " + label, text: "↗",
			onclick: function (ev) { ev.stopPropagation(); } }));
		return wrap;
	}
	// A compact link card: an icon, a title, where it goes.
	function mcCard(img, icon, title, sub) {
		return el("a", { class: "mc-embed mc-card", href: img.page, target: "_blank", rel: "noopener noreferrer nofollow", title: img.page },
			el("span", { class: "mc-cardicon", "aria-hidden": "true", text: icon }),
			el("span", { class: "mc-cardtext" }, el("span", { class: "mc-cardtitle", text: title }), el("span", { class: "mc-cardsub", text: sub })));
	}

	function mcAgo(t) {
		if (!t) return "";
		var s = Math.max(0, Date.now() / 1000 - t);
		if (s < 60) return "just now";
		if (s < 3600) return Math.floor(s / 60) + " min ago";
		if (s < 86400) return Math.floor(s / 3600) + " h ago";
		if (s < 86400 * 30) return Math.floor(s / 86400) + " d ago";
		return new Date(t * 1000).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
	}

	/* The composer's emoji + GIF picker, Discord-style. Emoji are plain Unicode
	   (offline); GIFs come from Giphy's search (a free key, kept in this
	   browser) and are sent as a direct .gif URL, so any client shows a tappable
	   GIF and ours and meshcore-open preview it. "g:ID" from others is read. */
	var MC_EMOJI = [
		["Smileys", "😀 grin|😃 smile happy|😄 laugh happy|😁 beam grin|😆 laugh|😅 sweat laugh|🤣 rofl|😂 joy tears laugh|🙂 slight smile|🙃 upside down|😉 wink|😊 blush smile|😇 angel halo|🥰 love hearts|😍 heart eyes love|🤩 star struck|😘 kiss|😋 yum tongue|😛 tongue|🤪 zany silly|😎 cool sunglasses|🤓 nerd geek|🥳 party celebrate|😏 smirk|😒 unamused|😔 pensive sad|😞 disappointed|😟 worried|😕 confused|🙁 frown|😣 persevere|😖 confounded|😫 tired|😩 weary|🥺 pleading puppy|😢 cry sad|😭 sob cry|😤 triumph huff|😠 angry|😡 rage mad|🤬 swearing curse|🤯 mind blown|😳 flushed|🥵 hot heat|🥶 cold freezing|😱 scream fear|😨 fearful|😰 anxious|😥 sad|🤔 thinking hmm|🤭 giggle oops|🤫 shush quiet|🤥 lying|😶 no mouth|😐 neutral|😑 expressionless|😬 grimace|🙄 eye roll|😴 sleep zzz|🤤 drool|😪 sleepy|😮 wow surprised|😲 astonished|🥱 yawn bored|🤢 nauseated sick|🤮 vomit sick|🤧 sneeze|😷 mask sick|🤒 thermometer sick|🤕 bandage hurt|🥴 woozy drunk|😵 dizzy|🤠 cowboy|🤡 clown|🤑 money|🥸 disguise|😈 devil evil|👿 imp angry|💀 skull dead|💩 poop"],
		["Gestures", "👍 thumbs up like yes|👎 thumbs down dislike no|👌 ok perfect|🤌 pinch italian|🤏 small pinch|✌️ peace victory|🤞 crossed fingers luck|🤟 love you|🤘 rock horns|🤙 call me hang loose|👈 left|👉 right|👆 up|👇 down|☝️ point up|✋ raised hand stop|🤚 back hand|🖐️ hand|🖖 vulcan spock|👋 wave hi bye|🤛 fist left|🤜 fist right|👊 fist bump punch|✊ raised fist|👏 clap applause|🙌 raise hands praise|👐 open hands|🤲 palms up|🙏 pray thanks please|✍️ writing|💪 muscle strong|🫵 point you|🫶 heart hands love|🤝 handshake deal"],
		["People", "❤️ red heart love|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|🤍 white heart|🤎 brown heart|💔 broken heart|❣️ heart exclamation|💕 two hearts|💞 revolving hearts|💓 beating heart|💗 growing heart|💖 sparkling heart|💘 cupid arrow|💝 heart gift|💟 heart decoration|💋 kiss lips|👀 eyes look|👁️ eye|🧠 brain|🫀 heart organ|👶 baby|🧒 child|👦 boy|👧 girl|🧑 person|👨 man|👩 woman|🧓 old|👴 grandpa|👵 grandma|🧔 beard|👮 police cop|🕵️ detective spy|💂 guard|👷 construction worker|🤴 prince|👸 princess|🦸 superhero|🦹 villain|🧙 wizard mage|🧚 fairy|🧛 vampire|🧜 mermaid|🧟 zombie|🙅 no|🙆 ok|💁 info sassy|🙋 raise hand|🙇 bow sorry|🤦 facepalm|🤷 shrug|👼 angel baby|🎅 santa|💃 dancer|🕺 dancing man|👯 bunny ears party"],
		["Animals", "🐶 dog puppy|🐱 cat|🐭 mouse|🐹 hamster|🐰 rabbit bunny|🦊 fox|🐻 bear|🐼 panda|🐨 koala|🐯 tiger|🦁 lion|🐮 cow|🐷 pig|🐸 frog|🐵 monkey|🙈 see no evil monkey|🙉 hear no evil|🙊 speak no evil|🐔 chicken|🐧 penguin|🐦 bird|🦆 duck|🦅 eagle|🦉 owl|🦇 bat|🐺 wolf|🐗 boar|🐴 horse|🦄 unicorn|🐝 bee|🐛 bug|🦋 butterfly|🐌 snail|🐞 ladybug|🐢 turtle|🐍 snake|🦖 dino trex|🐙 octopus|🦑 squid|🦀 crab|🐠 fish|🐟 fish|🐬 dolphin|🐳 whale|🦈 shark|🐊 crocodile|🐘 elephant|🦏 rhino|🐫 camel|🦒 giraffe|🐓 rooster|🦃 turkey|🐾 paws|🐉 dragon|🌵 cactus|🎄 christmas tree|🌲 tree|🌳 tree|🌴 palm|🌱 seedling|🌿 herb|☘️ clover|🍀 four leaf clover luck|🍁 maple leaf|🍂 leaves fall|🌸 blossom|🌺 hibiscus|🌻 sunflower|🌹 rose|🌷 tulip|🌼 flower|💐 bouquet"],
		["Food", "🍏 green apple|🍎 apple|🍐 pear|🍊 orange tangerine|🍋 lemon|🍌 banana|🍉 watermelon|🍇 grapes|🍓 strawberry|🫐 blueberries|🍈 melon|🍒 cherries|🍑 peach|🥭 mango|🍍 pineapple|🥥 coconut|🥝 kiwi|🍅 tomato|🥑 avocado|🍆 eggplant|🥔 potato|🥕 carrot|🌽 corn|🌶️ hot pepper spicy|🥒 cucumber|🥬 lettuce|🥦 broccoli|🧄 garlic|🧅 onion|🍄 mushroom|🥜 peanuts|🍞 bread|🥐 croissant|🥖 baguette|🧀 cheese|🥚 egg|🍳 fried egg|🥞 pancakes|🧇 waffle|🥓 bacon|🍔 burger|🍟 fries|🍕 pizza|🌭 hotdog|🥪 sandwich|🌮 taco|🌯 burrito|🥙 pita|🍜 ramen noodles|🍝 pasta spaghetti|🍣 sushi|🍱 bento|🍚 rice|🍙 rice ball|🍦 ice cream|🍩 donut|🍪 cookie|🎂 birthday cake|🍰 cake|🧁 cupcake|🍫 chocolate|🍬 candy|🍭 lollipop|🍯 honey|🍿 popcorn|☕ coffee|🍵 tea|🧋 bubble tea|🥤 soda cup|🍺 beer|🍻 cheers beers|🍷 wine|🥂 champagne toast|🍸 cocktail|🥃 whiskey|🍾 bottle pop"],
		["Activities", "⚽ soccer football|🏀 basketball|🏈 american football|⚾ baseball|🥎 softball|🎾 tennis|🏐 volleyball|🏉 rugby|🎱 8ball pool|🏓 ping pong|🏸 badminton|🥅 goal|🏒 hockey|🏑 field hockey|🥍 lacrosse|🏏 cricket|⛳ golf|🏹 archery bow|🎣 fishing|🥊 boxing|🥋 martial arts|🎽 running shirt|⛸️ skate|🎿 ski|🛷 sled|🏂 snowboard|🏋️ weight lift gym|🤸 cartwheel|⛹️ basketball player|🤺 fencing|🤾 handball|🏌️ golfer|🏄 surf|🏊 swim|🤽 water polo|🚣 rowing|🧗 climbing|🚴 cycling bike|🚵 mountain bike|🏆 trophy win|🥇 gold medal first|🥈 silver medal|🥉 bronze medal|🏅 medal|🎖️ military medal|🎯 target bullseye|🎮 game controller|🕹️ joystick|🎲 dice|🎰 slot|🎳 bowling|🎨 art palette|🎭 theater|🎤 mic sing|🎧 headphones|🎼 music|🎹 piano keys|🥁 drums|🎸 guitar|🎺 trumpet|🎻 violin|🪕 banjo|🎬 clapper film|🎪 circus"],
		["Travel", "🚗 car|🚕 taxi|🚙 suv|🚌 bus|🚎 trolley|🏎️ race car|🚓 police car|🚑 ambulance|🚒 fire truck|🚐 van|🚚 truck|🚛 lorry|🚜 tractor|🛵 scooter|🏍️ motorcycle|🚲 bicycle|🛴 kick scooter|🛹 skateboard|🚂 train|🚆 train|🚄 bullet train|🚅 shinkansen|🚈 metro|🚇 subway|🚉 station|✈️ plane flight|🛫 takeoff|🛬 landing|🚀 rocket|🛸 ufo|🚁 helicopter|⛵ sailboat|🚤 speedboat|🛥️ motor boat|🚢 ship|⚓ anchor|⛽ fuel gas|🚦 traffic light|🗺️ map|🗿 moai statue|🗽 statue liberty|🗼 tokyo tower|🏰 castle|🎡 ferris wheel|🎢 roller coaster|🎠 carousel|⛱️ beach umbrella|🏖️ beach|🏝️ island|🏔️ mountain snow|⛰️ mountain|🌋 volcano|🏕️ camping|⛺ tent|🏠 house|🏡 home garden|🏢 office building|🏬 department store|🏥 hospital|🏦 bank|🏨 hotel|⛪ church|🕌 mosque|🛕 temple|🕍 synagogue|🌁 foggy|🌃 night stars|🏙️ cityscape|🌄 sunrise mountains|🌅 sunrise|🌇 sunset city|🌉 bridge night|🎆 fireworks|🎇 sparkler|🌌 milky way"],
		["Objects", "⌚ watch|📱 phone mobile|💻 laptop|⌨️ keyboard|🖥️ desktop monitor|🖨️ printer|🖱️ mouse|💾 floppy save|💿 cd|📀 dvd|📷 camera|📸 camera flash|📹 video camera|🎥 movie camera|📺 tv|📻 radio|🎙️ studio mic|⏰ alarm clock|⏳ hourglass|📡 satellite antenna signal|🔋 battery|🔌 plug|💡 bulb idea|🔦 flashlight|🕯️ candle|🧯 extinguisher|💸 money wings|💵 dollar|💴 yen|💶 euro|💷 pound|💰 money bag|💳 credit card|💎 gem diamond|⚖️ scales|🧰 toolbox|🔧 wrench|🔨 hammer|⚙️ gear|🧲 magnet|🔫 water gun|💣 bomb|🧨 firecracker|🔪 knife|🛡️ shield|🚬 cigarette|⚰️ coffin|🏺 amphora|🔮 crystal ball|📿 beads|💈 barber|🔭 telescope|🔬 microscope|💊 pill|💉 syringe|🩸 blood|🩹 bandage|🌡️ thermometer|🧪 test tube|🧬 dna|🦠 microbe virus|🧫 petri|🚽 toilet|🚿 shower|🛁 bath|🧻 toilet paper|🧼 soap|🧽 sponge|🪣 bucket|🔑 key|🗝️ old key|🔒 locked|🔓 unlocked|📦 package box|📫 mailbox|✉️ envelope mail|📧 email|📝 memo note|📋 clipboard|📌 pin|📎 paperclip|✂️ scissors|📏 ruler|🔗 link chain|📚 books|📖 open book|🔖 bookmark|🏷️ tag label"],
		["Symbols", "💯 hundred perfect|✅ check yes done|❌ cross no wrong|❎ cross|✔️ check mark|☑️ check box|🔴 red circle|🟠 orange circle|🟡 yellow circle|🟢 green circle|🔵 blue circle|🟣 purple circle|⚫ black circle|⚪ white circle|🟥 red square|🟧 orange square|🟨 yellow square|🟩 green square|🟦 blue square|🟪 purple square|⬛ black square|⬜ white square|🔶 orange diamond|🔷 blue diamond|🔺 red triangle up|🔻 red triangle down|💠 diamond dot|🔘 radio button|❓ question|❔ question white|❗ exclamation|❕ exclamation white|‼️ double exclamation|⁉️ interrobang|⚠️ warning|🚫 no forbidden|🛑 stop|♻️ recycle|🔥 fire lit|⭐ star|🌟 glowing star|✨ sparkles|⚡ lightning bolt|💥 boom collision|💢 anger|💦 sweat drops|💨 dash wind|🌈 rainbow|☀️ sun|🌤️ sun cloud|⛅ cloud sun|☁️ cloud|🌧️ rain|⛈️ storm|🌩️ lightning|❄️ snowflake|⛄ snowman|☃️ snowman|🌊 wave water|💧 droplet|🌙 moon crescent|🌛 moon face|🌝 full moon face|🌞 sun face|🪐 planet saturn|🌍 earth globe|🎉 party tada|🎊 confetti|🎈 balloon|🎁 gift present|🎀 ribbon bow|🎗️ reminder ribbon|🏁 checkered flag|🚩 triangle flag|🏳️ white flag|🏴 black flag|🏳️‍🌈 rainbow pride flag|♾️ infinity|🆗 ok button|🆕 new|🆒 cool|🆓 free|🔝 top up|🔞 no under 18|💤 zzz sleep"]
	];
	function mcGiphyKey() { try { return localStorage.getItem("pr.giphyKey") || ""; } catch (e) { return ""; } }
	function mcSetGiphyKey(k) { try { if (k) localStorage.setItem("pr.giphyKey", k); else localStorage.removeItem("pr.giphyKey"); } catch (e) {} }
	var MC_DEMO_GIFS = ["8kejjglzkEprO", "3oEjI6SIIHBdRxXI40", "l0HlNaQ6gWfllcjDO", "xT0xeJpnrWC4XWblEk", "26ufdipQqU2lhNA4g", "l46Cy1rHbQ92uuLXa"];
	// Results are cached per query for the session so re-opening the picker or
	// repeating a search costs no API call (free Giphy keys allow 100/hour).
	var mcGifCache = {};
	function mcGifSearch(q) {
		if (DEMO) return Promise.resolve(MC_DEMO_GIFS.map(function (id) {
			return { id: id, thumb: "https://media.giphy.com/media/" + id + "/200w.gif", title: "a demo GIF" };
		}));
		var query = (q || "").trim().toLowerCase(), ck = query || "\x00trending";
		if (mcGifCache[ck]) return mcGifCache[ck];
		var key = mcGiphyKey();
		if (!key) return Promise.reject(new Error("no-key"));
		var base = "https://api.giphy.com/v1/gifs/", path = query ? "search?q=" + encodeURIComponent(query) + "&" : "trending?";
		var p = fetch(base + path + "api_key=" + encodeURIComponent(key) + "&limit=24&rating=pg-13&bundle=messaging_non_clips").then(function (r) {
			if (r.status === 401 || r.status === 403) throw new Error("bad-key");
			if (r.status === 429) throw new Error("Giphy's hourly limit is reached — try again later");
			if (!r.ok) throw new Error("Giphy error " + r.status);
			return r.json();
		}).then(function (j) {
			return (j.data || []).map(function (g) {
				var im = g.images || {}, t = im.fixed_width_small || im.fixed_width_downsampled || im.fixed_width || im.preview_gif || {};
				return { id: g.id, thumb: t.url, title: g.title || "GIF" };
			}).filter(function (g) { return g.id && g.thumb; });
		});
		p.catch(function () { delete mcGifCache[ck]; });   // never cache a failure
		mcGifCache[ck] = p;
		return p;
	}

	function renderMessenger() {
		clear(VIEW);
		VIEW.classList.add("view-app");

		/* As Discord has it: the conversations down the left (a search, the
		   channels, direct messages; your radio at the foot), the open one
		   beside them, filling the window, each scrolling on its own; on a
		   phone, one or the other */
		var search = el("input", { class: "inp mc-find", type: "search", placeholder: "Find or start a conversation",
			"aria-label": "Find or start a conversation (Ctrl+K)", autocomplete: "off", spellcheck: "false" });
		var nav = el("nav", { class: "mc-nav", "aria-label": "Conversations" });
		var mePanel = el("div", { class: "mc-mepanel" });
		var side = el("aside", { class: "mc-side" }, el("div", { class: "mc-findwrap" }, search), nav, mePanel);
		var main = el("section", { class: "mc-main" });
		var app = el("div", { class: "mc-app" }, side, main);
		VIEW.appendChild(app);

		// The open conversation: its head, its messages, the composer
		var threadHead = el("div", { class: "mc-thead" });
		var threadBody = el("div", { class: "mc-msgs", "aria-live": "polite" });
		var jumpBtn = el("button", { type: "button", class: "mc-jump", onclick: function () { toBottom(); } });
		jumpBtn.hidden = true;
		var input = el("textarea", { class: "mc-input", rows: "1", placeholder: "Message", "aria-label": "Message" });
		var count = el("span", { class: "mc-count" });
		var sendBtn = el("button", { type: "button", class: "mc-send", title: "Send (Enter)", "aria-label": "Send", onclick: send }, mcIcon("send"));
		var pickBtn = el("button", { type: "button", class: "mc-emojibtn", title: "Emoji & GIFs", "aria-label": "Emoji and GIFs", onclick: function (ev) { ev.stopPropagation(); openComposerPicker(pickBtn); } }, "☺");
		var sendStatus = el("div", { class: "status mc-cstatus" });
		// The composer's word (an error sending, say): gone when there's none
		function sayStatus(text, kind) {
			sendStatus.textContent = text;
			sendStatus.className = "status mc-cstatus" + (kind ? " " + kind : "");
		}
		var replyBar = el("div", { class: "mc-replybar" });
		replyBar.hidden = true;
		var vThread = el("div", { class: "mc-view" }, threadHead,
			el("div", { class: "mc-msgwrap" }, threadBody, jumpBtn),
			el("div", { class: "mc-compose" }, replyBar, el("div", { class: "mc-box" }, input, count, pickBtn, sendBtn), sendStatus));
		var vPage = el("div", { class: "mc-view mc-page" });   // contacts, your radio, a channel's settings, a new channel
		var vNote = el("div", { class: "mc-view mc-note" });   // no radio, connecting, no service
		main.appendChild(vThread); main.appendChild(vPage); main.appendChild(vNote);
		vThread.hidden = vPage.hidden = true;
		vNote.appendChild(el("div", { class: "muted", text: "Loading…" }));

		var st = null, contacts = [], channels = [], freeSlot = null, seq = 0, timer = null;
		// The radio's settings and stats as last asked, an editor open; the command line's; the packet log's
		var cfg = null, cfgErr = null, editing = null, health = null, healthAt = 0, healthErr = null;
		var term = { target: "self", logs: {}, hist: [], hpos: 0, auth: {}, since: {}, busy: false, timer: null };
		var feed = { list: [], since: 0, paused: false, filter: "", timer: null, open: {}, err: null, chash: {} };
		var mode = null, open = null, page = null;      // a thread (its conv), a page, or a note
		var thread = [], byId = {}, shown = {}, more = false, loadingOlder = false, unreadFrom = 0, newBelow = 0, jumpWas = "";
		var rmsgs = {}, reacts = {};   // the thread's reactions; by the message each is to, emoji, who
		var replyTo = null, radioLine = null, radioStatus = null, contactsFill = null;
		var cv = { kind: "all", q: "", sort: "recent", n: 100 };   // the contacts page: which, found how, in what order, how many
		var collapsed = {};
		try { collapsed = JSON.parse(localStorage.getItem("pirate_mc_collapsed") || "{}") || {}; } catch (e) {}
		var TOUCH = !!(window.matchMedia && window.matchMedia("(hover: none)").matches);

		function alive() { return VIEW.contains(app); }
		function failed(e) {
			if (String(e.message || e) === "unauthorized") { onError(e); return true; }
			return false;
		}
		function line(node, text, kind) { node.textContent = text; node.className = "status" + (kind ? " " + kind : ""); }
		function showMain(which) {
			vThread.hidden = which !== "thread";
			vPage.hidden = which !== "page";
			vNote.hidden = which !== "note";
		}
		function backBtn() {
			return el("button", { type: "button", class: "linkbtn mc-back", "aria-label": "All conversations", text: "←",
				onclick: function () { app.classList.remove("mc-open"); } });
		}
		function chanOf(conv) { for (var i = 0; i < channels.length; i++) if (channels[i].conv === conv) return channels[i]; return null; }
		function contactOf(conv) { for (var i = 0; i < contacts.length; i++) if (contacts[i].conv === conv) return contacts[i]; return null; }
		function convName(conv) { var c = chanOf(conv) || contactOf(conv); return c ? c.name : conv; }
		function full() { return !!st && (!!st.contacts_full || (!!st.max_contacts && contacts.length >= st.max_contacts)); }
		function route(c) { return c.flood ? "no route yet" : c.hops ? c.hops + " hop" + (c.hops === 1 ? "" : "s") : "direct"; }
		function chanIcon(c, cls) { return mcIcon(mcChanKind(c) === "private" ? "lock" : "hash", cls); }
		var KIND_TEXT = {
			"public": "MeshCore's public channel: everyone on the mesh reads it",
			hashtag: "a #hashtag channel: anyone who knows its name reads it",
			"private": "private: only those with its key read it"
		};

		/* The list: channels and direct messages, or what the search finds */
		function badgeEl(n) { return el("span", { class: "mc-unread", text: n > 99 ? "99+" : String(n) }); }
		function isOpen(conv) { return mode === "thread" && open === conv; }
		function chanItem(c) {
			return el("div", { class: "mc-item" + (isOpen(c.conv) ? " active" : "") + (c.unread ? " news" : "") },
				el("button", { type: "button", class: "mc-itemmain", onclick: function () { openConv(c.conv); } },
					chanIcon(c, "mc-ci"), el("span", { class: "mc-name", text: mcChanLabel(c) }), c.unread ? badgeEl(c.unread) : null),
				el("button", { type: "button", class: "mc-itembtn", title: "Channel settings", "aria-label": c.name + ": settings",
					onclick: function () { openPage("chan:" + c.index); } }, mcIcon("gear")));
		}
		function dmItem(c, sub) {
			return el("div", { class: "mc-item" + (isOpen(c.conv) ? " active" : "") + (c.unread ? " news" : "") },
				el("button", { type: "button", class: "mc-itemmain", onclick: function () { openConv(c.conv); } },
					mcFace(c.name, false, "sm"), el("span", { class: "mc-name", text: c.name }),
					c.favorite ? el("span", { class: "mc-fav", title: "A favourite", "aria-label": "a favourite", text: "★" }) : null,
					c.unread ? badgeEl(c.unread) : el("span", { class: "mc-itemsub", text: sub != null ? sub : mcAgo(c.last_message) })));
		}
		function byLast(a, b) { return (b.last_message || 0) - (a.last_message || 0); }
		function section(key, title, items, make, empty, extra) {
			var shut = !!collapsed[key], unread = 0;
			items.forEach(function (c) { unread += c.unread || 0; });
			nav.appendChild(el("div", { class: "mc-sec" },
				el("button", { type: "button", class: "mc-sechead" + (shut ? " shut" : ""), "aria-expanded": shut ? "false" : "true",
					onclick: function () {
						collapsed[key] = !shut;
						try { localStorage.setItem("pirate_mc_collapsed", JSON.stringify(collapsed)); } catch (e) {}
						renderSide();
					} },
					mcIcon("chev", "mc-chev"), el("span", { text: title }), shut && unread ? badgeEl(unread) : null),
				extra || null));
			// Shut, it still shows the open one and those with news, as Discord's do
			if (shut) items = items.filter(function (c) { return c.unread || isOpen(c.conv); });
			else if (!items.length && empty) nav.appendChild(el("div", { class: "mc-none muted", text: empty }));
			items.forEach(function (c) { nav.appendChild(make(c)); });
		}
		function renderSide() {
			var keep = nav.scrollTop;
			clear(nav);
			if (!st || st.state !== "ready") return;
			var q = search.value.trim().toLowerCase();
			var people = contacts.filter(function (c) { return c.type === "chat"; });
			var dms = people.filter(function (c) { return c.last_message; }).sort(byLast);
			if (q) return renderFound(q, people, dms);
			nav.appendChild(el("div", { class: "mc-item mc-home" + (mode === "page" && page === "contacts" ? " active" : "") },
				el("button", { type: "button", class: "mc-itemmain", onclick: function () { openPage("contacts"); } },
					mcIcon("people", "mc-ci"), el("span", { class: "mc-name", text: "Contacts" }),
					el("span", { class: "mc-itemsub" + (full() ? " warn" : ""), text: contacts.length + (full() ? " · full" : "") }))));
			section("channels", "Channels", channels, chanItem, "None yet",
				el("button", { type: "button", class: "mc-secbtn", title: "Add a channel", "aria-label": "Add a channel",
					onclick: function () { openPage("addch"); } }, mcIcon("plus")));
			section("dms", "Direct messages", dms, function (c) { return dmItem(c); }, "None yet: find someone above, or in Contacts");
			nav.scrollTop = keep;
		}
		function renderFound(q, people, dms) {
			function has(c) { return c.name.toLowerCase().indexOf(q) >= 0; }
			var ch = channels.filter(has), dm = dms.filter(has);
			var others = people.filter(function (c) { return !c.last_message && has(c); })
				.sort(function (a, b) { return (b.last_advert || 0) - (a.last_advert || 0); });
			function grp(title, items, make, extra) {
				if (!items.length) return;
				nav.appendChild(el("div", { class: "mc-sec" }, el("div", { class: "mc-sechead plain" }, el("span", { text: title })), extra || null));
				items.forEach(function (c) { nav.appendChild(make(c)); });
			}
			grp("Channels", ch, chanItem);
			grp("Direct messages", dm, function (c) { return dmItem(c); });
			grp("Start a conversation", others.slice(0, 40), function (c) { return dmItem(c, c.last_advert ? "heard " + mcAgo(c.last_advert) : ""); },
				others.length > 40 ? el("span", { class: "mc-itemsub", text: "40 of " + others.length }) : null);
			if (!ch.length && !dm.length && !others.length)
				nav.appendChild(el("div", { class: "mc-none muted", text: "Nothing called that. People come with their adverts: send yours (your radio, the gear below) and others add you." }));
		}
		search.addEventListener("input", renderSide);
		search.addEventListener("keydown", function (ev) {
			if (ev.key === "Enter") {
				var b = nav.querySelector(".mc-itemmain");
				if (b) { ev.preventDefault(); b.click(); }
			} else if (ev.key === "Escape" && search.value) { ev.preventDefault(); search.value = ""; renderSide(); }
		});
		// Ctrl+K (or Cmd+K): to the search, as Discord's quick switcher
		function onKey(ev) {
			if (!alive()) { document.removeEventListener("keydown", onKey); return; }
			if (ev.key === "Escape" && !pop.hidden) {
				var back = popAnchor;
				closeProfile();
				if (back && document.contains(back) && back.focus) back.focus();
				return;
			}
			if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === "k" || ev.key === "K")) {
				ev.preventDefault();
				app.classList.remove("mc-open");
				search.focus();
				search.select();
			}
		}
		document.addEventListener("keydown", onKey);
		// Read when seen: a thread open in a tab out of sight stays unread
		function onVis() {
			if (!alive()) { document.removeEventListener("visibilitychange", onVis); return; }
			if (!document.hidden) markRead(true);
		}
		document.addEventListener("visibilitychange", onVis);
		// From a phone's width to a wide one with nothing open: the first channel beside the list
		function onResize() {
			if (!alive()) { window.removeEventListener("resize", onResize); return; }
			placePop();
			if (mode === "none" && window.innerWidth > 860 && st && st.state === "ready") openFirst();
		}
		window.addEventListener("resize", onResize);

		/* Your radio, at the foot of the list */
		function battPct(mv) { return Math.max(0, Math.min(100, Math.round((mv - 3300) / 9))); }
		function showMe() {
			clear(mePanel);
			if (!st || st.state !== "ready") {
				mePanel.appendChild(el("div", { class: "mc-meinfo" }, el("div", { class: "mc-mename muted",
					text: !st ? "Radio" : st.state === "connecting" ? "Connecting…" : "No radio plugged in" })));
				return;
			}
			var g = st.gps || {}, bits = [];
			if (st.battery_mv) bits.push(battPct(st.battery_mv) + "%");
			if (g.available) bits.push(!g.enabled ? "GPS off" : g.live ? "GPS fix" : "GPS, no fix");
			var meBtn = el("button", { type: "button", class: "mc-mewho", title: "Your profile", onclick: function () { openProfile({ me: true }, meBtn); } },
				mcFace(st.name, true),
				el("span", { class: "mc-meinfo" },
					el("span", { class: "mc-mename", text: st.name }),
					el("span", { class: "mc-mesub" }, bits.join(" · "),
						st.share_location ? el("span", { class: "mc-mewarn", title: "Its adverts carry where it is",
							text: (bits.length ? " · " : "") + "sharing location" }) : null)));
			mePanel.appendChild(meBtn);
			mePanel.appendChild(el("button", { type: "button", class: "mc-iconbtn" + (mode === "page" && page === "terminal" ? " on" : ""),
				title: "Command line", "aria-label": "Command line: your radio's, and repeaters'", onclick: function () { openPage("terminal"); } }, mcIcon("term")));
			mePanel.appendChild(el("button", { type: "button", class: "mc-iconbtn" + (mode === "page" && page === "packets" ? " on" : ""),
				title: "Packets it hears", "aria-label": "Packets it hears: the packet log", onclick: function () { openPage("packets"); } }, mcIcon("pkts")));
			mePanel.appendChild(el("button", { type: "button", class: "mc-iconbtn" + (mode === "page" && page === "radio" ? " on" : ""),
				title: "Your radio", "aria-label": "Your radio: its settings", onclick: function () { openPage("radio"); } }, mcIcon("gear")));
		}

		/* No radio, connecting, or no service: said where the conversation goes */
		function showNote(s, err) {
			cancelReply();
			mode = "note"; open = null; page = null;
			clear(nav); clear(vNote);
			showMain("note");
			app.classList.add("mc-open");
			if (err) vNote.appendChild(el("div", { class: "placeholder" }, el("b", { text: "The Messenger can't reach the radio." }), el("div", { text: err })));
			else if (s.state === "absent") {
				vNote.appendChild(el("div", { class: "placeholder" },
					el("b", { text: "No MeshCore radio is plugged in." }),
					el("div", { text: "Plug one into the USB port, running MeshCore's companion firmware for USB (for a LilyGo T-Echo: \"Companion (USB)\" on flasher.meshcore.co.uk)." })));
				if (s.error) vNote.appendChild(alertEl("warn", s.error));
			} else vNote.appendChild(el("div", { class: "placeholder" }, el("b", { text: "Connecting to the radio on " + devLabel(s.device) + "…" })));
		}

		/* Pages beside the list, in the conversation's place */
		function openPage(p) {
			cancelReply();
			closeProfile();
			mode = "page"; page = p; open = null;
			if (search.value) search.value = "";
			app.classList.add("mc-open");
			showMain("page");
			radioLine = null;
			renderPage();
			renderSide();
			showMe();
		}
		function pageHead(icon, title, sub) {
			return el("div", { class: "mc-thead" }, backBtn(), icon, el("strong", { text: title }),
				sub ? el("span", { class: "mc-hsub muted", text: sub }) : null);
		}
		function renderPage() {
			contactsFill = null;
			radioStatus = null;
			if (page === "contacts") return renderContacts();
			if (page === "radio") return renderRadio();
			if (page === "terminal") return renderTerminal();
			if (page === "packets") return renderPackets();
			if (page === "addch") return renderAddChannel();
			if (page && page.indexOf("chan:") === 0) return renderChannel(+page.slice(5));
		}
		function openFirst() {
			var wide = window.innerWidth > 860;
			if (wide && channels.length) return openConv(channels[0].conv);
			if (wide) return openPage("contacts");
			cancelReply();
			mode = "none"; open = null; page = null;
			showMain("none");
			app.classList.remove("mc-open");
			renderSide();
		}

		// Contacts: everyone heard, to find, sort, message or remove
		// (Favourites: those the radio has marked so, by any app, whatever they are)
		var CKINDS = [["all", "All"], ["fav", "★ Favourites"], ["chat", "People"], ["repeater", "Repeaters"], ["room", "Rooms"], ["sensor", "Sensors"]];
		var KIND_NAME = { chat: "person", repeater: "repeater", room: "room", sensor: "sensor" };
		function contactCounts() {
			var n = { all: contacts.length, fav: 0 };
			contacts.forEach(function (c) { n[c.type] = (n[c.type] || 0) + 1; if (c.favorite) n.fav++; });
			return n;
		}
		function renderContacts() {
			clear(vPage);
			var n = contactCounts(), tabN = {};
			vPage.appendChild(pageHead(mcIcon("people", "mc-hic"), "Contacts",
				contacts.length + (st && st.max_contacts ? " of the " + st.max_contacts + " the radio keeps" : "")));
			var tabs = el("div", { class: "mc-tabs", role: "tablist" });
			CKINDS.forEach(function (k) {
				if (k[0] !== "all" && k[0] !== "fav" && !n[k[0]]) return;
				tabN[k[0]] = el("span", { class: "mc-tabn", text: String(n[k[0]] || 0) });
				tabs.appendChild(el("button", { type: "button", role: "tab", class: "mc-tab" + (cv.kind === k[0] ? " on" : ""),
					"aria-selected": cv.kind === k[0] ? "true" : "false",
					onclick: function () { cv.kind = k[0]; cv.n = 100; renderContacts(); } },
					k[1], tabN[k[0]]));
			});
			var q = el("input", { class: "inp mc-cfind", type: "search", placeholder: "Search contacts", "aria-label": "Search contacts" });
			q.value = cv.q;
			var sort = el("select", { class: "sel mc-csort", "aria-label": "In what order" },
				el("option", { value: "recent", text: "Heard most recently" }),
				el("option", { value: "stale", text: "Heard longest ago" }),
				el("option", { value: "name", text: "By name" }),
				el("option", { value: "near", text: "Fewest hops" }));
			sort.value = cv.sort;
			q.addEventListener("input", function () { cv.q = q.value; cv.n = 100; fill(); });
			sort.addEventListener("change", function () { cv.sort = sort.value; cv.n = 100; fill(); });
			vPage.appendChild(el("div", { class: "mc-cbar" }, tabs, el("div", { class: "mc-cfilters" }, q, sort)));
			if (full()) vPage.appendChild(el("div", { class: "mc-cnote" }, alertEl("warn",
				"The radio's contact list is full (" + contacts.length + " of " + st.max_contacts + "): it adds no one new until some go. \"Heard longest ago\" puts the stale ones first.")));
			var listEl = el("div", { class: "mc-clist" });
			vPage.appendChild(listEl);
			function fill() {
				var keep = listEl.scrollTop, ql = cv.q.trim().toLowerCase(), now = contactCounts();
				// The tabs' counts as they are now (a favourite made, someone removed)
				Object.keys(tabN).forEach(function (k) { tabN[k].textContent = String(now[k] || 0); });
				clear(listEl);
				var list = contacts.filter(function (c) {
					return (cv.kind === "all" || (cv.kind === "fav" ? c.favorite : c.type === cv.kind)) &&
						(!ql || c.name.toLowerCase().indexOf(ql) >= 0);
				});
				list.sort(cv.sort === "name" ? function (a, b) { return a.name.localeCompare(b.name); }
					: cv.sort === "stale" ? function (a, b) { return (a.last_advert || 0) - (b.last_advert || 0); }
					: cv.sort === "near" ? function (a, b) { return (a.flood ? 99 : a.hops || 0) - (b.flood ? 99 : b.hops || 0) || (b.last_advert || 0) - (a.last_advert || 0); }
					: function (a, b) { return (b.last_advert || 0) - (a.last_advert || 0); });
				if (!list.length) listEl.appendChild(el("div", { class: "mc-none muted",
					text: cv.kind === "fav" && !ql ? "No favourites yet: star someone (☆) to keep them here. The radio keeps them too, when its list is full and it makes room." :
						contacts.length ? "No one called that." : "No contacts yet: they come with adverts heard on the mesh." }));
				list.slice(0, cv.n).forEach(function (c) { listEl.appendChild(contactRow(c)); });
				if (list.length > cv.n) listEl.appendChild(el("div", { class: "mc-more" },
					btn("Show more (" + (list.length - cv.n) + " left)", { onclick: function () { cv.n += 200; fill(); } })));
				listEl.scrollTop = keep;
			}
			contactsFill = fill;
			fill();
		}
		function contactRow(c) {
			var person = c.type === "chat";
			var who = el("button", { type: "button", class: "mc-cwho", title: "Profile", onclick: function () { openProfile({ contact: c }, who); } },
				person ? mcFace(c.name, false, "sm") : mcTile(c.name, "sm"),
				el("span", { class: "mc-cmain" },
					el("span", { class: "mc-cname" }, el("span", { class: "mc-cn", text: c.name }),
						person ? null : el("span", { class: "mc-kind", text: KIND_NAME[c.type] || c.type })),
					el("span", { class: "mc-csub", text: route(c) + " · " + (c.last_advert ? "heard " + mcAgo(c.last_advert) : "not heard yet") })));
			return el("div", { class: "mc-crow" }, starBtn(c), who,
				el("div", { class: "mc-cacts" },
					person ? btn("Message", { cls: "small", onclick: function () { openConv(c.conv); } }) : null,
					c.flood ? null : btn("Forget route", { cls: "small", onclick: function () { contactOp("contact_reset_path", c); } }),
					btn("Remove", { cls: "small reset", onclick: function () {
						if (window.confirm("Remove " + c.name + " from the radio's contacts? An advert from them adds them back.")) contactOp("contact_remove", c);
					} })));
		}
		function contactOp(method, c, more) {
			var p = { key: c.key }, k;
			for (k in more || {}) p[k] = more[k];
			call("pirate.meshcore", method, p).then(function (r) {
				if (r.error) window.alert(r.error);
				refreshAll();
			}).catch(function (e) { if (!failed(e)) window.alert(String(e.message || e)); });
		}
		// A favourite: the radio's mark (its other apps see it too), and kept
		// by the radio when its list is full and it makes room for new ones
		function starBtn(c) {
			return el("button", { type: "button", class: "mc-star" + (c.favorite ? " on" : ""), "aria-pressed": c.favorite ? "true" : "false",
				title: c.favorite ? "A favourite, on the radio: click to unmark" : "Make a favourite: marked on the radio, and kept when its contact list is full",
				"aria-label": (c.favorite ? "Unfavourite " : "Favourite ") + c.name,
				onclick: function (ev) { ev.stopPropagation(); contactOp("contact_favorite", c, { favorite: !c.favorite }); } }, c.favorite ? "★" : "☆");
		}

		// Your radio: how it's doing, and its settings, each as the radio last
		// said it (asked again each time this is shown). An editor open is left
		// alone by the page's own refreshes, until it's saved or put away
		function sec(title) { return el("h4", { class: "sub-h2", text: title }); }
		function descr(text) { return el("p", { class: "descr", text: text }); }
		function loadCfg() {
			return call("pirate.meshcore", "settings").then(function (c) {
				if (!alive()) return;
				if (c.error) { cfg = null; cfgErr = c.error; }
				else { cfg = c; cfgErr = null; }
				if (mode === "page" && page === "radio") renderRadio(true);
			}).catch(function (e) {
				if (failed(e)) return;
				cfgErr = /status 3\b/.test(String(e.message || e)) ? "old" : String(e.message || e);
				if (mode === "page" && page === "radio") renderRadio(true);
			});
		}
		function renderRadio(fresh) {
			if (!fresh) loadCfg();
			if (editing && vPage.contains(editing)) return;
			editing = null;
			clear(vPage);
			var s = st, c = cfg, g = s.gps || {}, r = (c && c.radio) || s.radio || {};
			vPage.appendChild(pageHead(mcFace(s.name, true, "sm"), s.name, (s.model || "MeshCore") + (s.firmware ? " · MeshCore " + s.firmware : "")));
			var body = el("div", { class: "mc-pagebody mc-settings" });
			vPage.appendChild(body);
			// What the last change did, in sight wherever the page is scrolled to
			radioStatus = el("div", { class: "status", role: "status" });
			if (radioLine) line(radioStatus, radioLine[0], radioLine[1]);
			body.appendChild(el("div", { class: "mc-setstatus" }, radioStatus));
			if (s.share_location)
				body.appendChild(alertEl("warn", "This radio shares its location in its adverts: everyone on the mesh sees where it is. MeshCore's app turns that off."));
			else if (c && c.telemetry && c.telemetry.location === 2)
				body.appendChild(alertEl("warn", "Its adverts leave out where this radio is, but anyone who asks for its telemetry is told. \"Who may ask for its telemetry\", below, keeps it to the contacts you allow."));
			if (cfgErr === "old")
				body.appendChild(alertEl("warn", "The router's MeshCore service is older than this page: update the router's firmware for the radio's settings, its command line and the packet log."));
			else if (cfgErr)
				body.appendChild(alertEl("warn", cfgErr));

			// How it's doing
			body.appendChild(sec("How it's doing"));
			var hBox = el("div");
			body.appendChild(hBox);
			fillHealth(hBox);
			body.appendChild(el("div", { class: "toolbar" },
				btn("Refresh", { onclick: function () { loadHealth(hBox); } }),
				btn("Packets it hears", { onclick: function () { openPage("packets"); } }),
				btn("Command line", { onclick: function () { openPage("terminal"); } })));
			if (cfgErr !== "old" && (!c || c.stats) && Date.now() - healthAt > 20000) loadHealth(hBox);

			// On the mesh
			body.appendChild(sec("On the mesh"));
			body.appendChild(kvEl([
				["Battery", mcBattery(s.battery_mv)],
				["Port", devLabel(s.device)],
				["Key", s.key ? el("code", { class: "mc-key", text: s.key }) : null],
				["Contacts", contacts.length + (s.max_contacts ? " of " + s.max_contacts : "") + (full() ? " (full)" : "")],
				["Channels", channels.length + (s.max_channels ? " of " + s.max_channels : "")]
			]));
			body.appendChild(el("div", { class: "toolbar" },
				btn("Advert to neighbours", { onclick: function () { advert(false); } }),
				btn("Advert to the whole mesh", { onclick: function () { advert(true); } }),
				btn("Rename", { onclick: rename })));
			body.appendChild(descr("An advert says your radio is here, so others can add you: to those in range, or passed on across the whole mesh. Its name is what they see."));

			// Its radio: the mesh's settings, and how loud
			body.appendChild(sec("Radio"));
			if (r.freq_khz) {
				var pre = mcPresetOf(r);
				body.appendChild(el("p", { class: "mc-setnow" },
					el("strong", { text: mcMHz(r.freq_khz) + " MHz" }), " · " + mcKHz(r.bw_hz) + " kHz · SF" + r.sf + " · CR" + r.cr,
					el("span", { class: "muted", text: pre ? " · MeshCore's " + pre.t + " settings" : " · not one of MeshCore's presets" })));
			}
			var radioBox = el("div");
			body.appendChild(radioBox);
			var bar = el("div", { class: "toolbar" });
			if (c) {
				bar.appendChild(btn("Change…", { onclick: function () { radioEditor(radioBox, r); } }));
				var most = c.radio.max_tx_power || 22, tx = el("select", { class: "sel", "aria-label": "TX power" });
				for (var d = most; d >= -9; d--)
					tx.appendChild(el("option", { value: String(d), text: d + " dBm" + (d === most ? " (its most)" : "") }));
				tx.value = String(c.radio.tx_power);
				tx.addEventListener("change", function () { act(call("pirate.meshcore", "set_tx_power", { dbm: +tx.value }), "TX power: " + tx.value + " dBm"); });
				bar.appendChild(el("label", { class: "chkline" }, "TX power", tx));
			} else if (r.tx_power != null) bar.appendChild(el("span", { class: "status", text: "TX power " + r.tx_power + " dBm" }));
			body.appendChild(bar);
			body.appendChild(descr("Every radio on a mesh has the same frequency, bandwidth, spreading factor and coding rate: change them only to join another mesh, or to follow yours. More TX power reaches further, on more battery."));

			// Where it is, and who's told
			body.appendChild(sec("Location"));
			var locBar = el("div", { class: "toolbar" });
			locBar.appendChild(btn(s.share_location ? "Stop sharing location" : "Share location", { onclick: function () { shareLoc(!s.share_location); } }));
			var lstat = meshLocStat();
			if (lstat && lstat.most !== s.share_location)
				locBar.appendChild(btn("Match the mesh", { primary: true, onclick: function () { shareLoc(lstat.most); } }));
			body.appendChild(locBar);
			var telAll = c && c.telemetry && c.telemetry.location === 2;
			body.appendChild(descr(s.share_location ? "Your adverts carry where your radio is - everyone on the mesh sees it. MeshCore's own app keeps this off." +
				(telAll ? " Stop, and its telemetry stops telling anyone who asks too: only the contacts you allow." : "") :
				"Your adverts carry only your radio's name, not where it is. Turn it on to let the mesh see where you are."));
			if (lstat) body.appendChild(el("p", { class: "descr muted", text: meshLocSentence(lstat, s.share_location) }));
			if (g.available)
				body.appendChild(el("div", { class: "toolbar" },
					btn(g.enabled ? "GPS off" : "GPS on", { onclick: function () { gps(!g.enabled); } }),
					el("span", { class: "status", text: !g.enabled ? "GPS off" : g.live ? "GPS fix: " + g.lat.toFixed(5) + ", " + g.lon.toFixed(5) + " (it tags the Wi-Fi survey)" : "GPS on, no fix yet" })));
			if (c && !c.gps) {
				var pBox = el("div");
				body.appendChild(el("p", { class: "mc-setnow", text: c.position ? "Set by hand: " + c.position.lat.toFixed(5) + ", " + c.position.lon.toFixed(5) : "No position set by hand." }));
				body.appendChild(pBox);
				body.appendChild(el("div", { class: "toolbar" }, btn(c.position ? "Change position…" : "Set a position…", { onclick: function () { positionEditor(pBox, c.position); } })));
				body.appendChild(descr("With its GPS off, its adverts carry this, when it shares where it is."));
			}

			if (c) {
				// Who may ask for its telemetry
				body.appendChild(sec("Who may ask for its telemetry"));
				body.appendChild(el("div", { class: "form mc-form3" },
					telSel("Its battery", "telemetry_base", c.telemetry.base),
					telSel("Where it is", "telemetry_location", c.telemetry.location),
					telSel("Its sensors", "telemetry_environment", c.telemetry.environment)));
				body.appendChild(descr("\"Contacts you allow\": the ones you let, each on its own (in MeshCore's app). Someone asking for its telemetry gets only what this lets them."));

				// The contacts it adds by itself
				body.appendChild(sec("Contacts it adds"));
				var auto = el("input", { type: "checkbox" });
				auto.checked = !!c.auto_add;
				auto.addEventListener("change", function () { act(call("pirate.meshcore", "set_params", { auto_add: auto.checked }), auto.checked ? "it adds the radios it hears" : "it adds no one by itself"); });
				body.appendChild(el("label", { class: "chkline mc-setline" }, auto, "Add the radios it hears, by itself"));
				var aa = c.autoadd;
				if (aa) {
					var kinds = el("div", { class: "mc-kinds" + (c.auto_add ? "" : " off") });
					[["chat", "People"], ["repeater", "Repeaters"], ["room", "Rooms"], ["sensor", "Sensors"]].forEach(function (k) {
						var cb = el("input", { type: "checkbox" });
						cb.checked = !!aa[k[0]];
						cb.disabled = !c.auto_add;
						cb.addEventListener("change", function () {
							var p = {};
							p[k[0]] = cb.checked;
							act(call("pirate.meshcore", "set_autoadd", p), k[1].toLowerCase() + (cb.checked ? ": added" : ": left out"));
						});
						kinds.appendChild(el("label", { class: "chkline" }, cb, k[1]));
					});
					body.appendChild(kinds);
					var far = el("select", { class: "sel", "aria-label": "From how far" }), cur = aa.any_distance ? -1 : aa.max_hops;
					far.appendChild(el("option", { value: "-1", text: "any distance" }));
					far.appendChild(el("option", { value: "0", text: "only those heard directly" }));
					for (var h = 1; h <= 8; h++) far.appendChild(el("option", { value: String(h), text: "up to " + h + " hop" + (h > 1 ? "s" : "") + " away" }));
					if (cur > 8) far.appendChild(el("option", { value: String(cur), text: "up to " + cur + " hops away" }));
					far.value = String(cur);
					far.disabled = !c.auto_add;
					far.addEventListener("change", function () { act(call("pirate.meshcore", "set_autoadd", { max_hops: +far.value }), "it adds those from " + far.options[far.selectedIndex].text); });
					body.appendChild(el("div", { class: "toolbar mc-kindsfar" }, el("label", { class: "chkline" }, "From", far)));
					var over = el("input", { type: "checkbox" });
					over.checked = !!aa.overwrite_oldest;
					over.addEventListener("change", function () { act(call("pirate.meshcore", "set_autoadd", { overwrite_oldest: over.checked }), over.checked ? "a full list makes room: the one heard longest ago goes" : "a full list adds no one new"); });
					body.appendChild(el("label", { class: "chkline mc-setline" }, over, "When its list is full, make room: the one heard longest ago goes (never a favourite)"));
				}
				body.appendChild(descr("Off, it adds no one by itself: someone new is added only when you add them. Its list holds " + (s.max_contacts || 350) + "."));

				// Advanced
				body.appendChild(sec("Advanced"));
				var acks = el("select", { class: "sel", "aria-label": "Extra acks" });
				[["0", "none"], ["1", "one"], ["2", "two"]].forEach(function (o) { acks.appendChild(el("option", { value: o[0], text: o[1] })); });
				acks.value = String(c.extra_acks);
				acks.addEventListener("change", function () { act(call("pirate.meshcore", "set_params", { extra_acks: +acks.value }), "extra acks: " + acks.options[acks.selectedIndex].text); });
				var tBox = el("div"), tbar = el("div", { class: "toolbar" }, el("label", { class: "chkline" }, "Extra acks", acks));
				if (c.tuning) tbar.appendChild(btn("Tuning…", { onclick: function () { tuningEditor(tBox, c.tuning); } }));
				body.appendChild(tbar);
				body.appendChild(tBox);
				body.appendChild(descr("Extra acks: each ack it sends, sent again, so more of its messages are confirmed, at the cost of airtime." +
					(c.tuning ? " Tuning (RX delay " + c.tuning.rx_delay + ", airtime factor " + c.tuning.airtime_factor + "): how long it waits before passing on what it hears, and how long it keeps quiet after sending; leave them unless your mesh asks otherwise." : "")));
			}

			// A restart
			body.appendChild(sec("Restart"));
			body.appendChild(el("div", { class: "toolbar" }, btn("Restart the radio", { onclick: function () {
				if (window.confirm("Restart the radio? It's gone for a few seconds, then this connects to it again."))
					act(call("pirate.meshcore", "reboot"), "restarting: it's back in a few seconds");
			} })));
		}
		function telSel(label, key, val) {
			var s = el("select", { class: "sel" });
			[["0", "No one"], ["1", "Contacts you allow"], ["2", "Anyone"]].forEach(function (o) { s.appendChild(el("option", { value: o[0], text: o[1] })); });
			s.value = String(val);
			s.addEventListener("change", function () {
				var p = {};
				p[key] = +s.value;
				act(call("pirate.meshcore", "set_params", p), label.toLowerCase() + ": " + s.options[s.selectedIndex].text.toLowerCase() + " may ask");
			});
			return el("label", {}, el("span", { class: "lbl", text: label }), s);
		}
		// An editor in its place, kept until it's saved or put away
		function editor(box, parts, save) {
			var status = el("span", { class: "status" }), form = el("div", { class: "mc-editor" });
			parts.forEach(function (p) { if (p) form.appendChild(p); });
			form.appendChild(el("div", { class: "toolbar" }, btn("Save", { primary: true, onclick: function () { save(status, done); } }),
				btn("Cancel", { onclick: function () { editing = null; renderRadio(true); } }), status));
			clear(box).appendChild(form);
			editing = form;
			function done(ok) {
				editing = null;
				radioLine = [ok, "ok-text"];
				refreshAll();
			}
			return status;
		}
		function saving(status, p, ok, done) {
			line(status, "…");
			p.then(function (x) {
				if (x.error) return line(status, x.error, "err");
				done(ok);
			}).catch(function (e) { if (!failed(e)) line(status, String(e.message || e), "err"); });
		}
		function field(label, input) { return el("label", {}, el("span", { class: "lbl", text: label }), input); }
		function radioEditor(box, r) {
			var pre = el("select", { class: "sel" }), bw = el("select", { class: "sel" }), sf = el("select", { class: "sel" }), cr = el("select", { class: "sel" });
			var f = el("input", { class: "inp", type: "number", step: "0.001", min: "150", max: "2500", value: mcMHz(r.freq_khz) });
			var note = el("p", { class: "descr" }), i;
			pre.appendChild(el("option", { value: "", text: "MeshCore's settings for a region…" }));
			MC_PRESETS.forEach(function (p, j) {
				pre.appendChild(el("option", { value: String(j), text: p.t + ": " + mcMHz(p.f) + " MHz, " + mcKHz(p.bw) + " kHz, SF" + p.sf + ", CR" + p.cr }));
			});
			MC_BWS.forEach(function (b) { bw.appendChild(el("option", { value: String(b), text: mcKHz(b) + " kHz" })); });
			if (MC_BWS.indexOf(r.bw_hz) < 0) bw.appendChild(el("option", { value: String(r.bw_hz), text: mcKHz(r.bw_hz) + " kHz" }));
			for (i = 5; i <= 12; i++) sf.appendChild(el("option", { value: String(i), text: "SF" + i }));
			for (i = 5; i <= 8; i++) cr.appendChild(el("option", { value: String(i), text: "CR" + i + " (4/" + i + ")" }));
			bw.value = String(r.bw_hz);
			sf.value = String(r.sf);
			cr.value = String(r.cr);
			pre.addEventListener("change", function () {
				var p = MC_PRESETS[+pre.value];
				if (!p) return;
				f.value = mcMHz(p.f);
				bw.value = String(p.bw);
				sf.value = String(p.sf);
				cr.value = String(p.cr);
				note.textContent = p.hs ? "That mesh also uses " + p.hs + "-byte hop ids: set those in MeshCore's own app." : "";
			});
			editor(box, [
				el("div", { class: "form form-wide" }, field("MeshCore's settings, by region", pre)),
				el("div", { class: "form mc-form4" }, field("Frequency (MHz)", f), field("Bandwidth", bw), field("Spreading factor", sf), field("Coding rate", cr)),
				note,
				alertEl("warn", "These have to be your mesh's: on any others your radio stops hearing it, and it you, until they're set back.")
			], function (status, done) {
				var khz = Math.round(parseFloat(f.value) * 1000), p = { freq_khz: khz, bw_hz: +bw.value, sf: +sf.value, cr: +cr.value };
				if (!(khz >= 150000 && khz <= 2500000)) return line(status, "a frequency from 150 to 2500 MHz", "err");
				var said = mcMHz(khz) + " MHz, " + mcKHz(p.bw_hz) + " kHz, SF" + p.sf + ", CR" + p.cr;
				if (khz === r.freq_khz && p.bw_hz === r.bw_hz && p.sf === r.sf && p.cr === r.cr) return done("the radio's settings are as they were");
				if (!window.confirm("Set the radio to " + said + "? If these aren't your mesh's, it goes quiet.")) return;
				saving(status, call("pirate.meshcore", "set_radio", p), "radio: " + said, done);
			});
		}
		function positionEditor(box, pos) {
			var la = el("input", { class: "inp", type: "number", step: "0.00001", min: "-90", max: "90", value: pos ? pos.lat.toFixed(5) : "" });
			var lo = el("input", { class: "inp", type: "number", step: "0.00001", min: "-180", max: "180", value: pos ? pos.lon.toFixed(5) : "" });
			// This device's location: a browser has it only on a secure page (HTTPS)
			var here = window.isSecureContext && navigator.geolocation ? btn("This device's location", { onclick: function () {
				navigator.geolocation.getCurrentPosition(function (p) {
					la.value = p.coords.latitude.toFixed(5);
					lo.value = p.coords.longitude.toFixed(5);
				}, function () {}, { timeout: 10000 });
			} }) : null;
			editor(box, [el("div", { class: "form" }, field("Latitude", la), field("Longitude", lo)), here ? el("div", { class: "toolbar" }, here) : null],
				function (status, done) {
					var a = parseFloat(la.value), b = parseFloat(lo.value);
					if (!(a >= -90 && a <= 90) || !(b >= -180 && b <= 180)) return line(status, "a latitude from -90 to 90, a longitude from -180 to 180", "err");
					saving(status, call("pirate.meshcore", "set_position", { lat: a, lon: b }), "position: " + a.toFixed(5) + ", " + b.toFixed(5), done);
				});
		}
		function tuningEditor(box, t) {
			var rx = el("input", { class: "inp", type: "number", step: "0.1", min: "0", max: "20", value: String(t.rx_delay) });
			var af = el("input", { class: "inp", type: "number", step: "0.1", min: "0", max: "9", value: String(t.airtime_factor) });
			editor(box, [el("div", { class: "form" }, field("RX delay (0 to 20)", rx), field("Airtime factor (0 to 9)", af))],
				function (status, done) {
					var a = parseFloat(rx.value), b = parseFloat(af.value);
					if (!(a >= 0 && a <= 20)) return line(status, "an RX delay from 0 to 20", "err");
					if (!(b >= 0 && b <= 9)) return line(status, "an airtime factor from 0 to 9", "err");
					saving(status, call("pirate.meshcore", "set_tuning", { rx_delay: a, airtime_factor: b }), "tuning: RX delay " + a + ", airtime factor " + b, done);
				});
		}
		// How it's doing: its stats, asked for (three questions, one answer)
		function loadHealth(box) {
			healthErr = null;
			if (!health) fillHealth(box);
			return call("pirate.meshcore", "stats").then(function (h) {
				if (!alive()) return;
				if (h.error) healthErr = h.error;
				else { health = h; healthAt = Date.now(); }
				if (document.body.contains(box)) fillHealth(box);
			}).catch(function (e) {
				if (failed(e)) return;
				healthErr = /status 3\b/.test(String(e.message || e)) ? "the router's MeshCore service is older than this page" : String(e.message || e);
				if (document.body.contains(box)) fillHealth(box);
			});
		}
		function tile(label, value) { return el("div", { class: "mc-tile" }, el("span", { class: "mc-tl", text: label }), el("span", { class: "mc-tv", text: value })); }
		function fillHealth(box) {
			var h = health, grid = el("div", { class: "mc-tiles" });
			clear(box);
			if (!h) {
				box.appendChild(el("p", { class: "status" + (healthErr ? " err" : ""), text: healthErr || "asking it…" }));
				return;
			}
			if (h.core) {
				grid.appendChild(tile("Battery", mcBattery(h.core.battery_mv)));
				grid.appendChild(tile("Up for", mcLong(h.core.uptime)));
				grid.appendChild(tile("Waiting to send", h.core.queue + " packet" + (h.core.queue === 1 ? "" : "s")));
			}
			if (h.radio) {
				grid.appendChild(tile("Noise floor", h.radio.noise_floor + " dBm"));
				grid.appendChild(tile("Last heard", h.radio.last_rssi + " dBm · " + h.radio.last_snr + " dB SNR"));
				grid.appendChild(tile("On the air", "sending " + mcLong(h.radio.tx_air) + " · hearing " + mcLong(h.radio.rx_air)));
			}
			if (h.packets) {
				var p = h.packets;
				grid.appendChild(tile("Packets heard", p.received + " (" + p.received_flood + " flooded, " + p.received_direct + " direct)" + (p.receive_errors ? ", " + p.receive_errors + " garbled" : "")));
				grid.appendChild(tile("Packets sent", p.sent + " (" + p.sent_flood + " flooded, " + p.sent_direct + " direct)"));
			}
			box.appendChild(grid);
			if (healthErr) box.appendChild(el("p", { class: "status err", text: healthErr }));
		}
		function act(p, ok) {
			radioLine = ["…"];
			if (radioStatus) line(radioStatus, "…");
			return p.then(function (r) {
				radioLine = r.error ? [r.error, "err"] : [ok, "ok-text"];
				if (radioStatus) line(radioStatus, radioLine[0], radioLine[1]);
				refreshAll();
			}).catch(function (e) {
				if (failed(e)) return;
				radioLine = [String(e.message || e), "err"];
				if (radioStatus) line(radioStatus, radioLine[0], radioLine[1]);
			});
		}
		function advert(flood) { act(call("pirate.meshcore", "advert", { flood: flood }), flood ? "advert sent to the whole mesh" : "advert sent to its neighbours"); }
		function gps(on) { act(call("pirate.meshcore", "gps", { enabled: on }), on ? "GPS on: give it a few minutes for a fix" : "GPS off"); }
		function rename() {
			var n = window.prompt("The radio's name, as the mesh knows it:", (st && st.name) || "");
			if (n == null || !n.trim()) return;
			act(call("pirate.meshcore", "set_name", { name: n.trim() }), "renamed: send an advert so others see it");
		}

		function shareLoc(on) {
			// Off, its location telemetry comes down from anyone too (the router does that): said so
			var tel = !on && cfg && cfg.telemetry && cfg.telemetry.location === 2;
			act(call("pirate.meshcore", "set_location", { enabled: on }), on ? "sharing location: send an advert so others see it" :
				tel ? "location now private, and its telemetry tells only the contacts you allow: send an advert to update others" : "location now private: send an advert to update others");
		}
		// What most radios we've heard do with their location, so ours can match
		// the mesh. Only chat nodes (people) count - repeaters and rooms nearly
		// always carry theirs, which would drown out the choice people make.
		function meshLocStat() {
			var peers = contacts.filter(function (c) { return c.type === "chat" && c.last_advert; });
			if (!peers.length) return null;
			var share = 0;
			peers.forEach(function (c) { if (c.lat != null) share++; });
			return { share: share, hide: peers.length - share, total: peers.length, most: share * 2 > peers.length };
		}
		function meshLocSentence(stat, cur) {
			var n = stat.most ? stat.share : stat.hide;
			var doing = stat.most ? "share where they are" : "keep their location private";
			var txt = "Most radios you've heard (" + n + " of " + stat.total + ") " + doing + ".";
			return txt + (stat.most === cur ? " Yours matches them." : " \"Match the mesh\" sets ours the same.");
		}
		/* A command line: the radio's own (MeshCore's CLI, from 1.14), or a
		   repeater's, room's or sensor's, over the mesh, once logged in to it.
		   Each one's lines are kept while the page is open */
		var MC_CLI_SELF = ["ver", "board", "get name", "get radio", "get tx"];
		var MC_CLI_REMOTE = ["ver", "clock", "neighbors", "stats-core", "stats-radio", "stats-packets", "get radio", "get tx", "get name", "get role", "advert"];
		var MC_CLI_RISKY = /^(reboot|clkreboot|poweroff|shutdown|erase|start ota|password\b|tempradio|set (radio|freq|bw|sf|cr|prv\.key|guest\.password|repeat)\b)/i;
		var MC_ROLES = ["a guest", "read only", "read and write", "its admin"];
		function termServers() {
			return contacts.filter(function (c) { return c.type === "repeater" || c.type === "room" || c.type === "sensor"; });
		}
		function renderTerminal() {
			stopTermPoll();
			clear(vPage);
			var t = term.target === "self" ? null : contacts.filter(function (c) { return c.key === term.target; })[0] || null;
			if (!t) term.target = "self";
			var key = t ? t.key : "self";
			vPage.appendChild(pageHead(mcIcon("term", "mc-hic"), "Command line", t ? t.name : "your radio"));
			var body = el("div", { class: "mc-pagebody" });
			vPage.appendChild(body);
			var who = el("select", { class: "sel", "aria-label": "Whose command line" });
			who.appendChild(el("option", { value: "self", text: "Your radio (" + (st.name || "this one") + ")" }));
			termServers().forEach(function (c) {
				who.appendChild(el("option", { value: c.key, text: c.name + " · " + c.type + (term.auth[c.key] ? " · logged in" : "") }));
			});
			who.value = key;
			who.addEventListener("change", function () { term.target = who.value; renderTerminal(); });
			body.appendChild(el("div", { class: "toolbar" }, el("label", { class: "chkline" }, "Whose", who)));
			if (t) body.appendChild(loginBar(t));
			else if (cfg && cfg.cli === false)
				body.appendChild(alertEl("warn", "This radio's firmware has no command line: it came with MeshCore 1.14. A repeater's, here, works all the same."));
			var out = el("div", { class: "mc-console", role: "log", "aria-live": "polite" });
			(term.logs[key] || []).forEach(function (l) { out.appendChild(termLine(l)); });
			var inp = el("input", { class: "inp", type: "text", spellcheck: "false", autocomplete: "off", autocapitalize: "off",
				"aria-label": "Command", placeholder: t ? "a command for " + t.name + " (log in as its admin first)" : "a command: ver, get radio, set tx 20…" });
			var run = btn("Run", { primary: true, onclick: go });
			body.appendChild(out);
			body.appendChild(el("div", { class: "mc-cmdrow" }, el("span", { class: "mc-prompt", text: ">" }), inp, run));
			var chips = el("div", { class: "mc-cmdchips" });
			(t ? MC_CLI_REMOTE : MC_CLI_SELF).forEach(function (c) {
				chips.appendChild(el("button", { type: "button", class: "mc-cmdchip", text: c, onclick: function () { inp.value = c; go(); } }));
			});
			body.appendChild(chips);
			body.appendChild(descr(t
				? "Its own command line, over the mesh: each command a message to it, each answer one back (a few seconds, further across the mesh). MeshCore answers only those logged in as its admin."
				: "MeshCore's command line, your radio's: \"ver\", \"get radio\", \"set tx 20\"… What a command changes here shows in its settings too."));
			inp.addEventListener("keydown", function (ev) {
				if (ev.key === "Enter") { ev.preventDefault(); go(); }
				else if (ev.key === "ArrowUp" && term.hist.length) {
					ev.preventDefault();
					term.hpos = Math.max(0, term.hpos - 1);
					inp.value = term.hist[term.hpos] || "";
				} else if (ev.key === "ArrowDown" && term.hist.length) {
					ev.preventDefault();
					term.hpos = Math.min(term.hist.length, term.hpos + 1);
					inp.value = term.hist[term.hpos] || "";
				}
			});
			out.scrollTop = out.scrollHeight;
			if (!TOUCH) inp.focus();
			if (t) startTermPoll(t.key, out);
			function go() {
				var cmd = inp.value.trim();
				if (!cmd || term.busy) return;
				if (MC_CLI_RISKY.test(cmd) && !window.confirm("Run \"" + cmd + "\" on " + (t ? t.name : "your radio") + "? It can restart it, cut it off the mesh, or change how others reach it.")) return;
				term.hist.push(cmd);
				if (term.hist.length > 50) term.hist.shift();
				term.hpos = term.hist.length;
				inp.value = "";
				termAdd(key, { k: "cmd", text: cmd }, out);
				term.busy = true;
				run.disabled = true;
				(t ? call("pirate.meshcore", "remote_cli", { key: t.key, command: cmd }) : call("pirate.meshcore", "cli", { command: cmd })).then(function (r) {
					if (r.error) termAdd(key, { k: "err", text: r.error }, out);
					else termAdd(key, { k: "out", text: r.reply, ms: r.ms }, out);
					if (!t && /^set\b/i.test(cmd)) refreshAll();
				}).catch(function (e) {
					if (!failed(e)) termAdd(key, { k: "err", text: /status 3\b/.test(String(e.message || e)) ? "the router's MeshCore service is older than this page" : String(e.message || e) }, out);
				}).then(function () {
					term.busy = false;
					run.disabled = false;
					if (!TOUCH && document.body.contains(inp)) inp.focus();
				});
			}
		}
		function termLine(l) {
			var n = el("div", { class: "mc-tl-" + l.k });
			if (l.k === "cmd") n.appendChild(el("span", { class: "mc-prompt", text: "> " }));
			n.appendChild(document.createTextNode(l.text == null ? "" : l.text));
			if (l.late) n.appendChild(el("span", { class: "mc-tlnote", text: "  (came later)" }));
			else if (l.ms > 1500) n.appendChild(el("span", { class: "mc-tlnote", text: "  " + (l.ms / 1000).toFixed(1) + " s" }));
			return n;
		}
		function termAdd(key, l, out) {
			var a = term.logs[key] || (term.logs[key] = []);
			a.push(l);
			if (a.length > 300) a.shift();
			if (out && document.body.contains(out)) {
				out.appendChild(termLine(l));
				out.scrollTop = out.scrollHeight;
			}
		}
		// Its answers that came after their call gave up, or to another app's commands
		function startTermPoll(key, out) {
			stopTermPoll();
			term.timer = setInterval(function () {
				if (!alive() || mode !== "page" || page !== "terminal" || term.target !== key) return stopTermPoll();
				call("pirate.meshcore", "cli_log", { key: key, since: term.since[key] || 0 }).then(function (r) {
					if (!r || r.error || !r.lines) return;
					r.lines.forEach(function (l) { termAdd(key, { k: "out", text: l.text, late: true }, out); });
					term.since[key] = r.seq;
				}).catch(function () {});
			}, 4000);
		}
		function stopTermPoll() {
			if (term.timer) clearInterval(term.timer);
			term.timer = null;
		}
		// A login to it (its admin password, or none for a guest), its status, a logout
		function loginBar(t) {
			var a = term.auth[t.key], box = el("div", { class: "mc-loginbar" }), stBox = el("div");
			var pw = el("input", { class: "inp", type: "password", autocomplete: "off", "aria-label": "Its password", placeholder: "its admin password" });
			var status = el("span", { class: "status", text: a ? "logged in as " + MC_ROLES[a.role != null ? a.role : a.admin ? 3 : 0] : "not logged in" });
			box.appendChild(el("div", { class: "toolbar" }, pw,
				btn("Log in", { primary: !a, onclick: function () { login(pw.value); } }),
				btn("As a guest", { onclick: function () { login(""); } }),
				a ? btn("Log out", { onclick: logout }) : null,
				btn("Its status", { onclick: rstatus }), status));
			box.appendChild(stBox);
			pw.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); login(pw.value); } });
			return box;
			function login(p) {
				// As MeshCore's app asks: a guest logs in over a route, not flooded across the mesh
				if (!p && (t.flood || t.hops == null))
					return line(status, "no route to it yet: a guest logs in over a route, not flooded across the whole mesh (find one on its profile)", "err");
				line(status, "logging in…");
				call("pirate.meshcore", "login", { key: t.key, password: p }).then(function (r) {
					pw.value = "";
					if (r.error) return line(status, r.error, "err");
					term.auth[t.key] = { admin: !!r.admin, role: r.role };
					renderTerminal();
				}).catch(function (e) { pw.value = ""; if (!failed(e)) line(status, String(e.message || e), "err"); });
			}
			function logout() {
				call("pirate.meshcore", "logout", { key: t.key }).catch(function () {}).then(function () {
					delete term.auth[t.key];
					renderTerminal();
				});
			}
			function rstatus() {
				line(status, "asking it…");
				call("pirate.meshcore", "remote_status", { key: t.key }).then(function (r) {
					if (r.error) return line(status, r.error, "err");
					line(status, term.auth[t.key] ? "logged in as " + MC_ROLES[term.auth[t.key].role != null ? term.auth[t.key].role : 3] : "not logged in");
					var g = el("div", { class: "mc-tiles" });
					if (r.battery_mv) g.appendChild(tile("Battery", mcBattery(r.battery_mv)));
					if (r.uptime != null) g.appendChild(tile("Up for", mcLong(r.uptime)));
					if (r.noise_floor != null) g.appendChild(tile("Noise floor", r.noise_floor + " dBm"));
					if (r.last_rssi != null) g.appendChild(tile("Last heard", r.last_rssi + " dBm" + (r.last_snr != null ? " · " + r.last_snr + " dB SNR" : "")));
					if (r.received != null) g.appendChild(tile("Packets heard", r.received + (r.received_flood != null ? " (" + r.received_flood + " flooded, " + r.received_direct + " direct)" : "")));
					if (r.sent != null) g.appendChild(tile("Packets sent", r.sent + (r.sent_flood != null ? " (" + r.sent_flood + " flooded, " + r.sent_direct + " direct)" : "")));
					if (r.air_secs != null) g.appendChild(tile("On the air", "sending " + mcLong(r.air_secs) + (r.rx_air_secs != null ? " · hearing " + mcLong(r.rx_air_secs) : "")));
					if (r.flood_dups != null) g.appendChild(tile("Heard twice", r.flood_dups + " flooded, " + r.direct_dups + " direct"));
					if (r.queue != null) g.appendChild(tile("Waiting to send", String(r.queue)));
					clear(stBox).appendChild(g);
				}).catch(function (e) { if (!failed(e)) line(status, String(e.message || e), "err"); });
			}
		}
		/* Every packet the radio hears, as it hears it (MeshCore's, raw), read
		   as far as that goes without keys: who adverts (and where, if they
		   share it), what kind each is, which way it came, how well */
		var MC_FEED_FILTERS = [["", "Every kind"], ["advert", "Adverts"], ["message", "Messages"], ["channel", "Channels'"], ["ack", "Acks"],
			["path", "Paths"], ["request", "Requests and responses"], ["trace", "Traces"], ["other", "Others"]];
		function feedKind(d) {
			var t = d.typeName;
			if (t === "advert" || t === "message" || t === "ack" || t === "path" || t === "trace") return t;
			if (t === "channel" || t === "channel data") return "channel";
			if (t === "request" || t === "response" || t === "anonymous request") return "request";
			return "other";
		}
		// Whose a hash (a key's first byte, or bytes) could be: a contact's, or yours
		function hashWho(h, repeaters) {
			if (!h) return "?";
			var m = contacts.filter(function (c) { return c.key.slice(0, h.length) === h && (!repeaters || c.type !== "chat"); });
			if (!m.length && repeaters) m = contacts.filter(function (c) { return c.key.slice(0, h.length) === h; });
			if (st && st.key && st.key.slice(0, h.length) === h) return m.length ? h + " (you, or " + m.length + " more)" : "you";
			if (m.length === 1) return m[0].name;
			return m.length ? h + " (one of " + m.length + ")" : h;
		}
		function chanWho(h) {
			var m = channels.filter(function (c) {
				if (!feed.chash[c.secret]) feed.chash[c.secret] = mcChanHash(c.secret);
				return feed.chash[c.secret] === h;
			});
			return m.length === 1 ? mcChanLabel(m[0]) : m.length ? h + " (one of " + m.length + ")" : "channel " + h;
		}
		function feedRoute(d) {
			if (d.short && d.hops == null) return "";
			var via = d.path && d.path.length ? d.path.map(function (h) { return hashWho(h, true); }).join(" › ") : "";
			return (d.flood ? "flooded" : "direct") + (d.scoped ? " (scoped)" : "") +
				(d.hops ? (d.flood ? ", " + d.hops + " hop" + (d.hops > 1 ? "s" : "") + ": " : ", route: ") + via : d.flood ? ", first-hand" : "");
		}
		function feedWhat(d) {
			if (d.short) return "cut short";
			switch (d.typeName) {
			case "advert":
				return (d.name || "a " + d.kind) + " (" + d.kind + ")" + (d.lat != null ? " at " + d.lat.toFixed(4) + ", " + d.lon.toFixed(4) : "");
			case "message": case "request": case "response": case "path":
				return d.dst ? "to " + hashWho(d.dst) + ", from " + hashWho(d.src) : "";
			case "channel": case "channel data":
				return d.chan ? "on " + chanWho(d.chan) : "";
			case "anonymous request":
				return d.dst ? "to " + hashWho(d.dst) + " (a login, or a request), from " + hashWho(d.key.slice(0, 2)) : "";
			case "ack": return d.ack ? "checksum " + d.ack : "";
			case "trace": return d.tag ? "tag " + d.tag : "";
			case "control": return d.control || "";
			}
			return d.ver ? "payload version " + (d.ver + 1) : "";
		}
		function renderPackets() {
			stopFeed();
			clear(vPage);
			vPage.appendChild(pageHead(mcIcon("pkts", "mc-hic"), "Packets it hears", "as the radio hears them"));
			var body = el("div", { class: "mc-pagebody" });
			vPage.appendChild(body);
			var filt = el("select", { class: "sel", "aria-label": "Which" });
			MC_FEED_FILTERS.forEach(function (f) { filt.appendChild(el("option", { value: f[0], text: f[1] })); });
			filt.value = feed.filter;
			var pause = btn(feed.paused ? "Go on" : "Pause", { onclick: function () {
				feed.paused = !feed.paused;
				pause.textContent = feed.paused ? "Go on" : "Pause";
				draw();
				if (!feed.paused) tick();
			} });
			var count = el("span", { class: "status" }), list = el("div", { class: "mc-pkts" }), note = el("div");
			body.appendChild(el("div", { class: "toolbar" }, filt, pause, btn("Clear", { onclick: function () { feed.list = []; feed.open = {}; draw(); } }), count));
			body.appendChild(note);
			body.appendChild(list);
			body.appendChild(descr("Every packet your radio hears, from any radio in range: an advert says who's there (and where, if they share it); the rest are addressed by the first byte of a key, or of a channel's, and encrypted. A hop is a repeater it came through, by the first byte or bytes of its key. Newest first; click one for its bytes."));
			filt.addEventListener("change", function () { feed.filter = filt.value; draw(); });
			draw();
			tick();
			feed.timer = setInterval(tick, 2500);
			function tick() {
				if (!alive() || mode !== "page" || page !== "packets") return stopFeed();
				if (feed.paused) return;
				call("pirate.meshcore", "packets", { since: feed.since, limit: 200 }).then(function (r) {
					if (!alive() || !document.body.contains(list)) return;
					if (r.error) { feed.err = r.error; return draw(); }
					if ((r.seq || 0) < feed.since) { feed.since = 0; return; }   // the service started again: its count did too
					var got = r.packets || [];
					got.forEach(function (k) { k.d = mcDecodePacket(k.raw || ""); feed.list.push(k); });
					if (feed.list.length > 500) feed.list.splice(0, feed.list.length - 500);
					feed.since = r.seq || feed.since;
					var was = feed.err;
					feed.err = null;
					if (got.length || was) draw();
				}).catch(function (e) {
					if (failed(e)) return;
					feed.err = /status 3\b/.test(String(e.message || e)) ? "The router's MeshCore service is older than this page: update the router's firmware for the packet log." : String(e.message || e);
					draw();
				});
			}
			function draw() {
				clear(note);
				if (feed.err) note.appendChild(alertEl("warn", feed.err));
				clear(list);
				var shown = 0, n = 0;
				for (var i = feed.list.length - 1; i >= 0; i--) {
					var k = feed.list[i];
					if (feed.filter && feedKind(k.d) !== feed.filter) continue;
					n++;
					if (shown < 200) { list.appendChild(pktRow(k)); shown++; }
				}
				count.textContent = n + (feed.filter ? " of " + feed.list.length : "") + " packet" + (n === 1 ? "" : "s") + (feed.paused ? " · paused" : " · listening");
			}
			function pktRow(k) {
				var d = k.d, row = el("div", { class: "mc-pkt mc-pk-" + feedKind(d) + (feed.open[k.id] ? " open" : ""), tabindex: "0", role: "button",
					"aria-expanded": feed.open[k.id] ? "true" : "false" },
					el("span", { class: "mc-pt", title: new Date(k.rx * 1000).toLocaleString(), text: new Date(k.rx * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) }),
					el("span", { class: "mc-psig", text: k.snr + " dB · " + k.rssi + " dBm" }),
					el("span", { class: "mc-ptype", text: d.typeName || "?" }),
					el("span", { class: "mc-proute", text: feedRoute(d) }),
					el("span", { class: "mc-pwhat", text: feedWhat(d) }),
					el("span", { class: "mc-psize", text: d.size + " B" }));
				if (feed.open[k.id]) row.appendChild(pktDetail(k));
				function flip() {
					if (feed.open[k.id]) delete feed.open[k.id];
					else feed.open[k.id] = 1;
					row.parentNode.replaceChild(pktRow(k), row);
				}
				row.addEventListener("click", function (ev) { if (!ev.target.closest(".mc-pdetail")) flip(); });
				row.addEventListener("keydown", function (ev) { if ((ev.key === "Enter" || ev.key === " ") && ev.target === row) { ev.preventDefault(); flip(); } });
				return row;
			}
			function pktDetail(k) {
				var d = k.d;
				return el("div", { class: "mc-pdetail" }, kvEl([
					["Route", ["transport flood", "flood", "direct", "transport direct"][d.route] + (d.scoped ? " (scope " + d.scope + ")" : "")],
					["Hops", d.hops != null ? d.hops + (d.hops ? " (" + d.path.join(" ") + ", " + d.hashSize + "-byte ids)" : "") : null],
					["Payload", d.payloadSize != null ? d.payloadSize + " bytes, version " + (d.ver + 1) : null],
					["Key", d.key ? el("code", { class: "mc-key", text: d.key }) : null],
					["Advert's time", d.time ? new Date(d.time * 1000).toLocaleString() : null],
					["Heard", new Date(k.rx * 1000).toLocaleString() + " · SNR " + k.snr + " dB · RSSI " + k.rssi + " dBm"]
				]), el("div", { class: "mc-praw", text: (k.raw || "").replace(/(..)/g, "$1 ").trim() }));
			}
		}
		function stopFeed() {
			if (feed.timer) clearInterval(feed.timer);
			feed.timer = null;
		}
		// A new channel, and a channel's settings
		function renderAddChannel() {
			clear(vPage);
			vPage.appendChild(pageHead(mcIcon("plus", "mc-hic"), "Add a channel",
				channels.length + " of " + ((st && st.max_channels) || 40) + " slots used"));
			var body = el("div", { class: "mc-pagebody" });
			var chName = el("input", { class: "inp", type: "text", placeholder: "#hashtag, or a name" });
			var chKey = el("input", { class: "inp", type: "text", spellcheck: "false", placeholder: "its key, if you were given one (32 hex digits)" });
			var status = el("span", { class: "status" });
			body.appendChild(el("div", { class: "form form-wide" },
				el("label", {}, el("span", { class: "lbl", text: "Name" }), chName),
				el("label", {}, el("span", { class: "lbl", text: "Key" }), chKey)));
			body.appendChild(el("div", { class: "toolbar" }, btn("Add channel", { primary: true, onclick: add }), status));
			body.appendChild(el("p", { class: "descr", text:
				"A #hashtag channel's key comes from its name: anyone who knows the name can join, so it isn't private. Another name gets a random key, private to those you give it to; or give the key someone shared." }));
			vPage.appendChild(body);
			chName.addEventListener("keydown", function (ev) { if (ev.key === "Enter") add(); });
			if (!TOUCH) chName.focus();
			function add() {
				var n = chName.value.trim(), k = chKey.value.trim().toLowerCase(), slot = freeSlot;
				if (!n) return line(status, "give it a name", "err");
				if (k && !/^[0-9a-f]{32}$/.test(k)) return line(status, "a key is 32 hex digits", "err");
				if (slot == null) return line(status, "the radio's channel slots are all taken: remove one first", "err");
				line(status, "adding…");
				call("pirate.meshcore", "channel_set", { index: slot, name: n, secret: k || undefined }).then(function (r) {
					if (r.error) return line(status, r.error, "err");
					line(status, "added: " + n, "ok-text");
					setTimeout(function () {
						refreshLists().then(function () {
							var c = channels.filter(function (x) { return x.index === slot; })[0];
							if (alive() && c && page === "addch") openConv(c.conv);
						});
					}, 600);
				}).catch(function (e) { if (!failed(e)) line(status, String(e.message || e), "err"); });
			}
		}
		function renderChannel(idx) {
			clear(vPage);
			var c = channels.filter(function (x) { return x.index === idx; })[0];
			if (!c) {
				vPage.appendChild(pageHead(null, "Channel", null));
				vPage.appendChild(el("div", { class: "mc-pagebody" }, el("p", { class: "muted", text: "That channel is gone." })));
				return;
			}
			var kind = mcChanKind(c), status = el("span", { class: "status" });
			vPage.appendChild(pageHead(chanIcon(c, "mc-hic"), mcChanLabel(c), KIND_TEXT[kind]));
			var key = el("code", { class: "mc-key", text: "••••••••••••••••" }), showing = false;
			var body = el("div", { class: "mc-pagebody" });
			body.appendChild(kvEl([
				["Name", c.name],
				["Kind", { "public": "MeshCore's public channel", hashtag: "#hashtag (its key from its name)", "private": "private" }[kind]],
				["Slot", String(c.index)],
				["Key", el("span", {}, key, " ", el("button", { type: "button", class: "linkbtn", text: "show", onclick: function () {
					showing = !showing;
					key.textContent = showing ? c.secret : "••••••••••••••••";
					this.textContent = showing ? "hide" : "show";
				} }))]
			]));
			body.appendChild(el("p", { class: "descr", text: kind === "private"
				? "To bring someone in, give them its name and key: they add it as a channel whose key they were given."
				: kind === "hashtag" ? "Anyone who adds " + c.name + " reads it: its key comes from its name." : "Every MeshCore radio has it." }));
			body.appendChild(el("div", { class: "toolbar" },
				btn("Open it", { primary: true, onclick: function () { openConv(c.conv); } }),
				btn("Remove channel", { cls: "reset", onclick: function () { removeChannel(c, status); } }), status));
			vPage.appendChild(body);
		}
		function removeChannel(c, status) {
			if (!window.confirm("Remove the channel " + c.name + "? Its messages here stay; the radio forgets its key.")) return;
			call("pirate.meshcore", "channel_set", { index: c.index, name: "" }).then(function (r) {
				if (r.error) return line(status, r.error, "err");
				setTimeout(function () { refreshLists().then(function () { if (alive()) openFirst(); }); }, 600);
			}).catch(function (e) { if (!failed(e)) line(status, String(e.message || e), "err"); });
		}

		/* Profiles, as Discord's popout: a person's (or a repeater's) card from
		   their face or name, wherever it is: who they are, their route and a
		   trace along it, where they are, what they share; message or mention
		   them from it */
		var pop = el("div", { class: "mc-pop", role: "dialog", "aria-label": "Profile" });
		pop.hidden = true;
		app.appendChild(pop);
		var popAnchor = null;
		function closeProfile() {
			pop.hidden = true;
			pop.classList.remove("picker");
			clear(pop);
			popAnchor = null;
		}
		function openProfile(t, anchor) {
			popAnchor = anchor;
			pop.classList.remove("picker");
			clear(pop).appendChild(profileEl(t));
			pop.hidden = false;
			placePop();
			var f = pop.querySelector("button");
			if (f && !TOUCH) f.focus({ preventScroll: true });
		}
		// Beside what was clicked, inside the window; on a phone, a sheet from the foot
		function placePop() {
			if (pop.hidden) return;
			if (window.innerWidth <= 860 || !popAnchor) {
				pop.classList.add("sheet");
				pop.style.left = pop.style.top = "";
				return;
			}
			pop.classList.remove("sheet");
			var w = pop.offsetWidth, h = pop.offsetHeight, x, y;
			if (document.contains(popAnchor)) {
				var r = popAnchor.getBoundingClientRect();
				x = r.right + 12;
				y = r.top - 8;
				if (x + w > window.innerWidth - 8) x = r.left - w - 12;
				if (x < 8) x = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
			} else {
				// What it was beside is gone (redrawn): it stays, inside the window
				x = parseFloat(pop.style.left) || 8;
				y = parseFloat(pop.style.top) || 8;
				if (x + w > window.innerWidth - 8) x = window.innerWidth - w - 8;
			}
			if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
			if (y < 8) y = 8;
			pop.style.left = Math.round(x) + "px";
			pop.style.top = Math.round(y) + "px";
		}
		function onDown(ev) {
			if (!alive()) { document.removeEventListener("pointerdown", onDown, true); return; }
			if (!pop.hidden && !pop.contains(ev.target) && !(popAnchor && popAnchor.contains(ev.target))) closeProfile();
		}
		document.addEventListener("pointerdown", onDown, true);

		// Who a message's sender is: you; a direct message's contact; in a channel, the contact of that name
		function contactByName(name) {
			var best = null;
			contacts.forEach(function (c) {
				if (c.name === name && (!best || (c.type === "chat") > (best.type === "chat") ||
					((c.type === "chat") === (best.type === "chat") && (c.last_advert || 0) > (best.last_advert || 0)))) best = c;
			});
			return best;
		}
		function targetByName(name) {
			if (st && name === st.name) return { me: true };
			var c = contactByName(name);
			return c ? { contact: c } : { name: name };
		}
		function targetOf(m) {
			if (m.out) return { me: true };
			if (m.conv.charAt(0) === "c") { var c = contactOf(m.conv); if (c) return { contact: c }; }
			return targetByName(m.from || sender(m));
		}
		function myPos() {
			var g = st && st.gps;
			return g && g.lat != null && g.lon != null && (g.lat || g.lon) ? { lat: g.lat, lon: g.lon, live: !!g.live } : null;
		}
		// How far, and which way, from one place to another (on a sphere: near enough)
		function distance(a, b) {
			var r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
			var h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.pow(Math.sin(dLon / 2), 2);
			var y = Math.sin(dLon) * Math.cos(b.lat * r);
			var x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos(dLon);
			var deg = (Math.atan2(y, x) / r + 360) % 360;
			return { m: 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h))), way: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8] };
		}
		function distText(m) { return m < 1000 ? Math.round(m) + " m" : (m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000)) + " km"; }
		function fmtMs(ms) { return ms < 1000 ? ms + " ms" : (ms / 1000).toFixed(1) + " s"; }
		// A hop: its repeater's name ("?" when other repeaters have its id too), or its id
		function hopLabel(h) { return h.name ? h.name + (h.maybe ? "?" : "") : h.id; }
		function hopWhy(h) {
			return h.maybe ? h.maybe + " repeaters you know have the id " + h.id + ": this is the one heard most recently" : "";
		}
		function routeText(c) {
			if (c.flood) return "No route yet: messages to them go out to the whole mesh";
			if (!c.hops) return "Direct: heard without a repeater between you";
			var via = (c.path || []).map(hopLabel);
			return c.hops + " hop" + (c.hops === 1 ? "" : "s") + (via.length ? ": " + via.join(" → ") : "");
		}
		function cardSec(title) { return el("div", { class: "mc-cardsec" }, el("h4", { text: title })); }
		function snrPill(v) {
			var q = v >= 5 ? "good" : v >= 0 ? "fair" : v >= -7 ? "weak" : "poor";
			return el("span", { class: "mc-snr " + q, title: "SNR: how far above the noise it was heard", text: (v > 0 ? "+" : "") + v + " dB" });
		}
		// A place: its coordinates, how far from you, a map
		function posEl(pos, from, me) {
			var mine = myPos(), d = !me && mine ? distance(mine, pos) : null;
			var map = "https://www.openstreetmap.org/?mlat=" + pos.lat.toFixed(5) + "&mlon=" + pos.lon.toFixed(5) + "#map=15/" + pos.lat.toFixed(5) + "/" + pos.lon.toFixed(5);
			return el("div", { class: "mc-cardline" },
				el("div", {}, el("code", { text: pos.lat.toFixed(5) + ", " + pos.lon.toFixed(5) }),
					el("a", { class: "mc-maplink", href: map, target: "_blank", rel: "noopener noreferrer", text: "Map ↗" })),
				el("div", { class: "muted mc-cardmeta", text: (d ? distText(d.m) + " " + d.way + " of you · " : "") + from }));
		}
		// A MeshMapper ping: said so, how it was heard (a message that heads its
		// group has that above it), and where it was sent from, if its user shares that
		function pingEl(p, sig) {
			var box = el("span", { class: "mc-words mc-ping",
				title: "A MeshMapper wardriving ping (MM:" + p.tag + "). Its tag is its session's and ping's, keyed: only MeshMapper's server reads it" },
				el("span", { class: "mc-ping-k", text: "📡 ping" }),
				sig ? el("span", { class: "mc-sig", text: sig }) : null);
			if (p.pos) {
				var mine = myPos(), d = mine ? distance(mine, p.pos) : null, la = p.pos.lat.toFixed(5), lo = p.pos.lon.toFixed(5);
				box.appendChild(el("span", { class: "mc-ping-pos" },
					"sent from " + la + ", " + lo + (d ? " (" + distText(d.m) + " " + d.way + " of you)" : ""),
					el("a", { class: "mc-maplink", href: "https://www.openstreetmap.org/?mlat=" + la + "&mlon=" + lo + "#map=15/" + la + "/" + lo,
						target: "_blank", rel: "noopener noreferrer", text: "Map ↗" })));
			}
			return box;
		}
		var TELEM = { voltage: "Battery", percentage: "Battery", temperature: "Temperature", humidity: "Humidity", pressure: "Pressure",
			altitude: "Altitude", light: "Light", current: "Current", power: "Power", energy: "Energy", distance: "Distance",
			concentration: "Concentration", direction: "Heading", frequency: "Frequency" };
		function telemetryEl(r) {
			var box = el("div", {}), grid = el("div", { class: "mc-telem" }), any = false;
			(r.readings || []).forEach(function (x) {
				if (x.kind === "gps") { box.appendChild(posEl({ lat: x.lat, lon: x.lon }, "from their telemetry, just now" + (x.alt ? " · " + Math.round(x.alt) + " m up" : ""))); return; }
				if (x.value == null) return;
				any = true;
				grid.appendChild(el("span", { class: "muted", text: TELEM[x.kind] || x.kind }));
				grid.appendChild(el("span", { text: (Math.round(x.value * 100) / 100) + (x.unit ? " " + x.unit : "") }));
			});
			if (any) box.insertBefore(grid, box.firstChild);
			if (!box.firstChild) box.appendChild(el("div", { class: "muted mc-cardmeta", text: "They answered, sharing nothing more." }));
			box.appendChild(el("div", { class: "muted mc-cardmeta", text: "Answered in " + fmtMs(r.ms || 0) + "." }));
			return box;
		}
		function traceEl(r) {
			var list = el("ol", { class: "mc-trace" });
			list.appendChild(el("li", {}, el("span", { class: "mc-hopname", text: "You" })));
			(r.hops || []).forEach(function (h) {
				list.appendChild(el("li", { title: hopWhy(h) || null },
					el("span", { class: "mc-hopname" + (h.name && !h.maybe ? "" : " muted"), text: h.name ? hopLabel(h) : "unknown repeater" }),
					el("code", { class: "mc-hopid", text: h.id }), snrPill(h.snr)));
			});
			list.appendChild(el("li", {}, el("span", { class: "mc-hopname", text: "You" }), snrPill(r.snr_back)));
			return el("div", {}, list, el("div", { class: "muted mc-cardmeta",
				text: "There and back in " + fmtMs(r.ms || 0) + ". Each SNR is how well that one heard the one before it." }));
		}
		function discoveredEl(r) {
			function way(p) { return p && p.length ? p.map(hopLabel).join(" → ") : "direct"; }
			return el("div", {},
				el("div", { class: "mc-cardline", text: "Found in " + fmtMs(r.ms || 0) + (r.kept ? ", and used from now on" : "") + "." }),
				el("div", { class: "muted mc-cardmeta", text: "There: " + way(r.out) + " · back: " + way(r["in"]) }));
		}
		// A trace, a route, telemetry: asked of the radio, the answer in the card when it comes
		function ask(kind, c, res, b) {
			var says = { trace: "Tracing the route…", discover: "Asking across the whole mesh for a route…", telemetry: "Asking for their telemetry…" };
			b.disabled = true;
			clear(res).appendChild(el("div", { class: "status", text: says[kind] }));
			placePop();
			call("pirate.meshcore", kind, { key: c.key }).then(function (r) {
				b.disabled = false;
				if (!alive()) return;
				clear(res);
				if (r.error) res.appendChild(el("div", { class: "status err", text: r.error }));
				else if (kind === "trace") res.appendChild(traceEl(r));
				else if (kind === "discover") { res.appendChild(discoveredEl(r)); refreshLists(); }
				else res.appendChild(telemetryEl(r));
				placePop();
			}).catch(function (e) {
				b.disabled = false;
				if (!failed(e)) clear(res).appendChild(el("div", { class: "status err", text: String(e.message || e) }));
			});
		}
		// "@[Name] " where the cursor is, as MeshCore's apps mention someone
		function mention(name) {
			var at = "@[" + name + "] ", s = input.selectionStart || 0, e = input.selectionEnd || 0;
			input.value = input.value.slice(0, s) + at + input.value.slice(e);
			input.selectionStart = input.selectionEnd = s + at.length;
			grow(); updateCount();
			input.focus();
		}
		function profileEl(t) {
			var me = !!t.me, c = t.contact || null, name = me ? (st && st.name) || "You" : c ? c.name : t.name || "someone";
			var person = me || !c || c.type === "chat", card = el("div", { class: "mc-card" });
			var banner = el("div", { class: "mc-banner" + (me ? " mine" : "") });
			if (!me) mcColour(banner, name);
			card.appendChild(banner);
			card.appendChild(el("div", { class: "mc-cardface" }, person ? mcFace(name, me, "lg") : mcTile(name, "lg")));
			var nm = el("div", { class: "mc-cardname" + (me ? " mine" : "") }, el("span", { text: name }));
			if (!me) mcColour(nm, name);
			card.appendChild(nm);
			card.appendChild(el("div", { class: "mc-cardchips" },
				el("span", { class: "mc-kind", text: me ? "you" : c ? KIND_NAME[c.type] || c.type : "not a contact" }),
				c && c.last_advert ? el("span", { class: "muted", text: "heard " + mcAgo(c.last_advert) }) : null,
				me && st && st.battery_mv ? el("span", { class: "muted", text: "battery " + battPct(st.battery_mv) + "%" }) : null));
			var body = el("div", { class: "mc-cardbody" });
			card.appendChild(body);
			var key = me ? st && st.key : c && c.key;
			if (key) {
				var k = el("code", { class: "mc-cardkey", title: "Its public key: click for all of it", text: key.slice(0, 16) + "…" }), whole = false;
				k.addEventListener("click", function () { whole = !whole; k.textContent = whole ? key : key.slice(0, 16) + "…"; placePop(); });
				body.appendChild(el("div", { class: "mc-cardline" }, k));
			}
			if (!me && !c) body.appendChild(el("p", { class: "mc-cardnote muted",
				text: "Not among your contacts: an advert from them adds them. Until then, there's no messaging them directly." }));
			// The route, a trace along it, finding one
			if (c) {
				var sec = cardSec("Route"), res = el("div", { class: "mc-cardres" }), acts = el("div", { class: "mc-cardacts" });
				sec.appendChild(el("div", { class: "mc-cardline", text: routeText(c) }));
				if (!c.flood && (c.type === "repeater" || c.hops > 0))
					acts.appendChild(btn("Trace route", { cls: "small", onclick: function () { ask("trace", c, res, this); } }));
				acts.appendChild(btn(c.flood ? "Find a route" : "Find a new route", { cls: "small", onclick: function () { ask("discover", c, res, this); } }));
				if (!c.flood) acts.appendChild(btn("Forget route", { cls: "small", onclick: function () { contactOp("contact_reset_path", c); closeProfile(); } }));
				sec.appendChild(acts);
				sec.appendChild(res);
				body.appendChild(sec);
			}
			// Where they are: from their advert (or your radio's GPS), and asked for now
			var pos = me ? myPos() : c && c.lat != null ? { lat: c.lat, lon: c.lon } : null;
			var psec = cardSec("Position");
			if (pos) psec.appendChild(posEl(pos, me ? (pos.live ? "your radio's GPS, now" : "your radio's GPS, its last fix") : "from their advert, " + mcAgo(c.last_advert), me));
			else psec.appendChild(el("div", { class: "mc-cardline muted", text: me ? "No GPS position." : person ? "Their adverts carry no position." : "Its adverts carry no position." }));
			if (me && st && st.share_location) psec.appendChild(el("div", { class: "mc-cardmeta warn-text", text: "Your adverts carry it: everyone on the mesh sees where you are." }));
			if (c) {
				var tres = el("div", { class: "mc-cardres" });
				psec.appendChild(el("div", { class: "mc-cardacts" }, btn("Ask for telemetry", { cls: "small", title: "Their battery, and their position and sensors if they share them with you",
					onclick: function () { ask("telemetry", c, tres, this); } })));
				psec.appendChild(tres);
			}
			if (me || c) body.appendChild(psec);
			// To message them, mention them; to remove them
			var foot = el("div", { class: "mc-cardfoot" });
			if (c && c.type === "chat") foot.appendChild(btn("Message", { primary: true, onclick: function () { closeProfile(); openConv(c.conv); } }));
			if (!me && mode === "thread" && open && open.charAt(0) === "#")
				foot.appendChild(btn("Mention", { onclick: function () { closeProfile(); mention(name); } }));
			if (me) foot.appendChild(btn("Your radio's settings", { primary: true, onclick: function () { closeProfile(); openPage("radio"); } }));
			if (c) foot.appendChild(btn(c.favorite ? "★ Unfavourite" : "☆ Favourite", { cls: "small",
				title: c.favorite ? "A favourite, on the radio" : "Marked on the radio, and kept when its contact list is full",
				onclick: function () { closeProfile(); contactOp("contact_favorite", c, { favorite: !c.favorite }); } }));
			if (c) foot.appendChild(btn("Remove", { cls: "small reset", onclick: function () {
				if (window.confirm("Remove " + c.name + " from the radio's contacts? An advert from them adds them back.")) { closeProfile(); contactOp("contact_remove", c); }
			} }));
			if (foot.firstChild) card.appendChild(foot);
			return card;
		}

		/* The open conversation */
		function showThreadHead() {
			clear(threadHead);
			threadHead.appendChild(backBtn());
			var ch = chanOf(open), c = contactOf(open);
			if (ch) {
				threadHead.appendChild(chanIcon(ch, "mc-hic"));
				threadHead.appendChild(el("strong", { text: mcChanLabel(ch) }));
				threadHead.appendChild(el("span", { class: "mc-hsub muted", text: KIND_TEXT[mcChanKind(ch)] }));
				threadHead.appendChild(el("button", { type: "button", class: "mc-iconbtn mc-hbtn", title: "Channel settings", "aria-label": "Channel settings",
					onclick: function () { openPage("chan:" + ch.index); } }, mcIcon("gear")));
			} else if (c) {
				var who = el("button", { type: "button", class: "mc-hwho", title: "Profile", onclick: function () { openProfile({ contact: c }, who); } },
					mcFace(c.name, false, "sm"), el("strong", { text: c.name }));
				threadHead.appendChild(who);
				threadHead.appendChild(el("span", { class: "mc-hsub muted",
					text: (c.flood ? "no route yet: messages go out to the whole mesh" : route(c)) + (c.last_advert ? " · heard " + mcAgo(c.last_advert) : "") }));
			} else threadHead.appendChild(el("strong", { text: open }));
		}
		// The top of a conversation, when there's nothing before
		function startEl() {
			var ch = chanOf(open);
			if (ch) return el("div", { class: "mc-start" },
				el("div", { class: "mc-startic" }, chanIcon(ch)),
				el("h3", { text: "Welcome to " + (mcChanKind(ch) === "private" ? "" : "#") + mcChanLabel(ch) }),
				el("p", { class: "muted", text: "The start of " + ch.name + " on this router. " + {
					"public": "MeshCore's public channel: everyone on the mesh reads it.",
					hashtag: "A #hashtag channel: anyone who knows its name reads it.",
					"private": "Private: only those with its key read it."
				}[mcChanKind(ch)] }));
			var name = convName(open);
			return el("div", { class: "mc-start" }, mcFace(name, false, "lg"), el("h3", { text: name }),
				el("p", { class: "muted", text: "The start of your messages with " + name + " here." }));
		}

		// A reply goes with "@[Name] " first, as the daemon writes it: the room that takes
		function answerName(m) { return m.from || sender(m); }
		function maxBytes() {
			var n = open && open.charAt(0) === "#" ? Math.max(10, 150 - utf8len((st && st.name) || "") - 2) : 150;
			if (replyTo) n -= utf8len("@[" + answerName(replyTo) + "] ");
			return Math.max(1, n);
		}
		function updateCount() {
			var n = utf8len(input.value), m = maxBytes();
			count.textContent = n ? n + " / " + m : "";
			count.className = "mc-count" + (n > m ? " err" : n > m - 20 ? " near" : "");
			sendBtn.disabled = mode !== "thread" || !open || !input.value.trim() || n > m;
		}
		function grow() {
			input.style.height = "auto";
			input.style.height = Math.min(input.scrollHeight, 168) + "px";
		}
		input.addEventListener("input", function () { grow(); updateCount(); });
		input.addEventListener("keydown", function (ev) {
			if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); if (!sendBtn.disabled) send(); }
			else if (ev.key === "Escape" && replyTo) { ev.preventDefault(); cancelReply(); }
		});

		function statusEl(m) {
			var s = m.status, t = { queued: "queued", sent: "sent", delivered: "delivered", unconfirmed: "not confirmed", failed: "failed" }[s] || s;
			var span = el("span", { class: "mc-st mc-" + s, text: t + (s === "delivered" && m.trip_ms ? " · " + m.trip_ms + " ms" : "") +
				(m.attempt ? " · try " + (m.attempt + 1) : "") });
			if ((s === "unconfirmed" || s === "failed") && m.conv.charAt(0) === "c")
				span.appendChild(el("button", { type: "button", class: "linkbtn mc-retry", text: " retry", onclick: function () { resend(m); } }));
			return span;
		}
		// Who sent it: you, or the name it came with (a direct message's, the contact's)
		function sender(m) {
			if (m.out) return (st && st.name) || m.from || "you";
			return m.from || (m.conv.charAt(0) === "#" ? "someone" : convName(m.conv));
		}

		/* Replies, as MeshCore's apps write them: "@[Name] " first (MeshCore
		   Open's with "#" and a time). Which message one answers: ours, as we
		   sent it; theirs, as the daemon made it out */
		var MENTION = /^@\[([^\]]+?)(?:#\d{10,16})?\]:?[ \t]*/;
		function plain(text) { return String(text || "").replace(MENTION, ""); }
			// Some clients prepend a ">"-quoted snippet of the message they answer
			// (e.g. ">Testing ou.."); we already show that above (the reply line),
			// so a leading quote block in the body is redundant. Drop it, with the
			// blank line it sits on, but keep a message that was only a quote.
			function stripQuote(text) {
				var lines = String(text).split("\n"), i = 0, n = lines.length;
				while (i < n && lines[i].trim() === "") i++;
				if (i >= n || !/^\s*>/.test(lines[i])) return text;
				while (i < n && /^\s*>/.test(lines[i])) i++;
				while (i < n && lines[i].trim() === "") i++;
				var rest = lines.slice(i).join("\n");
				return rest.trim() === "" ? text : rest;
			}
			// A bracketed mention "@[Name]" (or "@[Name#hash]") as plain text, for
			// previews and snippets: shown as "@Name", without the brackets.
			function mcDebracket(s) { return String(s).replace(/@\[([^\]]+?)(?:#\d{10,16})?\]/g, "@$1"); }
		// A reply answers a message the daemon found; "@[Name]" answering none is a mention
		function isReply(m) { return !!m.reply; }
		function answers(m) {
			var mm = MENTION.exec(m.text || ""), t, mine = (st && st.name) || "";
			if (!m.reply) return null;
			t = byId[m.reply];
			if (t) return { msg: t, name: sender(t), out: !!t.out, text: stripQuote(plain(t.text)) };
			if (m.reply_text != null)
				return { id: m.reply, name: m.reply_out ? mine || m.reply_from : m.reply_from || (mm && mm[1]) || "someone", out: !!m.reply_out, text: stripQuote(plain(m.reply_text)) };
			return { name: mm ? mm[1] : "someone", out: !!mm && mm[1] === mine, text: null };
		}
		function mentionOf(m) {
			var mm = !m.reply && MENTION.exec(m.text || "");
			return mm ? { name: mm[1], me: mm[1] === ((st && st.name) || ""), rest: m.text.slice(mm[0].length) } : null;
		}
		function startReply(m) {
			if (replyTo && shown[replyTo.id]) shown[replyTo.id].classList.remove("mc-target");
			replyTo = m;
			if (shown[m.id]) shown[m.id].classList.add("mc-target");
			var nm = el("span", { class: "mc-rname", text: sender(m) });
			if (m.out) nm.classList.add("mine"); else mcColour(nm, sender(m));
			clear(replyBar).appendChild(el("span", { class: "mc-rb-text" }, "Replying to ", nm,
				el("span", { class: "mc-rb-snip", text: mcMediaLabel(stripQuote(plain(m.text))) || mcDebracket(stripQuote(plain(m.text))) })));
			replyBar.appendChild(el("button", { type: "button", class: "mc-rb-x", title: "Don't reply (Esc)", "aria-label": "Don't reply", text: "✕", onclick: cancelReply }));
			replyBar.hidden = false;
			updateCount();
			input.focus();
		}
		function cancelReply() {
			if (!replyTo) return;
			if (shown[replyTo.id]) shown[replyTo.id].classList.remove("mc-target");
			replyTo = null;
			replyBar.hidden = true;
			updateCount();
		}
		// To the message a reply answers: older ones fetched until it's there, then a flash where it is
		function jumpTo(id, tries) {
			var n = shown[id];
			if (n) {
				threadBody.scrollTop = Math.max(0, n.offsetTop - threadBody.clientHeight / 3);
				n.classList.remove("mc-flash");
				void n.offsetWidth;
				n.classList.add("mc-flash");
				setTimeout(function () { n.classList.remove("mc-flash"); }, 1700);
			} else if (more && (tries || 0) < 20 && thread.length && id < thread[0].id)
				loadOlder().then(function (got) { if (got) jumpTo(id, (tries || 0) + 1); });
		}

		// One sender's messages run together, as a chat app has them: a new
		// group for another sender, another day, after a few minutes' quiet,
		// a reply (what it answers goes above it), or where the news starts
		function startsGroup(prev, m) {
			return !prev || !prev.out !== !m.out || sender(prev) !== sender(m) ||
				!mcSameDay(prev.ts, m.ts) || Math.abs(m.ts - prev.ts) > 420 || isReply(m) || m.id === unreadFrom;
		}
		function signal(m) {
			var s = [];
			if (m.snr != null) s.push("SNR " + m.snr + " dB");
			if (m.hops != null) s.push(m.hops ? m.hops + " hop" + (m.hops === 1 ? "" : "s") : "direct");
			return s.join(" · ");
		}
		// A group's first message carries the face, the name and the time; the
		// rest, only their text (the time and signal show on hover)
		function msgEl(m, head) {
			var who = sender(m), sig = m.out ? "" : signal(m), when = new Date(m.ts * 1000).toLocaleString();
			var rep = answers(m), men = mentionOf(m);
			var row = el("div", { class: "mc-row" + (head ? " mc-head" : "") + (m.out ? " out" : "") +
				(rep ? " mc-reply" : "") + (!m.out && ((rep && rep.out) || (men && men.me)) ? " mc-me" : "") +
				(replyTo && replyTo.id === m.id ? " mc-target" : ""), "data-id": String(m.id) });
			if (!m.out) mcColour(row, who);
			// What it answers, above it: their face, their name, the start of it
			if (rep) {
				var rn = el("span", { class: "mc-rname", text: "@" + rep.name }), to = rep.msg ? rep.msg.id : rep.id;
				if (rep.out) rn.classList.add("mine"); else mcColour(rn, rep.name);
				row.appendChild(el("span", { class: "mc-conn", "aria-hidden": "true" }));
				row.appendChild(el("button", { type: "button", class: "mc-rline", title: to ? "Show the message it answers" : "",
					onclick: function () { if (to) jumpTo(to); } },
					mcFace(rep.name, rep.out, "xxs"), rn,
					el("span", { class: "mc-rtext" + (rep.text == null ? " gone" : ""), text: rep.text == null ? "a message not kept here" : mcMediaLabel(rep.text) || mcDebracket(rep.text) || " " })));
			}
			// React, Reply: on hover (a tap, on a phone)
			if (m.out || m.from || m.conv.charAt(0) !== "#")
				row.appendChild(el("div", { class: "mc-acts" },
					canReact(m) ? el("button", { type: "button", class: "mc-act mc-act-react", title: "Add a reaction", "aria-label": "Add a reaction",
						onclick: function (ev) { ev.stopPropagation(); openPicker(m, this); } }, "☺") : null,
					el("button", { type: "button", class: "mc-act", title: "Reply", onclick: function (ev) { ev.stopPropagation(); startReply(m); } }, "↩ Reply")));
			var face = head ? mcFace(who, m.out) : null;
			if (face) { face.classList.add("mc-pick"); face.setAttribute("data-pick", "1"); }
			row.appendChild(el("div", { class: "mc-gut" },
				face || el("span", { class: "mc-gtime", title: when, text: mcHM(m.ts) })));
			var body = el("div", { class: "mc-body" });
			if (head) body.appendChild(el("div", { class: "mc-who" },
				el("span", { class: "mc-author mc-pick", "data-pick": "1", role: "button", tabindex: "0", title: "Profile", text: who }),
				el("span", { class: "mc-when", title: when, text: mcHM(m.ts) }),
				sig ? el("span", { class: "mc-sig", text: sig }) : null));
			// Its words, links clickable; images under them (a message that's
			// only an image: the image, its link back if it won't load)
			var words = men ? " " + men.rest : rep ? stripQuote(plain(m.text)) : m.text, media = [], only = mcOnlyMedia(words);
			var trimmed = String(words).trim(), mco = MC_IMG.test(trimmed) ? trimmed : null, ph = mcPlaceholder(trimmed), wordsEl;
			var ping = !men && !rep && !mco && !ph ? mcMapperPing(trimmed) : null;
			if (ph) wordsEl = el("span", { class: "mc-words mc-ph", text: ph });
			else if (mco) wordsEl = el("span", { class: "mc-words mc-hide" });
			else if (ping) wordsEl = pingEl(ping, head ? "" : sig);
			else wordsEl = el("span", { class: "mc-words" + (only ? " mc-hide" : "") }, mcLinkify(words, media, (st && st.name) || ""));
			if (!ph && !mco && only && !media.length) {
				// meshcore-open's "g:ID": its page's link, should the GIF not load
				media.push(only);
				clear(wordsEl).appendChild(document.createTextNode("GIF: "));
				wordsEl.appendChild(el("a", { class: "mc-link", href: only.page, target: "_blank", rel: "noopener noreferrer nofollow", text: only.page.replace(/^https:\/\//, "") }));
			}
			body.appendChild(el("div", { class: "mc-text" },
				men ? el("span", { class: "mc-mention" + (men.me ? " me" : ""), "data-mention": men.name, role: "button", tabindex: "0", text: "@" + men.name }) : null,
				wordsEl,
				m.out ? statusEl(m) : null,
				!head && sig && !ping ? el("span", { class: "mc-sig mc-hover", text: sig }) : null));
			if (media.length) {
				var embeds = el("div", { class: "mc-embeds" });
				media.forEach(function (x) { embeds.appendChild(mcEmbed(x, function () { wordsEl.classList.remove("mc-hide"); })); });
				body.appendChild(embeds);
			}
			// An MCOimg: drawn; one this can't draw, said in words, not basE91
			if (mco) {
				var pic = mcoimgEl(mco, function (why) { wordsEl.textContent = why; wordsEl.className = "mc-words mc-ph"; }, keepBottom);
				if (pic) body.appendChild(el("div", { class: "mc-embeds" }, pic));
			}
			var chips = reactsEl(m);
			if (chips) body.appendChild(chips);
			row.appendChild(body);
			return row;
		}

		/* Reactions, as Discord shows them: a chip each emoji under the
		   message, how many, who on hover, yours lit; a click adds yours */
		var QUICK = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "👏", "🎉", "👀", "💯", "✅"];
		// In a channel, any message with a name; in a DM, only theirs: a DM's
		// reaction names no one, so meshcore-open (and MCO Advanced) look for
		// it only among the messages they sent, and show one to yours as text
		function canReact(m) {
			return m.conv.charAt(0) === "#" ? !!(m.out || m.from) : !m.out;
		}
		function reactsEl(m) {
			var r = reacts[m.id], can = canReact(m);
			if (!r) return null;
			var box = el("div", { class: "mc-reacts" });
			Object.keys(r).forEach(function (e) {
				var who = r[e], keys = Object.keys(who), mine = keys.some(function (k) { return who[k].out; });
				var names = keys.map(function (k) { return who[k].out ? "you" : who[k].name; });
				box.appendChild(el("button", { type: "button", class: "mc-react" + (mine ? " mine" : ""),
					title: names.join(", ") + (mine || !can ? "" : " · click to react too"), "aria-label": e + ": " + names.join(", "),
					onclick: function (ev) { ev.stopPropagation(); if (!mine && can) react(m, e); } },
					el("span", { class: "mc-remoji", text: e }), el("span", { class: "mc-rcount", text: String(keys.length) })));
			});
			if (can)
				box.appendChild(el("button", { type: "button", class: "mc-react mc-react-add", title: "Add a reaction", "aria-label": "Add a reaction",
					onclick: function (ev) { ev.stopPropagation(); openPicker(m, this); } }, "+"));
			return box;
		}
		function react(m, e) {
			sayStatus("");
			call("pirate.meshcore", "react", { id: m.id, emoji: e }).then(function (r) {
				if (r.error) sayStatus(r.error, "err");
				else poll();
			}).catch(function (e2) { if (!failed(e2)) sayStatus(String(e2.message || e2), "err"); });
		}
		// The picker: the ones most used, or any emoji of yours
		function openPicker(m, anchor) {
			popAnchor = anchor;
			clear(pop);
			pop.classList.add("picker");
			var grid = el("div", { class: "mc-picker" });
			QUICK.forEach(function (e) {
				grid.appendChild(el("button", { type: "button", class: "mc-pick-e", title: e, text: e, onclick: function () { closeProfile(); react(m, e); } }));
			});
			var other = el("input", { class: "inp mc-pick-in", type: "text", placeholder: "or type one", "aria-label": "An emoji of your own", maxlength: "16" });
			other.addEventListener("keydown", function (ev) {
				if (ev.key === "Enter" && other.value.trim()) { ev.preventDefault(); var e = other.value.trim(); closeProfile(); react(m, e); }
			});
			pop.appendChild(el("div", { class: "mc-pickwrap" }, el("div", { class: "mc-pickhead", text: "React to " + sender(m) }), grid, other));
			pop.hidden = false;
			placePop();
			if (!TOUCH) grid.firstChild.focus({ preventScroll: true });
		}

		/* The composer's emoji + GIF picker, opened by the ☺ button. Emoji insert
		   where the cursor is and the picker stays open; a GIF drops in its
		   "g:ID" and closes. */
		var cpickTab = "emoji";
		function insertAt(s) {
			var a = input.selectionStart || 0, b = input.selectionEnd || 0;
			input.value = input.value.slice(0, a) + s + input.value.slice(b);
			input.selectionStart = input.selectionEnd = a + s.length;
			grow(); updateCount();
		}
		function openComposerPicker(anchor) {
			if (!pop.hidden && popAnchor === anchor) { closeProfile(); return; }
			popAnchor = anchor;
			pop.classList.add("picker");
			clear(pop).appendChild(buildComposerPicker());
			pop.hidden = false;
			placePop();
		}
		function buildComposerPicker() {
			var wrap = el("div", { class: "mc-cpick" });
			var search = el("input", { class: "inp mc-cpsearch", type: "search", autocomplete: "off", spellcheck: "false", "aria-label": "Search" });
			var body = el("div", { class: "mc-cpbody" });
			var tEmoji, tGif;
			function renderBody() { clear(body); if (cpickTab === "gif") renderGifs(body, search.value.trim()); else renderEmoji(body, search.value.trim()); }
			function setTab(id) {
				cpickTab = id;
				tEmoji.classList.toggle("on", id === "emoji");
				tGif.classList.toggle("on", id === "gif");
				search.placeholder = id === "gif" ? "Search Giphy" : "Search emoji";
				renderBody();
			}
			tEmoji = el("button", { type: "button", class: "mc-cptab", onclick: function () { setTab("emoji"); } }, "😀 Emoji");
			tGif = el("button", { type: "button", class: "mc-cptab", onclick: function () { setTab("gif"); } }, "▶ GIF");
			var gifTimer = null;
			search.addEventListener("input", function () {
				if (cpickTab !== "gif") { renderBody(); return; }   // emoji filter is local; GIF search is debounced
				clearTimeout(gifTimer);
				gifTimer = setTimeout(renderBody, 500);
			});
			wrap.appendChild(el("div", { class: "mc-cptabs" }, tEmoji, tGif));
			wrap.appendChild(search);
			wrap.appendChild(body);
			setTab(cpickTab);
			setTimeout(function () { if (!TOUCH) { try { search.focus({ preventScroll: true }); } catch (e) {} } }, 0);
			return wrap;
		}
		function renderEmoji(body, q) {
			q = q.toLowerCase();
			var any = false;
			MC_EMOJI.forEach(function (cat) {
				var items = cat[1].split("|").filter(function (it) { return !q || it.toLowerCase().indexOf(q) >= 0; });
				if (!items.length) return;
				any = true;
				if (!q) body.appendChild(el("div", { class: "mc-cpcat", text: cat[0] }));
				var grid = el("div", { class: "mc-emoji-grid" });
				items.forEach(function (it) {
					var sp = it.indexOf(" "), e = sp < 0 ? it : it.slice(0, sp);
					grid.appendChild(el("button", { type: "button", class: "mc-emoji", title: sp < 0 ? e : it.slice(sp + 1), text: e,
						onclick: function () { insertAt(e); input.focus(); } }));
				});
				body.appendChild(grid);
			});
			if (!any) body.appendChild(el("div", { class: "muted mc-cpnote", text: "No emoji match that." }));
		}
		function renderGifs(body, q) {
			if (!DEMO && !mcGiphyKey()) { gifKeyForm(body, false); return; }
			body.appendChild(el("div", { class: "muted mc-cpnote", text: "Loading…" }));
			mcGifSearch(q).then(function (gifs) {
				clear(body);
				if (!gifs.length) { body.appendChild(el("div", { class: "muted mc-cpnote", text: q ? "No GIFs for that." : "No GIFs." })); return; }
				var grid = el("div", { class: "mc-gif-grid" });
				gifs.forEach(function (g) {
					grid.appendChild(el("button", { type: "button", class: "mc-gif", title: g.title, onclick: function () { pickGif(g.id); } },
						el("img", { src: g.thumb, alt: g.title, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" })));
				});
				body.appendChild(grid);
				if (!DEMO) body.appendChild(el("div", { class: "mc-cpvia" }, el("span", { text: "via Giphy" }),
					el("button", { type: "button", class: "lnk mc-cpkeybtn", text: "change key", onclick: function () { gifKeyForm(body, false); } })));
			}).catch(function (e) {
				clear(body);
				var m = String(e && e.message);
				if (m === "no-key" || m === "bad-key") gifKeyForm(body, m === "bad-key");
				else body.appendChild(el("div", { class: "status err mc-cpnote", text: "Giphy: " + (e.message || e) }));
			});
		}
		function gifKeyForm(body, bad) {
			clear(body);
			body.appendChild(el("p", { class: "descr mc-cpnote", text: bad
				? "That Giphy key was rejected. Paste a valid one:"
				: "GIF search uses Giphy. Paste a free API key (developers.giphy.com → Create an App). It stays in this browser." }));
			var inp = el("input", { class: "inp", type: "text", placeholder: "Giphy API key", value: mcGiphyKey(), spellcheck: "false", autocomplete: "off" });
			var save = el("button", { class: "btn small", type: "button", text: "Save", onclick: function () {
				var k = inp.value.trim();
				mcSetGiphyKey(k);
				if (k) renderGifs(body, "");
			} });
			inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); save.onclick(); } });
			body.appendChild(el("div", { class: "mc-cpkeyrow" }, inp, save));
		}
		function pickGif(id) {
			// A plain .gif URL: every client shows a tappable GIF (ours and
			// meshcore-open still preview it), unlike "g:ID" which only
			// meshcore-open understands and others show as literal text.
			var g = "https://media.giphy.com/media/" + id + "/giphy.gif", v = input.value;
			if (!v.trim()) input.value = "";
			else if (!/\s$/.test(v)) g = " " + g;
			insertAt(g);
			closeProfile();
			input.focus();
		}
		// A sender's face or name, or a mention: their profile
		function picked(ev) {
			var pk = ev.target.closest("[data-pick]"), mn = ev.target.closest("[data-mention]");
			if (pk) {
				var row = pk.closest(".mc-row"), m = row && byId[row.getAttribute("data-id")];
				if (m) openProfile(targetOf(m), pk);
				return true;
			}
			if (mn) {
				openProfile(targetByName(mn.getAttribute("data-mention")), mn);
				return true;
			}
			return false;
		}
		threadBody.addEventListener("keydown", function (ev) {
			if ((ev.key === "Enter" || ev.key === " ") && picked(ev)) ev.preventDefault();
		});
		// A tap on a phone shows a message's actions (there's no hover)
		threadBody.addEventListener("click", function (ev) {
			if (picked(ev)) return;
			if (!TOUCH || ev.target.closest("button, a")) return;
			var row = ev.target.closest(".mc-row"), was = threadBody.querySelector(".mc-sel");
			if (was && was !== row) was.classList.remove("mc-sel");
			if (row) row.classList.toggle("mc-sel");
		});

		// The thread's messages; its reactions apart, by the message each is to
		// (one whose message isn't here waits, unshown, as MeshCore One has it)
		function setThread(list) {
			thread = [];
			byId = {};
			rmsgs = {};
			list.forEach(function (m) {
				if (m.emoji) rmsgs[m.id] = m;
				else { thread.push(m); byId[m.id] = m; }
			});
			gatherReacts();
		}
		function gatherReacts() {
			reacts = {};
			Object.keys(rmsgs).forEach(function (id) {
				var m = rmsgs[id];
				if (!m.react) return;
				var r = reacts[m.react] || (reacts[m.react] = {}), e = r[m.emoji] || (r[m.emoji] = {});
				// One a person, an emoji: a reaction passed on twice is one
				e[m.out ? "\u0000you" : sender(m)] = { name: m.out ? (st && st.name) || "You" : sender(m), out: !!m.out };
			});
		}
		function allMsgs() { return thread.concat(Object.keys(rmsgs).map(function (id) { return rmsgs[id]; })); }
		function rerender(t) {
			var i = thread.indexOf(t), node = msgEl(t, startsGroup(thread[i - 1], t));
			if (shown[t.id]) threadBody.replaceChild(node, shown[t.id]);
			shown[t.id] = node;
		}
		// Where the news starts: the first of the last so many that came
		function firstUnread(u) {
			for (var i = thread.length - 1, n = 0; i >= 0 && u > 0; i--)
				if (!thread[i].out && ++n === u) return thread[i].id;
			return 0;
		}
		function dayEl(t) { return el("div", { class: "mc-day", role: "separator" }, el("span", { text: mcDay(t) })); }
		function appendMsg(m, prev) {
			if (!prev || !mcSameDay(prev.ts, m.ts)) threadBody.appendChild(dayEl(m.ts));
			if (m.id === unreadFrom) threadBody.appendChild(el("div", { class: "mc-newline", role: "separator", "aria-label": "New messages" }, el("span", { text: "New" })));
			shown[m.id] = threadBody.appendChild(msgEl(m, startsGroup(prev, m)));
		}
		function renderThread() {
			clear(threadBody);
			shown = {};
			threadBody.appendChild(more ? el("div", { class: "mc-older muted", text: "Older messages, as you scroll up…" }) : startEl());
			if (!thread.length) threadBody.appendChild(el("div", { class: "mc-none muted", text: "No messages yet." }));
			var prev = null;
			thread.forEach(function (m) { appendMsg(m, prev); prev = m; });
		}
		function nearBottom() { return threadBody.scrollHeight - threadBody.scrollTop - threadBody.clientHeight < 90; }
		// A change that grows a message (an image drawn): at the newest still, if it was
		function keepBottom(fn) {
			var near = nearBottom();
			fn();
			if (near) toBottom();
		}
		function toBottom() {
			threadBody.scrollTop = threadBody.scrollHeight;
			newBelow = 0;
			jumpBtn.hidden = true;
			jumpWas = "";
		}
		function showJump() {
			var label = newBelow ? newBelow + " new message" + (newBelow === 1 ? "" : "s") : "Jump to the newest";
			if (label === jumpWas && !jumpBtn.hidden) return;
			jumpWas = label;
			clear(jumpBtn).appendChild(document.createTextNode(label + " "));
			jumpBtn.appendChild(mcIcon("down"));
			jumpBtn.classList.toggle("news", newBelow > 0);
			jumpBtn.hidden = false;
		}
		threadBody.addEventListener("scroll", function () {
			if (threadBody.scrollTop < 240 && more && !loadingOlder) loadOlder();
			if (nearBottom()) { newBelow = 0; jumpBtn.hidden = true; jumpWas = ""; }
			else if (newBelow || threadBody.scrollHeight - threadBody.scrollTop - threadBody.clientHeight > threadBody.clientHeight * 1.5) showJump();
		});
		// Older messages, a page at a time, as Discord fetches them: kept where you were
		function loadOlder() {
			if (!more || loadingOlder || !thread.length) return Promise.resolve(false);
			loadingOlder = true;
			var conv = open;
			return call("pirate.meshcore", "messages", { conv: conv, before: thread[0].id, limit: 100 }).then(function (r) {
				loadingOlder = false;
				if (!alive() || !isOpen(conv)) return false;
				var older = r.messages || [], h = threadBody.scrollHeight, top = threadBody.scrollTop;
				setThread(older.concat(allMsgs()));
				more = !!r.more && older.length > 0;
				renderThread();
				threadBody.scrollTop = threadBody.scrollHeight - h + top;
				return older.length > 0;
			}, function () { loadingOlder = false; return false; });
		}
		// Into the open thread: a new one at the end (under its day), a changed
		// one (its delivery) where it is
		function placeMsg(m) {
			var old = byId[m.id];
			// A reaction: its message's chips afresh (if its message is here)
			if (m.emoji) {
				var was = rmsgs[m.id], nearR = nearBottom();
				rmsgs[m.id] = m;
				if (was && was.react === m.react) return;
				gatherReacts();
				if (m.react && byId[m.react]) {
					rerender(byId[m.react]);
					if (nearR) toBottom();
				}
				return;
			}
			if (old) {
				thread[thread.indexOf(old)] = m;
				byId[m.id] = m;
				rerender(m);
				return;
			}
			var near = nearBottom(), prev = thread[thread.length - 1];
			thread.push(m);
			byId[m.id] = m;
			if (!prev) renderThread(); else appendMsg(m, prev);
			if (near || m.out) toBottom();
			else { newBelow++; showJump(); }
		}
		function openConv(conv) {
			if (conv !== open) cancelReply();
			closeProfile();
			var c = chanOf(conv) || contactOf(conv), u = (c && c.unread) || 0;
			mode = "thread"; page = null; open = conv;
			if (search.value) search.value = "";
			app.classList.add("mc-open");
			showMain("thread");
			renderSide();
			showMe();
			showThreadHead();
			var ch = chanOf(conv);
			input.placeholder = "Message " + (ch ? (mcChanKind(ch) === "private" ? "" : "#") + mcChanLabel(ch) : convName(conv));
			setThread([]);
			shown = {}; more = false; unreadFrom = 0; newBelow = 0;
			jumpBtn.hidden = true; jumpWas = "";
			sayStatus("");
			clear(threadBody).appendChild(el("div", { class: "mc-none muted", text: "Loading…" }));
			call("pirate.meshcore", "messages", { conv: conv, limit: Math.min(200, Math.max(100, u + 30)) }).then(function (r) {
				if (!alive() || !isOpen(conv)) return;
				setThread(r.messages || []);
				more = !!r.more;
				unreadFrom = firstUnread(u);
				renderThread();
				// To where the news starts, if that's up a way; else the newest
				var d = unreadFrom && threadBody.querySelector(".mc-newline");
				if (d && threadBody.scrollHeight - d.offsetTop > threadBody.clientHeight) threadBody.scrollTop = Math.max(0, d.offsetTop - 80);
				else toBottom();
				if (threadBody.scrollHeight <= threadBody.clientHeight && more) loadOlder();
				markRead();
			}).catch(function (e) { if (!failed(e)) clear(threadBody).appendChild(warnEl(e)); });
			updateCount();
			if (!TOUCH) input.focus();
		}
		// The open conversation is read: on the router too, when it had news
		function markRead(force) {
			if (mode !== "thread" || !open || document.hidden) return;
			var c = chanOf(open) || contactOf(open);
			if (force || (c && c.unread)) {
				if (c) c.unread = 0;
				renderSide();
				call("pirate.meshcore", "read", { conv: open }).catch(function () {});
			}
		}
		function send() {
			var text = input.value.trim(), to = open;
			if (!to || !text || mode !== "thread") return;
			sendBtn.disabled = true;
			sayStatus("");
			var p = { to: to, text: text };
			if (replyTo) p.reply = replyTo.id;
			call("pirate.meshcore", "send", p).then(function (r) {
				if (r.error) { sayStatus(r.error, "err"); updateCount(); return; }
				input.value = "";
				grow();
				cancelReply();
				updateCount();
				poll();
			}).catch(function (e) { if (!failed(e)) sayStatus(String(e.message || e), "err"); updateCount(); });
		}
		function resend(m) {
			call("pirate.meshcore", "resend", { id: m.id }).then(function (r) {
				if (r.error) sayStatus(r.error, "err");
				poll();
			}).catch(function (e) { if (!failed(e)) sayStatus(String(e.message || e), "err"); });
		}

		/* Keeping up: everything, then what changed every few seconds */
		function refreshAll() {
			return call("pirate.meshcore", "status").then(function (s) {
				if (!alive()) return;
				st = s;
				seq = Math.max(seq, s.seq || 0);
				showMe();
				if (s.state !== "ready") { showNote(s); return; }
				return refreshLists().then(function () {
					if (!alive()) return;
					if (mode === null || mode === "note") openFirst();
					else if (mode === "page" && page === "radio") renderRadio();
					else if (mode === "thread") { showThreadHead(); updateCount(); }
				});
			}).catch(function (e) {
				if (failed(e) || !alive()) return;
				st = null;
				showMe();
				showNote(null, String(e.message || e) === "ubus status 4"
					? "The MeshCore service isn't running on this router (pirate-meshcore)." : String(e.message || e));
			});
		}
		function poll() {
			return call("pirate.meshcore", "poll", { since: seq }).then(function (p) {
				if (!alive()) return;
				var was = st && st.state;
				seq = p.seq || seq;
				if (p.meta || p.state !== was) return refreshAll().then(function () { catchUp(p); });
				catchUp(p);
			}).catch(function () {});
		}
		// New and changed messages: the open thread's shown, the others'
		// counted afresh (the lists come again, with their unread)
		function catchUp(p) {
			var msgs = p.messages || [], elsewhere = false, here = false;
			if (p.truncated && mode === "thread") return openConv(open);
			msgs.forEach(function (m) {
				if (isOpen(m.conv)) { placeMsg(m); if (!m.out) here = true; }
				else if (!m.out) elsewhere = true;
			});
			if (here) markRead(true);
			if (elsewhere) refreshLists();
		}
		function refreshLists() {
			return Promise.all([call("pirate.meshcore", "contacts"), call("pirate.meshcore", "channels")]).then(function (r) {
				if (!alive()) return;
				contacts = r[0].contacts || [];
				channels = r[1].channels || [];
				freeSlot = r[1].free != null ? r[1].free : null;
				if (mode === "thread" && open) { var c = chanOf(open) || contactOf(open); if (c && !document.hidden) c.unread = 0; }
				renderSide();
				if (contactsFill) contactsFill();
			}).catch(function () {});
		}
		function loop() {
			if (!alive()) { timer = null; return; }
			poll().then(function () { timer = setTimeout(loop, 3000); });
		}
		showMe();
		updateCount();
		refreshAll().then(function () { timer = setTimeout(loop, 3000); });
	}

	/* ---------- Capture ---------- */

	function renderCapture() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Capture", "passive packet capture to the microSD card"));

		var ctl = panel("New capture");
		var ifaceSel = el("select", { class: "sel" });
		var filterIn = el("input", { class: "inp", type: "text", placeholder: "optional BPF filter, e.g. port 53" });
		var nameIn = el("input", { class: "inp", type: "text", placeholder: "optional name" });
		var startBtn = btn("Start capture", { primary: true, onclick: doStart });
		var stopBtn = btn("Stop", { cls: "reset", onclick: doStop });
		var statusLine = el("div", { class: "status" });
		ctl.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "Interface" }), ifaceSel),
			el("label", {}, el("span", { class: "lbl", text: "Filter" }), filterIn),
			el("label", {}, el("span", { class: "lbl", text: "Name" }), nameIn)));
		ctl.appendChild(el("div", { class: "toolbar" }, startBtn, stopBtn, statusLine));
		ctl.appendChild(el("p", { class: "descr", text:
			"Captures on an ordinary interface (no monitor mode, no transmit), size-rotated so it cannot fill the card." }));

		var filesPanel = panel("Saved captures");
		filesPanel.style.marginTop = "14px";
		var filesWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		filesPanel.appendChild(el("div", { class: "toolbar" }, btn("Refresh", { onclick: refresh })));
		filesPanel.appendChild(filesWrap);

		VIEW.appendChild(ctl); VIEW.appendChild(filesPanel);

		function fillIfaces(d) {
			clear(ifaceSel);
			((d && d.interfaces) || []).forEach(function (i) {
				var l = ifLabel(i.name);
				ifaceSel.appendChild(el("option", { value: i.name,
					text: (l === i.name ? i.name : l + " — " + i.name) + (i.state && i.state !== "up" && i.state !== "unknown" ? " (" + i.state + ")" : "") }));
			});
		}
		function showStatus(s) {
			var running = s && s.running;
			startBtn.disabled = !!running;
			stopBtn.disabled = !running;
			if (running) {
				statusLine.textContent = "capturing on " + ifLabel(s.iface) + (s.filter ? " [" + s.filter + "]" : "") +
					" — " + size(s.size) + ", " + dur(s.elapsed) + (s.file ? " — " + s.file : "");
				statusLine.className = "status ok-text";
			} else {
				statusLine.textContent = "idle";
				statusLine.className = "status";
			}
		}
		function fillFiles(d) {
			var list = (d && d.files) || [];
			if (!list.length) { clear(filesWrap).appendChild(el("div", { class: "placeholder", text: "No captures on the card yet." })); return; }
			clear(filesWrap).appendChild(tableEl(["File", "Size", "When"], list.map(function (f) {
				var url = "http://" + (location.hostname || "192.168.1.1") + ":8081/pirate-radio/capture/" + f.name;
				return [el("a", { href: url, target: "_blank", rel: "noopener", text: f.name }), size(f.size), f.mtime || ""];
			})));
		}
		function refresh() {
			call("pirate.capture", "status").then(showStatus).catch(function () {});
			call("pirate.capture", "list").then(fillFiles).catch(function (e) {
				clear(filesWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}
		function doStart() {
			startBtn.disabled = true;
			call("pirate.capture", "start", { iface: ifaceSel.value, filter: filterIn.value, name: nameIn.value }).then(function (s) {
				if (s.error) { statusLine.textContent = s.error; statusLine.className = "status err"; startBtn.disabled = false; return; }
				showStatus(s); refresh();
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				statusLine.textContent = String(e.message || e); statusLine.className = "status err"; startBtn.disabled = false;
			});
		}
		function doStop() {
			stopBtn.disabled = true;
			call("pirate.capture", "stop").then(function () { refresh(); }).catch(function (e) {
				statusLine.textContent = String(e.message || e); statusLine.className = "status err";
			});
		}

		call("pirate.capture", "interfaces").then(fillIfaces).catch(function (e) {
			if (String(e.message || e) === "unauthorized") return onError(e);
		});
		refresh();
	}

	/* ---------- Handshake (passive) ---------- */

	function renderHandshake() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Handshakes", "passive WPA handshake capture (monitor mode)"));
		VIEW.appendChild(alertEl("info",
			"Listen-only: a radio in monitor mode records the WPA 4-way handshake when a device reconnects on its own. It never transmits, deauthenticates, or forces a reconnection. For networks you own or are authorized to test — cracking happens offline on your computer."));

		var ctl = panel("New capture");
		ctl.style.marginTop = "14px";
		var radioSel = el("select", { class: "sel" });
		var chIn = el("input", { class: "inp", type: "number", min: "1", max: "196", placeholder: "channel, e.g. 6" });
		var nameIn = el("input", { class: "inp", type: "text", placeholder: "optional name" });
		var startBtn = btn("Start capture", { primary: true, onclick: doStart });
		var stopBtn = btn("Stop", { cls: "reset", onclick: doStop });
		var statusLine = el("div", { class: "status" });
		ctl.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "Radio" }), radioSel),
			el("label", {}, el("span", { class: "lbl", text: "Channel" }), chIn),
			el("label", {}, el("span", { class: "lbl", text: "Name" }), nameIn)));
		ctl.appendChild(el("div", { class: "toolbar" }, startBtn, stopBtn, statusLine));

		var filesPanel = panel("Saved handshakes");
		filesPanel.style.marginTop = "14px";
		var filesWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		filesPanel.appendChild(el("div", { class: "toolbar" }, btn("Refresh", { onclick: refresh })));
		filesPanel.appendChild(filesWrap);

		VIEW.appendChild(ctl); VIEW.appendChild(filesPanel);

		function fillRadios(d) {
			clear(radioSel);
			var any = false;
			((d && d.radios) || []).forEach(function (r) {
				var o = el("option", { value: r.phy, text: phyLabel(r.phy) + " — " + r.phy + (r.monitor ? "" : " (no monitor)") });
				if (!r.monitor) o.disabled = true; else any = true;
				radioSel.appendChild(o);
			});
			if (!any) radioSel.appendChild(el("option", { value: "", text: "no monitor-capable radio" }));
		}
		function showStatus(s) {
			var running = s && s.running;
			startBtn.disabled = !!running;
			stopBtn.disabled = !running;
			if (running) {
				var hs = s.eapol >= 4 ? " — handshake likely (" + s.eapol + " EAPOL)"
					: (s.eapol ? " — " + s.eapol + " EAPOL frames" : " — waiting for a handshake…");
				statusLine.textContent = "listening on the " + phyLabel(s.phy) + ", ch " + s.channel + " — " + size(s.size) + ", " + dur(s.elapsed) + hs;
				statusLine.className = "status " + (s.eapol >= 4 ? "ok-text" : "");
			} else {
				statusLine.textContent = "idle";
				statusLine.className = "status";
			}
		}
		function fillFiles(d) {
			var list = (d && d.files) || [];
			if (!list.length) { clear(filesWrap).appendChild(el("div", { class: "placeholder", text: "No handshakes captured yet." })); return; }
			clear(filesWrap).appendChild(tableEl(["File", "Size", "When"], list.map(function (f) {
				var url = "http://" + (location.hostname || "192.168.1.1") + ":8081/pirate-radio/handshake/" + f.name;
				return [el("a", { href: url, target: "_blank", rel: "noopener", text: f.name }), size(f.size), f.mtime || ""];
			})));
		}
		function refresh() {
			call("pirate.handshake", "status").then(showStatus).catch(function () {});
			call("pirate.handshake", "list").then(fillFiles).catch(function (e) {
				clear(filesWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}
		function doStart() {
			startBtn.disabled = true;
			call("pirate.handshake", "start", { phy: radioSel.value, channel: chIn.value, name: nameIn.value }).then(function (s) {
				if (s.error) { statusLine.textContent = s.error; statusLine.className = "status err"; startBtn.disabled = false; return; }
				showStatus(s); refresh();
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				statusLine.textContent = String(e.message || e); statusLine.className = "status err"; startBtn.disabled = false;
			});
		}
		function doStop() {
			stopBtn.disabled = true;
			call("pirate.handshake", "stop").then(function () { refresh(); }).catch(function (e) {
				statusLine.textContent = String(e.message || e); statusLine.className = "status err";
			});
		}

		call("pirate.handshake", "radios").then(fillRadios).catch(function (e) {
			if (String(e.message || e) === "unauthorized") return onError(e);
		});
		refresh();
	}

	/* ---------- Firmware ---------- */

	function renderFirmware() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Firmware", "flash a new Pirate Radio image to this device"));

		var curPanel = panel("Current firmware");
		var curWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		curPanel.appendChild(curWrap);

		var flashPanel = panel("Flash new firmware");
		flashPanel.style.marginTop = "14px";
		flashPanel.appendChild(alertEl("info",
			"Upload a sysupgrade image, or fetch it by URL. It is checked against this device before anything is written — a flash never starts from an image that fails the check. If a flash ever goes wrong, hold the reset button at power-on for the GL.iNet U-Boot recovery page."));

		var fileIn = el("input", { class: "inp", type: "file", accept: ".bin,.img,application/octet-stream" });
		var urlIn = el("input", { class: "inp", type: "text", placeholder: "https://…/…-sysupgrade.bin" });
		var shaIn = el("input", { class: "inp", type: "text", placeholder: "expected sha256 (optional)" });
		flashPanel.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "Image file" }), fileIn),
			el("label", {}, el("span", { class: "lbl", text: "…or URL" }), urlIn),
			el("label", {}, el("span", { class: "lbl", text: "sha256" }), shaIn)));
		flashPanel.appendChild(el("div", { class: "toolbar" },
			btn("Upload image", { onclick: doUpload }), btn("Fetch by URL", { onclick: doFetch })));

		var stagedLine = el("div", { class: "status", text: "No image staged." });
		var keepChk = el("input", { type: "checkbox" }); keepChk.checked = true;
		var flashBtn = btn("Flash & reboot", { primary: true, cls: "reset", onclick: doApply });
		flashBtn.disabled = true;
		var clearBtn = btn("Discard image", { onclick: doClear });
		flashPanel.appendChild(stagedLine);
		flashPanel.appendChild(el("div", { class: "toolbar" },
			el("label", { class: "chkline" }, keepChk, document.createTextNode(" Keep current settings")),
			flashBtn, clearBtn));
		flashPanel.appendChild(el("p", { class: "descr", text:
			"Flashing reboots the device; it is unreachable for a minute or two. With settings kept, your Wi-Fi, uplink and password carry over." }));

		var bkPanel = panel("Back up configuration");
		bkPanel.style.marginTop = "14px";
		var bkStatus = el("span", { class: "status" });
		bkPanel.appendChild(el("div", { class: "toolbar" }, btn("Back up now", { onclick: doBackup }), bkStatus));
		bkPanel.appendChild(el("p", { class: "descr", text:
			"Writes a config archive to the device. Copy it off with scp for a spare — a kept-settings flash does not need it." }));

		VIEW.appendChild(curPanel); VIEW.appendChild(flashPanel); VIEW.appendChild(bkPanel);

		function kv(pairs) {
			var dl = el("dl", { class: "kv" });
			pairs.forEach(function (p) {
				if (p[1] == null || p[1] === "") return;
				dl.appendChild(el("dt", { text: p[0] }));
				dl.appendChild(el("dd", { text: String(p[1]) }));
			});
			return dl;
		}
		function showStaged(s) {
			clear(stagedLine);
			if (!s || !s.staged) { stagedLine.className = "status"; stagedLine.textContent = "No image staged."; flashBtn.disabled = true; return; }
			stagedLine.className = "status";
			stagedLine.appendChild(badge(s.verified ? "verified" : "not verified", s.verified ? "sec-ok" : "sec-warn"));
			stagedLine.appendChild(document.createTextNode(" " + size(s.staged_size) + " staged" + (s.verified ? " — ready to flash" : "")));
			flashBtn.disabled = !s.verified;
		}
		function showStatus(s) {
			clear(curWrap).appendChild(kv([
				["Model", s.model],
				["Firmware", s.firmware],
				["Staging free", s.staging_free ? mb(s.staging_free) + " MB" : null]
			]));
			showStaged(s);
		}
		function refresh() {
			return call("pirate.firmware", "status").then(showStatus).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				clear(curWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}
		function verifyStaged() {
			stagedLine.className = "status"; stagedLine.textContent = "verifying…";
			return call("pirate.firmware", "verify").then(function (r) {
				if (!r.ok) { stagedLine.textContent = r.error || "verification failed"; stagedLine.className = "status err"; }
				return refresh();
			});
		}
		function uploadImage(f) {
			if (DEMO) { DEMO_FW.staged = true; DEMO_FW.size = f.size; DEMO_FW.verified = false; return Promise.resolve({ ok: true, size: f.size }); }
			return fetch("/cgi-bin/pirate-upload", { method: "PUT", body: f }).then(function (r) { return r.json(); });
		}
		function doUpload() {
			var f = fileIn.files && fileIn.files[0];
			if (!f) { stagedLine.className = "status err"; stagedLine.textContent = "choose an image file first"; return; }
			stagedLine.className = "status"; stagedLine.textContent = "uploading " + f.name + "…";
			uploadImage(f).then(function (r) {
				if (!r || !r.ok) { stagedLine.className = "status err"; stagedLine.textContent = (r && r.error) || "upload failed"; return; }
				return verifyStaged();
			}).catch(function (e) { stagedLine.className = "status err"; stagedLine.textContent = String(e.message || e); });
		}
		function doFetch() {
			if (!urlIn.value) { stagedLine.className = "status err"; stagedLine.textContent = "enter a URL"; return; }
			stagedLine.className = "status"; stagedLine.textContent = "fetching…";
			call("pirate.firmware", "fetch", { url: urlIn.value, sha256: shaIn.value }).then(function (r) {
				if (!r.ok) { stagedLine.className = "status err"; stagedLine.textContent = r.error || "download failed"; return; }
				return verifyStaged();
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				stagedLine.className = "status err"; stagedLine.textContent = String(e.message || e);
			});
		}
		function doApply() {
			if (!window.confirm("Flash this image and reboot the Slate? It will be offline for a minute or two.")) return;
			flashBtn.disabled = true;
			call("pirate.firmware", "apply", { mode: keepChk.checked ? "keep" : "reset" }).then(function (r) {
				if (!r.ok) { stagedLine.className = "status err"; stagedLine.textContent = r.error || "flash refused"; flashBtn.disabled = false; return; }
				stagedLine.className = "status ok-text";
				stagedLine.textContent = "flashing now — the Slate is rebooting. Reload this page in a minute or two.";
			}).catch(function () {
				// sysupgrade tears the connection down as it reboots; that is expected.
				stagedLine.className = "status ok-text";
				stagedLine.textContent = "flashing — the Slate is rebooting. Reload this page in a minute or two.";
			});
		}
		function doClear() {
			call("pirate.firmware", "clear").then(function () { fileIn.value = ""; return refresh(); }).catch(function () {});
		}
		function doBackup() {
			bkStatus.className = "status"; bkStatus.textContent = "backing up…";
			call("pirate.firmware", "backup").then(function (r) {
				if (!r.ok) { bkStatus.className = "status err"; bkStatus.textContent = r.error || "backup failed"; return; }
				bkStatus.className = "status ok-text"; bkStatus.textContent = "saved " + r.file + " (" + size(r.size) + ")";
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				bkStatus.className = "status err"; bkStatus.textContent = String(e.message || e);
			});
		}

		refresh();
	}

	/* ---------- DreamPi ---------- */

	// dreampi's states: badge, badge class, what it means
	var DP_STATES = {
		"listening": ["ready", "sec-ok", "Playing a dial tone: dial from the Dreamcast."],
		"answering": ["answering", "sec-warn", "Heard the Dreamcast dial; answering."],
		"connected": ["online", "sec-ok", "The Dreamcast is online."],
		"hanging-up": ["hanging up", "sec-warn", "The call ended; resetting the modem."],
		"starting": ["starting", "sec-warn", "Starting the modem."],
		"no-modem": ["no modem", "sec-neutral", "Plug in a USB modem to answer the Dreamcast."],
		"off": ["off", "sec-neutral", "Answering is turned off."]
	};
	var DP_SERVICES = { ppp: "DreamPi servers", dcnet: "DCNet" };
	var DP_TIMER = null;

	function renderDreampi() {
		clear(VIEW);
		VIEW.appendChild(viewHead("DreamPi", "a Dreamcast online through a USB modem"));

		var stPanel = panel("Status");
		var stWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		stPanel.appendChild(stWrap);

		var setPanel = panel("Settings");
		setPanel.style.marginTop = "14px";
		var svcSel = el("select", { class: "sel" },
			el("option", { value: "ppp", text: "DreamPi servers (PPP on the Slate)" }),
			el("option", { value: "dcnet", text: "DCNet (Flycast's network)" }));
		var enChk = el("input", { type: "checkbox" });
		var toneChk = el("input", { type: "checkbox" });
		var nowChk = el("input", { type: "checkbox" });
		var dmzChk = el("input", { type: "checkbox" });
		var dmzNote = el("p", { class: "descr" });
		var saveStatus = el("span", { class: "status" });
		var setWrap = el("div", { hidden: "" });
		setWrap.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "Calls go to" }), svcSel)));
		setWrap.appendChild(el("div", { class: "toolbar" },
			el("label", { class: "chkline" }, enChk, document.createTextNode(" Answer the Dreamcast")),
			el("label", { class: "chkline" }, toneChk, document.createTextNode(" Dial tone")),
			el("label", { class: "chkline" }, nowChk, document.createTextNode(" Dreamcast Now")),
			el("label", { class: "chkline" }, dmzChk, document.createTextNode(" DMZ"))));
		setWrap.appendChild(el("div", { class: "toolbar" }, btn("Save", { primary: true, onclick: save }), saveStatus));
		setWrap.appendChild(el("p", { class: "descr", text:
			"Dial *69 before the number to send one call to DCNet. Turn the dial tone off only for a Dreamcast set to blind dial. " +
			"Dreamcast Now lists what you play on dreamcast.online/now; during PPP calls it sends a hash of this router's MAC address " +
			"and of the game server names the Dreamcast looks up." }));
		setWrap.appendChild(dmzNote);
		setPanel.appendChild(setWrap);

		var nowPanel = panel("Dreamcast Now");
		nowPanel.style.marginTop = "14px";
		var nowLine = el("div", { class: "status", text: "Loading…" });
		var nameIn = el("input", { class: "inp", type: "text", maxlength: "40", placeholder: "your name on the list" });
		var nameStatus = el("span", { class: "status" });
		var asIn = el("input", { class: "inp", type: "text", placeholder: "B8:27:EB:12:34:56, or the 64-digit id" });
		var asStatus = el("span", { class: "status" });
		var host = location.hostname || "the Slate";
		nowPanel.appendChild(nowLine);
		nowPanel.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "Name" }), nameIn)));
		nowPanel.appendChild(el("div", { class: "toolbar" }, btn("Set name", { primary: true, onclick: setName }), nameStatus));
		nowPanel.appendChild(el("p", { class: "descr", text:
			"During PPP calls the Slate reports to Dreamcast Now as a DreamPi does, and the site works out the game from the " +
			"servers the Dreamcast looks up. The name is public there, and one name belongs to one Dreamcast; until one is set, " +
			"the site shows \"Unnamed_\" and an id." }));
		nowPanel.appendChild(el("h4", { class: "sub-h2", text: "Report as your DreamPi" }));
		nowPanel.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "DreamPi's MAC address or id" }), asIn)));
		nowPanel.appendChild(el("div", { class: "toolbar" }, btn("Use", { onclick: setAs }),
			btn("Back to this router's own", { cls: "reset", onclick: function () { asIn.value = ""; setAs(); } }), asStatus));
		nowPanel.appendChild(el("p", { class: "descr", text:
			"To carry on as the DreamPi you had (its name, picture and history), give its MAC address, or the id " +
			"dreamcast.online/now/configure/ shows for it while it's on your network." }));
		nowPanel.appendChild(el("p", { class: "descr", text:
			"The site's own configure page works with the Slate too, as with a DreamPi: open " +
			"dreamcast.online/now/configure/ on a computer on the Slate's network. It looks for dreampi.local; if your browser " +
			"doesn't find it, enter " + host + ". Browsers may ask before letting a website reach a device on your network." }));

		var howPanel = panel("Connecting the Dreamcast");
		howPanel.style.marginTop = "14px";
		howPanel.appendChild(el("p", { class: "descr", text:
			"Dreamcast modem → line voltage inducer → USB voice modem (a DreamPi's: Conexant RD02-D400 / Dell NW147, Zoom 3095, …) → " +
			"the Slate's USB port, through a hub if an SDR is plugged in too. The Slate plays the dial tone and answers; no phone line is involved." }));
		howPanel.appendChild(el("p", { class: "descr", text:
			"On the Dreamcast, set up the ISP as for a DreamPi: any phone number, any user name and password, DNS automatic. " +
			"DCNet works with DCNet-patched games." }));

		var logPanel = panel("Recent log");
		logPanel.style.marginTop = "14px";
		var logPre = el("pre", { class: "raw-pre", text: "Loading…" });
		logPanel.appendChild(el("div", { class: "toolbar" }, btn("Refresh", { onclick: refresh })));
		logPanel.appendChild(logPre);

		VIEW.appendChild(stPanel); VIEW.appendChild(setPanel); VIEW.appendChild(nowPanel);
		VIEW.appendChild(howPanel); VIEW.appendChild(logPanel);

		function kv(pairs) {
			var dl = el("dl", { class: "kv" });
			pairs.forEach(function (p) {
				if (p[1] == null || p[1] === "") return;
				dl.appendChild(el("dt", { text: p[0] }));
				dl.appendChild(el("dd", { text: String(p[1]) }));
			});
			return dl;
		}
		function showStatus(s) {
			clear(stWrap);
			if (!s.installed) { stWrap.appendChild(el("div", { class: "muted", text: "DreamPi is not installed in this image." })); return; }
			var st = DP_STATES[s.state] || [s.state, "sec-neutral", ""];
			var m = (s.modems || [])[0];
			var inCall = s.state === "answering" || s.state === "connected";
			stWrap.appendChild(el("div", { class: "toolbar" }, badge(st[0], st[1]), el("span", { class: "status", text: st[2] })));
			stWrap.appendChild(kv([
				["Modem", m ? m.name + " — on " + devLabel(m.device) + " (" + m.id + ")" : "none plugged in"],
				["Call", inCall ? (s.number || "?") + " · " + (DP_SERVICES[s.call_service] || s.call_service) +
					(s.since ? " · " + dur(Date.now() / 1000 - s.since) : "") : null],
				// rx on the router's end of the link is what the Dreamcast sent
				["PPP link", s.link ? s.dreamcast_ip + " ⇄ " + s.local_ip + " · " + size(s.rx_bytes) + " up, " +
					size(s.tx_bytes) + " down" : null],
				["Last lookup", s.link ? s.lookup : null],
				["Calls go to", DP_SERVICES[s.service] || s.service]
			]));
			showListing(s.dcnow_name, s.dcnow, s.dcnow_id, s.dcnow_as_dreampi);
			// The form follows the saved settings until it is shown
			if (setWrap.hidden) {
				svcSel.value = s.service;
				enChk.checked = !!s.enabled; toneChk.checked = !!s.dial_tone; nowChk.checked = !!s.dcnow;
				dmzChk.checked = !!s.dmz;
				setWrap.hidden = false;
			}
			dmzNote.textContent = "DMZ, which DreamPi's guides advise for games that take incoming connections: everything that " +
				"comes in from the internet unasked goes to the Dreamcast, none of it to the Slate. If the Slate is behind another " +
				"router, make " + (s.wan_ip ? "the Slate (" + s.wan_ip + " there)" : "the Slate") + " that router's DMZ host too.";
		}
		function showLog(r) {
			var lines = (r && r.lines) || [];
			logPre.textContent = lines.length ? lines.join("\n") : "Nothing logged yet.";
		}
		// The name as the site has it, once fetched; until then the last one set here
		var siteName = null;
		var listedId = "";
		function showListing(name, on, id, asPi) {
			if (siteName) name = siteName;
			if (id) listedId = id;
			clear(nowLine);
			if (!name) { nowLine.textContent = "Loading…"; return; }
			nowLine.appendChild(document.createTextNode((on === false ? "Reporting is off. " : "") + "Listed as "));
			nowLine.appendChild(el("strong", { text: name }));
			nowLine.appendChild(document.createTextNode(" on "));
			nowLine.appendChild(el("a", { href: "https://dreamcast.online/now/", target: "_blank", rel: "noopener", text: "dreamcast.online/now" }));
			if (listedId) nowLine.appendChild(document.createTextNode(" (id " + listedId.slice(0, 6) + "…" +
				(asPi ? ", as your DreamPi" : "") + ")"));
			if (!nameIn.value) nameIn.value = /^Unnamed_/.test(name) ? "" : name;
		}
		function setAs() {
			asStatus.className = "status"; asStatus.textContent = "switching…";
			call("pirate.dreampi", "dcnow_id", { id: asIn.value.trim() }).then(function (r) {
				if (r.error && !r.id) { asStatus.className = "status err"; asStatus.textContent = r.error; return; }
				siteName = r.name || null; listedId = r.id || ""; nameIn.value = "";
				asStatus.className = "status ok-text";
				asStatus.textContent = r.name ? "now listed as " + r.name : "switched; " + (r.error || "");
				status();
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				asStatus.className = "status err"; asStatus.textContent = String(e.message || e);
			});
		}
		function setName() {
			nameStatus.className = "status"; nameStatus.textContent = "setting…";
			call("pirate.dreampi", "dcnow_name", { name: nameIn.value.trim() }).then(function (r) {
				if (r.error) { nameStatus.className = "status err"; nameStatus.textContent = r.error; return; }
				siteName = r.name;
				nameStatus.className = "status ok-text"; nameStatus.textContent = "listed as " + r.name;
				status();
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				nameStatus.className = "status err"; nameStatus.textContent = String(e.message || e);
			});
		}
		function status() {
			return call("pirate.dreampi", "status").then(showStatus).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				clear(stWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}
		function refresh() {
			status();
			call("pirate.dreampi", "log").then(showLog).catch(function (e) { logPre.textContent = String(e.message || e); });
		}
		function save() {
			saveStatus.className = "status"; saveStatus.textContent = "saving…";
			call("pirate.dreampi", "set", { enabled: enChk.checked, service: svcSel.value,
				dial_tone: toneChk.checked, dcnow: nowChk.checked, dmz: dmzChk.checked }).then(function (r) {
				if (r.error) { saveStatus.className = "status err"; saveStatus.textContent = r.error; return; }
				saveStatus.className = "status ok-text"; saveStatus.textContent = "saved";
				showStatus(r);
			}).catch(function (e) {
				if (String(e.message || e) === "unauthorized") return onError(e);
				saveStatus.className = "status err"; saveStatus.textContent = String(e.message || e);
			});
		}

		// The state changes as the Dreamcast calls: keep it current while
		// this page is open.
		if (DP_TIMER) clearInterval(DP_TIMER);
		DP_TIMER = setInterval(function () {
			if (current !== "dreampi") { clearInterval(DP_TIMER); DP_TIMER = null; return; }
			status();
		}, 5000);
		refresh();
		// The site's current name, which may have been set elsewhere
		call("pirate.dreampi", "dcnow").then(function (r) {
			if (r.name) { siteName = r.name; nameIn.value = ""; showListing(r.name, null, r.id); }
		}).catch(function () {});
	}

	/* ---------- Drives (USB flash drives and disks) ---------- */

	var USB_TIMER = null;

	function renderDrives() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Drives", "USB flash drives and disks, shared while plugged in; the microSD card too, if you choose"));

		var drPanel = panel("Plugged in");
		var drWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		drPanel.appendChild(drWrap);

		// The file browser, for the drive being browsed
		var fbPanel = panel(null);
		fbPanel.style.marginTop = "14px";
		fbPanel.hidden = true;
		var fbHead = el("h3", { class: "sub-h" });
		var fbCrumbs = el("div", { class: "crumbs" });
		var fbWrap = el("div");
		fbPanel.appendChild(fbHead); fbPanel.appendChild(fbCrumbs); fbPanel.appendChild(fbWrap);

		var shPanel = panel("Network share");
		shPanel.style.marginTop = "14px";
		var shState = el("div", { class: "toolbar" });
		var shAccess = el("p", { class: "descr" });
		var enChk = el("input", { type: "checkbox" });
		var cardChk = el("input", { type: "checkbox" });
		var enStatus = el("span", { class: "status" });
		var enLine = el("label", { class: "chkline" }, enChk, document.createTextNode(" Share the drives on the network (SMB)"));
		var cardNote = el("p", { class: "descr" });
		var pw1 = el("input", { class: "inp", type: "password", autocomplete: "new-password", placeholder: "at least 5 characters" });
		var pw2 = el("input", { class: "inp", type: "password", autocomplete: "new-password", placeholder: "again" });
		var pwStatus = el("span", { class: "status" });
		var pwClear = btn("Remove the password", { cls: "reset", onclick: function () { setPassword(""); } });
		var shOpts = el("div", {},
			el("div", { class: "toolbar" }, enLine,
				el("label", { class: "chkline" }, cardChk, document.createTextNode(" Share the microSD card too")),
				btn("Save", { onclick: saveEnabled }), enStatus),
			cardNote);
		var shForm = el("div", { hidden: "" });
		shForm.appendChild(el("h4", { class: "sub-h2", text: "Share password" }));
		shForm.appendChild(shAccess);
		shForm.appendChild(el("div", { class: "form" },
			el("label", {}, el("span", { class: "lbl", text: "New password" }), pw1),
			el("label", {}, el("span", { class: "lbl", text: "Retype it" }), pw2)));
		shForm.appendChild(el("div", { class: "toolbar" },
			btn("Set password", { primary: true, onclick: function () { setPassword(null); } }), pwClear, pwStatus));
		var shMissing = el("div", { class: "muted", hidden: "", text:
			"This firmware has no SMB server (ksmbd): drives show here, but not on the network." });
		shPanel.appendChild(shState); shPanel.appendChild(shOpts); shPanel.appendChild(shForm); shPanel.appendChild(shMissing);

		var howPanel = panel("Connecting");
		howPanel.style.marginTop = "14px";
		var howWrap = el("div");
		howPanel.appendChild(howWrap);

		VIEW.appendChild(drPanel); VIEW.appendChild(fbPanel); VIEW.appendChild(shPanel); VIEW.appendChild(howPanel);

		var last = null;          // the last status
		var browsing = null;      // { name, path } of the folder on show
		var formSet = false;
		var webHost = location.hostname || "192.168.1.1";

		function smbHost(s) { return String(s.host || "pirateradio").toLowerCase() + ".local"; }
		function fileUrl(port, name, path) {
			var parts = [name].concat(path ? path.split("/") : []);
			return "http://" + webHost + ":" + port + "/" + parts.map(encodeURIComponent).join("/");
		}
		function failed(e) {
			if (String(e.message || e) === "unauthorized") { onError(e); return true; }
			return false;
		}

		function meter(used, total) {
			var pct = total ? Math.min(100, Math.round(used * 100 / total)) : 0;
			var m = el("div", { class: "meter" + (pct >= 90 ? " full" : "") });
			var fill = el("span");
			fill.style.width = pct + "%";
			m.appendChild(fill);
			return m;
		}
		function driveCard(d, s) {
			var card = el("div", { class: "drive" });
			var head = el("div", { class: "drive-head" },
				el("strong", { text: d.name }),
				d.card ? badge("microSD", "sec-ok") : null,
				badge(d.fs || "?", "sec-neutral"),
				d.readonly ? badge("read-only", "sec-warn") : null,
				el("span", { class: "muted", text: d.model || "" }));
			card.appendChild(head);
			card.appendChild(meter(d.used, d.size));
			card.appendChild(el("div", { class: "status", text:
				gb(d.free) + " free of " + gb(d.size) + " · " + (d.card ? "the microSD slot" : "the USB port") + " (" + d.device + ")" }));
			var pairs = [];
			if (s.installed && s.enabled) {
				pairs.push(["Windows", "\\\\" + smbHost(s) + "\\" + d.name]);
				pairs.push(["macOS, Linux", "smb://" + smbHost(s) + "/" + d.name]);
			}
			if (pairs.length) {
				var dl = el("dl", { class: "kv" });
				pairs.forEach(function (p) { dl.appendChild(el("dt", { text: p[0] })); dl.appendChild(el("dd", { text: p[1] })); });
				card.appendChild(dl);
			}
			var ejStatus = el("span", { class: "status" });
			card.appendChild(el("div", { class: "toolbar drive-actions" },
				btn("Browse", { primary: true, onclick: function () { browse(d.name, ""); } }),
				el("a", { class: "btn", href: fileUrl(s.http_port || 8082, d.name, "") + "/", target: "_blank", rel: "noopener",
					text: "Open in a new tab" }),
				// The card stays in: "Share the microSD card too" takes it off the list
				d.card ? null : btn("Eject", { onclick: function () { eject(d, ejStatus); } }),
				ejStatus));
			return card;
		}
		var shown = "";
		function showStatus(s) {
			// Polled every few seconds: redraw only when something changed
			var key = JSON.stringify(s);
			if (key === shown) return;
			shown = key;
			last = s;
			var drives = s.drives || [];
			clear(drWrap);
			if (!drives.length) {
				drWrap.appendChild(el("div", { class: "placeholder" },
					el("b", { text: "No drive plugged in" }),
					el("div", { class: "muted", text: "Plug a USB flash drive or disk into the router's USB port (through a hub " +
						"if something else is plugged in). It shows up here, and on the network, within a few seconds." })));
			} else {
				drives.forEach(function (d) { drWrap.appendChild(driveCard(d, s)); });
				drWrap.appendChild(el("p", { class: "descr", text:
					"Eject a drive before pulling it out: it is written to as you use it. FAT32, exFAT, NTFS and ext4 work." +
					(drives.some(function (d) { return d.card; }) ? " The microSD card can't be ejected here: turn off sharing it first." : "") }));
			}
			// The drive being browsed went away
			if (browsing && !drives.some(function (d) { return d.name === browsing.name; })) {
				browsing = null; fbPanel.hidden = true;
			}

			clear(shState);
			shMissing.hidden = !!s.installed;
			shForm.hidden = !s.installed;
			enLine.hidden = !s.installed;
			// The checkboxes follow the saved settings until they are first shown
			if (!formSet) { enChk.checked = !!s.enabled; cardChk.checked = !!s.card; formSet = true; }
			cardNote.textContent = "The microSD card holds Pirate Radio's recordings and captures, Wi-Fi handshakes " +
				"included: share it only with a password set, or on a network you trust. Shared, it shows here as " +
				"microSD, alongside the drives." + (s.card && !s.card_in ? " No card is in the slot right now." : "");
			if (s.installed) {
				var st = !s.enabled ? ["off", "sec-neutral", "Sharing is turned off; the drives show only here."] :
					s.sharing ? ["sharing", "sec-ok", "On the network as " + smbHost(s) + "."] :
					["idle", "sec-neutral", "Starts when a drive is plugged in."];
				shState.appendChild(badge(st[0], st[1]));
				shState.appendChild(el("span", { class: "status", text: st[2] }));
				shAccess.textContent = s.password ?
					"Password-protected: sign in as \"" + s.user + "\" with the share password. Set a new one below, " +
					"or remove it to let anyone on the network in." :
					"No password: anyone on the router's network can read and write the drives. Windows 11 refuses " +
					"to connect without one: set a password, and sign in as \"" + s.user + "\" with it.";
				pwClear.hidden = !s.password;
			}

			clear(howWrap);
			var h = smbHost(s);
			howWrap.appendChild(el("p", { class: "descr", text:
				"Windows: in File Explorer's address bar, type \\\\" + h + " (the router also appears under Network). " +
				"macOS: Finder → Go → Connect to Server → smb://" + h + ". Android and iOS: a file manager's " +
				"\"connect to server\" (SMB) with " + h + "." }));
			howWrap.appendChild(el("p", { class: "descr", text:
				"\"Open in a new tab\" and the files below open from the router (port " + (s.http_port || 8082) + "), " +
				"which asks for the router's sign-in: root and its password. Only the router's own network reaches the " +
				"drives; nothing is shared to the internet." }));
		}

		function crumbsFor(name, path) {
			clear(fbCrumbs);
			var parts = path ? path.split("/") : [];
			var link = function (label, p) {
				return el("button", { type: "button", class: "linkbtn", text: label, onclick: function () { browse(name, p); } });
			};
			fbCrumbs.appendChild(link(name, ""));
			parts.forEach(function (seg, i) {
				fbCrumbs.appendChild(el("span", { class: "muted", text: " / " }));
				var p = parts.slice(0, i + 1).join("/");
				fbCrumbs.appendChild(i === parts.length - 1 ? el("span", { text: seg }) : link(seg, p));
			});
		}
		function when(t) {
			if (!t) return "";
			var d = new Date(t * 1000);
			function two(n) { return (n < 10 ? "0" : "") + n; }
			return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) + " " + two(d.getHours()) + ":" + two(d.getMinutes());
		}
		function browse(name, path) {
			browsing = { name: name, path: path };
			fbPanel.hidden = false;
			fbHead.textContent = "Files on " + name;
			crumbsFor(name, path);
			clear(fbWrap).appendChild(el("div", { class: "muted", text: "Loading…" }));
			call("pirate.usb", "list", { name: name, path: path }).then(function (r) {
				if (!browsing || browsing.name !== name || browsing.path !== path) return;
				if (r.error) { clear(fbWrap).appendChild(alertEl("warn", r.error)); return; }
				var list = r.entries || [];
				var port = (last && last.http_port) || 8082;
				clear(fbWrap);
				if (!list.length) { fbWrap.appendChild(el("div", { class: "placeholder", text: "This folder is empty." })); return; }
				var rows = [];
				if (r.path) {
					var up = r.path.split("/").slice(0, -1).join("/");
					rows.push([el("button", { type: "button", class: "linkbtn", text: "↑ up", onclick: function () { browse(name, up); } }), "", ""]);
				}
				list.forEach(function (f) {
					var p = r.path ? r.path + "/" + f.name : f.name;
					rows.push([
						f.dir ? el("button", { type: "button", class: "linkbtn", text: f.name + "/", onclick: function () { browse(name, p); } })
							: el("a", { href: fileUrl(port, name, p), target: "_blank", rel: "noopener", text: f.name }),
						f.dir ? "" : size(f.size),
						when(f.mtime)
					]);
				});
				fbWrap.appendChild(tableEl(["Name", "Size", "Modified"], rows));
				if (r.truncated) fbWrap.appendChild(el("p", { class: "descr", text:
					"Showing the first " + list.length + " of " + r.total + " entries; open the folder in a new tab, or over the network, for all of them." }));
			}).catch(function (e) {
				if (failed(e)) return;
				clear(fbWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}

		function eject(d, line) {
			if (!window.confirm("Eject " + d.name + "? It stops being shared and is safe to pull out; plug it in again to use it.")) return;
			line.className = "status"; line.textContent = "ejecting…";
			call("pirate.usb", "eject", { name: d.name }).then(function (r) {
				if (r.error) { line.className = "status err"; line.textContent = r.error; return; }
				line.className = "status ok-text"; line.textContent = "ejected: safe to pull out";
				if (browsing && browsing.name === d.name) { browsing = null; fbPanel.hidden = true; }
				setTimeout(status, 800);
			}).catch(function (e) {
				if (failed(e)) return;
				line.className = "status err"; line.textContent = String(e.message || e);
			});
		}
		function saveEnabled() {
			enStatus.className = "status"; enStatus.textContent = "saving…";
			call("pirate.usb", "set", { enabled: enChk.checked, card: cardChk.checked }).then(function (r) {
				if (r.error) { enStatus.className = "status err"; enStatus.textContent = r.error; return; }
				enStatus.className = "status ok-text"; enStatus.textContent = "saved";
				showStatus(r);
			}).catch(function (e) {
				if (failed(e)) return;
				enStatus.className = "status err"; enStatus.textContent = String(e.message || e);
			});
		}
		// pw: null takes the form's; "" removes the password
		function setPassword(pw) {
			var bad = function (msg) { pwStatus.className = "status err"; pwStatus.textContent = msg; };
			if (pw === null) {
				if (pw1.value.length < 5) return bad("use at least 5 characters");
				if (pw1.value !== pw2.value) return bad("the two entries differ");
				pw = pw1.value;
			} else if (!window.confirm("Remove the share password? Anyone on the network can then read and write the drives.")) {
				return;
			}
			pwStatus.className = "status"; pwStatus.textContent = "saving…";
			call("pirate.usb", "set_password", { password: pw }).then(function (r) {
				if (r.error) return bad(r.error);
				pw1.value = ""; pw2.value = "";
				pwStatus.className = "status ok-text";
				pwStatus.textContent = r.password ? "password set" : "password removed";
				showStatus(r);
			}).catch(function (e) {
				if (failed(e)) return;
				bad(String(e.message || e));
			});
		}
		function status() {
			return call("pirate.usb", "status").then(showStatus).catch(function (e) {
				if (failed(e)) return;
				clear(drWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}

		// Drives come and go as they're plugged in and pulled out: keep the
		// page current while it is open.
		if (USB_TIMER) clearInterval(USB_TIMER);
		USB_TIMER = setInterval(function () {
			if (current !== "drives") { clearInterval(USB_TIMER); USB_TIMER = null; return; }
			status();
		}, 4000);
		status();
	}

	/* ---------- Phone (an Android phone on the USB port; pirate.phone) ---------- */

	var PH_TIMER = null;
	// The phone's USB modes, in menu order: [id, label, set_mode arg, status.mode values it matches]
	var PH_MODES = [
		["charge", "No data", "charge", ["charge", "unknown"]],
		["mtp", "File transfer", "mtp", ["mtp", "file"]],
		["ptp", "Photos (PTP)", "ptp", ["ptp"]],
		["tether", "Tethering", "tether", ["tether"]],
		["midi", "MIDI", "midi", ["midi"]],
		["webcam", "Webcam", "webcam", ["webcam"]]
	];

	function renderPhone() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Phone", "an Android phone on the USB port — switch and use its USB modes"));

		var idPanel = panel("Phone");
		var idWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		idPanel.appendChild(idWrap);

		var modePanel = panel("USB mode");
		var modeRow = el("div", { class: "toolbar mode-row" });
		var modeStatus = el("span", { class: "status" });
		var modeNote = el("p", { class: "descr" });
		modePanel.appendChild(modeRow); modePanel.appendChild(modeStatus); modePanel.appendChild(modeNote);

		var usePanel = panel(null);
		usePanel.style.marginTop = "14px";

		VIEW.appendChild(idPanel); VIEW.appendChild(modePanel); VIEW.appendChild(usePanel);

		var shownKey = "", lastMode = "\x00", fbPath = "/sdcard";

		function say(line, text, kind) {
			line.className = "status" + (kind === "err" ? " err" : kind === "ok" ? " ok-text" : "");
			line.textContent = text || "";
		}
		function failed(e) { if (String(e.message || e) === "unauthorized") { onError(e); return true; } return false; }
		function modeLabel(mode) {
			for (var i = 0; i < PH_MODES.length; i++) if (PH_MODES[i][3].indexOf(mode) >= 0) return PH_MODES[i][1];
			return mode || "unknown";
		}

		function status() {
			return call("pirate.phone", "status").then(show).catch(function (e) {
				if (failed(e)) return;
				var msg = String(e.message || e);
				if (msg === "ubus status 4") msg = "The Phone backend (pirate.phone) isn't on this router yet — update the UI package.";
				clear(idWrap).appendChild(alertEl("warn", msg));
			});
		}

		function show(s) {
			var key = JSON.stringify(s);
			if (key !== shownKey) { shownKey = key; renderId(s); renderModeRow(s); }
			if (s.mode !== lastMode) { lastMode = s.mode; renderUse(s); }
		}

		function renderId(s) {
			clear(idWrap);
			if (!s.present) {
				idWrap.appendChild(alertEl("info", "No phone on the USB port. Plug an Android phone into the Slate."));
				idWrap.appendChild(el("p", { class: "descr", text:
					"Then pick a USB mode on the phone (File transfer, Tethering, MIDI, PTP or Webcam) and the router recognises and sets it up here." }));
				return;
			}
			idWrap.appendChild(el("div", { class: "drive-head" },
				el("strong", { text: s.model || ((s.vendor || "Phone") + " device") }),
				badge(modeLabel(s.mode), "sec-ok"),
				s.android ? badge("Android " + s.android, "sec-neutral") : null,
				typeof s.battery === "number" ? badge(s.battery + "%", s.battery < 20 ? "sec-warn" : "sec-neutral") : null));
			idWrap.appendChild(el("p", { class: "descr", text:
				"Switch the USB mode on the phone itself (swipe down the USB notification, or Settings → Connected devices → USB). The router recognises each mode and sets it up here — no USB debugging needed." }));
		}

		function renderModeRow(s) {
			clear(modeRow);
			PH_MODES.forEach(function (m) {
				var on = m[3].indexOf(s.mode) >= 0;
				var chip = el("span", { class: "mode-chip" + (on ? " on" : ""), text: m[1] });
				if (DEMO) { chip.style.cursor = "pointer"; chip.onclick = function () { demoSwitch(m[2]); }; }
				modeRow.appendChild(chip);
			});
			modeStatus.textContent = "";
			modeNote.textContent = !s.present ? ""
				: "The highlighted mode is what the phone is in now. Change it on the phone (swipe down the USB notification → pick a mode) and the router follows within a few seconds.";
		}

		function demoSwitch(fn) {
			call("pirate.phone", "set_mode", { mode: fn }).then(function (s) { lastMode = "\x00"; show(s); });
		}

		function renderUse(s) {
			clear(usePanel);
			if (!s.present) return;
			var mode = s.mode;
			if (mode === "mtp" || mode === "ptp" || mode === "file") return renderFiles(s);
			if (mode === "tether") return renderTether(s);
			if (mode === "webcam") return renderWebcam(s);
			if (mode === "midi") return renderMidi(s);
			usePanel.appendChild(el("h3", { class: "sub-h", text: "Charging only" }));
			usePanel.appendChild(el("p", { class: "descr", text: "The data lines are idle. On the phone, switch to File transfer, Tethering, MIDI, PTP or Webcam and it becomes usable here." }));
		}

		/* ---- files (over adb) ---- */
		function renderFiles(s) {
			usePanel.appendChild(el("h3", { class: "sub-h", text: (s.mode === "ptp" ? "Photos" : "Files") + " on the phone" }));
			usePanel.appendChild(el("p", { class: "descr", text:
				"In " + (s.mode === "ptp" ? "PTP" : "file transfer") + " mode the phone's storage is reachable only over USB debugging. Browsing is optional — start it and the phone shows one Allow dialog." }));
			if (s.adb_installed === false) { usePanel.appendChild(alertEl("info", "adb isn't installed on this router, so file browsing isn't available.")); return; }
			var crumbs = el("div", { class: "crumbs" });
			var listWrap = el("div", {});
			var fstatus = el("span", { class: "status" });
			var startBtn = btn("Browse files over USB debugging", { onclick: function () {
				startBtn.disabled = true;
				loadDir(fbPath && fbPath.indexOf("/sdcard") === 0 ? fbPath : "/sdcard", crumbs, listWrap, fstatus);
			} });
			usePanel.appendChild(el("div", { class: "toolbar" }, startBtn, fstatus));
			usePanel.appendChild(crumbs); usePanel.appendChild(listWrap);
		}
		function crumbLink(label, path, c, l, f) {
			return el("a", { href: "#", class: "lnk", text: label, onclick: function (ev) { ev.preventDefault(); loadDir(path, c, l, f); } });
		}
		function loadDir(path, crumbs, listWrap, fstatus) {
			fbPath = path;
			clear(crumbs).appendChild(crumbLink("phone", "/sdcard", crumbs, listWrap, fstatus));
			var rel = path.replace(/^\/sdcard\/?/, ""), p = "/sdcard";
			if (rel) rel.split("/").forEach(function (seg) { p += "/" + seg; crumbs.appendChild(document.createTextNode(" / ")); crumbs.appendChild(crumbLink(seg, p, crumbs, listWrap, fstatus)); });
			clear(listWrap).appendChild(el("div", { class: "muted", text: "Loading…" }));
			call("pirate.phone", "files", { path: path }).then(function (r) {
				if (r.error) { clear(listWrap).appendChild(alertEl("warn", r.error)); return; }
				var ents = (r.entries || []).slice().sort(function (x, y) {
					if (x.dir !== y.dir) return x.dir ? -1 : 1;
					return x.name.toLowerCase() < y.name.toLowerCase() ? -1 : 1;
				});
				var rows = ents.map(function (e) {
					var base = path.replace(/\/$/, "") + "/" + e.name;
					var nameCell = e.dir
						? el("a", { href: "#", class: "lnk", text: e.name + "/", onclick: function (ev) { ev.preventDefault(); loadDir(base, crumbs, listWrap, fstatus); } })
						: el("span", { text: e.name });
					return [nameCell, e.dir ? "" : gb(e.size),
						e.dir ? "" : btn("Download", { cls: "small", onclick: function () { pull(base, e.name, fstatus); } })];
				});
				clear(listWrap).appendChild(rows.length ? tableEl(["Name", "Size", ""], rows) : el("div", { class: "muted", text: "empty" }));
				if (r.truncated) listWrap.appendChild(el("div", { class: "muted", text: "Showing the first " + (r.count || rows.length) + " — open a subfolder to narrow it down." }));
			}).catch(function (e) { if (!failed(e)) clear(listWrap).appendChild(alertEl("warn", String(e.message || e))); });
		}
		function pull(path, name, fstatus) {
			say(fstatus, "downloading " + name + "…");
			call("pirate.phone", "pull", { path: path }).then(function (r) {
				if (r.error || !r.ok) return say(fstatus, r.error || "couldn't read that file", "err");
				var a = el("a", { href: r.url, download: r.name || name });
				document.body.appendChild(a); a.click(); document.body.removeChild(a);
				say(fstatus, "downloaded " + (r.name || name) + " (" + gb(r.size) + ")", "ok");
			}).catch(function (e) { if (!failed(e)) say(fstatus, String(e.message || e), "err"); });
		}

		/* ---- tethering ---- */
		function renderTether(s) {
			usePanel.appendChild(el("h3", { class: "sub-h", text: "USB tethering" }));
			if (!s.supports || !s.supports.tether) {
				usePanel.appendChild(alertEl("warn", "The phone is tethering, but this firmware can't use it yet. Reflash with the updated image (it adds kmod-usb-net-cdc-ncm) and this becomes a one-tap uplink."));
				return;
			}
			var tstatus = el("span", { class: "status" }), t = s.tether || {};
			if (t.up) {
				usePanel.appendChild(el("p", { class: "descr", text: "The router is using the phone's internet (" + (t.iface || "") + (t.wan_ip ? ", " + t.wan_ip : "") + ")." }));
				usePanel.appendChild(el("div", { class: "toolbar" }, btn("Stop using it", { cls: "reset", onclick: function () { tether("down", tstatus); } }), tstatus));
			} else {
				usePanel.appendChild(el("p", { class: "descr", text: "Route the router's traffic out through the phone's connection." }));
				usePanel.appendChild(el("div", { class: "toolbar" }, btn("Use the phone's internet", { primary: true, onclick: function () { tether("up", tstatus); } }), tstatus));
			}
		}
		function tether(act, tstatus) {
			say(tstatus, act === "up" ? "bringing the uplink up…" : "stopping…");
			call("pirate.phone", "tether", { action: act }).then(function (s) {
				if (s.error) return say(tstatus, s.error, "err");
				lastMode = "\x00"; show(s);
			}).catch(function (e) { if (!failed(e)) say(tstatus, String(e.message || e), "err"); });
		}

		/* ---- webcam ---- */
		function renderWebcam(s) {
			usePanel.appendChild(el("h3", { class: "sub-h", text: "Webcam" }));
			if (!s.supports || !s.supports.webcam) {
				usePanel.appendChild(alertEl("warn", "The phone is in webcam mode, but this firmware can't use it yet. Reflash with the updated image (kmod-video-uvc + ustreamer) to stream it here."));
				return;
			}
			var wstatus = el("span", { class: "status" });
			var w = s.webcam_stream || {}, host = location.hostname || "pirateradio.local";
			usePanel.appendChild(el("div", { class: "toolbar" },
				w.running ? btn("Stop", { cls: "reset", onclick: function () { webcam("stop", wstatus); } })
						: btn("Start the stream", { primary: true, onclick: function () { webcam("start", wstatus); } }),
				wstatus));
			if (w.running) usePanel.appendChild(el("div", { class: "cam-wrap" },
				el("img", { class: "cam", src: "http://" + host + ":" + (w.port || 8081) + "/stream", alt: "phone camera" })));
		}
		function webcam(act, wstatus) {
			say(wstatus, act === "start" ? "starting the stream…" : "stopping…");
			call("pirate.phone", "webcam", { action: act }).then(function (r) {
				if (r.error) return say(wstatus, r.error, "err");
				lastMode = "\x00"; status();
			}).catch(function (e) { if (!failed(e)) say(wstatus, String(e.message || e), "err"); });
		}

		/* ---- MIDI ---- */
		function renderMidi(s) {
			usePanel.appendChild(el("h3", { class: "sub-h", text: "MIDI" }));
			if (!s.supports || !s.supports.midi) {
				usePanel.appendChild(alertEl("warn", "The phone is in MIDI mode, but this firmware has no USB-audio driver yet. Reflash with the updated image (kmod-usb-audio) to see the MIDI port."));
				return;
			}
			var wrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
			usePanel.appendChild(wrap);
			call("pirate.phone", "midi").then(function (r) {
				clear(wrap);
				var ports = r.ports || [];
				wrap.appendChild(ports.length ? tableEl(["MIDI port"], ports.map(function (p) { return [p.name]; }))
					: el("div", { class: "muted", text: r.note || "no MIDI port" }));
			}).catch(function (e) { if (!failed(e)) clear(wrap).appendChild(alertEl("warn", String(e.message || e))); });
		}

		if (PH_TIMER) clearInterval(PH_TIMER);
		PH_TIMER = setInterval(function () {
			if (current !== "phone") { clearInterval(PH_TIMER); PH_TIMER = null; return; }
			status();
		}, 5000);
		status();
	}

	/* ---------- Flipper (a Flipper Zero on the USB port; pirate-flipper) ---------- */

	var FZ_TIMER = null, FZ_RUN = 0;
	var FZ_KEYBOARD = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
		Enter: "ok", " ": "ok", Backspace: "back", Escape: "back" };
	// The screen's backlight and its pixels
	var FZ_BG = [254, 138, 44], FZ_FG = [24, 14, 4];

	function renderFlipper() {
		clear(VIEW);
		VIEW.appendChild(viewHead("Flipper", "a Flipper Zero on the USB port: its screen and buttons, its files"));
		var run = ++FZ_RUN;   // this page's loops stop once it is left, or drawn again
		function alive() { return run === FZ_RUN && current === "flipper"; }
		function failed(e) {
			if (String(e.message || e) === "unauthorized") { onError(e); return true; }
			return false;
		}
		function say(line, text, kind) {
			line.className = "status" + (kind === "err" ? " err" : kind === "ok" ? " ok-text" : "");
			line.textContent = text;
		}

		/* The Flipper itself */
		var devPanel = panel("Flipper Zero");
		var devWrap = el("div", {}, el("div", { class: "muted", text: "Loading…" }));
		var actStatus = el("span", { class: "status" });
		var devActs = el("div", { class: "toolbar", hidden: "" },
			btn("Beep and blink", { onclick: findIt }),
			btn("Set its clock to this computer's", { onclick: setClock }),
			btn("Restart it", { onclick: restart }),
			btn("All details", { onclick: details }),
			actStatus);
		var detWrap = el("div", { hidden: "" });
		devPanel.appendChild(devWrap); devPanel.appendChild(devActs); devPanel.appendChild(detWrap);

		/* Its screen and buttons */
		var scrPanel = panel("Screen");
		scrPanel.style.marginTop = "14px";
		scrPanel.hidden = true;
		var canvas = el("canvas", { class: "fz-screen", width: "128", height: "64", tabindex: "0",
			"aria-label": "The Flipper's screen. With it selected, the arrow keys, Enter and Backspace press its buttons." });
		var g = canvas.getContext("2d");
		var img = g.createImageData(128, 64);
		var scrStatus = el("span", { class: "status", text: "waiting for the screen…" });
		var pad = el("div", { class: "fz-pad" });
		scrPanel.appendChild(el("div", { class: "fz-wrap" }, el("div", { class: "fz-lcd" }, canvas), pad));
		scrPanel.appendChild(el("div", { class: "toolbar" }, btn("Save a screenshot", { onclick: screenshot }), scrStatus));
		scrPanel.appendChild(el("p", { class: "descr", text:
			"Press the buttons here, or click the screen and use the arrow keys, Enter (OK) and Backspace or Esc (Back). " +
			"Hold a button for a long press." }));

		/* Its files */
		var fPanel = panel("Files");
		fPanel.style.marginTop = "14px";
		fPanel.hidden = true;
		var fStatus = el("span", { class: "status" });
		var upInput = el("input", { type: "file", multiple: "", hidden: "" });
		var upBtn = btn("Upload files", { primary: true, onclick: function () { upInput.click(); } });
		var mkBtn = btn("New folder", { onclick: newFolder });
		var fCrumbs = el("div", { class: "crumbs" });
		var fWrap = el("div");
		upInput.addEventListener("change", function () {
			var files = Array.prototype.slice.call(upInput.files || []);
			upInput.value = "";
			if (files.length) uploadAll(files);
		});
		fPanel.appendChild(el("div", { class: "toolbar" }, upBtn, mkBtn,
			btn("Refresh", { onclick: function () { browse(path); } }), fStatus, upInput));
		fPanel.appendChild(fCrumbs);
		fPanel.appendChild(fWrap);
		fPanel.appendChild(el("p", { class: "descr", text:
			"ext is the Flipper's SD card, int its own storage. File names are plain ASCII; downloads are 8 MB at most." }));

		VIEW.appendChild(devPanel); VIEW.appendChild(scrPanel); VIEW.appendChild(fPanel);

		var ready = false, shown = "", path = "/ext", listing = [];

		/* ---- status ---- */

		function showDevice(s) {
			var key = JSON.stringify(s);
			if (key === shown) return;
			shown = key;
			var was = ready;
			ready = s.state === "ready";
			scrPanel.hidden = fPanel.hidden = devActs.hidden = !ready;
			if (!ready) { detWrap.hidden = true; scrSeq = 0; }
			clear(devWrap);
			if (s.state === "missing") {
				devWrap.appendChild(alertEl("warn", s.error));
			} else if (s.state === "absent") {
				devWrap.appendChild(el("div", { class: "placeholder" },
					el("b", { text: "No Flipper plugged in" }),
					el("div", { class: "muted", text: "Plug a Flipper Zero into the router's USB port with a data cable " +
						"(through a hub if a drive is plugged in too). It shows up here within a few seconds. If it is " +
						"locked with a PIN, unlock it." })));
				if (s.error) devWrap.appendChild(alertEl("warn", s.error));
			} else if (s.state === "dfu") {
				devWrap.appendChild(alertEl("warn", "The Flipper is in DFU (recovery) mode: it has no screen or files to " +
					"show. Repair or update its firmware with qFlipper on a computer."));
			} else if (s.state === "connecting") {
				devWrap.appendChild(el("div", { class: "muted", text: "Connecting to the Flipper on " + (devLabel(s.device) || "the USB port") + "…" }));
				if (s.error) devWrap.appendChild(alertEl("warn", s.error));
			} else {
				var head = el("div", { class: "drive-head" },
					el("strong", { text: s.name || "Flipper" }),
					badge(s.model || "Flipper Zero", "sec-neutral"),
					s.firmware ? badge("firmware " + s.firmware, "sec-ok") : null,
					s.branch ? el("span", { class: "muted", text: s.branch }) : null);
				devWrap.appendChild(head);
				if (s.battery != null) {
					var m = el("div", { class: "meter" + (s.battery <= 15 ? " full" : "") }), fill = el("span");
					fill.style.width = Math.max(0, Math.min(100, s.battery)) + "%";
					m.appendChild(fill);
					devWrap.appendChild(m);
				}
				devWrap.appendChild(el("div", { class: "status", text:
					(s.battery != null ? "battery " + s.battery + "%" + (s.charging ? " · " + s.charging : "") : "battery unknown") +
					" · " + (s.sd ? "SD card: " + gb(s.sd_free) + " free of " + gb(s.sd_total) : "no SD card") }));
				var dl = el("dl", { class: "kv" });
				[["Port", devLabel(s.device)], ["Firmware built", s.build_date], ["Commit", s.commit], ["RPC protocol", s.protobuf]].forEach(function (p) {
					if (!p[1]) return;
					dl.appendChild(el("dt", { text: p[0] }));
					dl.appendChild(el("dd", { text: p[1] }));
				});
				devWrap.appendChild(dl);
			}
			// Plugged in: show its files
			if (ready && !was) browse(path);
		}
		function status() {
			return call("pirate.flipper", "status").then(showDevice).catch(function (e) {
				if (failed(e)) return;
				var msg = String(e.message || e);
				if (msg === "ubus status 4")
					msg = "The Flipper service (pirate-flipper) isn't running on this router: its firmware may predate the Flipper page.";
				showDevice({ state: "missing", error: msg });
			});
		}

		/* ---- actions ---- */

		function act(method, params, doing, done) {
			say(actStatus, doing);
			return call("pirate.flipper", method, params).then(function (r) {
				if (r.error) return say(actStatus, r.error, "err");
				say(actStatus, done, "ok");
			}).catch(function (e) { if (!failed(e)) say(actStatus, String(e.message || e), "err"); });
		}
		function findIt() { act("alert", {}, "beeping…", "it beeped and blinked"); }
		function setClock() {
			var d = new Date();
			act("time", { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(),
				minute: d.getMinutes(), second: d.getSeconds(), weekday: d.getDay() || 7 },
				"setting its clock…", "clock set to " + d.toLocaleString());
		}
		function restart() {
			if (!window.confirm("Restart the Flipper? It is back here in a few seconds.")) return;
			act("reboot", { mode: "os" }, "restarting…", "restarting: back in a few seconds");
		}
		function details() {
			if (!detWrap.hidden) { detWrap.hidden = true; return; }
			call("pirate.flipper", "info").then(function (r) {
				if (r.error) return say(actStatus, r.error, "err");
				var rows = [];
				[r.info || {}, r.power || {}].forEach(function (t) {
					Object.keys(t).sort().forEach(function (k) { rows.push([k.replace(/_/g, " "), String(t[k])]); });
				});
				clear(detWrap).appendChild(tableEl(["", ""], rows));
				detWrap.hidden = false;
			}).catch(function (e) { if (!failed(e)) say(actStatus, String(e.message || e), "err"); });
		}

		/* ---- the screen ---- */

		var scrSeq = 0, vertical = false;
		function draw(b64, orient) {
			var bin = atob(b64), vert = /^vertical/.test(orient || ""), cw = vert ? 64 : 128, x, y;
			if (vert !== vertical) {
				vertical = vert;
				canvas.width = cw; canvas.height = vert ? 128 : 64;
				canvas.classList.toggle("vert", vert);
				img = g.createImageData(canvas.width, canvas.height);
			}
			var d = img.data;
			for (y = 0; y < 64; y++) {
				for (x = 0; x < 128; x++) {
					var on = (bin.charCodeAt((y >> 3) * 128 + x) >> (y & 7)) & 1, nx = x, ny = y;
					if (orient === "horizontal_flip") { nx = 127 - x; ny = 63 - y; }
					else if (orient === "vertical") { nx = 63 - y; ny = x; }
					else if (orient === "vertical_flip") { nx = y; ny = 127 - x; }
					var i = (ny * cw + nx) * 4, c = on ? FZ_FG : FZ_BG;
					d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
				}
			}
			g.putImageData(img, 0, 0);
		}
		// One request out at a time: the router answers once the screen changes
		function screenLoop() {
			if (!alive()) return;
			if (!ready || document.hidden) { setTimeout(screenLoop, 1000); return; }
			call("pirate.flipper", "screen", { seq: scrSeq }).then(function (r) {
				if (!alive()) return;
				if (r.frame) {
					draw(r.frame, r.orientation);
					if (!scrSeq) say(scrStatus, "live", "ok");
					scrSeq = r.seq;
				}
				setTimeout(screenLoop, r.state !== "ready" ? 1500 : r.frame ? 0 : 150);
			}, function (e) {
				if (failed(e)) return;
				say(scrStatus, String(e.message || e), "err");
				setTimeout(screenLoop, 2000);
			});
		}
		function screenshot() {
			var s = el("canvas"), k = 4, t = new Date();
			s.width = canvas.width * k; s.height = canvas.height * k;
			var sg = s.getContext("2d");
			sg.imageSmoothingEnabled = false;
			sg.drawImage(canvas, 0, 0, s.width, s.height);
			function two(n) { return (n < 10 ? "0" : "") + n; }
			var name = "flipper-" + t.getFullYear() + two(t.getMonth() + 1) + two(t.getDate()) + "-" +
				two(t.getHours()) + two(t.getMinutes()) + two(t.getSeconds()) + ".png";
			s.toBlob(function (b) { if (b) saveBlob(b, name); });
		}

		/* ---- its buttons ---- */

		var queue = Promise.resolve(), pending = 0;
		// In order, one after another, as the Flipper would have them
		function send(key, type) {
			pending++;
			queue = queue.then(function () {
				return call("pirate.flipper", "input", { key: key, type: type });
			}).then(function (r) {
				if (r && r.error) say(scrStatus, r.error, "err");
			}, function (e) {
				if (!failed(e)) say(scrStatus, String(e.message || e), "err");
			}).then(function () { pending--; });
		}
		// A button held down: press; after half a second, long, then repeats;
		// let go: short (if it wasn't long) and release
		function holder(key, b) {
			var down = false, long = false, t = null, rep = null;
			return {
				down: function () {
					if (down) return;
					down = true; long = false;
					if (b) b.classList.add("down");
					send(key, "press");
					t = setTimeout(function () {
						long = true;
						send(key, "long");
						rep = setInterval(function () { if (pending < 2) send(key, "repeat"); }, 200);
					}, 500);
				},
				up: function () {
					if (!down) return;
					down = false;
					if (b) b.classList.remove("down");
					clearTimeout(t); clearInterval(rep);
					send(key, long ? "release" : "short+release");
				}
			};
		}
		var holds = {};
		[["up", "▲", "Up"], ["left", "◀", "Left"], ["ok", "OK", "OK"], ["right", "▶", "Right"],
			["down", "▼", "Down"], ["back", "↩", "Back"]].forEach(function (k) {
			var b = el("button", { type: "button", class: "fz-key fz-" + k[0], "aria-label": k[2], title: k[2], text: k[1] });
			var h = holds[k[0]] = holder(k[0], b);
			b.addEventListener("pointerdown", function (ev) {
				ev.preventDefault();
				if (b.setPointerCapture) try { b.setPointerCapture(ev.pointerId); } catch (e2) {}
				h.down();
			});
			["pointerup", "pointercancel", "lostpointercapture"].forEach(function (t) { b.addEventListener(t, h.up); });
			b.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });
			// The keyboard on a focused button: Enter and Space press it
			b.addEventListener("keydown", function (ev) {
				if ((ev.key === "Enter" || ev.key === " ") && !ev.repeat) { ev.preventDefault(); h.down(); }
			});
			b.addEventListener("keyup", function (ev) {
				if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); h.up(); }
			});
			pad.appendChild(b);
		});
		canvas.addEventListener("keydown", function (ev) {
			var k = FZ_KEYBOARD[ev.key];
			if (!k) return;
			ev.preventDefault();
			if (!ev.repeat) holds[k].down();
		});
		canvas.addEventListener("keyup", function (ev) {
			var k = FZ_KEYBOARD[ev.key];
			if (!k) return;
			ev.preventDefault();
			holds[k].up();
		});
		canvas.addEventListener("blur", function () { Object.keys(holds).forEach(function (k) { holds[k].up(); }); });
		canvas.addEventListener("pointerdown", function () { canvas.focus(); });

		/* ---- files ---- */

		function join(dir, name) { return (dir === "/" ? "" : dir) + "/" + name; }
		function parentOf(p) { return p.replace(/\/[^/]*$/, "") || "/"; }
		function badName(n) {
			if (!n || n === "." || n === "..") return "give a name";
			if (!/^[\x20-\x7e]+$/.test(n)) return "the Flipper takes plain ASCII names only";
			if (/[\/\\:*?"<>|]/.test(n)) return "no / \\ : * ? \" < > | in names";
			return null;
		}
		function crumbs(p) {
			clear(fCrumbs);
			var link = function (label, to) {
				return el("button", { type: "button", class: "linkbtn", text: label, onclick: function () { browse(to); } });
			};
			var parts = p === "/" ? [] : p.slice(1).split("/");
			fCrumbs.appendChild(parts.length ? link("Flipper", "/") : el("span", { text: "Flipper" }));
			parts.forEach(function (seg, i) {
				fCrumbs.appendChild(el("span", { class: "muted", text: " / " }));
				var to = "/" + parts.slice(0, i + 1).join("/");
				fCrumbs.appendChild(i === parts.length - 1 ? el("span", { text: seg }) : link(seg, to));
			});
		}
		function browse(p) {
			path = p;
			crumbs(p);
			upBtn.disabled = mkBtn.disabled = p === "/";
			clear(fWrap).appendChild(el("div", { class: "muted", text: "Loading…" }));
			call("pirate.flipper", "list", { path: p }).then(function (r) {
				if (!alive() || path !== p) return;
				if (r.error) { clear(fWrap).appendChild(alertEl("warn", r.error)); return; }
				// "any" is the Flipper's alias for one of the others
				listing = (r.files || []).filter(function (f) { return p !== "/" || f.name !== "any"; }).sort(function (a, b) {
					return (b.dir - a.dir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
				});
				clear(fWrap);
				var rows = [];
				if (p !== "/") rows.push([el("button", { type: "button", class: "linkbtn", text: "↑ up",
					onclick: function () { browse(parentOf(p)); } }), "", ""]);
				listing.forEach(function (f) {
					var fp = join(p, f.name);
					var label = p !== "/" ? f.name + (f.dir ? "/" : "") :
						f.name === "ext" ? "ext/ (SD card)" : f.name === "int" ? "int/ (internal)" : f.name + "/";
					var line = el("span", { class: "status" });
					rows.push([
						f.dir ? el("button", { type: "button", class: "linkbtn", text: label, onclick: function () { browse(fp); } })
							: el("span", { text: f.name }),
						f.dir ? "" : size(f.size),
						p === "/" ? "" : el("span", { class: "fz-acts" },
							f.dir ? null : btn("Download", { cls: "small", onclick: function () { download(fp, f.name, line); } }),
							btn("Rename", { cls: "small", onclick: function () { rename(fp, f.name); } }),
							btn("Delete", { cls: "small reset", onclick: function () { remove(fp, f); } }),
							line)
					]);
				});
				if (listing.length) fWrap.appendChild(tableEl(["Name", "Size", ""], rows));
				else {
					if (rows.length) fWrap.appendChild(tableEl(["Name", "Size", ""], rows));
					fWrap.appendChild(el("div", { class: "placeholder", text: "This folder is empty." }));
				}
				if (r.total) fWrap.appendChild(el("p", { class: "descr", text:
					"Showing the first " + listing.length + " of " + r.total + " entries." }));
			}).catch(function (e) {
				if (failed(e)) return;
				clear(fWrap).appendChild(alertEl("warn", String(e.message || e)));
			});
		}
		function fileOp(method, params, doing, done) {
			say(fStatus, doing);
			return call("pirate.flipper", method, params).then(function (r) {
				if (r.error) return say(fStatus, r.error, "err");
				say(fStatus, done, "ok");
				browse(path);
			}).catch(function (e) { if (!failed(e)) say(fStatus, String(e.message || e), "err"); });
		}
		function newFolder() {
			var n = window.prompt("New folder in " + path + ":", "");
			if (n == null) return;
			var bad = badName(n.trim());
			if (bad) return say(fStatus, bad, "err");
			fileOp("mkdir", { path: join(path, n.trim()) }, "making " + n.trim() + "…", "made " + n.trim());
		}
		function rename(fp, name) {
			var n = window.prompt("Rename " + name + " to:", name);
			if (n == null || n.trim() === name) return;
			var bad = badName(n.trim());
			if (bad) return say(fStatus, bad, "err");
			fileOp("rename", { path: fp, to: join(parentOf(fp), n.trim()) }, "renaming…", "renamed to " + n.trim());
		}
		function remove(fp, f) {
			if (!window.confirm("Delete " + f.name + (f.dir ? " and everything in it" : "") + " from the Flipper?")) return;
			fileOp("delete", { path: fp, recursive: !!f.dir }, "deleting " + f.name + "…", "deleted " + f.name);
		}

		function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
		function download(fp, name, line) {
			say(line, "reading…");
			function poll() {
				return call("pirate.flipper", "read", { path: fp }).then(function (r) {
					if (r.error) throw new Error(r.error);
					if (r.busy) { say(line, "reading… " + size(r.got)); return wait(400).then(poll); }
					return slices();
				});
			}
			function slices() {
				var parts = [], off = 0;
				function next() {
					return call("pirate.flipper", "read", { path: fp, offset: off }).then(function (r) {
						if (r.error) throw new Error(r.error);
						var bin = atob(r.data || ""), u = new Uint8Array(bin.length), i;
						for (i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
						parts.push(u);
						off += u.length;
						if (r.more) { say(line, "downloading… " + Math.round(off * 100 / r.size) + "%"); return next(); }
						saveBlob(new Blob(parts, { type: "application/octet-stream" }), name);
						say(line, "downloaded", "ok");
					});
				}
				return next();
			}
			poll().catch(function (e) { if (!failed(e)) say(line, String(e.message || e), "err"); });
		}

		function b64(u8) {
			var s = "", i;
			for (i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
			return btoa(s);
		}
		function readFile(file) {
			if (file.arrayBuffer) return file.arrayBuffer();
			return new Promise(function (res, rej) {
				var fr = new FileReader();
				fr.onload = function () { res(fr.result); };
				fr.onerror = function () { rej(fr.error); };
				fr.readAsArrayBuffer(file);
			});
		}
		// Pieces of 32 KiB: a ubus request through uhttpd is 64 KB at most
		function uploadOne(dir, file) {
			var bad = badName(file.name);
			if (bad) return Promise.reject(new Error(file.name + ": " + bad));
			if (dir === path && listing.some(function (f) { return f.name === file.name; }) &&
				!window.confirm(file.name + " is on the Flipper already. Replace it?")) return Promise.resolve();
			var fp = join(dir, file.name);
			return readFile(file).then(function (buf) {
				var u8 = new Uint8Array(buf), off = 0;
				function next() {
					var piece = u8.subarray(off, off + 32768), more = off + piece.length < u8.length;
					say(fStatus, "uploading " + file.name + "… " + (u8.length ? Math.round(off * 100 / u8.length) : 0) + "%");
					return call("pirate.flipper", "write", { path: fp, offset: off, data: b64(piece), more: more }).then(function (r) {
						if (r.error) throw new Error(file.name + ": " + r.error);
						off += piece.length;
						if (more) return next();
						say(fStatus, "uploaded " + file.name + " (" + size(u8.length) + ")", "ok");
					});
				}
				return next();
			});
		}
		function uploadAll(files) {
			var dir = path, chain = Promise.resolve();
			if (dir === "/") return say(fStatus, "open ext (the SD card) or int first", "err");
			files.forEach(function (f) { chain = chain.then(function () { return uploadOne(dir, f); }); });
			chain.then(function () { if (path === dir) browse(dir); }, function (e) {
				if (failed(e)) return;
				say(fStatus, String(e.message || e), "err");
				if (path === dir) browse(dir);
			});
		}

		// Plugged in and pulled out as it likes: keep the page current while it is open
		if (FZ_TIMER) clearInterval(FZ_TIMER);
		FZ_TIMER = setInterval(function () {
			if (!alive()) { clearInterval(FZ_TIMER); FZ_TIMER = null; return; }
			status();
		}, 4000);
		status();
		screenLoop();
	}

	function saveBlob(blob, name) {
		var a = el("a", { href: URL.createObjectURL(blob), download: name });
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
	}

	/* ---------- fallback for an unknown route ---------- */

	function renderPlaceholder(name) {
		clear(VIEW);
		VIEW.appendChild(viewHead(String(name)));
		VIEW.appendChild(el("div", { class: "placeholder", text: "Unknown section." }));
	}

	/* ---------- sections (the sidebar) / router ---------- */

	var GROUPS = [
		["Overview", [["dashboard", "Dashboard"], ["messenger", "Messenger"]]],
		["Radio", [["receivers", "Receivers"], ["sensors", "Sensors"]]],
		["Wi-Fi", [["survey", "Survey"], ["threats", "Threats"], ["handshake", "Handshakes"]]],
		["Network", [["uplink", "Uplink"], ["clients", "Clients"], ["hosts", "Hosts"], ["capture", "Capture"]]],
		["USB devices", [["drives", "Drives"], ["phone", "Phone"], ["flipper", "Flipper"], ["dreampi", "DreamPi"]]],
		["System", [["status", "Status"], ["access", "Access"], ["terminal", "Terminal"], ["firmware", "Firmware"]]]
	];
	// Pages that were renamed, for old links
	var ALIASES = { sdr: "receivers", router: "status" };
	var TABS = [];
	GROUPS.forEach(function (g) { TABS = TABS.concat(g[1]); });
	var current = "dashboard";

	function renderTabs() {
		var nav = clear($("tabs")), here = "";
		GROUPS.forEach(function (g) {
			nav.appendChild(el("div", { class: "nav-grp", text: g[0] }));
			g[1].forEach(function (t) {
				var b = el("button", {
					class: "nav-item" + (t[0] === current ? " active" : ""),
					type: "button", text: t[1],
					onclick: function () {
						menu(false);
						if (t[0] !== current) window.scrollTo(0, 0);
						setTab(t[0]);
					}
				});
				if (t[0] === current) { b.setAttribute("aria-current", "page"); here = t[1]; }
				nav.appendChild(b);
			});
		});
		$("top-title").textContent = here;
		$("top-title").title = "";
	}

	// The sections: a drawer at any width, opened from the strip at the top,
	// over the page (which stays as it is); a section chosen, a click beside
	// it or Escape puts it away
	function menu(open) {
		document.body.classList.toggle("menu-open", open);
		$("menu-btn").setAttribute("aria-expanded", open ? "true" : "false");
	}
	$("menu-btn").title = "Sections";
	// (What shrank the docked sidebar, kept in this browser, is no more)
	try { localStorage.removeItem("pirate_side_shut"); } catch (e) {}
	$("menu-btn").addEventListener("click", function () {
		menu(!document.body.classList.contains("menu-open"));
	});
	$("scrim").addEventListener("click", function () { menu(false); });
	document.addEventListener("keydown", function (ev) {
		if (ev.key === "Escape" && document.body.classList.contains("menu-open")) menu(false);
	});

	// The line under the name in the sidebar: the router's address on its own
	// network (where this page is), as it has it now; until it says, the
	// address this browser used. Asked once signed in, at most once a minute
	var addrAsked = 0;
	function showAddr() {
		var a = $("devaddr");
		if (!a) return;   // (an index.html from before, still in the browser's cache)
		if (!a.textContent) a.textContent = location.hostname;
		if (Date.now() - addrAsked < 60000) return;
		addrAsked = Date.now();
		call("pirate.router", "status").then(function (s) {
			if (s && s.lan_ip) a.textContent = s.lan_ip;
		}).catch(function () {});
	}

	function setTab(id) {
		id = ALIASES[id] || id;
		current = id;
		VIEW.classList.remove("view-app");   // the Messenger's: the whole window
		showAddr();
		renderTabs();
		try { location.hash = id; } catch (e) {}
		if (id === "dashboard") return loadDashboard();
		if (id === "messenger") return renderMessenger();
		if (id === "receivers") return renderReceivers();
		if (id === "sensors") return renderSensors();
		if (id === "hosts") return renderHosts();
		if (id === "survey") return renderSurvey();
		if (id === "threats") return renderThreats();
		if (id === "uplink") return renderUplink();
		if (id === "clients") return renderClients();
		if (id === "status") return renderStatus();
		if (id === "access") return renderAccess();
		if (id === "terminal") return renderTerminal();
		if (id === "dreampi") return renderDreampi();
		if (id === "drives") return renderDrives();
		if (id === "phone") return renderPhone();
		if (id === "flipper") return renderFlipper();
		if (id === "capture") return renderCapture();
		if (id === "handshake") return renderHandshake();
		if (id === "firmware") return renderFirmware();
		renderPlaceholder(id);
	}

	/* ---------- chrome ---------- */

	function setNetPill(online, ssid) {
		var p = $("net-pill");
		// Shown once a page has said whether the router is online
		p.hidden = online == null;
		if (online == null) { p.className = "pill"; p.textContent = ""; return; }
		p.className = "pill " + (online ? "ok" : "bad");
		p.textContent = (online ? "online" : "offline") + (ssid ? " · " + ssid : "");
	}

	function onError(e) {
		if (String(e.message || e) === "unauthorized" && !DEMO) { firstRun(); return; }
		clear(VIEW).appendChild(el("div", { class: "placeholder" },
			el("b", { text: "Couldn't reach the Slate" }),
			el("div", { class: "muted", text: String(e.message || e) })));
	}

	/* ---------- login ---------- */

	function showLogin() { $("login").hidden = false; var p = $("p"); if (p) p.focus(); }
	function hideLogin() { $("login").hidden = true; }

	// First run: a fresh flash has no root password, and rpcd then accepts any
	// password (session.c: "password is not set"). So an empty-password sign-in
	// that succeeds means no password exists yet: ask for one to be set before
	// ever asking for one. If it fails, a password exists: the normal sign-in.
	function firstRun() {
		login("root", "", false).then(showSetup).catch(showLogin);
	}
	function showSetup() { $("setup").hidden = false; var p = $("np1"); if (p) p.focus(); }

	$("setup-form").addEventListener("submit", function (ev) {
		ev.preventDefault();
		var a = $("np1").value, b = $("np2").value, err = $("setup-err");
		function fail(msg) { err.textContent = msg; err.hidden = false; }
		err.hidden = true;
		if (a.length < 5) return fail("Use at least 5 characters.");
		if (a !== b) return fail("The two entries differ.");
		call("pirate.router", "set_password", { password: a }).then(function (r) {
			if (r.error) return fail(r.error);
			$("np1").value = ""; $("np2").value = "";
			rememberSession();
			$("setup").hidden = true;
			setTab(current);
		}).catch(function (e) { fail(String(e.message || e)); });
	});

	$("login-form").addEventListener("submit", function (ev) {
		ev.preventDefault();
		var err = $("login-err");
		err.hidden = true;
		login($("u").value, $("p").value).then(function () {
			hideLogin();
			setTab(current);
		}).catch(function () {
			err.textContent = "Sign-in failed. Check the password.";
			err.hidden = false;
		});
	});

	/* ---------- boot ---------- */

	function startTab() {
		var h = (location.hash || "").replace("#", "");
		h = ALIASES[h] || h;
		return TABS.some(function (t) { return t[0] === h; }) ? h : "dashboard";
	}

	function boot() {
		current = startTab();
		renderTabs();
		if (DEMO) {
			$("demo-badge").hidden = false;
			setTab(current);
			if (/[?&]setup=1/.test(location.search)) showSetup();
			return;
		}
		try { SID = sessionStorage.getItem("pirate_sid"); } catch (e) { SID = null; }
		if (SID) { setTab(current); } else { firstRun(); }
	}

	window.addEventListener("hashchange", function () {
		var h = startTab();
		if (h !== current) setTab(h);
	});

	boot();
})();
