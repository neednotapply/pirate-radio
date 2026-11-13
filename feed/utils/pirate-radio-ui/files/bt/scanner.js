/* Pirate Radio: the Bluetooth page.

   What a Bluetooth dongle on the router's USB port hears of the devices
   around, made into a list of them: each with its name, what kind of thing
   it is, who made it and how strongly it is heard. The router does none of
   that. pirate-bluetooth there has the adapter listen (a passive scan: it
   asks nothing of what it hears) and hands on what the adapter reports as it
   is, an HCI event a record (its source says how); this file makes devices
   of them, with bt/names.js for the names of makers and services.

   What a device is called and taken for comes from what it advertises, and
   is only as good as that: a name is the device's own word, a maker is
   whoever's number leads its data, and a kind is a reading of both.

   window.PirateBT.mount(node, options) puts the page's content in node and
   returns { destroy() }. app.js loads this file, after bt/names.js, the
   first time the page is opened. options: call(object, method, params), the
   page's ubus call, answering with a promise; unauthorized(error), for a
   session that has run out; demo: a made-up neighbourhood, no adapter.
   window.PirateBT.pure is the parts with no page to them (tests/bt/). */
(function () {
	"use strict";

	var NAMES = (typeof window !== "undefined" && window.PirateBTNames) || null;

	/* ---------- small things ---------- */

	function el(tag, attrs) {
		var n = document.createElement(tag), k;
		if (attrs) for (k in attrs) {
			if (k === "class") n.className = attrs[k];
			else if (k === "text") n.textContent = attrs[k];
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
	function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }

	function s8(v) { return v > 127 ? v - 256 : v; }
	function le16(d, o) { return d[o] | d[o + 1] << 8; }
	function be16(d, o) { return d[o] << 8 | d[o + 1]; }
	function be32(d, o) { return (d[o] << 24 | d[o + 1] << 16 | d[o + 2] << 8 | d[o + 3]) >>> 0; }
	function two(v) { return (v < 16 ? "0" : "") + v.toString(16); }
	function hex(d, sep) {
		var s = "", i;
		for (i = 0; i < d.length; i++) s += (i && sep ? sep : "") + two(d[i]);
		return s;
	}
	function hex4(v) { return ("000" + v.toString(16)).slice(-4).toUpperCase(); }
	function unhex(s) {
		s = s.replace(/[^0-9a-f]/gi, "");
		var d = new Uint8Array(s.length >> 1), i;
		for (i = 0; i < d.length; i++) d[i] = parseInt(s.substr(2 * i, 2), 16);
		return d;
	}
	function same(a, b) {
		if (a.length !== b.length) return false;
		for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
		return true;
	}
	// An address as it is written: as sent, its lowest byte comes first
	function addrText(d, o) {
		var s = "", i;
		for (i = 5; i >= 0; i--) s += (i < 5 ? ":" : "") + two(d[o + i]);
		return s.toUpperCase();
	}
	// A 128-bit UUID as it is written; as sent, lowest byte first
	function uuidText(d, o) {
		var s = "", i;
		for (i = 15; i >= 0; i--) {
			s += two(d[o + i]);
			if (i === 12 || i === 10 || i === 8 || i === 6) s += "-";
		}
		return s.toUpperCase();
	}
	// Text as devices send it: UTF-8, and whatever is not is a mark
	function utf8(d) {
		var s = "", i = 0, c, n, cp, k;
		while (i < d.length) {
			c = d[i++];
			if (c < 0x80) { s += String.fromCharCode(c); continue; }
			n = c >= 0xf0 ? 3 : c >= 0xe0 ? 2 : c >= 0xc0 ? 1 : 0;
			cp = n === 3 ? c & 7 : n === 2 ? c & 15 : c & 31;
			if (!n || i + n > d.length) { s += "�"; continue; }
			for (k = 0; k < n; k++) {
				if ((d[i + k] & 0xc0) !== 0x80) { cp = -1; break; }
				cp = cp << 6 | (d[i + k] & 63);
			}
			if (cp < 0) { s += "�"; continue; }
			i += n;
			s += cp > 0xffff ? String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 1023)) :
				String.fromCharCode(cp);
		}
		return s;
	}
	// A name fit to show: no control characters, not endless
	function tidy(s) {
		return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim().slice(0, 64);
	}

	var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", B64AT = (function () {
		var t = new Int16Array(128), i;
		for (i = 0; i < 128; i++) t[i] = 0;
		for (i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
		return t;
	})();
	function b64dec(s) {
		var n = s.length - s.length % 4, pad = n && s.charAt(n - 1) === "=" ? (s.charAt(n - 2) === "=" ? 2 : 1) : 0;
		var out = new Uint8Array(Math.max(0, n / 4 * 3 - pad)), o = 0, i, v;
		for (i = 0; i < n; i += 4) {
			v = B64AT[s.charCodeAt(i) & 127] << 18 | B64AT[s.charCodeAt(i + 1) & 127] << 12 |
				B64AT[s.charCodeAt(i + 2) & 127] << 6 | B64AT[s.charCodeAt(i + 3) & 127];
			if (o < out.length) out[o++] = v >> 16 & 255;
			if (o < out.length) out[o++] = v >> 8 & 255;
			if (o < out.length) out[o++] = v & 255;
		}
		return out;
	}
	function b64enc(d) {
		var s = "", i, v;
		for (i = 0; i < d.length; i += 3) {
			v = d[i] << 16 | (d[i + 1] || 0) << 8 | (d[i + 2] || 0);
			s += B64.charAt(v >> 18) + B64.charAt(v >> 12 & 63) +
				(i + 1 < d.length ? B64.charAt(v >> 6 & 63) : "=") + (i + 2 < d.length ? B64.charAt(v & 63) : "=");
		}
		return s;
	}

	/* ---------- what the router hands on ---------- */

	// The records in a "reports" answer's data: each 2 bytes of length (of
	// the rest), 4 of time (ms on the router's clock), the HCI event's code,
	// and its parameters
	function records(d) {
		var out = [], o = 0, n;
		while (o + 7 <= d.length) {
			n = le16(d, o);
			if (n < 5 || o + 2 + n > d.length) break;
			out.push({ t: (d[o + 2] | d[o + 3] << 8 | d[o + 4] << 16 | d[o + 5] << 24) >>> 0, evt: d[o + 6],
				p: d.subarray(o + 7, o + 2 + n) });
			o += 2 + n;
		}
		return out;
	}

	// How a thing advertises (the PDU): what may be done with it
	var PDU = ["ADV_IND", "ADV_DIRECT_IND", "ADV_SCAN_IND", "ADV_NONCONN_IND", "SCAN_RSP"];

	// The advertising reports in an LE Meta event's parameters, as
	//   { pdu, connectable, scannable, directed, response, addrType, addr, rssi, tx, data, extended, cut }
	// pdu is an index into PDU (null where the advertising is of the newer
	// kind, which has no such names); rssi and tx are dBm, or null when the
	// adapter does not say; cut: there was more data than came
	function reportsIn(p) {
		var out = [], n, o, i, t, len, r;
		if (p.length < 2) return out;
		n = p[1];
		o = 2;
		if (p[0] === 0x02) {
			// LE Advertising Report: kind, address type, address, the data and its length, strength
			for (i = 0; i < n && o + 9 <= p.length; i++) {
				t = p[o];
				len = p[o + 8];
				if (o + 10 + len > p.length) break;
				r = s8(p[o + 9 + len]);
				out.push({ pdu: t <= 4 ? t : null, connectable: t === 0 || t === 1, scannable: t === 0 || t === 2,
					directed: t === 1, response: t === 4, addrType: p[o + 1], addr: addrText(p, o + 2),
					rssi: r === 127 ? null : r, tx: null, data: p.subarray(o + 9, o + 9 + len), extended: false, cut: false });
				o += 10 + len;
			}
		} else if (p[0] === 0x0d) {
			// LE Extended Advertising Report: what it is (bits), address type, address, the two PHYs,
			// the set, its power, strength, the periodic interval, whom it is for, the data
			for (i = 0; i < n && o + 24 <= p.length; i++) {
				t = le16(p, o);
				len = p[o + 23];
				if (o + 24 + len > p.length) break;
				r = s8(p[o + 13]);
				out.push({ pdu: !(t & 16) ? null : t & 8 ? 4 : (t & 15) === 3 ? 0 : (t & 15) === 5 ? 1 : (t & 15) === 2 ? 2 : (t & 15) === 0 ? 3 : null,
					connectable: !!(t & 1), scannable: !!(t & 2), directed: !!(t & 4), response: !!(t & 8),
					addrType: p[o + 2], addr: p[o + 2] === 0xff ? "" : addrText(p, o + 3),
					rssi: r === 127 ? null : r, tx: s8(p[o + 12]) === 127 ? null : s8(p[o + 12]),
					data: p.subarray(o + 24, o + 24 + len), extended: true, cut: (t >> 5 & 3) === 2 });
				o += 24 + len;
			}
		} else if (p[0] === 0x0b) {
			// LE Direct Advertising Report: to one device by name, and no data
			for (i = 0; i < n && o + 16 <= p.length; i++) {
				r = s8(p[o + 15]);
				out.push({ pdu: 1, connectable: true, scannable: false, directed: true, response: false,
					addrType: p[o + 1], addr: addrText(p, o + 2), rssi: r === 127 ? null : r, tx: null,
					data: p.subarray(0, 0), extended: false, cut: false });
				o += 16;
			}
		}
		return out;
	}

	// Whose an address is. A public one is the device's for good, out of its
	// maker's block. A random one is made up: static (the device's for good
	// all the same, or until it is restarted), or private, changed every few
	// minutes: resolvable (what the device is bonded with can tell it is the
	// same one) or not (nothing can)
	function addrKind(addrType, addr) {
		if (!(addrType & 1)) return "public";
		var top = parseInt(addr.slice(0, 2), 16) >> 6;
		return top === 3 ? "static" : top === 1 ? "resolvable" : top === 0 ? "unresolvable" : "random";
	}

	/* ---------- what an advertisement says ---------- */

	// Its structures: each a length, a type, and data
	function adParts(data) {
		var out = [], o = 0, n;
		while (o + 1 < data.length) {
			n = data[o];
			if (!n || o + 1 + n > data.length) break;
			out.push({ type: data[o + 1], d: data.subarray(o + 2, o + 1 + n) });
			o += 1 + n;
		}
		return out;
	}

	// The same, each with a key for the kind of thing it says, so that the
	// latest of each kind can be kept: a maker's data by the maker, a
	// service's by the service; and Apple's, which holds several messages
	// (a type, a length, the message), a part for each message
	function partsOf(data) {
		var out = [];
		adParts(data).forEach(function (p) {
			var key = two(p.type), o, l, d, t, from;
			if (p.type === 0xff && p.d.length >= 2) {
				key += ":" + hex4(le16(p.d, 0));
				if (le16(p.d, 0) === 0x004c && p.d.length >= 4) {
					for (o = 2; o + 2 <= p.d.length; o = from + l) {
						t = p.d[o];
						// (type 1 has no length: it is all the rest. One cut short: what there is)
						from = t === 0x01 ? o + 1 : o + 2;
						l = t === 0x01 ? p.d.length - from : Math.min(p.d[o + 1], p.d.length - from);
						d = new Uint8Array(4 + l);
						d[0] = 0x4c;
						d[2] = t;
						d[3] = l;
						d.set(p.d.subarray(from, from + l), 4);
						out.push({ key: key + ":" + two(t), type: 0xff, d: d });
					}
					return;
				}
			} else if (p.type === 0x16 && p.d.length >= 2) key += ":" + hex4(le16(p.d, 0));
			else if (p.type === 0x20 && p.d.length >= 4) key += ":" + hex(p.d.subarray(0, 4));
			else if (p.type === 0x21 && p.d.length >= 16) key += ":" + hex(p.d.subarray(0, 16));
			out.push({ key: key, type: p.type, d: p.d });
		});
		return out;
	}

	// The kinds of thing a device is taken for, in the order they are offered
	var KINDS = [
		["personal", "Phones, computers, watches"],
		["audio", "Headphones and speakers"],
		["tracker", "Trackers"],
		["beacon", "Beacons"],
		["sensor", "Sensors"],
		["home", "TVs, lights, appliances"],
		["input", "Keyboards, mice, controllers"],
		["health", "Health and fitness"],
		["other", "Other"]
	];
	var KIND_NAME = {};
	KINDS.forEach(function (k) { KIND_NAME[k[0]] = k[1]; });

	// What a service says of the thing that has it
	var SERVICE_KIND = {
		0x1808: "health", 0x1809: "health", 0x180d: "health", 0x1810: "health", 0x1814: "health", 0x1816: "health",
		0x1818: "health", 0x181d: "health", 0x181f: "health", 0x1822: "health", 0x1826: "health", 0x183a: "health",
		0x1812: "input", 0x181a: "sensor", 0x1827: "home", 0x1828: "home",
		0x1844: "audio", 0x184e: "audio", 0x184f: "audio", 0x1850: "audio", 0x1852: "audio", 0x1853: "audio",
		0x1854: "audio", 0x1855: "audio", 0x1856: "audio", 0x1858: "audio"
	};
	// What an appearance's category says
	var LOOK_KIND = {
		1: "personal", 2: "personal", 3: "personal", 4: "home", 5: "home", 6: "input", 8: "tracker", 9: "tracker",
		10: "home", 11: "input", 12: "health", 13: "health", 14: "health", 15: "input", 16: "health", 17: "health",
		18: "health", 19: "home", 20: "home", 21: "sensor", 22: "home", 23: "home", 24: "home", 25: "home", 26: "home",
		27: "home", 28: "home", 29: "home", 30: "home", 31: "home", 32: "home", 33: "audio", 34: "audio", 36: "home",
		37: "audio", 39: "home", 40: "home", 41: "audio", 42: "input", 43: "home", 49: "health", 50: "health",
		52: "health", 53: "health", 54: "health", 55: "health", 81: "health"
	};
	// Apple's messages, by the names those who worked them out gave them
	var APPLE = {
		0x01: "background services", 0x02: "iBeacon", 0x03: "AirPrint", 0x05: "AirDrop", 0x06: "HomeKit",
		0x07: "Proximity Pairing", 0x08: "Hey Siri", 0x09: "AirPlay target", 0x0a: "AirPlay source",
		0x0b: "Magic Switch", 0x0c: "Handoff", 0x0d: "Instant Hotspot (wanted)", 0x0e: "Instant Hotspot (offered)",
		0x0f: "Nearby Action", 0x10: "Nearby Info", 0x12: "Find My"
	};
	// What says "I am ready to pair" of Apple's headphones: the model
	var APPLE_AUDIO = {
		0x0220: "AirPods", 0x0f20: "AirPods (2nd generation)", 0x1320: "AirPods (3rd generation)",
		0x0e20: "AirPods Pro", 0x1420: "AirPods Pro (2nd generation)", 0x0a20: "AirPods Max",
		0x0320: "Powerbeats3", 0x0520: "BeatsX", 0x0620: "Beats Solo3", 0x0920: "Beats Studio3",
		0x0b20: "Powerbeats Pro", 0x0c20: "Beats Solo Pro", 0x1020: "Beats Flex", 0x1120: "Beats Studio Buds",
		0x1220: "Beats Fit Pro"
	};
	// What a Microsoft device says it is
	var MS_DEVICE = {
		1: "an Xbox", 6: "an iPhone with Microsoft's software", 7: "an iPad with Microsoft's software",
		8: "an Android device with Microsoft's software", 9: "a Windows desktop computer", 11: "a Windows phone",
		12: "a Linux device with Microsoft's software", 13: "a Windows IoT device", 14: "a Surface Hub",
		15: "a Windows laptop", 16: "a Windows tablet"
	};
	var BT_VERSION = { 0: "1.0b", 1: "1.1", 2: "1.2", 3: "2.0", 4: "2.1", 5: "3.0", 6: "4.0", 7: "4.1", 8: "4.2",
		9: "5.0", 10: "5.1", 11: "5.2", 12: "5.3", 13: "5.4", 14: "6.0" };

	function companyName(code) {
		return (NAMES && NAMES.company(code)) || "company 0x" + hex4(code);
	}
	// A service as it is called: by name where it has one, by number anyway
	function serviceName(u) {
		var n;
		if (typeof u === "string") {
			// One of Bluetooth's own 16-bit numbers, written out in full
			if (/^0000[0-9A-F]{4}-0000-1000-8000-00805F9B34FB$/.test(u)) return serviceName(parseInt(u.slice(4, 8), 16));
			n = NAMES && NAMES.service(u);
			return n ? n + " (" + u + ")" : u;
		}
		n = NAMES && (NAMES.service(u) || (NAMES.member(u) ? NAMES.member(u) + "'s" : null));
		return n ? n + " (0x" + hex4(u) + ")" : "0x" + hex4(u);
	}

	// An Eddystone beacon's web address: a scheme, then text with the common
	// endings a byte each
	function eddystoneUrl(d, o) {
		var SCHEME = ["http://www.", "https://www.", "http://", "https://"];
		var END = [".com/", ".org/", ".edu/", ".net/", ".info/", ".biz/", ".gov/", ".com", ".org", ".edu", ".net", ".info", ".biz", ".gov"];
		var s = SCHEME[d[o]] || "", i;
		for (i = o + 1; i < d.length; i++) s += d[i] < END.length ? END[d[i]] : d[i] > 32 && d[i] < 127 ? String.fromCharCode(d[i]) : "";
		return s;
	}

	// What a device is, as far as the structures it has sent tell (parts: as
	// partsOf gives them, the latest of each kind):
	//   name     its own name, where it says one
	//   maker    whose number is on its data
	//   kind     one of KINDS
	//   what     what it seems to be, in a few words
	//   tags     [text, tone] to mark it with (tone: "warn" for a tracker, "bad" for one away from its owner)
	//   tracker  { network, away }: away true, false, or null where it does not say
	//   facts    [label, value]: the rest of what it says, for whoever wants it all
	function describe(parts) {
		var s = { name: "", maker: "", kind: "", what: "", tags: [], tracker: null, facts: [] };
		var kindRank = 0, whatRank = 0, makerRank = 0, shortName = "", services = [], apple = [];

		function kind(k, rank) { if (k && rank > kindRank) { s.kind = k; kindRank = rank; } }
		function what(t, rank) { if (rank > whatRank) { s.what = t; whatRank = rank; } }
		function maker(m, rank) { if (m && rank > makerRank) { s.maker = m; makerRank = rank; } }
		function fact(k, v) { s.facts.push([k, v]); }
		function tracker(network, away, text) {
			s.tracker = { network: network, away: away };
			kind("tracker", 9);
			what(text, 9);
		}
		function service(u) {
			services.push(serviceName(u));
			if (u === "6E400001-B5A3-F393-E0A9-E50E24DCCA9E") what("a gadget with a serial port over Bluetooth", 2);
			if (typeof u !== "number") return;
			kind(SERVICE_KIND[u], 3);
			if (u === 0xfeed || u === 0xfeec || u === 0xfd84) { tracker("Tile", null, "a Tile tracker"); maker("Tile", 5); }
			else if (u === 0xfe33 || u === 0xfe65) { tracker("Chipolo", null, "a Chipolo tracker"); maker("Chipolo", 5); }
			else memberMaker(u);
		}
		// Whose a service's number is, for a maker: but Google's and Apple's are ways of
		// doing a thing that anybody's device may use
		function memberMaker(u) {
			var m = NAMES && NAMES.member(u);
			if (m && m !== "Google" && m !== "Apple") maker(m, 2);
		}

		function appleSays(d) {
			// (as partsOf leaves it: Apple's number, the message's type, its length, the message)
			var t = d[2], v = d.subarray(4), type, model;
			if (apple.indexOf(APPLE[t] || "0x" + two(t)) < 0) apple.push(APPLE[t] || "0x" + two(t));
			if (t === 0x02 && v.length >= 21) {
				// A beacon in Apple's form, which anybody's beacon may use
				kind("beacon", 8);
				what("an iBeacon", 8);
				fact("iBeacon", uuidTextBE(v, 0) + ", major " + be16(v, 16) + ", minor " + be16(v, 18) +
					", " + s8(v[20]) + " dBm at 1 m");
				return;
			}
			// (a tracker of another maker's on Apple's network is not Apple's)
			if (t !== 0x12 || (v.length && (v[0] >> 4 & 3) !== 2)) maker("Apple", 6);
			if (t === 0x12 && v.length >= 1) {
				// Find My: what kind of thing (two bits of the first byte), and, by the
				// length, whether it is with its owner (2 bytes) or by itself and
				// calling for anybody's help (25: a key follows)
				type = v[0] >> 4 & 3;
				tracker("Apple's Find My", v.length >= 25,
					type === 1 ? "an AirTag" : type === 3 ? "AirPods, as a Find My device" :
					type === 2 ? "a tracker on Apple's Find My network (not Apple's own)" : "an Apple device, as a Find My device");
				if (type === 3) kind("audio", 10);
				if (type === 0) kind("personal", 10);
				if (type === 1) fact("Battery, as it says", ["full", "medium", "low", "very low"][v[0] >> 6 & 3]);
			} else if (t === 0x07 && v.length >= 3) {
				model = APPLE_AUDIO[v[1] << 8 | v[2]];
				kind("audio", 8);
				what(model ? model : "Apple or Beats headphones", 8);
				fact("Model, as it says", model || "0x" + hex4(v[1] << 8 | v[2]));
			} else if (t === 0x0b) {
				kind("personal", 7);
				what("an Apple Watch, as it seems", 7);
			} else if (t === 0x09) {
				kind("home", 6);
				what("an AirPlay receiver: an Apple TV, a HomePod, a TV or a speaker", 6);
			} else if (t === 0x06) {
				kind("home", 6);
				what("a HomeKit accessory", 6);
			} else if (t === 0x03) {
				kind("home", 6);
				what("a printer (AirPrint)", 6);
			} else {
				kind("personal", 5);
				what("an Apple device: an iPhone, iPad, Mac or Watch", 5);
			}
		}

		function microsoftSays(d) {
			var v = d.subarray(2), o, n;
			if (v[0] === 0x01 && v.length >= 2) {
				// (Windows says so, on whoever's computer it runs)
				kind("personal", 6);
				what(MS_DEVICE[v[1] & 63] || "a device with Microsoft's software", 6);
			} else if (v[0] === 0x03 && v.length >= 3) {
				// Swift Pair: "pair me", from any maker's keyboard, mouse or headphones. Then
				// its classic address (kind 1), what it is as classic Bluetooth has it (1
				// and 2), and its name
				o = 3 + (v[1] === 1 ? 6 : 0) + (v[1] === 1 || v[1] === 2 ? 3 : 0);
				if ((v[1] === 1 || v[1] === 2) && v.length >= o) classSays(v[o - 3] | v[o - 2] << 8 | v[o - 1] << 16);
				n = v.length > o ? tidy(utf8(v.subarray(o))) : "";
				if (n && !shortName) shortName = n;
				s.tags.push(["ready to pair", ""]);
				fact("Swift Pair", "asks to be paired" + (n ? ", as " + n : ""));
			}
		}

		// A RuuviTag's readings (its data format 5)
		function ruuviSays(d) {
			var v = d.subarray(2), power;
			if (v[0] !== 5 || v.length < 24) return false;
			power = be16(v, 13);
			kind("sensor", 8);
			what("a RuuviTag", 8);
			if (be16(v, 1) !== 0x8000) fact("Temperature", ((be16(v, 1) << 16 >> 16) * 0.005).toFixed(2) + " °C");
			if (be16(v, 3) !== 0xffff) fact("Humidity", (be16(v, 3) * 0.0025).toFixed(1) + " %");
			if (be16(v, 5) !== 0xffff) fact("Air pressure", ((be16(v, 5) + 50000) / 100).toFixed(1) + " hPa");
			if (power >> 5 !== 2047) fact("Battery", ((power >> 5) + 1600) / 1000 + " V");
			return true;
		}

		// What a classic device says it is: the major class, in bits 8 to 12
		function classSays(c) {
			var major = c >> 8 & 31, minor = c >> 2 & 63;
			var NAME = ["", "a computer", "a phone", "a network access point", "an audio or video device", "a keyboard, mouse or controller",
				"a printer, scanner or camera", "a wearable", "a toy", "a health device"];
			if (!major || major >= NAME.length) return;
			// (of the audio and video ones, a set-top box and those with a picture are a TV's kind)
			kind(major === 1 || major === 2 || major === 7 ? "personal" : major === 4 ? (minor === 9 || (minor >= 11 && minor <= 16) ? "home" : "audio") :
				major === 5 ? "input" : major === 9 ? "health" : major === 3 || major === 6 ? "home" : "other", 4);
			what(NAME[major], 3);
		}

		function serviceData(u, d) {
			var t;
			if (u === 0xfeaa && d.length >= 1) {
				// Google's: an Eddystone beacon (the frame's type in the upper four
				// bits), or a tracker on its Find My Device network
				t = d[0];
				if (t === 0x40 || t === 0x41) {
					tracker("Google's Find My Device", t === 0x41 ? true : null, "a tracker on Google's Find My Device network");
				} else {
					kind("beacon", 8);
					what("an Eddystone beacon", 8);
					if (t === 0x00 && d.length >= 18) fact("Eddystone UID", hex(d.subarray(2, 12)) + " / " + hex(d.subarray(12, 18)) + ", " + s8(d[1]) + " dBm at 0 m");
					else if (t === 0x10 && d.length >= 3) fact("Eddystone URL", eddystoneUrl(d, 2));
					else if (t === 0x20 && d.length >= 14 && !d[1]) fact("Eddystone telemetry", be16(d, 2) + " mV, " +
						((be16(d, 4) << 16 >> 16) / 256).toFixed(1) + " °C, up " + Math.round(be32(d, 10) / 10) + " s");
					else if (t === 0x30) fact("Eddystone EID", "an identity that changes");
				}
			} else if (u === 0xfe2c) {
				kind("audio", 2);
				what("a Fast Pair accessory: headphones, most often", 2);
				if (d.length === 3) {
					s.tags.push(["ready to pair", ""]);
					fact("Fast Pair", "asks to be paired, model 0x" + hex(d).toUpperCase());
				} else fact("Fast Pair", "paired to an account");
			} else if (u === 0xfd6f) {
				kind("personal", 5);
				what("a phone with exposure notifications on", 4);
			} else if (u === 0xfd5a || u === 0xfd59) {
				maker("Samsung", 5);
				tracker("Samsung's SmartThings Find", null, "a Samsung SmartTag, as it seems");
			} else if (u === 0xfcb2 && d.length >= 2) {
				// The trackers' common word (Apple's and Google's): the network, and a bit
				// that says it is near its owner
				tracker(d[0] === 1 ? "Apple's Find My" : d[0] === 2 ? "Google's Find My Device" : "a tracking network", !(d[1] & 1),
					"a location tracker");
			} else if (u === 0xfeed || u === 0xfeec || u === 0xfd84 || u === 0xfe33 || u === 0xfe65) {
				service(u);
				services.pop();
			} else if (u === 0xfe95) {
				maker("Xiaomi", 5);
				what("a Xiaomi device", 2);
			} else {
				kind(SERVICE_KIND[u], 3);
				memberMaker(u);
			}
			fact("Data for " + serviceName(u), d.length ? hex(d, " ") : "none");
		}

		parts.forEach(function (p) {
			var d = p.d, i, a, c;
			switch (p.type) {
			case 0x01:
				if (d.length) fact("Flags", "0x" + two(d[0]) + ": " + (d[0] & 2 ? "to be found by anybody" : d[0] & 1 ? "to be found for a while" : "not to be found") +
					(d[0] & 4 ? ", Low Energy only" : ", classic Bluetooth too"));
				break;
			case 0x02: case 0x03:
				for (i = 0; i + 2 <= d.length; i += 2) service(le16(d, i));
				break;
			case 0x04: case 0x05:
				for (i = 0; i + 4 <= d.length; i += 4) services.push("0x" + two(d[i + 3]) + two(d[i + 2]) + two(d[i + 1]) + two(d[i]));
				break;
			case 0x06: case 0x07:
				for (i = 0; i + 16 <= d.length; i += 16) service(uuidText(d, i));
				break;
			case 0x08:
				if (!shortName) shortName = tidy(utf8(d));
				break;
			case 0x09:
				s.name = tidy(utf8(d));
				break;
			case 0x0a:
				if (d.length) fact("Transmit power, as it says", s8(d[0]) + " dBm");
				break;
			case 0x0d:
				if (d.length >= 3) classSays(d[0] | d[1] << 8 | d[2] << 16);
				break;
			case 0x16:
				if (d.length >= 2) serviceData(le16(d, 0), d.subarray(2));
				break;
			case 0x19:
				if (d.length >= 2) {
					a = NAMES && NAMES.appearance(le16(d, 0));
					kind(LOOK_KIND[le16(d, 0) >> 6], 4);
					fact("Appearance, as it says", a ? a.name + (a.name !== a.category ? " (" + a.category + ")" : "") : "0x" + hex4(le16(d, 0)));
					if (a) what(/^[aeiou]/i.test(a.name) ? "an " + a.name.toLowerCase() : "a " + a.name.toLowerCase(), 4);
				}
				break;
			case 0x20:
				if (d.length >= 4) fact("Data for service 0x" + two(d[3]) + two(d[2]) + two(d[1]) + two(d[0]), hex(d.subarray(4), " "));
				break;
			case 0x21:
				if (d.length >= 16) fact("Data for " + serviceName(uuidText(d, 0)), hex(d.subarray(16), " "));
				break;
			case 0x24:
				fact("Address on the web", utf8(d.subarray(1)));
				break;
			case 0x29: case 0x2a: case 0x2b:
				kind("home", 3);
				what("a Bluetooth Mesh device", 3);
				break;
			case 0xff:
				if (d.length < 2) break;
				c = le16(d, 0);
				if (c === 0x004c && d.length >= 4) { appleSays(d); break; }
				if (c === 0x0006 && d.length >= 3) microsoftSays(d);
				else if (c === 0x0499 && ruuviSays(d)) maker("Ruuvi", 5);
				else maker(companyName(c), 4);
				fact("Maker's data, " + companyName(c), d.length > 2 ? hex(d.subarray(2), " ") : "none");
				break;
			default:
				fact("Type 0x" + two(p.type), d.length ? hex(d, " ") : "none");
			}
		});

		if (!s.name) s.name = shortName;
		if (services.length) fact(services.length > 1 ? "Services" : "Service", services.join(", "));
		if (apple.length) fact("Apple's messages", apple.join(", "));
		// What its name gives away, where nothing better has
		if (/\b(tv|bravia|roku|chromecast|fire ?tv)\b|\[tv\]/i.test(s.name)) { kind("home", 1); what("a TV or a media box, by its name", 1); }
		else if (/buds|airpods|headphone|earphone|earbud|soundbar|speaker|\bjbl\b|bose|soundcore|\bw[hf]-1000/i.test(s.name)) {
			kind("audio", 1);
			what("headphones or a speaker, by its name", 1);
		} else if (/watch|\bband\b|fitbit|garmin|amazfit|forerunner|fenix/i.test(s.name)) { kind("personal", 1); what("a watch or a band, by its name", 1); }
		if (s.tracker) {
			s.tags.unshift(["tracker", "warn"]);
			if (s.tracker.away === true) s.tags.push(["away from its owner", "bad"]);
			else if (s.tracker.away === false) s.tags.push(["with its owner", ""]);
			fact("Tracking network", s.tracker.network);
		}
		if (!s.kind) s.kind = "other";
		return s;
	}

	// A 128-bit UUID sent highest byte first, as Apple's beacons have it
	function uuidTextBE(d, o) {
		var s = "", i;
		for (i = 0; i < 16; i++) {
			s += two(d[o + i]);
			if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
		}
		return s.toUpperCase();
	}

	/* ---------- the devices ---------- */

	// The devices heard: one for each address (a public and a random address
	// alike are two), which for the many that change theirs every few minutes
	// is one for each address they have had. keep: one not heard for so long
	// is forgotten (ms); quiet: after so long it counts as gone quiet
	function Devices(o) {
		o = o || {};
		this.keep = o.keep || 300000;
		this.quiet = o.quiet || 30000;
		this.all = {};
		this.total = 0;
		this.adverts = 0;
	}

	// An advertising report (as reportsIn gives them), heard at `at` (ms)
	Devices.prototype.heard = function (r, at) {
		var id, d, gap, sec, h, g, changed = false;
		if (!r.addr || r.addrType === 0xff) return null;
		id = (r.addrType & 1 ? "r" : "p") + r.addr;
		d = this.all[id];
		if (!d) {
			d = this.all[id] = { id: id, addr: r.addr, addrType: r.addrType, addrKind: addrKind(r.addrType, r.addr),
				first: at, last: at, n: 0, rssi: null, level: null, lo: null, hi: null, gaps: [], every: null,
				pdu: null, connectable: false, extended: false, parts: {}, order: [], sent: null, seen: null, hist: [], rev: 0 };
			this.total++;
		} else {
			// How often it advertises: the gaps between what was heard of it, of
			// which the short ones tell (a long one is an advertisement missed)
			gap = at - d.last;
			if (gap >= 15 && gap <= 15000) {
				d.gaps.push(gap);
				if (d.gaps.length > 16) d.gaps.shift();
				g = d.gaps.slice().sort(function (a, b) { return a - b; });
				d.every = g[Math.floor((g.length - 1) / 4)];
			}
		}
		d.n++;
		this.adverts++;
		if (at > d.last) d.last = at;
		if (!r.response) {
			d.pdu = r.pdu;
			d.connectable = !!r.connectable;
			d.extended = !!r.extended;
		}
		if (r.rssi != null) {
			d.rssi = r.rssi;
			d.level = d.level == null ? r.rssi : d.level + (r.rssi - d.level) * 0.3;
			d.lo = d.lo == null ? r.rssi : Math.min(d.lo, r.rssi);
			d.hi = d.hi == null ? r.rssi : Math.max(d.hi, r.rssi);
			// The strongest it was heard in each second, for a while back
			sec = Math.floor(at / 1000);
			h = d.hist[d.hist.length - 1];
			if (h && h.t === sec) h.v = Math.max(h.v, r.rssi);
			else {
				d.hist.push({ t: sec, v: r.rssi });
				if (d.hist.length > 120) d.hist.shift();
			}
		}
		if (r.data && r.data.length) {
			partsOf(r.data).forEach(function (p) {
				var was = d.parts[p.key];
				if (was && same(was.d, p.d)) { was.at = at; return; }
				if (!was) {
					d.order.push(p.key);
					if (d.order.length > 48) delete d.parts[d.order.shift()];
				}
				// (a copy: what came is a window on the whole answer)
				d.parts[p.key] = { key: p.key, type: p.type, d: new Uint8Array(p.d), at: at };
				changed = true;
			});
			if (!r.response && (!d.sent || !same(d.sent, r.data))) d.sent = new Uint8Array(r.data);
		}
		if (changed || !d.seen) {
			d.seen = describe(d.order.map(function (k) { return d.parts[k]; }));
			d.rev++;
		}
		return d;
	};

	Devices.prototype.list = function () {
		var all = this.all;
		return Object.keys(all).map(function (k) { return all[k]; });
	};

	// Those not heard for too long are let go; how many went
	Devices.prototype.prune = function (now) {
		var n = 0, k;
		for (k in this.all) if (now - this.all[k].last > this.keep) { delete this.all[k]; n++; }
		return n;
	};

	// A capital to begin with, but not for a word that has its own further on (iBeacon)
	function capital(t) {
		return /^[a-z][a-z ]/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t;
	}

	// What a device is called on its line
	function titleOf(d) {
		var s = d.seen;
		if (s.name) return s.name;
		if (s.what) return capital(s.what.replace(/^an? /, ""));
		return "No name";
	}

	// The list in the order asked for. "signal": the strongest first, by its
	// smoothed strength in steps of 4 dB, so that two about as strong do not
	// keep changing places; then as they came
	function order(list, by) {
		function bucket(d) { return d.level == null ? -999 : Math.round(d.level / 4); }
		function text(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
		return list.sort(function (a, b) {
			var r = 0;
			if (by === "name") r = text((a.seen.name ? "0" : "1") + titleOf(a).toLowerCase(), (b.seen.name ? "0" : "1") + titleOf(b).toLowerCase());
			else if (by === "new") r = b.first - a.first;
			else if (by === "heard") r = b.last - a.last;
			else r = bucket(b) - bucket(a);
			return r || a.first - b.first || text(a.id, b.id);
		});
	}

	// Does a device answer to what was typed? (its name, what it is, its
	// maker, its address)
	function matches(d, q) {
		var s = d.seen;
		q = q.trim().toLowerCase();
		if (!q) return true;
		return (s.name + "\n" + s.what + "\n" + s.maker + "\n" + d.addr + "\n" + KIND_NAME[s.kind] + "\n" +
			s.tags.map(function (t) { return t[0]; }).join("\n")).toLowerCase().indexOf(q) >= 0;
	}

	/* ---------- a made-up neighbourhood, for the demo ---------- */

	function prng(seed) {
		var a = seed >>> 0;
		return function () {
			a = (a + 0x6D2B79F5) >>> 0;
			var t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	// An advertisement's data from its structures, each [type, bytes...]
	function adOf() {
		var out = [], i, p;
		for (i = 0; i < arguments.length; i++) {
			p = arguments[i];
			out.push(p.length);
			Array.prototype.push.apply(out, p);
		}
		return new Uint8Array(out);
	}
	function ascii(s) { return s.split("").map(function (c) { return c.charCodeAt(0); }); }
	function bytes(s) { return Array.prototype.slice.call(unhex(s)); }

	// Who is about: where (the address and its type: 1 random), how (pdu),
	// how strong and how often, and what they say. from and until (seconds
	// after the start): one that comes by and goes
	function demoCast() {
		var FLAGS = [0x01, 0x06];
		return [
			{ addr: "5B:3C:91:0A:44:E2", pdu: 0, rssi: -57, every: 290, data: [
				adOf([0x01, 0x1a], [0xff, 0x4c, 0x00, 0x10, 0x05, 0x01, 0x18, 0x9a, 0x3c, 0x71]),
				adOf([0x01, 0x1a], [0xff, 0x4c, 0x00, 0x0c, 0x0e, 0x00].concat(bytes("2f9a11c05b7e0d43a6b2f81e9c")), [0x0a, 0x0c]) ] },
			{ addr: "6E:10:22:7C:A3:15", pdu: 0, rssi: -61, every: 210,
				data: adOf([0xff, 0x4c, 0x00, 0x07, 0x19, 0x01, 0x0e, 0x20].concat(bytes("2b998f010005a1c4e87d3b52f0966e1d44a7c3085bd9"))) },
			{ addr: "EA:0B:0C:0D:0E:0F", pdu: 0, rssi: -74, every: 2000,
				data: adOf([0xff, 0x4c, 0x00, 0x12, 0x19, 0x10].concat(bytes("a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6"), [0x01, 0x00])) },
			{ addr: "D1:7E:43:9A:02:6C", pdu: 0, rssi: -63, every: 2000,
				data: adOf([0x01, 0x1a], [0xff, 0x4c, 0x00, 0x12, 0x02, 0x14, 0x03]) },
			{ addr: "1A:44:0C:E7:93:B8", pdu: 3, rssi: -60, every: 115,
				data: adOf([0xff, 0x06, 0x00, 0x01, 0x0f, 0x20, 0x22].concat(bytes("5c1e09d7a3f2484bb16e7702c9d53a8ef0126b94"))) },
			{ addr: "D3:91:5E:20:7A:44", pdu: 0, rssi: -49, every: 105,
				data: adOf(FLAGS, [0x19, 0xc2, 0x03], [0xff, 0x06, 0x00, 0x03, 0x00, 0x80].concat(ascii("Desk Mouse"))) },
			{ addr: "4C:E0:7B:11:9D:5A", pdu: 0, rssi: -66, every: 260,
				data: adOf(FLAGS, [0x16, 0x2c, 0xfe, 0x2e, 0x0d, 0x41], [0x0a, 0xf5], [0x09].concat(ascii("Pocket Buds"))) },
			{ addr: "C6:05:04:03:02:01", pdu: 3, rssi: -79, every: 350,
				data: adOf(FLAGS, [0xff, 0x4c, 0x00, 0x02, 0x15].concat(bytes("f7826da64fa24e988024bc5b71e0893e"), [0x00, 0x01, 0x00, 0x02, 0xc5])) },
			{ addr: "F0:4E:22:6B:C1:08", pdu: 3, rssi: -84, every: 700,
				data: adOf(FLAGS, [0x03, 0xaa, 0xfe], [0x16, 0xaa, 0xfe, 0x10, 0xee, 0x03].concat(ascii("example"), [0x00])) },
			{ addr: "CB:B8:33:4C:88:4F", pdu: 0, rssi: -70, every: 1285, ruuvi: true },
			{ addr: "E7:2A:90:4F:16:B3", pdu: 0, rssi: -68, every: 1000,
				data: adOf(FLAGS, [0x03, 0x0d, 0x18], [0x19, 0x41, 0x03], [0x09].concat(ascii("HRM-Dual:048812"))) },
			{ addr: "F8:1D:66:A0:35:7E", pdu: 0, rssi: -52, every: 480,
				data: adOf(FLAGS, [0xff, 0x75, 0x00, 0x42, 0x04, 0x01, 0x80, 0x60], [0x09].concat(ascii("Living Room TV"))) },
			{ addr: "DF:30:5C:88:12:E9", pdu: 0, rssi: -81, every: 2000,
				data: adOf(FLAGS, [0x03, 0xed, 0xfe], [0x16, 0xed, 0xfe, 0x02, 0x00].concat(bytes("7a11c93e5d02b4f6"))) },
			{ addr: "62:9C:14:F3:0B:A7", pdu: 0, rssi: -77, every: 2000,
				data: adOf(FLAGS, [0x03, 0x5a, 0xfd], [0x16, 0x5a, 0xfd, 0x13].concat(bytes("5e09c1d47a2f8830b6e4159c27d0a3f1c855"))) },
			{ addr: "3D:71:E2:5A:C0:19", pdu: 3, rssi: -88, every: 2000,
				data: adOf([0x16, 0xaa, 0xfe, 0x41].concat(bytes("09f3a25c7d1e84b6402fc9153ae78d06b1c4"), [0x5f])) },
			{ addr: "EC:52:0A:9F:3A:D4", pdu: 0, rssi: -64, every: 1000,
				data: adOf(FLAGS, [0x07].concat(bytes("9ecadc240ee5a9e093f3a3b50100406e")), [0x08].concat(ascii("T-Echo"))) },
			{ addr: "2B:60:D8:07:E1:3C", pdu: 3, rssi: -90, every: 1100,
				data: adOf([0x01, 0x04], [0xff, 0x23, 0xf1, 0x01, 0x02, 0x03, 0x04]) },
			// Two who walk past: a phone, then somebody's headphones
			{ addr: "7A:C4:1F:08:B2:6D", pdu: 0, rssi: -52, every: 300, from: 15, until: 75,
				data: adOf([0x01, 0x1a], [0xff, 0x4c, 0x00, 0x10, 0x06, 0x1d, 0x1e, 0x4b, 0xa2, 0x09, 0x58]) },
			{ addr: "55:E9:03:D6:71:AA", pdu: 0, rssi: -55, every: 240, from: 100, until: 150,
				data: adOf(FLAGS, [0x16, 0x2c, 0xfe, 0x00, 0x90, 0x7c, 0x21, 0x4e, 0xd3], [0x0a, 0xf8]) }
		];
	}

	// A RuuviTag's data for a temperature (°C) and a humidity (%)
	function ruuviData(temp, humidity) {
		var t = Math.round(temp / 0.005) & 0xffff, h = Math.round(humidity / 0.0025);
		return adOf([0x01, 0x06], [0xff, 0x99, 0x04, 0x05, t >> 8, t & 255, h >> 8, h & 255, 0xc3, 0x7c,
			0x00, 0x04, 0xff, 0xfc, 0x04, 0x0c, 0xac, 0x36, 0x42, 0x00, 0xcd, 0xcb, 0xb8, 0x33, 0x4c, 0x88, 0x4f]);
	}

	// What pirate-bluetooth would answer, with those about: status() and
	// reports(), as the page calls them. o.now: the clock (ms); o.seed
	function demoAdapter(o) {
		o = o || {};
		var clock = o.now || Date.now, rand = prng(o.seed || 7), t0 = clock(), last = t0, seq = 0, heard = 0;
		var cast = demoCast();
		cast.forEach(function (c, i) {
			c.next = t0 + rand() * c.every;
			c.phase = rand() * 6.283;
			c.swing = 3 + rand() * 4;
			c.bytes = unhex(c.addr).reverse();
			c.turn = i;
		});

		function strength(c, t) {
			var s = (t - t0) / 1000, at;
			if (c.from != null) {
				// Coming nearer, then going: weakest at either end
				at = (s - c.from) / (c.until - c.from);
				return c.rssi - 40 * Math.abs(2 * at - 1) + (rand() - 0.5) * 5;
			}
			return c.rssi + c.swing * Math.sin(s / 9 + c.phase) + (rand() - 0.5) * 5;
		}
		function dataOf(c, t) {
			if (c.ruuvi) return ruuviData(21.4 + Math.sin((t - t0) / 60000) * 0.6, 45.3);
			return c.data.length && c.data[0] instanceof Uint8Array ? c.data[c.turn++ % c.data.length] : c.data;
		}

		return {
			status: function () {
				return Promise.resolve({ state: "listening", adapter: "hci0", usb: "0a12:0001", usb_version: "8891",
					product: "CSR8510 A10", address: "00:1A:7D:DA:71:13", hci_version: 6, hci_revision: 0x22bb,
					lmp_version: 6, lmp_subversion: 0x22bb, maker: 10, extended: false, heard: heard, listening_ms: clock() - t0 });
			},
			reports: function () {
				var now = clock(), from = Math.max(last, now - 5000), evs = [], size = 0, out, o = 0;
				cast.forEach(function (c) {
					var s, d, rssi;
					for (; c.next <= now; c.next += c.every * (0.94 + 0.12 * rand())) {
						s = (c.next - t0) / 1000;
						// (one in eight is missed, as on the air)
						if (c.next <= from || (c.from != null && (s < c.from || s >= c.until)) || rand() < 0.125) continue;
						d = dataOf(c, c.next);
						rssi = Math.max(-100, Math.min(-30, Math.round(strength(c, c.next))));
						evs.push({ t: c.next, c: c, d: d, rssi: rssi });
						size += 7 + 12 + d.length;
					}
				});
				evs.sort(function (a, b) { return a.t - b.t; });
				out = new Uint8Array(size);
				evs.forEach(function (e) {
					var n = 12 + e.d.length, t = e.t >>> 0;
					// A record: its length, when, the event (LE Meta), and in it one advertising report
					out[o++] = (5 + n) & 255;
					out[o++] = (5 + n) >> 8;
					out[o++] = t & 255;
					out[o++] = t >>> 8 & 255;
					out[o++] = t >>> 16 & 255;
					out[o++] = t >>> 24 & 255;
					out[o++] = 0x3e;
					out[o++] = 0x02;
					out[o++] = 1;
					out[o++] = e.c.pdu;
					out[o++] = 1;
					out.set(e.c.bytes, o);
					o += 6;
					out[o++] = e.d.length;
					out.set(e.d, o);
					o += e.d.length;
					out[o++] = e.rssi & 255;
				});
				last = now;
				seq += evs.length;
				heard += evs.length;
				return Promise.resolve({ state: "listening", seq: seq, now: now >>> 0, data: b64enc(out) });
			}
		};
	}

	/* ---------- the page ---------- */

	var ADDR_KIND = {
		"public": ["its own", "Its own for good, out of its maker's block of addresses."],
		"static": ["its own, random", "Random, and its own all the same: it keeps it, at least until it is restarted."],
		"resolvable": ["changes", "Private: it takes a new one every few minutes. What it is paired with can tell it is the same device; nothing else can, so it may be on several lines here."],
		"unresolvable": ["changes", "Random, and changed as it likes: nothing can tell it is the same device from one to the next."],
		"random": ["random", "Random."]
	};

	function ago(ms) {
		var s = Math.round(ms / 1000);
		return s < 3 ? "now" : s < 90 ? s + " s ago" : Math.round(s / 60) + " min ago";
	}
	function clockTime(ms) {
		var t = new Date(ms);
		function p(v) { return (v < 10 ? "0" : "") + v; }
		return p(t.getHours()) + ":" + p(t.getMinutes()) + ":" + p(t.getSeconds());
	}
	function every(ms) {
		return ms == null ? "" : ms < 1000 ? "about every " + Math.round(ms / 10) * 10 + " ms" : "about every " + (ms / 1000).toFixed(1) + " s";
	}

	function mount(node, opts) {
		opts = opts || {};
		var be = opts.demo ? demoAdapter() : {
			status: function () { return opts.call("pirate.bluetooth", "status"); },
			reports: function (p) { return opts.call("pirate.bluetooth", "reports", p); }
		};
		var alive = true, paused = false, timer = null, drawT = null, waiting = false;
		var seq = null, state = "", stat = null, problem = "", lost = 0, since = Date.now(), tally = [];
		var devs = new Devices(), rows = {}, open = {}, shown = "", chipsKey = "", want = { kind: "", q: "", sort: "signal" };

		function button(label, cls, fn) {
			return el("button", { type: "button", class: "btn" + (cls ? " " + cls : ""), text: label, onclick: fn });
		}

		var dot = el("span", { class: "bt-dot" }), line = el("span", { class: "bt-line" });
		var pauseBtn = button("Pause", "", function () { setPaused(!paused); });
		var note = el("div");
		var search = el("input", { class: "inp bt-search", type: "search", placeholder: "Find: a name, a maker, an address",
			"aria-label": "Find among the devices", oninput: function () { want.q = search.value; draw(); } });
		var sortSel = el("select", { class: "sel", "aria-label": "Order", onchange: function () { want.sort = sortSel.value; draw(); } },
			el("option", { value: "signal", text: "Strongest first" }), el("option", { value: "heard", text: "Last heard first" }),
			el("option", { value: "new", text: "Newest first" }), el("option", { value: "name", text: "By name" }));
		var chips = el("div", { class: "bt-chips" });
		var stats = el("div", { class: "status bt-stats" });
		var listEl = el("div", { class: "bt-list", role: "list" });
		var head = el("div", { class: "bt-head", "aria-hidden": "true" },
			el("span", { text: "Signal" }), el("span", { text: "Device" }), el("span", { text: "" }),
			el("span", { text: "Maker" }), el("span", { text: "Address" }), el("span", { text: "Heard" }));
		var empty = el("div", { class: "placeholder" });
		var about = el("dl", { class: "kv" });
		var body = el("div", { class: "bt-body" },
			el("div", { class: "toolbar bt-controls" }, search, sortSel), chips, stats, head, listEl, empty);

		node.appendChild(el("div", { class: "bt" },
			el("div", { class: "toolbar bt-top" }, dot, line, pauseBtn),
			note, body,
			el("details", { class: "raw" }, el("summary", { text: "The adapter" }), about),
			el("p", { class: "descr bt-foot", text: "It only listens. Nothing here asks a device anything or connects to it, so a device that " +
				"does not advertise is not seen, and one that is seen cannot tell. Phones, watches and trackers change their addresses " +
				"every few minutes: one of them may be several lines here, until the old ones are let go (five minutes unheard)." })));

		/* ---- a device's line ---- */

		function rowFor(d) {
			var r = rows[d.id];
			if (r) return r;
			r = rows[d.id] = { rev: -1, txt: {}, moreKey: "" };
			r.bars = el("span", { class: "bt-bars n0", "aria-hidden": "true" }, el("i"), el("i"), el("i"), el("i"), el("i"));
			r.dbm = el("span", { class: "bt-dbm" });
			r.name = el("strong", { class: "bt-name" });
			r.what = el("span", { class: "bt-what" });
			r.tags = el("span", { class: "bt-tags" });
			r.maker = el("span", { class: "bt-maker" });
			r.addr = el("span", { class: "bt-addr" });
			r.seen = el("span", { class: "bt-seen" });
			r.head = el("button", { type: "button", class: "bt-row", "aria-expanded": "false" },
				el("span", { class: "bt-sig" }, r.bars, r.dbm), el("span", { class: "bt-who" }, r.name, r.what),
				r.tags, r.maker, r.addr, r.seen);
			r.more = el("div", { class: "bt-more", hidden: "" });
			r.el = el("div", { class: "bt-item", role: "listitem" }, r.head, r.more);
			r.head.addEventListener("click", function () {
				open[d.id] = !open[d.id];
				r.moreKey = "";
				draw();
			});
			return r;
		}

		function setText(r, k, n, text) {
			if (r.txt[k] === text) return;
			r.txt[k] = text;
			n.textContent = text;
		}

		// How strongly it was heard over the last two minutes, a bar a second
		function spark(d, now) {
			var c = el("canvas", { class: "bt-spark", width: "360", height: "44" }), g = c.getContext && c.getContext("2d");
			var end = Math.floor(now / 1000), i, h, x, v;
			if (!g) return c;
			g.fillStyle = "#e0a040";
			for (i = 0; i < d.hist.length; i++) {
				h = d.hist[i];
				x = 360 - (end - h.t + 1) * 3;
				if (x < 0) continue;
				// -100 dBm: nothing; -40: the whole height
				v = Math.max(1, Math.min(44, (h.v + 100) / 60 * 44));
				g.fillRect(x, 44 - v, 2, v);
			}
			return c;
		}

		function more(d, r, now) {
			var s = d.seen, k = ADDR_KIND[d.addrKind], dl, key;
			// (drawn again only when there is something else to say)
			key = d.rev + "|" + d.n + "|" + Math.floor(now / 1000);
			if (key === r.moreKey) return;
			r.moreKey = key;
			dl = el("dl", { class: "kv" });
			function kv(a, b) {
				if (b == null || b === "") return;
				dl.appendChild(el("dt", { text: a }));
				dl.appendChild(el("dd", { text: String(b) }));
			}
			kv("It is", s.what ? capital(s.what) : "Not said");
			kv("Kind", KIND_NAME[s.kind]);
			kv("Address", d.addr + ": " + k[1]);
			kv("Heard", d.n + (d.n === 1 ? " time" : " times") + ", first at " + clockTime(d.first) + (d.every ? ", " + every(d.every) : ""));
			kv("Signal", d.rssi == null ? "the adapter does not say" : d.rssi + " dBm now, between " + d.lo + " and " + d.hi);
			kv("Advertises", d.pdu != null ? (d.connectable ? "and can be connected to" : "only: it cannot be connected to") + " (" + PDU[d.pdu] + ")" :
				d.connectable ? "and can be connected to" : "only: it cannot be connected to");
			s.facts.forEach(function (f) { kv(f[0], f[1]); });
			kv("As sent", d.sent ? hex(d.sent, " ") : "");
			clear(r.more).appendChild(spark(d, now));
			r.more.appendChild(dl);
		}

		function paint(d, r, now) {
			var s = d.seen, gone = now - d.last > devs.quiet, lvl = d.level == null ? null : Math.round(d.level);
			var bars = lvl == null || gone ? 0 : lvl >= -55 ? 5 : lvl >= -65 ? 4 : lvl >= -75 ? 3 : lvl >= -85 ? 2 : 1;
			if (r.txt.bars !== bars) {
				r.txt.bars = bars;
				r.bars.className = "bt-bars n" + bars;
			}
			if (r.txt.gone !== gone) {
				r.txt.gone = gone;
				r.el.className = "bt-item" + (gone ? " gone" : "");
			}
			setText(r, "dbm", r.dbm, lvl == null ? "" : lvl + " dBm");
			setText(r, "name", r.name, titleOf(d));
			setText(r, "what", r.what, s.name && s.what ? s.what : s.name ? "" : KIND_NAME[s.kind]);
			setText(r, "maker", r.maker, s.maker);
			setText(r, "addr", r.addr, d.addr);
			setText(r, "seen", r.seen, ago(now - d.last));
			if (r.txt.kind !== d.addrKind) {
				r.txt.kind = d.addrKind;
				r.addr.title = ADDR_KIND[d.addrKind][1];
			}
			if (r.rev !== d.rev) {
				r.rev = d.rev;
				r.name.className = "bt-name" + (s.name ? "" : " unnamed");
				clear(r.tags);
				s.tags.forEach(function (t) {
					r.tags.appendChild(el("span", { class: "b" + (t[1] === "bad" ? " sec-open" : t[1] === "warn" ? " sec-warn" : ""), text: t[0] }));
				});
			}
			if (!!open[d.id] !== !r.more.hidden) {
				r.more.hidden = !open[d.id];
				r.head.setAttribute("aria-expanded", open[d.id] ? "true" : "false");
			}
			if (open[d.id]) more(d, r, now);
		}

		/* ---- the whole of it ---- */

		function chipsDraw(counts, n) {
			var key = want.kind + "|" + n + "|" + KINDS.map(function (k) { return counts[k[0]] || 0; }).join(",");
			if (key === chipsKey) return;
			chipsKey = key;
			clear(chips);
			function chip(id, label, count) {
				chips.appendChild(el("button", { type: "button", class: "mode-chip bt-chip" + (want.kind === id ? " on" : ""),
					text: label + " " + count, onclick: function () { want.kind = id; draw(); } }));
			}
			chip("", "All", n);
			KINDS.forEach(function (k) { if (counts[k[0]] || want.kind === k[0]) chip(k[0], k[1], counts[k[0]] || 0); });
		}

		function aboutDraw() {
			var s = stat || {}, lookalike;
			clear(about);
			function kv(a, b) {
				if (b == null || b === "") return;
				about.appendChild(el("dt", { text: a }));
				about.appendChild(el("dd", { text: String(b) }));
			}
			if (opts.demo) kv("Demo", "made up: no adapter is used");
			kv("Adapter", s.adapter);
			kv("On USB as", (s.usb || "") + (s.product ? " " + s.product : "") + (s.usb_version ? ", version " + s.usb_version : ""));
			kv("Address", s.address);
			if (s.hci_version != null) {
				kv("Bluetooth", (BT_VERSION[s.hci_version] || "version " + s.hci_version) +
					" (HCI " + s.hci_version + " revision 0x" + hex4(s.hci_revision) + ", LMP " + s.lmp_version + " subversion 0x" + hex4(s.lmp_subversion) + ")");
				kv("Chip by", companyName(s.maker) + " (" + s.maker + ")");
				// A dongle under CSR's USB number whose chip answers otherwise: as the
				// kernel's driver tells them apart
				lookalike = s.usb === "0a12:0001" && (s.maker !== 10 || s.hci_revision !== s.lmp_subversion);
				if (s.usb === "0a12:0001") kv("CSR's own", lookalike ? "no: it answers as another chip under CSR's number (a look-alike). It listens all the same." : "yes, by what it answers");
			}
			if (state === "listening") kv("Listening", "a passive scan" + (s.extended ? ", with the extended commands" : "") + ": it sends nothing");
			if (s.heard != null) kv("Heard this time", s.heard + " advertisements");
		}

		function draw() {
			if (!alive) return;
			var now = Date.now(), all, vis, counts = {}, inRange = 0, ids, seenIds = {}, rate = 0, text, k, tooOld;
			devs.prune(now);
			all = devs.list();
			all.forEach(function (d) {
				counts[d.seen.kind] = (counts[d.seen.kind] || 0) + 1;
				if (now - d.last <= devs.quiet) inRange++;
			});
			chipsDraw(counts, all.length);
			vis = order(all.filter(function (d) { return (!want.kind || d.seen.kind === want.kind) && matches(d, want.q); }), want.sort);
			vis.forEach(function (d) {
				seenIds[d.id] = true;
				paint(d, rowFor(d), now);
			});
			ids = vis.map(function (d) { return d.id; }).join(",");
			if (ids !== shown) {
				shown = ids;
				vis.forEach(function (d) { listEl.appendChild(rows[d.id].el); });
				for (k in rows) {
					if (seenIds[k]) continue;
					if (rows[k].el.parentNode) rows[k].el.parentNode.removeChild(rows[k].el);
					if (!devs.all[k]) { delete rows[k]; delete open[k]; }
				}
			}
			tally = tally.filter(function (t) { return now - t.t <= 5000; });
			tally.forEach(function (t) { rate += t.n; });
			stats.textContent = all.length ? inRange + " heard now, " + devs.total + " since " + clockTime(since).slice(0, 5) +
				" · " + Math.round(rate / 5) + " advertisements a second" + (lost ? " · " + lost + " missed (this page was slow to ask)" : "") : "";

			// What is to be said in place of the list, or over it
			// An adapter from before Bluetooth 4.0 (HCI version 6) has no Low
			// Energy: nothing to try again, and nothing wrong with it
			tooOld = state === "failed" && !!stat && stat.hci_version != null && stat.hci_version < 6;
			text = paused ? "Paused" : state === "listening" ? "Listening" + (stat && (stat.product || stat.adapter) ? " on " + (stat.product || stat.adapter) : "") :
				state === "absent" ? "No Bluetooth adapter" : tooOld ? "No Low Energy on this dongle" : state === "failed" ? "The adapter failed" :
				state === "idle" || state === "starting" ? "Starting the adapter…" : problem ? "No answer" : "Looking for the adapter…";
			if (opts.demo && !paused) text += " (demo: a made-up neighbourhood)";
			line.textContent = text;
			dot.className = "bt-dot" + (paused ? "" : state === "listening" ? " on" : state === "failed" || problem ? " bad" : "");
			pauseBtn.textContent = paused ? "Listen" : "Pause";
			pauseBtn.hidden = !paused && state !== "listening";
			clear(note);
			if (problem) note.appendChild(el("div", { class: "alert warn", text: problem }));
			else if (tooOld) note.appendChild(el("div", { class: "alert warn", text: "This dongle is Bluetooth " + (BT_VERSION[stat.hci_version] || "from before 4.0") +
				": it has no Low Energy, and what Low Energy devices advertise is all this page listens to. A dongle of Bluetooth 4.0 or later will do." }));
			else if (state === "failed" && stat && stat.error) note.appendChild(el("div", { class: "alert warn", text: "The adapter: " + stat.error + ". Trying again every few seconds." }));
			else if (state === "absent" && stat && stat.error) note.appendChild(el("div", { class: "alert warn", text: stat.error.replace(/^./, function (c) { return c.toUpperCase(); }) + "." }));
			head.hidden = listEl.hidden = !vis.length;
			body.hidden = (state === "absent" || tooOld) && !all.length;
			clear(empty);
			empty.hidden = !!vis.length;
			if (!vis.length) {
				if (state === "absent" || tooOld) { empty.hidden = true; }
				else if (all.length) empty.appendChild(el("b", { text: "None of the " + all.length + " heard match" }));
				else if (state === "listening") {
					empty.appendChild(el("b", { text: "Nothing heard yet" }));
					empty.appendChild(el("div", { text: "What advertises nearby shows here within a few seconds." }));
				} else empty.appendChild(el("b", { text: paused ? "Paused" : "Waiting for the adapter…" }));
			}
			if (state === "absent" && !all.length && !note.firstChild) {
				note.appendChild(el("div", { class: "placeholder" }, el("b", { text: "No Bluetooth adapter" }),
					el("div", { text: "Plug a Bluetooth dongle into the router's USB port (through a hub if something else is plugged in too). It shows up here within a few seconds." }),
					el("div", { text: "One that is plugged in and still not here may not have answered the router: the Status page says whether it did, and can switch the USB port off and on." })));
			}
		}

		/* ---- asking the router ---- */

		function status() {
			return be.status().then(function (s) {
				if (!alive) return;
				stat = s;
				aboutDraw();
				draw();
			}, function () {});
		}

		function took(r) {
			var now = Date.now(), n = 0;
			problem = "";
			if (r.state !== state) {
				state = r.state || "";
				status();
			}
			if (r.error && stat && stat.error !== r.error) status();
			if (r.lost) lost += r.lost;
			if (r.data) {
				records(b64dec(r.data)).forEach(function (rec) {
					if (rec.evt !== 0x3e) return;
					// (when it was heard, on this clock: as long ago as the router says)
					var at = now - ((r.now - rec.t) >>> 0);
					reportsIn(rec.p).forEach(function (rep) {
						if (devs.heard(rep, at)) n++;
					});
				});
			}
			if (n) tally.push({ t: now, n: n });
			if (r.seq != null) seq = r.seq;
		}

		function failed(e) {
			var msg = String((e && e.message) || e);
			if (msg === "unauthorized") {
				alive = false;
				if (opts.unauthorized) opts.unauthorized(e);
				return;
			}
			state = "";
			problem = msg === "ubus status 4" ?
				"The Bluetooth service (pirate-bluetooth) isn't running on this router: its firmware may predate the Bluetooth page." :
				"The router did not answer (" + msg + ").";
			draw();
		}

		// Asking is what keeps the adapter listening: so not while paused, and
		// not while nobody is looking at the page
		function ask() {
			timer = null;
			if (!alive || paused || waiting || (typeof document !== "undefined" && document.hidden)) return;
			var t0 = Date.now();
			waiting = true;
			be.reports(seq == null ? {} : { seq: seq }).then(function (r) {
				waiting = false;
				if (!alive) return;
				took(r || {});
				// A quarter of a second's worth at a time; slower while there is no adapter to hear
				next(state === "listening" || state === "starting" || state === "idle" ? Math.max(0, 250 - (Date.now() - t0)) : 2000);
			}, function (e) {
				waiting = false;
				if (!alive) return;
				failed(e);
				if (alive) next(5000);
			});
		}
		function next(ms) {
			if (timer) clearTimeout(timer);
			timer = alive && !paused ? setTimeout(ask, ms) : null;
		}
		function setPaused(p) {
			paused = p;
			if (!p) { seq = null; next(0); }
			draw();
		}
		function onShow() {
			if (alive && !paused && !document.hidden && !timer) next(0);
		}

		if (typeof document !== "undefined") document.addEventListener("visibilitychange", onShow);
		drawT = setInterval(draw, 500);
		aboutDraw();
		draw();
		status();
		next(0);

		return {
			destroy: function () {
				if (!alive && !drawT) return;
				alive = false;
				if (timer) clearTimeout(timer);
				clearInterval(drawT);
				drawT = null;
				if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onShow);
			}
		};
	}

	// (pure: the parts with no page to them, for tests/bt/)
	window.PirateBT = { mount: mount, pure: {
		records: records, reportsIn: reportsIn, addrKind: addrKind, adParts: adParts, partsOf: partsOf, describe: describe,
		Devices: Devices, order: order, matches: matches, titleOf: titleOf, demoAdapter: demoAdapter,
		b64dec: b64dec, b64enc: b64enc, utf8: utf8, unhex: unhex, hex: hex, KINDS: KINDS, PDU: PDU
	} };
})();
