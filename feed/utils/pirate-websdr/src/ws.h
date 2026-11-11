/* WebSocket (RFC 6455), the server's side: the handshake's accept key, the
   framing, and what it needs of an HTTP request. No I/O here. */
#ifndef PIRATE_WEBSDR_WS_H
#define PIRATE_WEBSDR_WS_H

#include <stddef.h>

#define WS_OP_CONT   0x0
#define WS_OP_TEXT   0x1
#define WS_OP_BINARY 0x2
#define WS_OP_CLOSE  0x8
#define WS_OP_PING   0x9
#define WS_OP_PONG   0xA

#define WS_MAX_HEADER 10	/* the longest frame header a server writes */
#define WS_ACCEPT_LEN 28	/* base64 of a SHA-1 */
#define WS_KEY_MAX 64		/* the longest Sec-WebSocket-Key taken */

/* Sec-WebSocket-Accept for a Sec-WebSocket-Key (at most WS_KEY_MAX
   characters of it are used). */
void ws_accept_key(const char *key, char out[WS_ACCEPT_LEN + 1]);

/* Writes the header of an unfragmented server frame carrying len bytes;
   returns its length (2, 4 or 10). out has room for WS_MAX_HEADER. */
size_t ws_write_header(unsigned char *out, int opcode, size_t len);

struct ws_frame {
	int opcode;
	int fin;
	unsigned char *payload;	/* in the caller's buffer, unmasked in place */
	size_t len;
};

#define WS_NEED_MORE 0
#define WS_ERR_PROTOCOL (-1)
#define WS_ERR_TOO_BIG (-2)

/* Parses one client frame at buf[0..have). Returns the bytes it takes up
   (the frame is whole, *f is filled in and its payload unmasked), or
   WS_NEED_MORE, or WS_ERR_PROTOCOL (reserved bits, not masked), or
   WS_ERR_TOO_BIG (its payload is longer than max_payload: said as soon as
   its header is in). */
int ws_parse_frame(unsigned char *buf, size_t have, size_t max_payload, struct ws_frame *f);

/* The value of header <name> in the head of an HTTP request (NUL-terminated,
   lines ending in CRLF): a pointer into req and the value's length, the
   blanks around it left out. NULL when the request has no such header. */
const char *ws_http_header(const char *req, const char *name, size_t *len);

/* Is <token> one of the comma-separated tokens of a header's value?
   ("Connection: keep-alive, Upgrade"). Letter case is ignored. */
int ws_has_token(const char *value, size_t len, const char *token);

/* Do an Origin ("http://host:port") and a Host ("host:port") header name the
   same host? Ports and letter case are ignored; IPv6 literals are in
   brackets in both. */
int ws_same_host(const char *origin, size_t olen, const char *host, size_t hlen);

/* Is the host of a Host header an address ("192.168.1.1", "[fd00::1]") or
   "localhost", rather than a name? No DNS can point those somewhere else. */
int ws_host_is_address(const char *host, size_t hlen);

/* Is the host of a Host header <name> itself, <name>.local or <name>.lan?
   (This machine's own name, as its network knows it.) Letter case is ignored. */
int ws_host_is_name(const char *host, size_t hlen, const char *name);

#endif
