/*
 * WebSocket (RFC 6455), the server's side: the handshake's accept key (SHA-1,
 * base64), the framing, and what it needs of an HTTP request. No I/O here.
 * Everything goes byte by byte: the router is big-endian.
 *
 * This is free software, licensed under the MIT license.
 */
#define _POSIX_C_SOURCE 200809L

#include <stdint.h>
#include <string.h>
#include <strings.h>

#include "ws.h"

/* ---------- SHA-1 (FIPS 180-1) ---------- */

static uint32_t rol32(uint32_t x, int n)
{
	return (x << n) | (x >> (32 - n));
}

static void sha1_block(uint32_t h[5], const unsigned char *p)
{
	uint32_t w[80], a, b, c, d, e, f, k, t;
	int i;

	for (i = 0; i < 16; i++)
		w[i] = ((uint32_t)p[4 * i] << 24) | ((uint32_t)p[4 * i + 1] << 16) |
			((uint32_t)p[4 * i + 2] << 8) | (uint32_t)p[4 * i + 3];
	for (; i < 80; i++)
		w[i] = rol32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

	a = h[0]; b = h[1]; c = h[2]; d = h[3]; e = h[4];
	for (i = 0; i < 80; i++) {
		if (i < 20) {
			f = (b & c) | (~b & d);
			k = 0x5a827999u;
		} else if (i < 40) {
			f = b ^ c ^ d;
			k = 0x6ed9eba1u;
		} else if (i < 60) {
			f = (b & c) | (b & d) | (c & d);
			k = 0x8f1bbcdcu;
		} else {
			f = b ^ c ^ d;
			k = 0xca62c1d6u;
		}
		t = rol32(a, 5) + f + e + k + w[i];
		e = d;
		d = c;
		c = rol32(b, 30);
		b = a;
		a = t;
	}
	h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
}

static void sha1(const unsigned char *msg, size_t len, unsigned char out[20])
{
	uint32_t h[5] = { 0x67452301u, 0xefcdab89u, 0x98badcfeu, 0x10325476u, 0xc3d2e1f0u };
	unsigned char tail[128];
	uint64_t bits = (uint64_t)len * 8;
	size_t i, rest, tlen;

	for (i = 0; i + 64 <= len; i += 64)
		sha1_block(h, msg + i);

	/* what is left, a 1 bit, zeros, and the length in bits in the last 8 bytes */
	rest = len - i;
	memset(tail, 0, sizeof(tail));
	memcpy(tail, msg + i, rest);
	tail[rest] = 0x80;
	tlen = (rest < 56) ? 64 : 128;
	for (i = 0; i < 8; i++)
		tail[tlen - 1 - i] = (unsigned char)((bits >> (8 * i)) & 0xff);
	sha1_block(h, tail);
	if (tlen == 128)
		sha1_block(h, tail + 64);

	for (i = 0; i < 5; i++) {
		out[4 * i] = (unsigned char)((h[i] >> 24) & 0xff);
		out[4 * i + 1] = (unsigned char)((h[i] >> 16) & 0xff);
		out[4 * i + 2] = (unsigned char)((h[i] >> 8) & 0xff);
		out[4 * i + 3] = (unsigned char)(h[i] & 0xff);
	}
}

/* ---------- base64 ---------- */

