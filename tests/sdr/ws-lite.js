/* WebSocket (RFC 6455) in as little as the tests need, with nothing but
   Node's own modules: a server (for the mock bridge) and a client that looks
   like a browser's WebSocket to the receiver's engine (Node 20 has none of
   its own). No extensions, no TLS. */
"use strict";

const http = require("http"), net = require("net"), crypto = require("crypto");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TEXT = 1, BINARY = 2, CLOSE = 8, PING = 9, PONG = 10;

function acceptFor(key) {
	return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

// One frame: FIN set, masked if it is the client's
function encode(opcode, payload, mask) {
	const n = payload.length, head = n < 126 ? 2 : n < 65536 ? 4 : 10;
	const out = Buffer.allocUnsafe(head + (mask ? 4 : 0) + n);
	out[0] = 0x80 | opcode;
	if (n < 126) out[1] = n;
	else if (n < 65536) { out[1] = 126; out.writeUInt16BE(n, 2); }
	else { out[1] = 127; out.writeUInt32BE(Math.floor(n / 4294967296), 2); out.writeUInt32BE(n >>> 0, 6); }
	if (mask) {
		out[1] |= 0x80;
		const key = crypto.randomBytes(4);
		key.copy(out, head);
		for (let i = 0; i < n; i++) out[head + 4 + i] = payload[i] ^ key[i & 3];
	} else payload.copy(out, head);
	return out;
}

function toBuffer(data) {
	if (Buffer.isBuffer(data)) return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	return Buffer.from(String(data), "utf8");
}

// Bytes in, frames out: onFrame(opcode, payload, masked). Fragments are put
// back together. onError(code) for what breaks the protocol.
class Reader {
	constructor(onFrame, onError) {
		this.onFrame = onFrame;
		this.onError = onError;
		this.buf = Buffer.alloc(0);
		this.parts = null;
		this.partOp = 0;
	}
	push(chunk) {
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		for (;;) {
			const buf = this.buf;
			if (buf.length < 2) return;
			const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
			let len = buf[1] & 0x7f, off = 2;
			if (buf[0] & 0x70) { this.onError(1002); return; }
			if (len === 126) {
				if (buf.length < 4) return;
				len = buf.readUInt16BE(2);
				off = 4;
			} else if (len === 127) {
				if (buf.length < 10) return;
				len = buf.readUInt32BE(2) * 4294967296 + buf.readUInt32BE(6);
				off = 10;
			}
			if (masked) off += 4;
			if (buf.length < off + len) return;
			let data = buf.subarray(off, off + len);
			if (masked) {
				const key = buf.subarray(off - 4, off);
				data = Buffer.from(data);
				for (let i = 0; i < len; i++) data[i] ^= key[i & 3];
			}
			this.buf = buf.subarray(off + len);
			if (op >= 8) this.onFrame(op, data, !!masked);
			else if (op === 0) {
				if (!this.parts) { this.onError(1002); return; }
				this.parts.push(data);
				if (fin) { const all = Buffer.concat(this.parts); this.parts = null; this.onFrame(this.partOp, all, !!masked); }
			} else if (fin) this.onFrame(op, data, !!masked);
			else { this.parts = [data]; this.partOp = op; }
		}
	}
}

/* ---------- the server's side of a connection ---------- */

class Connection {
	constructor(socket) {
		const self = this;
		this.socket = socket;
		this.open = true;
		this.onmessage = null;     // (data, isBinary): a string, or a Buffer
		this.onclose = null;       // (code)
		this.reader = new Reader(function (op, data, masked) {
			// What a client sends is masked, always
			if (!masked) { self.close(1002); return; }
			if (op === TEXT) { if (self.onmessage) self.onmessage(data.toString("utf8"), false); }
			else if (op === BINARY) { if (self.onmessage) self.onmessage(data, true); }
			else if (op === PING) self._write(encode(PONG, data, false));
			else if (op === CLOSE) self._closed(data.length >= 2 ? data.readUInt16BE(0) : 1005, true);
		}, function (code) { self.close(code); });
		socket.on("data", function (chunk) { if (self.open) self.reader.push(chunk); });
		// The other end hung up without a goodbye. A socket that an http.Server
		// hands over is one that stays half open then (allowHalfOpen), with no
		// "close" until this end closes too: so "end" is the word to go by.
		socket.on("end", function () { self._closed(1006, false); });
		socket.on("close", function () { self._closed(1006, false); });
		socket.on("error", function () {});
	}
	_write(buf) {
		if (this.open && !this.socket.destroyed) this.socket.write(buf);
	}
	send(data) {
		this._write(encode(typeof data === "string" ? TEXT : BINARY, toBuffer(data), false));
	}
	// Bytes waiting to leave: what a slow client has not taken yet
	get buffered() { return this.socket.writableLength; }
	close(code) {
		if (!this.open) return;
		const b = Buffer.alloc(2);
		b.writeUInt16BE(code || 1000, 0);
		this._write(encode(CLOSE, b, false));
		this._closed(code || 1000, false);
	}
	_closed(code, answer) {
		if (!this.open) return;
		if (answer && code !== 1006 && !this.socket.destroyed) {
			const b = Buffer.alloc(2);
			b.writeUInt16BE(code === 1005 ? 1000 : code, 0);
			try { this.socket.write(encode(CLOSE, b, false)); } catch (e) {}
		}
		this.open = false;
		this.socket.end();
		if (this.onclose) this.onclose(code);
	}
}

/* createServer({ verify(req), onConnection(conn, req), plain })
   verify: return null to accept, or { status, reason, text } to refuse the
   handshake. plain: the answer to a request that is not a WebSocket's.
   Returns the http.Server: listen() on it. */
function createServer(o) {
	const plain = o.plain || { status: 426, reason: "Upgrade Required", text: "a WebSocket endpoint\n" };
	const server = http.createServer(function (req, res) {
		res.writeHead(plain.status, plain.reason, { "Content-Type": "text/plain", "Connection": "close", "Upgrade": "websocket" });
		res.end(plain.text);
	});
	server.on("upgrade", function (req, socket, head) {
		const key = req.headers["sec-websocket-key"];
		function refuse(r) {
			socket.end("HTTP/1.1 " + r.status + " " + r.reason + "\r\nContent-Type: text/plain\r\nContent-Length: " + Buffer.byteLength(r.text) +
				"\r\nConnection: close\r\n\r\n" + r.text);
		}
		if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket" || req.headers["sec-websocket-version"] !== "13")
			return refuse({ status: 400, reason: "Bad Request", text: "not a WebSocket handshake\n" });
		const no = o.verify ? o.verify(req) : null;
		if (no) return refuse(no);
		socket.setNoDelay(true);
		socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acceptFor(key) + "\r\n\r\n");
		const conn = new Connection(socket);
		o.onConnection(conn, req);
		if (head && head.length) conn.reader.push(head);
	});
	return server;
}