/* out has room for 4 * ((len + 2) / 3) + 1 */
static void base64(const unsigned char *in, size_t len, char *out)
{
	static const char abc[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	size_t i, o = 0;

	for (i = 0; i + 2 < len; i += 3) {
		out[o++] = abc[in[i] >> 2];
		out[o++] = abc[((in[i] & 0x03) << 4) | (in[i + 1] >> 4)];
		out[o++] = abc[((in[i + 1] & 0x0f) << 2) | (in[i + 2] >> 6)];
		out[o++] = abc[in[i + 2] & 0x3f];
	}
	if (len - i == 1) {
		out[o++] = abc[in[i] >> 2];
		out[o++] = abc[(in[i] & 0x03) << 4];
		out[o++] = '=';
		out[o++] = '=';
	} else if (len - i == 2) {
		out[o++] = abc[in[i] >> 2];
		out[o++] = abc[((in[i] & 0x03) << 4) | (in[i + 1] >> 4)];
		out[o++] = abc[(in[i + 1] & 0x0f) << 2];
		out[o++] = '=';
	}
	out[o] = '\0';
}

/* ---------- the handshake ---------- */

void ws_accept_key(const char *key, char out[WS_ACCEPT_LEN + 1])
{
	static const char guid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
	unsigned char msg[WS_KEY_MAX + sizeof(guid)], digest[20];
	size_t klen = strlen(key);

	if (klen > WS_KEY_MAX)
		klen = WS_KEY_MAX;
	memcpy(msg, key, klen);
	memcpy(msg + klen, guid, sizeof(guid) - 1);
	sha1(msg, klen + sizeof(guid) - 1, digest);
	base64(digest, sizeof(digest), out);
}

const char *ws_http_header(const char *req, const char *name, size_t *len)
{
	size_t nlen = strlen(name);
	const char *p = strstr(req, "\r\n");	/* past the request line */

	while (p) {
		const char *v, *e;

		p += 2;
		if (*p == '\0' || *p == '\r')
			break;				/* the head's end */
		if (strncasecmp(p, name, nlen) == 0 && p[nlen] == ':') {
			v = p + nlen + 1;
			while (*v == ' ' || *v == '\t')
				v++;
			e = strstr(v, "\r\n");
			if (!e)
				e = v + strlen(v);
			while (e > v && (e[-1] == ' ' || e[-1] == '\t'))
				e--;
			*len = (size_t)(e - v);
			return v;
		}
		p = strstr(p, "\r\n");
	}
	return NULL;
}

int ws_has_token(const char *value, size_t len, const char *token)
{
	size_t tlen = strlen(token), i = 0;

	while (i < len) {
		size_t s, e;

		while (i < len && (value[i] == ' ' || value[i] == '\t' || value[i] == ','))
			i++;
		s = i;
		while (i < len && value[i] != ',')
			i++;
		e = i;
		while (e > s && (value[e - 1] == ' ' || value[e - 1] == '\t'))
			e--;
		if (e - s == tlen && strncasecmp(value + s, token, tlen) == 0)
			return 1;
	}
	return 0;
}

/* The host in "host", "host:port", "[v6]:port" or "scheme://host:port/..." */
static void host_part(const char *s, size_t len, const char **host, size_t *hlen)
{
	size_t i, start = 0, end;

	for (i = 0; i + 2 < len; i++) {
		if (s[i] == '/')
			break;				/* no scheme before a path */
		if (s[i] == ':' && s[i + 1] == '/' && s[i + 2] == '/') {
			start = i + 3;
			break;
		}
	}
	end = start;
	if (start < len && s[start] == '[') {
		while (end < len && s[end] != ']')
			end++;
		if (end < len)
			end++;				/* its closing bracket */
	} else {
		while (end < len && s[end] != ':' && s[end] != '/')
			end++;
	}
	*host = s + start;
	*hlen = end - start;
}

int ws_same_host(const char *origin, size_t olen, const char *host, size_t hlen)
{
	const char *a, *b;
	size_t alen, blen;

	host_part(origin, olen, &a, &alen);
	host_part(host, hlen, &b, &blen);
	return alen > 0 && alen == blen && strncasecmp(a, b, alen) == 0;
}

int ws_host_is_address(const char *host, size_t hlen)
{
	const char *h;
	size_t n, i;

	host_part(host, hlen, &h, &n);
	if (n == 0)
		return 0;
	if (h[0] == '[')
		return 1;				/* an IPv6 address */
	if (n == 9 && strncasecmp(h, "localhost", 9) == 0)
		return 1;
	for (i = 0; i < n; i++)
		if (!((h[i] >= '0' && h[i] <= '9') || h[i] == '.'))
			return 0;
	return 1;					/* digits and dots: an IPv4 address */
}

int ws_host_is_name(const char *host, size_t hlen, const char *name)
{
	static const char *const tails[] = { "", ".local", ".lan" };
	const char *h;
	size_t n, nlen = strlen(name), i;

	host_part(host, hlen, &h, &n);
	if (nlen == 0 || n < nlen || strncasecmp(h, name, nlen) != 0)
		return 0;
	for (i = 0; i < sizeof(tails) / sizeof(tails[0]); i++) {
		size_t t = strlen(tails[i]);

		if (n - nlen == t && strncasecmp(h + nlen, tails[i], t) == 0)
			return 1;
	}
	return 0;
}

/* ---------- frames ---------- */

size_t ws_write_header(unsigned char *out, int opcode, size_t len)
{
	out[0] = (unsigned char)(0x80 | (opcode & 0x0f));	/* FIN: never fragmented */
	if (len < 126) {
		out[1] = (unsigned char)len;
		return 2;
	}
	if (len <= 0xffff) {
		out[1] = 126;
		out[2] = (unsigned char)((len >> 8) & 0xff);
		out[3] = (unsigned char)(len & 0xff);
		return 4;
	}
	/* a 64-bit length, most significant byte first; ours fit in 32 bits */
	out[1] = 127;
	out[2] = out[3] = out[4] = out[5] = 0;
	out[6] = (unsigned char)((len >> 24) & 0xff);
	out[7] = (unsigned char)((len >> 16) & 0xff);
	out[8] = (unsigned char)((len >> 8) & 0xff);
	out[9] = (unsigned char)(len & 0xff);
	return 10;
}

int ws_parse_frame(unsigned char *buf, size_t have, size_t max_payload, struct ws_frame *f)
{
	size_t hdr = 2, len, i;
	const unsigned char *mask;

	if (have < 2)
		return WS_NEED_MORE;
	if (buf[0] & 0x70)
		return WS_ERR_PROTOCOL;		/* reserved bits: no extension was agreed */
	if (!(buf[1] & 0x80))
		return WS_ERR_PROTOCOL;		/* a client masks its frames */

	len = buf[1] & 0x7f;
	if (len == 126) {
		if (have < 4)
			return WS_NEED_MORE;
		len = ((size_t)buf[2] << 8) | (size_t)buf[3];
		hdr = 4;
	} else if (len == 127) {
		return WS_ERR_TOO_BIG;		/* 64 KiB and up: more than any limit here */
	}
	if (len > max_payload)
		return WS_ERR_TOO_BIG;
	if (have < hdr + 4 + len)
		return WS_NEED_MORE;

	mask = buf + hdr;
	f->payload = buf + hdr + 4;
	for (i = 0; i < len; i++)
		f->payload[i] ^= mask[i & 3];
	f->opcode = buf[0] & 0x0f;
	f->fin = (buf[0] & 0x80) != 0;
	f->len = len;
	return (int)(hdr + 4 + len);
}