/* ---------- the client: a browser's WebSocket, as far as the engine uses it ----------
   new WebSocket(url[, { headers }]); binaryType "arraybuffer"; onopen,
   onmessage({ data }), onerror, onclose({ code, reason, wasClean }); send,
   close; readyState. `status` is the HTTP status when the handshake was
   refused. */

class WebSocket {
	constructor(url, opts) {
		const self = this, u = new URL(url), key = crypto.randomBytes(16).toString("base64");
		if (u.protocol !== "ws:") throw new SyntaxError("The URL's scheme must be ws: " + url);
		this.url = url;
		this.readyState = 0;
		this.binaryType = "arraybuffer";
		this.onopen = this.onmessage = this.onerror = this.onclose = null;
		this.status = 0;
		this._done = false;
		let head = Buffer.alloc(0);
		const socket = this._socket = net.connect(+u.port || 80, u.hostname.replace(/^\[|\]$/g, ""));
		const reader = new Reader(function (op, data) {
			if (op === TEXT) self._emit("onmessage", { data: data.toString("utf8") });
			else if (op === BINARY) self._emit("onmessage", { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.length) });
			else if (op === PING) socket.write(encode(PONG, data, true));
			else if (op === CLOSE) {
				const code = data.length >= 2 ? data.readUInt16BE(0) : 1005;
				if (self.readyState === 1) socket.write(encode(CLOSE, data.subarray(0, 2), true));
				self._finish(code, data.length > 2 ? data.subarray(2).toString("utf8") : "", true);
			}
		}, function () { self._finish(1002, "", false); });
		socket.setNoDelay(true);
		socket.on("connect", function () {
			let extra = "";
			const h = (opts && opts.headers) || {};
			for (const k in h) extra += k + ": " + h[k] + "\r\n";
			socket.write("GET " + (u.pathname || "/") + u.search + " HTTP/1.1\r\nHost: " + u.host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
				"Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n" + extra + "\r\n");
		});
		socket.on("data", function (chunk) {
			if (self.readyState !== 0) { reader.push(chunk); return; }
			head = Buffer.concat([head, chunk]);
			const end = head.indexOf("\r\n\r\n");
			if (end < 0) return;
			const lines = head.subarray(0, end).toString("latin1").split("\r\n"), m = /^HTTP\/1\.[01] (\d+)/.exec(lines[0]);
			self.status = m ? +m[1] : 0;
			const accept = lines.map(function (l) { return /^sec-websocket-accept:\s*(.*)$/i.exec(l); }).filter(Boolean)[0];
			if (self.status !== 101 || !accept || accept[1].trim() !== acceptFor(key)) {
				self._emit("onerror", { message: "handshake refused: " + lines[0] });
				self._finish(1006, "", false);
				return;
			}
			self.readyState = 1;
			self._emit("onopen", {});
			if (head.length > end + 4) reader.push(head.subarray(end + 4));
		});
		socket.on("error", function (e) { self._emit("onerror", { message: e.message }); });
		socket.on("close", function () { self._finish(1006, "", false); });
	}
	_emit(name, ev) {
		if (typeof this[name] === "function") this[name](ev);
	}
	_finish(code, reason, clean) {
		if (this._done) return;
		this._done = true;
		this.readyState = 3;
		this._socket.destroy();
		this._emit("onclose", { code: code, reason: reason, wasClean: clean });
	}
	send(data) {
		if (this.readyState !== 1) throw new Error("WebSocket is not open");
		this._socket.write(encode(typeof data === "string" ? TEXT : BINARY, toBuffer(data), true));
	}
	close(code) {
		const self = this;
		if (this.readyState >= 2) return;
		if (this.readyState === 0) { this.readyState = 2; this._finish(1006, "", false); return; }
		this.readyState = 2;
		const b = Buffer.alloc(2);
		b.writeUInt16BE(code || 1000, 0);
		this._socket.write(encode(CLOSE, b, true));
		// The server answers and hangs up; if it does not, neither is waited for
		setTimeout(function () { self._finish(code || 1000, "", false); }, 1000).unref();
	}
}
WebSocket.CONNECTING = 0;
WebSocket.OPEN = 1;
WebSocket.CLOSING = 2;
WebSocket.CLOSED = 3;

module.exports = { createServer, WebSocket, acceptFor };
