/*
 * pirate-meshcore: a MeshCore radio on the router's USB port, on ubus as
 * pirate.meshcore, for the Pirate Radio UI's Messenger page: its contacts
 * and channels, messages to and from them, their delivery, its adverts and
 * settings, and its GPS's position for the Wi-Fi survey.
 *
 * The radio runs a MeshCore companion build for USB (such as LilyGo's
 * T-Echo's companion_radio_usb). MeshCore's companion protocol is in its
 * docs/companion_protocol.md and examples/companion_radio/MyMesh.cpp
 * (github.com/meshcore-dev/MeshCore, MIT); the code here is Pirate Radio's
 * own. Over USB, a frame to the radio is '<', a 16-bit little-endian
 * length and the frame; one from it, '>' and the same. A frame's first byte
 * says what it is: a command, the answer to one, or (0x80 and up) news.
 *
 * Connecting: the device query (protocol version 3: messages with their
 * SNR), app start (its name, key, radio and position), the router's clock,
 * its settings (the GPS), battery, contacts, channels, then the messages it
 * kept while nothing was connected. After that, news: a message waiting
 * (fetched), a delivery confirmed, an advert heard (contacts refreshed).
 *
 * Messages are kept here (the radio passes each on once), in
 * /etc/pirate-meshcore/messages: a line a message, then lines for what
 * becomes of it (sent, delivered, read), rewritten when it grows.
 *
 * This is free software, licensed under the MIT license.
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#include <libubox/blobmsg.h>
#include <libubox/list.h>
#include <libubox/uloop.h>
#include <libubox/utils.h>
#include <libubus.h>

/* Adafruit's nRF52 bootloader's USB vendor: LilyGo's T-Echo, RAK's 4631 */
#define MC_VID "239a"

#define MAX_FRAME    176     /* MeshCore's MAX_FRAME_SIZE */
#define PUB_KEY      32
#define PATH_MAX_SZ  64
#define MAX_CONTACTS 400
#define MAX_CHANNELS 40
#define MAX_MSGS     2000
#define MAX_TEXT     160     /* a message's text, in bytes, at most */
#define MAX_NAME     32
#define MAX_QUEUE    64
#define MAX_CONVS    (MAX_CONTACTS + MAX_CHANNELS + 64)
#define MAX_LIST     200     /* messages a call returns, at most */

#define OP_TIMEOUT_MS 6000
#define HS_RETRY_MS   1500
#define HS_TRIES      4
#define SCAN_MS       1000
#define RETRY_MS      5000
#define POS_MS        10000
#define BATT_MS       60000
#define REFRESH_MS    1500   /* contacts again, a moment after an advert */
#define LIVE_S        120    /* a position moved this recently is a fix */
#define ACK_MIN_MS    8000

/* Commands */
enum {
	CMD_APP_START = 1, CMD_SEND_TXT_MSG = 2, CMD_SEND_CHANNEL_TXT_MSG = 3, CMD_GET_CONTACTS = 4,
	CMD_SET_DEVICE_TIME = 6, CMD_SEND_SELF_ADVERT = 7, CMD_SET_ADVERT_NAME = 8,
	CMD_SYNC_NEXT_MESSAGE = 10, CMD_RESET_PATH = 13, CMD_REMOVE_CONTACT = 15,
	CMD_GET_BATT_AND_STORAGE = 20, CMD_DEVICE_QUERY = 22, CMD_GET_CHANNEL = 31,
	CMD_SET_CHANNEL = 32, CMD_GET_CUSTOM_VARS = 40, CMD_SET_CUSTOM_VAR = 41,
};
/* Answers */
enum {
	RESP_OK = 0, RESP_ERR = 1, RESP_CONTACTS_START = 2, RESP_CONTACT = 3, RESP_END_OF_CONTACTS = 4,
	RESP_SELF_INFO = 5, RESP_SENT = 6, RESP_CONTACT_MSG = 7, RESP_CHANNEL_MSG = 8,
	RESP_NO_MORE_MESSAGES = 10, RESP_BATT = 12, RESP_DEVICE_INFO = 13, RESP_CONTACT_MSG_V3 = 16,
	RESP_CHANNEL_MSG_V3 = 17, RESP_CHANNEL_INFO = 18, RESP_CUSTOM_VARS = 21, RESP_CHANNEL_DATA = 27,
};
/* News */
enum {
	PUSH_ADVERT = 0x80, PUSH_PATH_UPDATED = 0x81, PUSH_SEND_CONFIRMED = 0x82, PUSH_MSG_WAITING = 0x83,
	PUSH_NEW_ADVERT = 0x8a, PUSH_CONTACT_DELETED = 0x8f, PUSH_CONTACTS_FULL = 0x90,
};

struct buf {
	uint8_t *d;
	size_t len, cap;
};

static bool buf_add(struct buf *b, const void *p, size_t n)
{
	if (b->len + n > b->cap) {
		size_t c = b->cap ? b->cap : 1024;
		uint8_t *d;

		while (c < b->len + n)
			c *= 2;
		d = realloc(b->d, c);
		if (!d)
			return false;
		b->d = d;
		b->cap = c;
	}
	memcpy(b->d + b->len, p, n);
	b->len += n;
	return true;
}

static void buf_drop(struct buf *b, size_t n)
{
	if (n >= b->len) {
		b->len = 0;
		return;
	}
	memmove(b->d, b->d + n, b->len - n);
	b->len -= n;
}

static uint32_t rd32(const uint8_t *p) { return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24; }
static void wr32(uint8_t *p, uint32_t v) { p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24; }

static void hex(char *out, const uint8_t *p, size_t n)
{
	static const char h[] = "0123456789abcdef";
	size_t i;

	for (i = 0; i < n; i++) {
		out[2 * i] = h[p[i] >> 4];
		out[2 * i + 1] = h[p[i] & 15];
	}
	out[2 * n] = 0;
}

static int unhex(uint8_t *out, size_t max, const char *s)
{
	size_t n = strlen(s), i;

	if (n % 2 || n / 2 > max)
		return -1;
	for (i = 0; i < n; i += 2) {
		int a = isxdigit((unsigned char)s[i]), b = isxdigit((unsigned char)s[i + 1]);
		unsigned int v;

		if (!a || !b || sscanf(s + i, "%2x", &v) != 1)
			return -1;
		out[i / 2] = v;
	}
	return n / 2;
}

/* ---------- SHA-256, for hashtag channels' keys (FIPS 180-4) ---------- */

static const uint32_t K256[64] = {
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void sha256_block(uint32_t h[8], const uint8_t *p)
{
	uint32_t w[64], a, b, c, d, e, f, g, k, t1, t2;
	int i;

	for (i = 0; i < 16; i++)
		w[i] = (uint32_t)p[4 * i] << 24 | p[4 * i + 1] << 16 | p[4 * i + 2] << 8 | p[4 * i + 3];
	for (i = 16; i < 64; i++)
		w[i] = (ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ (w[i - 2] >> 10)) + w[i - 7] +
		       (ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ (w[i - 15] >> 3)) + w[i - 16];
	a = h[0]; b = h[1]; c = h[2]; d = h[3]; e = h[4]; f = h[5]; g = h[6]; k = h[7];
	for (i = 0; i < 64; i++) {
		t1 = k + (ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i];
		t2 = (ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
		k = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
	}
	h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
}

static void sha256(const uint8_t *p, size_t n, uint8_t out[32])
{
	uint32_t h[8] = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
			  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };
	uint8_t last[128];
	size_t i, rest = n % 64, tail;
	uint64_t bits = (uint64_t)n * 8;

	for (i = 0; i + 64 <= n; i += 64)
		sha256_block(h, p + i);
	memset(last, 0, sizeof(last));
	memcpy(last, p + n - rest, rest);
	last[rest] = 0x80;
	tail = rest < 56 ? 64 : 128;
	for (i = 0; i < 8; i++)
		last[tail - 1 - i] = bits >> (8 * i);
	sha256_block(h, last);
	if (tail == 128)
		sha256_block(h, last + 64);
	for (i = 0; i < 8; i++) {
		out[4 * i] = h[i] >> 24;
		out[4 * i + 1] = h[i] >> 16;
		out[4 * i + 2] = h[i] >> 8;
		out[4 * i + 3] = h[i];
	}
}

/* ---------- what the radio has ---------- */

struct contact {
	uint8_t key[PUB_KEY];
	uint8_t type, flags, path_len;
	char name[MAX_NAME + 1];
	uint32_t last_advert, lastmod;
	int32_t lat, lon;
};

struct channel {
	int idx;
	char name[MAX_NAME + 1];
	uint8_t secret[16];
};

struct msg {
	uint32_t id;                /* in order, from 1 */
	uint32_t seq;               /* the change it was last part of */
	char conv[16];              /* "c" and a contact's key's first 6 bytes, or "#" and a channel */
	bool out;
	uint32_t ts, rx;            /* the sender's time; the router's when it came */
	int16_t snr4;               /* SNR in quarter dB; INT16_MIN: none */
	uint8_t path;               /* hops (0xff: direct) */
	char status[12];            /* out: queued, sent, delivered, unconfirmed, failed */
	bool flood;
	uint8_t attempt;
	uint32_t ack, trip;
	int64_t ack_by;
	char from[MAX_NAME + 1];    /* in a channel, who sent it */
	char text[MAX_TEXT + 1];
};

struct conv_read {
	char conv[16];
	uint32_t upto;
};

enum state { ST_ABSENT, ST_CONNECTING, ST_READY };

enum op_kind {
	OP_QUERY, OP_APPSTART, OP_TIME, OP_CONTACTS, OP_CHANNEL, OP_VARS, OP_BATT, OP_SYNC,
	OP_SEND, OP_SEND_CH, OP_ADVERT, OP_NAME, OP_SETVAR, OP_SETCH, OP_REMOVE, OP_RESETPATH,
};

struct op {
	struct list_head list;
	enum op_kind kind;
	uint8_t frame[MAX_FRAME];
	size_t len;
	bool has_req;
	struct ubus_request_data req;
	uint32_t msg_id;
	int arg;
	bool last_initial;
};

static struct ubus_auto_conn conn;
#define UBUS (&conn.ctx)
static struct blob_buf rb;
static const char *opt_dev, *opt_sysfs = "/sys", *opt_store = "/etc/pirate-meshcore/messages";
static int pos_ms = POS_MS, ack_min_ms = ACK_MIN_MS;

static enum state state = ST_ABSENT;
static int fd = -1;
static struct uloop_fd ufd;
static struct uloop_timeout scan_t, hs_t, op_t, close_t, pos_t, batt_t, ack_t, refresh_t;
static struct buf in, out;
static char dev_path[256], last_error[160], fail_reason[160];
static bool broken, have_info;
static int hs_tries;

static LIST_HEAD(ops);
static int nops;
static struct op *cur;

/* The device */
static uint8_t fw_ver, max_channels = MAX_CHANNELS;
static unsigned max_contacts;
static char model[41], fw_version[21], fw_build[13];
static struct {
	bool have;
	uint8_t adv_type, tx_power, max_tx, multi_acks, adv_loc, telemetry, manual_add, sf, cr;
	uint8_t key[PUB_KEY];
	int32_t lat, lon;
	uint32_t freq, bw;
	char name[MAX_NAME + 1];
} self;
static struct {
	bool have;
	unsigned mv;
	uint32_t used_kb, total_kb;
} batt;
static bool gps_known, gps_on, pos_have;
static int32_t pos_lat, pos_lon;
static int64_t pos_moved;     /* when the position last changed (ms): a fix's */

static struct contact contacts[MAX_CONTACTS], loading[MAX_CONTACTS];
static int ncontacts, nloading;
static bool contacts_loaded, contacts_full;
static struct channel channels[MAX_CHANNELS];
static int nchannels;

static struct msg *msgs;      /* MAX_MSGS, oldest first */
static int nmsgs;
static uint32_t next_id = 1, seq = 1, meta_seq = 1;
static struct conv_read reads[MAX_CONVS];
static int nreads;
static unsigned store_lines;

static void out_flush(void);
static void op_next(void);
static void dev_fail(const char *why);

static int64_t now_ms(void)
{
	struct timespec t;

	clock_gettime(CLOCK_MONOTONIC, &t);
	return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static void logmsg(const char *fmt, ...)
{
	va_list ap;

	fprintf(stderr, "pirate-meshcore: ");
	va_start(ap, fmt);
	vfprintf(stderr, fmt, ap);
	va_end(ap);
	fputc('\n', stderr);
}

static const char *state_name(void)
{
	static const char *const n[] = { "absent", "connecting", "ready" };

	return n[state];
}

/* A string from a fixed field: up to its first NUL, not past its end */
static void field_str(char *s, size_t size, const uint8_t *p, size_t n)
{
	size_t l = strnlen((const char *)p, n);

	if (l >= size)
		l = size - 1;
	memcpy(s, p, l);
	s[l] = 0;
}

/* ---------- messages, and where they are kept ---------- */

static struct msg *msg_by_id(uint32_t id)
{
	int lo = 0, hi = nmsgs - 1;

	while (lo <= hi) {
		int m = (lo + hi) / 2;

		if (msgs[m].id == id)
			return &msgs[m];
		if (msgs[m].id < id)
			lo = m + 1;
		else
			hi = m - 1;
	}
	return NULL;
}

static uint32_t *read_upto(const char *conv, bool add)
{
	int i;

	for (i = 0; i < nreads; i++)
		if (!strcmp(reads[i].conv, conv))
			return &reads[i].upto;
	if (!add || nreads >= MAX_CONVS)
		return NULL;
	snprintf(reads[nreads].conv, sizeof(reads[nreads].conv), "%s", conv);
	reads[nreads].upto = 0;
	return &reads[nreads++].upto;
}

/* Tabs, line breaks and backslashes escaped, for the store's lines */
static void put_esc(FILE *f, const char *s)
{
	for (; *s; s++) {
		if (*s == '\t')
			fputs("\\t", f);
		else if (*s == '\n')
			fputs("\\n", f);
		else if (*s == '\r')
			fputs("\\r", f);
		else if (*s == '\\')
			fputs("\\\\", f);
		else
			fputc(*s, f);
	}
}

static void unesc(char *s)
{
	char *o = s;

	for (; *s; s++) {
		if (*s == '\\' && s[1]) {
			s++;
			*o++ = *s == 't' ? '\t' : *s == 'n' ? '\n' : *s == 'r' ? '\r' : *s;
		} else {
			*o++ = *s;
		}
	}
	*o = 0;
}

static void put_msg_line(FILE *f, const struct msg *m)
{
	fprintf(f, "m\t%u\t%s\t%d\t%u\t%u\t%d\t%u\t%s\t%d\t%u\t%u\t%u\t", m->id, m->conv, m->out, m->ts, m->rx,
		m->snr4, m->path, m->status, m->flood, m->attempt, m->ack, m->trip);
	put_esc(f, m->from);
	fputc('\t', f);
	put_esc(f, m->text);
	fputc('\n', f);
}

static FILE *store_open(const char *mode)
{
	char d[256], *s;

	snprintf(d, sizeof(d), "%s", opt_store);
	s = strrchr(d, '/');
	if (s && s != d) {
		*s = 0;
		mkdir(d, 0700);
	}
	return fopen(opt_store, mode);
}

/* Everything, afresh: once the store has grown well past what it keeps */
static void store_rewrite(void)
{
	char tmp[300];
	FILE *f;
	int i;

	snprintf(tmp, sizeof(tmp), "%s.new", opt_store);
	f = fopen(tmp, "w");
	if (!f)
		return;
	for (i = 0; i < nmsgs; i++)
		put_msg_line(f, &msgs[i]);
	for (i = 0; i < nreads; i++)
		fprintf(f, "r\t%s\t%u\n", reads[i].conv, reads[i].upto);
	if (fclose(f) == 0 && rename(tmp, opt_store) == 0)
		store_lines = nmsgs + nreads;
	else
		unlink(tmp);
}

static void store_line(const char *fmt, ...)
{
	va_list ap;
	FILE *f;

	if (store_lines > 3 * MAX_MSGS) {
		store_rewrite();
		return;
	}
	f = store_open("a");
	if (!f)
		return;
	va_start(ap, fmt);
	vfprintf(f, fmt, ap);
	va_end(ap);
	fclose(f);
	store_lines++;
}

static void store_msg(const struct msg *m)
{
	FILE *f;

	if (store_lines > 3 * MAX_MSGS) {
		store_rewrite();
		return;
	}
	f = store_open("a");
	if (!f)
		return;
	put_msg_line(f, m);
	fclose(f);
	store_lines++;
}

static void store_status(const struct msg *m)
{
	store_line("s\t%u\t%s\t%u\t%u\t%u\n", m->id, m->status, m->trip, m->ack, m->attempt);
}

static struct msg *msg_new(void)
{
	struct msg *m;

	if (nmsgs == MAX_MSGS) {
		memmove(msgs, msgs + 1, (MAX_MSGS - 1) * sizeof(*msgs));
		nmsgs--;
	}
	m = &msgs[nmsgs++];
	memset(m, 0, sizeof(*m));
	m->id = next_id++;
	m->seq = ++seq;
	m->snr4 = INT16_MIN;
	m->path = 0xff;
	return m;
}

static void store_load(void)
{
	char line[1024], *f[16], *s;
	FILE *fp = fopen(opt_store, "r");
	int n;

	if (!fp)
		return;
	while (fgets(line, sizeof(line), fp)) {
		line[strcspn(line, "\n")] = 0;
		store_lines++;
		for (n = 0, s = line; n < 16; n++) {
			f[n] = s;
			s = strchr(s, '\t');
			if (!s) {
				n++;
				break;
			}
			*s++ = 0;
		}
		if (f[0][0] == 'm' && n >= 15) {
			struct msg *m = msg_new();

			m->id = strtoul(f[1], NULL, 10);
			snprintf(m->conv, sizeof(m->conv), "%s", f[2]);
			m->out = atoi(f[3]);
			m->ts = strtoul(f[4], NULL, 10);
			m->rx = strtoul(f[5], NULL, 10);
			m->snr4 = atoi(f[6]);
			m->path = atoi(f[7]);
			snprintf(m->status, sizeof(m->status), "%s", f[8]);
			m->flood = atoi(f[9]);
			m->attempt = atoi(f[10]);
			m->ack = strtoul(f[11], NULL, 10);
			m->trip = strtoul(f[12], NULL, 10);
			unesc(f[13]);
			unesc(f[14]);
			snprintf(m->from, sizeof(m->from), "%s", f[13]);
			snprintf(m->text, sizeof(m->text), "%s", f[14]);
			/* Sent and never heard of again: not now, either */
			if (m->out && (!strcmp(m->status, "queued") || !strcmp(m->status, "sent")))
				snprintf(m->status, sizeof(m->status), "%s", "unconfirmed");
			if (m->id >= next_id)
				next_id = m->id + 1;
		} else if (f[0][0] == 's' && n >= 3) {
			struct msg *m = msg_by_id(strtoul(f[1], NULL, 10));

			if (m) {
				snprintf(m->status, sizeof(m->status), "%s", f[2]);
				if (n >= 4)
					m->trip = strtoul(f[3], NULL, 10);
				if (n >= 5)
					m->ack = strtoul(f[4], NULL, 10);
				if (n >= 6)
					m->attempt = atoi(f[5]);
			}
		} else if (f[0][0] == 'r' && n >= 3) {
			uint32_t *u = read_upto(f[1], true);

			if (u)
				*u = strtoul(f[2], NULL, 10);
		}
	}
	fclose(fp);
	if (nmsgs)
		logmsg("%d messages kept from before", nmsgs);
}

/* ---------- the serial port ---------- */

static void dev_fail(const char *why)
{
	if (broken)
		return;
	broken = true;
	snprintf(fail_reason, sizeof(fail_reason), "%s", why ? why : "");
	if (why)
		logmsg("%s: %s", dev_path, why);
	uloop_timeout_set(&close_t, 0);
}

static void out_flush(void)
{
	ssize_t w;

	if (fd < 0 || broken)
		return;
	while (out.len) {
		w = write(fd, out.d, out.len);
		if (w > 0) {
			buf_drop(&out, w);
			continue;
		}
		if (w < 0 && errno == EINTR)
			continue;
		if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
			break;
		dev_fail(NULL);
		return;
	}
	uloop_fd_add(&ufd, ULOOP_READ | (out.len ? ULOOP_WRITE : 0));
}

static void frame_send(const uint8_t *p, size_t n)
{
	uint8_t h[3] = { '<', n & 0xff, n >> 8 };

	buf_add(&out, h, 3);
	buf_add(&out, p, n);
	out_flush();
}

/* ---------- requests, one at a time ---------- */

static struct op *op_new(enum op_kind kind, const uint8_t *frame, size_t len)
{
	struct op *o = calloc(1, sizeof(*o));

	if (!o)
		return NULL;
	o->kind = kind;
	if (len > MAX_FRAME)
		len = MAX_FRAME;
	memcpy(o->frame, frame, len);
	o->len = len;
	return o;
}

static bool op_queued(enum op_kind kind)
{
	struct op *o;

	list_for_each_entry(o, &ops, list)
		if (o->kind == kind)
			return true;
	return false;
}

static void op_add(struct op *o)
{
	if (!o)
		return;
	list_add_tail(&o->list, &ops);
	nops++;
	op_next();
}

static void op_add1(enum op_kind kind, const uint8_t *frame, size_t len)
{
	op_add(op_new(kind, frame, len));
}

static void reply_ok(struct op *o, const char *err)
{
	struct blob_buf b = { 0 };

	if (!o->has_req)
		return;
	blob_buf_init(&b, 0);
	if (err)
		blobmsg_add_string(&b, "error", err);
	else
		blobmsg_add_u8(&b, "ok", 1);
	ubus_send_reply(UBUS, &o->req, b.head);
	ubus_complete_deferred_request(UBUS, &o->req, UBUS_STATUS_OK);
	blob_buf_free(&b);
	o->has_req = false;
}

static void msg_status(struct msg *m, const char *st)
{
	snprintf(m->status, sizeof(m->status), "%s", st);
	m->seq = ++seq;
	store_status(m);
}

static void op_finish(struct op *o, const char *err)
{
	if (o->kind == OP_SEND || o->kind == OP_SEND_CH) {
		struct msg *m = msg_by_id(o->msg_id);

		if (m && err)
			msg_status(m, "failed");
	}
	reply_ok(o, err);
	if (o == cur) {
		cur = NULL;
		uloop_timeout_cancel(&op_t);
	}
	list_del(&o->list);
	nops--;
	free(o);
	op_next();
}

static void op_next(void)
{
	if (cur || fd < 0 || broken || list_empty(&ops))
		return;
	cur = list_first_entry(&ops, struct op, list);
	frame_send(cur->frame, cur->len);
	uloop_timeout_set(&op_t, OP_TIMEOUT_MS);
}

static void op_timeout(struct uloop_timeout *t)
{
	(void)t;
	if (!cur)
		return;
	/* Before it is up, no answer means it isn't a USB companion */
	if (state != ST_READY && cur->kind != OP_CHANNEL) {
		op_finish(cur, "the radio didn't answer");
		dev_fail("the radio stopped answering");
		return;
	}
	op_finish(cur, "the radio didn't answer");
}

static const char *err_text(int code)
{
	switch (code) {
	case 1: return "the radio doesn't know that command";
	case 2: return "the radio has no such contact or channel";
	case 3: return "the radio is busy: its queue is full, try again";
	case 4: return "the radio is busy with something else";
	case 5: return "the radio couldn't save it";
	case 6: return "the radio refused that value";
	}
	return "the radio refused";
}

/* ---------- what the radio says ---------- */

/* The radio keeps its last position when its GPS has no fix (or one set
 * by hand): a position is a fix's while it moves, as a GPS's does, by a
 * millionth of a degree or so, from one reading to the next */
static void set_position(int32_t lat, int32_t lon)
{
	if (!pos_have) {
		pos_have = true;
		pos_moved = 0;
	} else if (lat != pos_lat || lon != pos_lon) {
		pos_moved = now_ms();
	}
	pos_lat = lat;
	pos_lon = lon;
}

static void on_self(const uint8_t *f, size_t n)
{
	char name[MAX_NAME + 1];

	if (n < 58)
		return;
	field_str(name, sizeof(name), f + 58, n - 58);
	/* Its position alone changing is no news for the page */
	if (!self.have || strcmp(name, self.name) || self.freq != rd32(f + 48) || self.bw != rd32(f + 52) ||
	    self.sf != f[56] || self.cr != f[57] || self.tx_power != f[2] || self.adv_loc != f[45])
		meta_seq = ++seq;
	self.have = true;
	self.adv_type = f[1];
	self.tx_power = f[2];
	self.max_tx = f[3];
	memcpy(self.key, f + 4, PUB_KEY);
	self.lat = (int32_t)rd32(f + 36);
	self.lon = (int32_t)rd32(f + 40);
	self.multi_acks = f[44];
	self.adv_loc = f[45];
	self.telemetry = f[46];
	self.manual_add = f[47];
	self.freq = rd32(f + 48);
	self.bw = rd32(f + 52);
	self.sf = f[56];
	self.cr = f[57];
	snprintf(self.name, sizeof(self.name), "%s", name);
	set_position(self.lat, self.lon);
}

static void contact_from(struct contact *c, const uint8_t *f, size_t n)
{
	memset(c, 0, sizeof(*c));
	memcpy(c->key, f + 1, PUB_KEY);
	c->type = f[33];
	c->flags = f[34];
	c->path_len = f[35];
	field_str(c->name, sizeof(c->name), f + 100, MAX_NAME);
	c->last_advert = rd32(f + 132);
	if (n >= 144) {
		c->lat = (int32_t)rd32(f + 136);
		c->lon = (int32_t)rd32(f + 140);
	}
	if (n >= 148)
		c->lastmod = rd32(f + 144);
}

static struct contact *contact_by_prefix(const uint8_t *p, size_t n)
{
	int i;

	for (i = 0; i < ncontacts; i++)
		if (!memcmp(contacts[i].key, p, n))
			return &contacts[i];
	return NULL;
}

static void conv_of_key(char *conv, const uint8_t *key)
{
	conv[0] = 'c';
	hex(conv + 1, key, 6);
}

/* A message the radio kept for us: a contact's or a channel's */
static void on_message(const uint8_t *f, size_t n)
{
	struct msg *m;
	size_t o = 1, tl;
	int16_t snr = INT16_MIN;
	uint8_t code = f[0], txt_type;
	const char *text;

	if (code == RESP_CONTACT_MSG_V3 || code == RESP_CHANNEL_MSG_V3) {
		if (n < 4)
			return;
		snr = (int8_t)f[1];
		o = 4;
	}
	if (code == RESP_CONTACT_MSG || code == RESP_CONTACT_MSG_V3) {
		struct contact *c;

		if (n < o + 12)
			return;
		txt_type = f[o + 7];
		c = contact_by_prefix(f + o, 6);
		m = msg_new();
		conv_of_key(m->conv, f + o);
		snprintf(m->from, sizeof(m->from), "%s", c ? c->name : "");
		m->path = f[o + 6];
		m->ts = rd32(f + o + 8);
		o += 12;
		if (txt_type == 2)
			o += 4;           /* a signature */
		if (o > n)
			o = n;
	} else {
		if (n < o + 7)
			return;
		m = msg_new();
		snprintf(m->conv, sizeof(m->conv), "#%u", f[o]);
		m->path = f[o + 1];
		m->ts = rd32(f + o + 3);
		o += 7;
	}
	m->snr4 = snr;
	m->rx = time(NULL);
	text = (const char *)f + o;
	tl = n - o;
	if (tl > MAX_TEXT)
		tl = MAX_TEXT;
	memcpy(m->text, text, tl);
	m->text[tl] = 0;
	/* A channel's text is "Name: text" */
	if (m->conv[0] == '#') {
		char *sep = strstr(m->text, ": ");

		if (sep && sep - m->text <= MAX_NAME) {
			memcpy(m->from, m->text, sep - m->text);
			m->from[sep - m->text] = 0;
			memmove(m->text, sep + 2, strlen(sep + 2) + 1);
		}
	}
	store_msg(m);
}

static void on_vars(const uint8_t *f, size_t n)
{
	char s[MAX_FRAME + 1], *tok, *save;

	field_str(s, sizeof(s), f + 1, n - 1);
	gps_known = false;
	for (tok = strtok_r(s, ",", &save); tok; tok = strtok_r(NULL, ",", &save)) {
		char *v = strchr(tok, ':');

		if (v && !strncmp(tok, "gps", v - tok) && v - tok == 3) {
			gps_known = true;
			gps_on = v[1] == '1';
		}
	}
	meta_seq = ++seq;
	if (gps_on)
		uloop_timeout_set(&pos_t, pos_ms);
}

static void contacts_refresh(void)
{
	static const uint8_t f[] = { CMD_GET_CONTACTS };

	if (state == ST_READY && !op_queued(OP_CONTACTS))
		op_add1(OP_CONTACTS, f, sizeof(f));
}

static void sync_messages(void)
{
	static const uint8_t f[] = { CMD_SYNC_NEXT_MESSAGE };

	if (!op_queued(OP_SYNC))
		op_add1(OP_SYNC, f, sizeof(f));
}

static void on_push(const uint8_t *f, size_t n)
{
	int i;

	switch (f[0]) {
	case PUSH_MSG_WAITING:
		sync_messages();
		break;
	case PUSH_SEND_CONFIRMED:
		if (n >= 9) {
			uint32_t ack = rd32(f + 1);

			for (i = nmsgs - 1; i >= 0; i--) {
				struct msg *m = &msgs[i];

				if (m->out && m->ack == ack && strcmp(m->status, "delivered")) {
					m->trip = rd32(f + 5);
					msg_status(m, "delivered");
					break;
				}
			}
		}
		break;
	case PUSH_NEW_ADVERT:
		if (n >= 136) {
			struct contact c, *e;

			contact_from(&c, f, n);
			e = contact_by_prefix(c.key, PUB_KEY);
			if (e)
				*e = c;
			else if (ncontacts < MAX_CONTACTS)
				contacts[ncontacts++] = c;
			meta_seq = ++seq;
		}
		break;
	case PUSH_ADVERT:
	case PUSH_PATH_UPDATED:
		uloop_timeout_set(&refresh_t, REFRESH_MS);
		break;
	case PUSH_CONTACT_DELETED:
		if (n >= 1 + PUB_KEY) {
			struct contact *c = contact_by_prefix(f + 1, PUB_KEY);

			if (c) {
				memmove(c, c + 1, (contacts + ncontacts - c - 1) * sizeof(*c));
				ncontacts--;
				meta_seq = ++seq;
			}
		}
		break;
	case PUSH_CONTACTS_FULL:
		contacts_full = true;
		meta_seq = ++seq;
		break;
	}
}

static void became_ready(void)
{
	if (state == ST_READY)
		return;
	state = ST_READY;
	meta_seq = ++seq;
	logmsg("%s: ready: %s, %d contacts, %d channels", dev_path, self.name, ncontacts, nchannels);
	uloop_timeout_set(&batt_t, BATT_MS);
	uloop_timeout_set(&ack_t, 1000);
	if (gps_on)
		uloop_timeout_set(&pos_t, pos_ms);
}

static void on_info(const uint8_t *f, size_t n)
{
	uint8_t fr[64];
	uint32_t t = time(NULL);
	int i;

	have_info = true;
	uloop_timeout_cancel(&hs_t);
	fw_ver = f[1];
	if (n >= 80) {
		max_contacts = f[2] * 2;
		max_channels = f[3] ? f[3] : 1;
		if (max_channels > MAX_CHANNELS)
			max_channels = MAX_CHANNELS;
		field_str(fw_build, sizeof(fw_build), f + 8, 12);
		field_str(model, sizeof(model), f + 20, 40);
		field_str(fw_version, sizeof(fw_version), f + 60, 20);
	}
	logmsg("%s: %s, MeshCore %s (%s)", dev_path, model[0] ? model : "a MeshCore radio",
	       fw_version[0] ? fw_version : "?", fw_build);

	/* Then what it has, in turn */
	memset(fr, 0, sizeof(fr));
	fr[0] = CMD_APP_START;
	memcpy(fr + 8, "PirateRadio", 11);
	op_add1(OP_APPSTART, fr, 19);
	/* The router's clock, if it has one: the radio only takes a later time */
	if (t > 1700000000) {
		fr[0] = CMD_SET_DEVICE_TIME;
		wr32(fr + 1, t);
		op_add1(OP_TIME, fr, 5);
	}
	fr[0] = CMD_GET_CUSTOM_VARS;
	op_add1(OP_VARS, fr, 1);
	fr[0] = CMD_GET_BATT_AND_STORAGE;
	op_add1(OP_BATT, fr, 1);
	fr[0] = CMD_GET_CONTACTS;
	op_add1(OP_CONTACTS, fr, 1);
	nchannels = 0;
	for (i = 0; i < max_channels; i++) {
		struct op *o;

		fr[0] = CMD_GET_CHANNEL;
		fr[1] = i;
		o = op_new(OP_CHANNEL, fr, 2);
		if (o) {
			o->arg = i;
			o->last_initial = i == max_channels - 1;
		}
		op_add(o);
	}
	sync_messages();
}

static void on_frame(const uint8_t *f, size_t n)
{
	struct op *o = cur;
	uint8_t code;

	if (!n)
		return;
	code = f[0];
	if (code >= 0x80) {
		on_push(f, n);
		return;
	}
	/* The device query's answer opens the session, whatever was asked */
	if (code == RESP_DEVICE_INFO && n >= 2) {
		bool first = !have_info;

		if (o && o->kind == OP_QUERY)
			op_finish(o, NULL);
		if (first)
			on_info(f, n);
		return;
	}
	if (!o)
		return;
	if (code == RESP_ERR) {
		if (o->kind == OP_CHANNEL) {
			/* Past the last slot: no more to fetch */
			struct op *x, *tmp;

			if (state == ST_CONNECTING)
				list_for_each_entry_safe(x, tmp, &ops, list)
					if (x != o && x->kind == OP_CHANNEL) {
						list_del(&x->list);
						nops--;
						free(x);
					}
			op_finish(o, NULL);
			if (state == ST_CONNECTING)
				became_ready();
			return;
		}
		if (o->kind == OP_TIME) {
			op_finish(o, NULL);   /* its clock was ahead: it keeps it */
			return;
		}
		op_finish(o, err_text(n > 1 ? f[1] : 0));
		return;
	}
	switch (o->kind) {
	case OP_APPSTART:
		if (code == RESP_SELF_INFO) {
			on_self(f, n);
			op_finish(o, NULL);
		}
		break;
	case OP_CONTACTS:
		if (code == RESP_CONTACTS_START) {
			nloading = 0;
			uloop_timeout_set(&op_t, OP_TIMEOUT_MS);
		} else if (code == RESP_CONTACT && n >= 136) {
			if (nloading < MAX_CONTACTS)
				contact_from(&loading[nloading++], f, n);
			uloop_timeout_set(&op_t, OP_TIMEOUT_MS);
		} else if (code == RESP_END_OF_CONTACTS) {
			memcpy(contacts, loading, nloading * sizeof(*contacts));
			ncontacts = nloading;
			contacts_loaded = true;
			meta_seq = ++seq;
			op_finish(o, NULL);
		}
		break;
	case OP_CHANNEL:
		if (code == RESP_CHANNEL_INFO && n >= 50) {
			bool last = o->last_initial;
			static const uint8_t zero[16];
			int j;

			/* This slot's, in place of what was there */
			for (j = 0; j < nchannels && channels[j].idx != f[1]; j++)
				;
			if (j < nchannels) {
				memmove(&channels[j], &channels[j + 1], (nchannels - j - 1) * sizeof(*channels));
				nchannels--;
			}
			if ((f[2] || memcmp(f + 34, zero, 16)) && nchannels < MAX_CHANNELS) {
				struct channel *c = &channels[nchannels++];

				c->idx = f[1];
				field_str(c->name, sizeof(c->name), f + 2, 32);
				memcpy(c->secret, f + 34, 16);
			}
			if (state == ST_READY)
				meta_seq = ++seq;
			op_finish(o, NULL);
			if (last && state == ST_CONNECTING)
				became_ready();
		}
		break;
	case OP_VARS:
		if (code == RESP_CUSTOM_VARS) {
			on_vars(f, n);
			op_finish(o, NULL);
		}
		break;
	case OP_BATT:
		if (code == RESP_BATT && n >= 3) {
			batt.have = true;
			batt.mv = f[1] | f[2] << 8;
			if (n >= 11) {
				batt.used_kb = rd32(f + 3);
				batt.total_kb = rd32(f + 7);
			}
			op_finish(o, NULL);
		}
		break;
	case OP_SYNC:
		if (code == RESP_CONTACT_MSG || code == RESP_CONTACT_MSG_V3 ||
		    code == RESP_CHANNEL_MSG || code == RESP_CHANNEL_MSG_V3 || code == RESP_CHANNEL_DATA) {
			if (code != RESP_CHANNEL_DATA)
				on_message(f, n);
			/* And the next, until there are none */
			op_finish(o, NULL);
			sync_messages();
		} else if (code == RESP_NO_MORE_MESSAGES) {
			op_finish(o, NULL);
		}
		break;
	case OP_SEND:
		if (code == RESP_SENT && n >= 10) {
			struct msg *m = msg_by_id(o->msg_id);

			if (m) {
				uint32_t est = rd32(f + 6);

				m->flood = f[1] == 1;
				m->ack = rd32(f + 2);
				m->ack_by = now_ms() + ((int)est > ack_min_ms ? (int)est : ack_min_ms) + 2000;
				msg_status(m, m->ack ? "sent" : "delivered");
			}
			op_finish(o, NULL);
		}
		break;
	case OP_SEND_CH:
		if (code == RESP_OK || code == RESP_SENT) {
			struct msg *m = msg_by_id(o->msg_id);

			if (m)
				msg_status(m, "sent");
			op_finish(o, NULL);
		}
		break;
	case OP_SETCH:
		if (code == RESP_OK) {
			uint8_t g[2] = { CMD_GET_CHANNEL, o->arg };

			op_finish(o, NULL);
			/* What the radio has now, to be sure */
			op_add1(OP_CHANNEL, g, 2);
		}
		break;
	case OP_TIME:
	case OP_ADVERT:
	case OP_NAME:
	case OP_REMOVE:
	case OP_RESETPATH:
		if (code == RESP_OK)
			op_finish(o, NULL);
		break;
	case OP_SETVAR:
		if (code == RESP_OK) {
			gps_on = o->arg;
			gps_known = true;
			meta_seq = ++seq;
			if (gps_on)
				uloop_timeout_set(&pos_t, 1000 < pos_ms ? 1000 : pos_ms);
			op_finish(o, NULL);
		}
		break;
	case OP_QUERY:
		break;
	}
}

static void parse_in(void)
{
	while (in.len) {
		size_t n;

		if (in.d[0] != '>') {
			/* Not a frame: drop up to the next start */
			uint8_t *p = memchr(in.d, '>', in.len);

			buf_drop(&in, p ? (size_t)(p - in.d) : in.len);
			continue;
		}
		if (in.len < 3)
			return;
		n = in.d[1] | in.d[2] << 8;
		if (n > MAX_FRAME + 16) {
			buf_drop(&in, 1);
			continue;
		}
		if (in.len < 3 + n)
			return;
		{
			uint8_t f[MAX_FRAME + 17];

			memcpy(f, in.d + 3, n);
			buf_drop(&in, 3 + n);
			on_frame(f, n);
		}
		if (broken)
			return;
	}
}

static void fd_cb(struct uloop_fd *u, unsigned int events)
{
	uint8_t tmp[2048];
	ssize_t r;

	if (broken || fd < 0)
		return;
	if (events & ULOOP_WRITE)
		out_flush();
	if (!broken && (events & ULOOP_READ)) {
		for (;;) {
			r = read(fd, tmp, sizeof(tmp));
			if (r > 0) {
				if (!buf_add(&in, tmp, r)) {
					dev_fail("out of memory");
					return;
				}
				parse_in();
				if (broken)
					return;
				continue;
			}
			if (r < 0 && errno == EINTR)
				continue;
			if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
				break;
			dev_fail(NULL);
			return;
		}
	}
	if (u->eof || u->error)
		dev_fail(NULL);
}

/* ---------- finding it, connecting ---------- */

static bool read_line(const char *path, char *s, size_t n)
{
	FILE *f = fopen(path, "r");

	if (!f)
		return false;
	if (!fgets(s, n, f))
		s[0] = 0;
	fclose(f);
	s[strcspn(s, "\r\n")] = 0;
	return true;
}

static bool find_radio(char *path, size_t n)
{
	char d[512], v[16];
	struct dirent *e;
	bool found = false;
	DIR *dir;

	if (opt_dev) {
		if (access(opt_dev, R_OK | W_OK))
			return false;
		snprintf(path, n, "%s", opt_dev);
		return true;
	}
	snprintf(d, sizeof(d), "%s/class/tty", opt_sysfs);
	dir = opendir(d);
	if (!dir)
		return false;
	while (!found && (e = readdir(dir))) {
		if (strncmp(e->d_name, "ttyACM", 6))
			continue;
		snprintf(d, sizeof(d), "%s/class/tty/%s/device/../idVendor", opt_sysfs, e->d_name);
		if (!read_line(d, v, sizeof(v)) || strcasecmp(v, MC_VID))
			continue;
		snprintf(path, n, "/dev/%s", e->d_name);
		found = true;
	}
	closedir(dir);
	return found;
}

static void hs_cb(struct uloop_timeout *t)
{
	static const uint8_t q[] = { CMD_DEVICE_QUERY, 3 };

	if (fd < 0 || have_info || broken)
		return;
	if (hs_tries++ >= HS_TRIES) {
		dev_fail("no answer from the radio: it needs a MeshCore companion build for USB "
			 "(the Bluetooth one says nothing over USB)");
		return;
	}
	/* Not queued: it may go again before an answer */
	frame_send(q, sizeof(q));
	uloop_timeout_set(t, HS_RETRY_MS);
}

static void dev_open(const char *path)
{
	struct termios t;

	fd = open(path, O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
	if (fd < 0) {
		snprintf(last_error, sizeof(last_error), "can't open %s: %s", path, strerror(errno));
		uloop_timeout_set(&scan_t, RETRY_MS);
		return;
	}
	if (!tcgetattr(fd, &t)) {
		cfmakeraw(&t);
		t.c_cflag |= CLOCAL | CREAD | HUPCL;
		t.c_cc[VMIN] = 1;
		t.c_cc[VTIME] = 0;
		cfsetispeed(&t, B115200);
		cfsetospeed(&t, B115200);
		tcsetattr(fd, TCSANOW, &t);
	}
	/* gpsd and the like keep off it */
	ioctl(fd, TIOCEXCL);
	tcflush(fd, TCIOFLUSH);
	snprintf(dev_path, sizeof(dev_path), "%s", path);
	state = ST_CONNECTING;
	broken = have_info = false;
	in.len = out.len = 0;
	hs_tries = 0;
	ufd.fd = fd;
	ufd.cb = fd_cb;
	uloop_fd_add(&ufd, ULOOP_READ);
	logmsg("%s: a MeshCore radio, connecting", path);
	uloop_timeout_set(&hs_t, 200);
}

static void scan_cb(struct uloop_timeout *t)
{
	char path[256];

	if (fd >= 0)
		return;
	if (!find_radio(path, sizeof(path))) {
		state = ST_ABSENT;
		last_error[0] = 0;
		uloop_timeout_set(t, SCAN_MS);
		return;
	}
	dev_open(path);
}

static void close_cb(struct uloop_timeout *t)
{
	const char *why = fail_reason[0] ? fail_reason : "the radio went away";
	struct op *o, *tmp;

	(void)t;
	if (fd >= 0) {
		uloop_fd_delete(&ufd);
		close(fd);
		fd = -1;
	}
	in.len = out.len = 0;
	uloop_timeout_cancel(&hs_t);
	uloop_timeout_cancel(&op_t);
	uloop_timeout_cancel(&pos_t);
	uloop_timeout_cancel(&batt_t);
	uloop_timeout_cancel(&refresh_t);
	if (state != ST_ABSENT)
		logmsg("%s: %s", dev_path, why);
	state = ST_ABSENT;
	cur = NULL;
	list_for_each_entry_safe(o, tmp, &ops, list)
		op_finish(o, why);
	have_info = self.have = batt.have = contacts_loaded = contacts_full = false;
	gps_known = gps_on = pos_have = false;
	pos_lat = pos_lon = 0;
	pos_moved = 0;
	ncontacts = nchannels = 0;
	meta_seq = ++seq;
	snprintf(last_error, sizeof(last_error), "%s", fail_reason);
	broken = false;
	uloop_timeout_set(&scan_t, fail_reason[0] ? RETRY_MS : SCAN_MS);
	fail_reason[0] = 0;
}

/* Its position, while the GPS is on: app start answers with it */
static void pos_cb(struct uloop_timeout *t)
{
	uint8_t f[19] = { CMD_APP_START };

	if (state != ST_READY || !gps_on)
		return;
	memcpy(f + 8, "PirateRadio", 11);
	if (!op_queued(OP_APPSTART))
		op_add1(OP_APPSTART, f, sizeof(f));
	uloop_timeout_set(t, pos_ms);
}

static void batt_cb(struct uloop_timeout *t)
{
	static const uint8_t f[] = { CMD_GET_BATT_AND_STORAGE };

	if (state != ST_READY)
		return;
	if (!op_queued(OP_BATT))
		op_add1(OP_BATT, f, sizeof(f));
	uloop_timeout_set(t, BATT_MS);
}

/* Sent and no delivery heard of in time: unconfirmed (it may still come) */
static void ack_cb(struct uloop_timeout *t)
{
	int64_t now = now_ms();
	int i;

	for (i = nmsgs - 1; i >= 0 && i >= nmsgs - 200; i--) {
		struct msg *m = &msgs[i];

		if (m->out && !strcmp(m->status, "sent") && m->ack && m->ack_by && now > m->ack_by)
			msg_status(m, "unconfirmed");
	}
	if (state == ST_READY)
		uloop_timeout_set(t, 1000);
}

static void refresh_cb(struct uloop_timeout *t)
{
	(void)t;
	contacts_refresh();
}

/* ---------- ubus ---------- */

enum {
	A_TO, A_TEXT, A_ID, A_CONV, A_SINCE, A_BEFORE, A_LIMIT, A_NAME, A_ENABLED, A_FLOOD,
	A_KEY, A_INDEX, A_SECRET,
	__A_MAX
};

/* Parsed loosely: a number may come as a string, a flag as a number */
static const struct blobmsg_policy pol_all[__A_MAX] = {
	[A_TO] = { "to", BLOBMSG_TYPE_UNSPEC },
	[A_TEXT] = { "text", BLOBMSG_TYPE_UNSPEC },
	[A_ID] = { "id", BLOBMSG_TYPE_UNSPEC },
	[A_CONV] = { "conv", BLOBMSG_TYPE_UNSPEC },
	[A_SINCE] = { "since", BLOBMSG_TYPE_UNSPEC },
	[A_BEFORE] = { "before", BLOBMSG_TYPE_UNSPEC },
	[A_LIMIT] = { "limit", BLOBMSG_TYPE_UNSPEC },
	[A_NAME] = { "name", BLOBMSG_TYPE_UNSPEC },
	[A_ENABLED] = { "enabled", BLOBMSG_TYPE_UNSPEC },
	[A_FLOOD] = { "flood", BLOBMSG_TYPE_UNSPEC },
	[A_KEY] = { "key", BLOBMSG_TYPE_UNSPEC },
	[A_INDEX] = { "index", BLOBMSG_TYPE_UNSPEC },
	[A_SECRET] = { "secret", BLOBMSG_TYPE_UNSPEC },
};
static struct blob_attr *tb[__A_MAX];

/* What `ubus -v list` shows for each method */
static const struct blobmsg_policy p_send[] = { { "to", BLOBMSG_TYPE_STRING }, { "text", BLOBMSG_TYPE_STRING } };
static const struct blobmsg_policy p_id[] = { { "id", BLOBMSG_TYPE_INT32 } };
static const struct blobmsg_policy p_messages[] = {
	{ "conv", BLOBMSG_TYPE_STRING }, { "before", BLOBMSG_TYPE_INT32 }, { "limit", BLOBMSG_TYPE_INT32 },
};
static const struct blobmsg_policy p_since[] = { { "since", BLOBMSG_TYPE_INT32 } };
static const struct blobmsg_policy p_conv[] = { { "conv", BLOBMSG_TYPE_STRING } };
static const struct blobmsg_policy p_name[] = { { "name", BLOBMSG_TYPE_STRING } };
static const struct blobmsg_policy p_enabled[] = { { "enabled", BLOBMSG_TYPE_BOOL } };
static const struct blobmsg_policy p_advert[] = { { "flood", BLOBMSG_TYPE_BOOL } };
static const struct blobmsg_policy p_key[] = { { "key", BLOBMSG_TYPE_STRING } };
static const struct blobmsg_policy p_channel[] = {
	{ "index", BLOBMSG_TYPE_INT32 }, { "name", BLOBMSG_TYPE_STRING }, { "secret", BLOBMSG_TYPE_STRING },
};

static void parse(struct blob_attr *msg)
{
	blobmsg_parse(pol_all, __A_MAX, tb, blob_data(msg), blob_len(msg));
}

static const char *arg_str(int i)
{
	return tb[i] && blobmsg_type(tb[i]) == BLOBMSG_TYPE_STRING ? blobmsg_get_string(tb[i]) : NULL;
}

static bool arg_num(int i, int64_t *v)
{
	struct blob_attr *a = tb[i];
	const char *s;
	char *e;

	if (!a)
		return false;
	switch (blobmsg_type(a)) {
	case BLOBMSG_TYPE_INT8:
		*v = blobmsg_get_u8(a);
		return true;
	case BLOBMSG_TYPE_INT16:
		*v = (int16_t)blobmsg_get_u16(a);
		return true;
	case BLOBMSG_TYPE_INT32:
		*v = (int32_t)blobmsg_get_u32(a);
		return true;
	case BLOBMSG_TYPE_INT64:
		*v = (int64_t)blobmsg_get_u64(a);
		return true;
	case BLOBMSG_TYPE_DOUBLE:
		*v = (int64_t)blobmsg_get_double(a);
		return true;
	case BLOBMSG_TYPE_STRING:
		s = blobmsg_get_string(a);
		*v = strtoll(s, &e, 10);
		return *s && !*e;
	}
	return false;
}

static int arg_bool(int i)
{
	const char *s = arg_str(i);
	int64_t v;

	if (!tb[i])
		return -1;
	if (s)
		return !strcmp(s, "1") || !strcmp(s, "true");
	return arg_num(i, &v) ? v != 0 : -1;
}

static int reply_error(struct ubus_context *c, struct ubus_request_data *req, const char *err)
{
	blob_buf_init(&rb, 0);
	blobmsg_add_string(&rb, "error", err);
	ubus_send_reply(c, req, rb.head);
	return UBUS_STATUS_OK;
}

static const char *not_ready(void)
{
	if (state == ST_ABSENT)
		return last_error[0] ? last_error : "no MeshCore radio is plugged in";
	if (state != ST_READY)
		return "the radio is still connecting: try again in a moment";
	if (nops >= MAX_QUEUE)
		return "the radio is busy: try again in a moment";
	return NULL;
}

static void add_coord(struct blob_buf *b, const char *name, int32_t v)
{
	blobmsg_add_double(b, name, v / 1e6);
}

/* Each conversation's unread count and latest message, in one pass */
static struct {
	char conv[16];
	int unread;
	uint32_t last;
} cstat[MAX_CONVS];
static int ncstat;

static void conv_stats(void)
{
	int i, j;

	ncstat = 0;
	for (i = nmsgs - 1; i >= 0; i--) {
		const struct msg *m = &msgs[i];
		uint32_t *u;

		for (j = 0; j < ncstat && strcmp(cstat[j].conv, m->conv); j++)
			;
		if (j == ncstat) {
			if (ncstat == MAX_CONVS)
				continue;
			snprintf(cstat[ncstat].conv, 16, "%s", m->conv);
			cstat[ncstat].unread = 0;
			cstat[ncstat].last = m->rx ? m->rx : m->ts;
			ncstat++;
		}
		u = read_upto(m->conv, false);
		if (!m->out && m->id > (u ? *u : 0))
			cstat[j].unread++;
	}
}

static int conv_unread(const char *conv, uint32_t *last)
{
	int j;

	for (j = 0; j < ncstat; j++)
		if (!strcmp(cstat[j].conv, conv)) {
			if (last)
				*last = cstat[j].last;
			return cstat[j].unread;
		}
	if (last)
		*last = 0;
	return 0;
}

static bool position_live(void)
{
	return gps_on && (pos_lat || pos_lon) && pos_moved && now_ms() - pos_moved <= LIVE_S * 1000;
}

static void add_position(struct blob_buf *b)
{
	void *t = blobmsg_open_table(b, "gps");

	blobmsg_add_u8(b, "available", gps_known);
	blobmsg_add_u8(b, "enabled", gps_on);
	blobmsg_add_u8(b, "live", position_live());
	if (pos_lat || pos_lon) {
		add_coord(b, "lat", pos_lat);
		add_coord(b, "lon", pos_lon);
		if (pos_moved)
			blobmsg_add_u32(b, "age", (now_ms() - pos_moved) / 1000);
	}
	blobmsg_close_table(b, t);
}

static int m_status(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		    const char *method, struct blob_attr *msg)
{
	char k[2 * PUB_KEY + 1];
	int i, unread = 0;

	(void)obj; (void)method; (void)msg;
	blob_buf_init(&rb, 0);
	blobmsg_add_string(&rb, "state", state_name());
	blobmsg_add_u32(&rb, "seq", seq);
	blobmsg_add_u32(&rb, "meta", meta_seq);
	if (state != ST_ABSENT)
		blobmsg_add_string(&rb, "device", dev_path);
	if (state == ST_ABSENT && last_error[0])
		blobmsg_add_string(&rb, "error", last_error);
	if (have_info) {
		if (model[0])
			blobmsg_add_string(&rb, "model", model);
		if (fw_version[0])
			blobmsg_add_string(&rb, "firmware", fw_version);
		if (fw_build[0])
			blobmsg_add_string(&rb, "build", fw_build);
		blobmsg_add_u32(&rb, "protocol", fw_ver);
		blobmsg_add_u32(&rb, "max_contacts", max_contacts);
		blobmsg_add_u32(&rb, "max_channels", max_channels);
	}
	if (self.have) {
		void *r;

		blobmsg_add_string(&rb, "name", self.name);
		hex(k, self.key, PUB_KEY);
		blobmsg_add_string(&rb, "key", k);
		blobmsg_add_u8(&rb, "share_location", self.adv_loc != 0);
		r = blobmsg_open_table(&rb, "radio");
		/* As the radio has them: kHz, and Hz */
		blobmsg_add_u32(&rb, "freq_khz", self.freq);
		blobmsg_add_u32(&rb, "bw_hz", self.bw);
		blobmsg_add_u32(&rb, "sf", self.sf);
		blobmsg_add_u32(&rb, "cr", self.cr);
		blobmsg_add_u32(&rb, "tx_power", self.tx_power);
		blobmsg_add_u32(&rb, "max_tx_power", self.max_tx);
		blobmsg_close_table(&rb, r);
	}
	if (batt.have) {
		blobmsg_add_u32(&rb, "battery_mv", batt.mv);
		if (batt.total_kb) {
			blobmsg_add_u32(&rb, "storage_used_kb", batt.used_kb);
			blobmsg_add_u32(&rb, "storage_total_kb", batt.total_kb);
		}
	}
	blobmsg_add_u32(&rb, "contacts", ncontacts);
	blobmsg_add_u32(&rb, "channels", nchannels);
	if (contacts_full)
		blobmsg_add_u8(&rb, "contacts_full", 1);
	conv_stats();
	for (i = 0; i < ncstat; i++)
		unread += cstat[i].unread;
	blobmsg_add_u32(&rb, "unread", unread);
	add_position(&rb);
	ubus_send_reply(c, req, rb.head);
	return UBUS_STATUS_OK;
}

static int m_position(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		      const char *method, struct blob_attr *msg)
{
	(void)obj; (void)method; (void)msg;
	blob_buf_init(&rb, 0);
	blobmsg_add_string(&rb, "state", state_name());
	blobmsg_add_u8(&rb, "available", gps_known);
	blobmsg_add_u8(&rb, "enabled", gps_on);
	blobmsg_add_u8(&rb, "live", position_live());
	if (position_live()) {
		add_coord(&rb, "lat", pos_lat);
		add_coord(&rb, "lon", pos_lon);
	}
	if (model[0])
		blobmsg_add_string(&rb, "source", model);
	ubus_send_reply(c, req, rb.head);
	return UBUS_STATUS_OK;
}

static const char *type_name(uint8_t t)
{
	switch (t) {
	case 1: return "chat";
	case 2: return "repeater";
	case 3: return "room";
	case 4: return "sensor";
	}
	return "unknown";
}

static int m_contacts(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		      const char *method, struct blob_attr *msg)
{
	char k[2 * PUB_KEY + 1], conv[16];
	void *a, *t;
	int i;

	(void)obj; (void)method; (void)msg;
	conv_stats();
	blob_buf_init(&rb, 0);
	blobmsg_add_u8(&rb, "loaded", contacts_loaded);
	a = blobmsg_open_array(&rb, "contacts");
	for (i = 0; i < ncontacts; i++) {
		const struct contact *x = &contacts[i];
		uint32_t last;

		t = blobmsg_open_table(&rb, NULL);
		hex(k, x->key, PUB_KEY);
		blobmsg_add_string(&rb, "key", k);
		conv_of_key(conv, x->key);
		blobmsg_add_string(&rb, "conv", conv);
		blobmsg_add_string(&rb, "name", x->name);
		blobmsg_add_string(&rb, "type", type_name(x->type));
		/* Its route: hops, or none known (it floods) */
		if (x->path_len == 0xff)
			blobmsg_add_u8(&rb, "flood", 1);
		else
			blobmsg_add_u32(&rb, "hops", x->path_len & 0x3f);
		blobmsg_add_u32(&rb, "last_advert", x->last_advert);
		if (x->lat || x->lon) {
			add_coord(&rb, "lat", x->lat);
			add_coord(&rb, "lon", x->lon);
		}
		blobmsg_add_u32(&rb, "unread", conv_unread(conv, &last));
		if (last)
			blobmsg_add_u32(&rb, "last_message", last);
		blobmsg_close_table(&rb, t);
	}
	blobmsg_close_array(&rb, a);
	ubus_send_reply(c, req, rb.head);
	return UBUS_STATUS_OK;
}

static int m_channels(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		      const char *method, struct blob_attr *msg)
{
	char s[33], conv[16];
	void *a, *t;
	int i, free_idx = -1;

	(void)obj; (void)method; (void)msg;
	conv_stats();
	blob_buf_init(&rb, 0);
	a = blobmsg_open_array(&rb, "channels");
	for (i = 0; i < nchannels; i++) {
		uint32_t last;

		t = blobmsg_open_table(&rb, NULL);
		snprintf(conv, sizeof(conv), "#%d", channels[i].idx);
		blobmsg_add_u32(&rb, "index", channels[i].idx);
		blobmsg_add_string(&rb, "conv", conv);
		blobmsg_add_string(&rb, "name", channels[i].name);
		hex(s, channels[i].secret, 16);
		blobmsg_add_string(&rb, "secret", s);
		blobmsg_add_u32(&rb, "unread", conv_unread(conv, &last));
		if (last)
			blobmsg_add_u32(&rb, "last_message", last);
		blobmsg_close_table(&rb, t);
	}
	blobmsg_close_array(&rb, a);
	/* The first free slot, for a new one */
	for (i = 0; i < max_channels && free_idx < 0; i++) {
		int j;

		for (j = 0; j < nchannels && channels[j].idx != i; j++)
			;
		if (j == nchannels)
			free_idx = i;
	}
	if (free_idx >= 0)
		blobmsg_add_u32(&rb, "free", free_idx);
	ubus_send_reply(c, req, rb.head);
	return UBUS_STATUS_OK;
}

static void add_msg(struct blob_buf *b, const struct msg *m)
{
	void *t = blobmsg_open_table(b, NULL);

	blobmsg_add_u32(b, "id", m->id);
	blobmsg_add_u32(b, "seq", m->seq);
	blobmsg_add_string(b, "conv", m->conv);
	blobmsg_add_u8(b, "out", m->out);
	blobmsg_add_u32(b, "ts", m->ts);
	if (m->rx)
		blobmsg_add_u32(b, "rx", m->rx);
	if (m->from[0])
		blobmsg_add_string(b, "from", m->from);
	blobmsg_add_string(b, "text", m->text);
	if (m->out) {
		blobmsg_add_string(b, "status", m->status);
		if (m->trip)
			blobmsg_add_u32(b, "trip_ms", m->trip);
		if (m->attempt)
			blobmsg_add_u32(b, "attempt", m->attempt);
		if (m->flood)
			blobmsg_add_u8(b, "flood", 1);
	} else {
		if (m->snr4 != INT16_MIN)
			blobmsg_add_double(b, "snr", m->snr4 / 4.0);
		if (m->path != 0xff)
			blobmsg_add_u32(b, "hops", m->path & 0x3f);
	}
	blobmsg_close_table(b, t);
}

/* A conversation's messages, newest last: its newest, or those before one */
static int m_messages(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		      const char *method, struct blob_attr *msg)
{
	const char *conv;
	int64_t before = 0, limit = 100;
	int i, start, n = 0;
	void *a;

	(void)obj; (void)method;
	parse(msg);
	conv = arg_str(A_CONV);
	if (!conv || !conv[0])
		return reply_error(c, req, "conv: a contact's or channel's, as contacts and channels have it");
	arg_num(A_BEFORE, &before);
	arg_num(A_LIMIT, &limit);
	if (limit < 1 || limit > MAX_LIST)
		limit = MAX_LIST;
	/* Back from the newest (or the one before), counting */
	for (start = nmsgs - 1; start >= 0; start--) {
		if (strcmp(msgs[start].conv, conv) || (before && msgs[start].id >= before))
			continue;
		if (++n == limit)
			break;
	}
	if (start < 0)
		start = 0;
	blob_buf_init(&rb, 0);
	blobmsg_add_u32(&rb, "seq", seq);
	a = blobmsg_open_array(&rb, "messages");
	for (i = start; i < nmsgs; i++)
		if (!strcmp(msgs[i].conv, conv) && (!before || msgs[i].id < before))
			add_msg(&rb, &msgs[i]);
	blobmsg_close_array(&rb, a);
	blobmsg_add_u8(&rb, "more", start > 0 && n == limit);
	ubus_send_reply(c, req, rb.head);
	return UBUS_STATUS_OK;
}

/* What changed since a seq: new or changed messages, and whether contacts,
 * channels or the device did */
static int m_poll(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		  const char *method, struct blob_attr *msg)
{
	int64_t since = 0;
	int i, n = 0;
	void *a;

	(void)obj; (void)method;
	parse(msg);
	arg_num(A_SINCE, &since);
	blob_buf_init(&rb, 0);
	blobmsg_add_string(&rb, "state", state_name());
	blobmsg_add_u32(&rb, "seq", seq);
	blobmsg_add_u8(&rb, "meta", meta_seq > since);
	/* The newest MAX_LIST changed, oldest first; more, and the page
	 * fetches what it shows afresh */
	for (i = nmsgs - 1; i >= 0; i--)
		if (msgs[i].seq > since && ++n > MAX_LIST)
			break;
	if (n > MAX_LIST)
		blobmsg_add_u8(&rb, "truncated", 1);
	a = blobmsg_open_array(&rb, "messages");
	for (i = i < 0 ? 0 : i + 1; i < nmsgs; i++)
		if (msgs[i].seq > since)
			add_msg(&rb, &msgs[i]);
	blobmsg_close_array(&rb, a);
	ubus_send_reply(c, req, rb.head);
	return UBUS_STATUS_OK;
}

/* Send a message: to a contact (its key, or the start of it: 12 hex
 * digits at least) or a channel ("#" and its index). It is kept at once,
 * queued; its status follows (sent, then delivered or unconfirmed). */
static int m_send(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		  const char *method, struct blob_attr *msg)
{
	const char *to, *text, *err;
	uint8_t f[MAX_FRAME], key[PUB_KEY];
	struct contact *ct = NULL;
	struct msg *m;
	struct op *o;
	size_t tl;
	int idx = -1, kl, i;

	(void)obj; (void)method;
	parse(msg);
	to = arg_str(A_TO);
	text = arg_str(A_TEXT);
	if (!to || !to[0])
		return reply_error(c, req, "to: a contact's key, or # and a channel's number");
	if (!text || !text[0])
		return reply_error(c, req, "text: the message");
	tl = strlen(text);
	if (tl > 150)
		return reply_error(c, req, "text: 150 bytes at most");
	for (i = 0; text[i]; i++)
		if ((unsigned char)text[i] < 32 && text[i] != '\n')
			return reply_error(c, req, "text: no control characters");
	if ((err = not_ready()))
		return reply_error(c, req, err);
	if (to[0] == '#') {
		char *e;

		idx = strtol(to + 1, &e, 10);
		for (i = 0; i < nchannels && channels[i].idx != idx; i++)
			;
		if (!to[1] || *e || i == nchannels)
			return reply_error(c, req, "to: no such channel");
		if (tl + strlen(self.name) + 2 > MAX_TEXT)
			return reply_error(c, req, "text: too long for a channel, with your name before it");
	} else {
		const char *k = to[0] == 'c' && strlen(to) == 13 ? to + 1 : to;

		kl = unhex(key, sizeof(key), k);
		if (kl < 6)
			return reply_error(c, req, "to: a contact's key (12 hex digits at least)");
		ct = contact_by_prefix(key, kl);
		if (!ct)
			return reply_error(c, req, "to: no such contact");
	}
	m = msg_new();
	m->out = true;
	m->ts = m->rx = time(NULL);
	snprintf(m->status, sizeof(m->status), "%s", "queued");
	snprintf(m->from, sizeof(m->from), "%s", self.name);
	memcpy(m->text, text, tl);
	m->text[tl] = 0;
	if (ct) {
		conv_of_key(m->conv, ct->key);
		f[0] = CMD_SEND_TXT_MSG;
		f[1] = 0;                 /* plain text */
		f[2] = 0;                 /* first attempt */
		wr32(f + 3, m->ts);
		memcpy(f + 7, ct->key, 6);
		memcpy(f + 13, text, tl);
		o = op_new(OP_SEND, f, 13 + tl);
	} else {
		snprintf(m->conv, sizeof(m->conv), "#%d", idx);
		f[0] = CMD_SEND_CHANNEL_TXT_MSG;
		f[1] = 0;
		f[2] = idx;
		wr32(f + 3, m->ts);
		memcpy(f + 7, text, tl);
		o = op_new(OP_SEND_CH, f, 7 + tl);
	}
	store_msg(m);
	if (o)
		o->msg_id = m->id;
	op_add(o);
	/* Sending it is reading what came before */
	{
		uint32_t *u = read_upto(m->conv, true);

		if (u && *u < m->id) {
			*u = m->id;
			store_line("r\t%s\t%u\n", m->conv, m->id);
		}
	}
	blob_buf_init(&rb, 0);
	blobmsg_add_u8(&rb, "ok", 1);
	blobmsg_add_u32(&rb, "id", m->id);
	blobmsg_add_u32(&rb, "seq", seq);
	ubus_send_reply(c, req, rb.head);
	return UBUS_STATUS_OK;
}

/* Send one again that wasn't confirmed: the same message (time and text),
 * the next attempt, as MeshCore's app does */
static int m_resend(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		    const char *method, struct blob_attr *msg)
{
	const char *err;
	uint8_t f[MAX_FRAME], key[PUB_KEY];
	struct contact *ct;
	struct msg *m;
	struct op *o;
	int64_t id;
	size_t tl;

	(void)obj; (void)method;
	parse(msg);
	if (!arg_num(A_ID, &id) || !(m = msg_by_id(id)) || !m->out)
		return reply_error(c, req, "id: a message you sent");
	if (m->conv[0] != 'c')
		return reply_error(c, req, "a channel's messages aren't confirmed: send it again instead");
	if (!strcmp(m->status, "delivered"))
		return reply_error(c, req, "it was delivered");
	if (!strcmp(m->status, "queued") || !strcmp(m->status, "sent"))
		return reply_error(c, req, "it is on its way: wait for it");
	if ((err = not_ready()))
		return reply_error(c, req, err);
	unhex(key, sizeof(key), m->conv + 1);
	ct = contact_by_prefix(key, 6);
	if (!ct)
		return reply_error(c, req, "that contact is gone");
	tl = strlen(m->text);
	m->attempt = m->attempt < 3 ? m->attempt + 1 : 3;
	f[0] = CMD_SEND_TXT_MSG;
	f[1] = 0;
	f[2] = m->attempt;
	wr32(f + 3, m->ts);
	memcpy(f + 7, ct->key, 6);
	memcpy(f + 13, m->text, tl);
	o = op_new(OP_SEND, f, 13 + tl);
	if (o)
		o->msg_id = m->id;
	msg_status(m, "queued");
	op_add(o);
	blob_buf_init(&rb, 0);
	blobmsg_add_u8(&rb, "ok", 1);
	blobmsg_add_u32(&rb, "seq", seq);
	ubus_send_reply(c, req, rb.head);
	return UBUS_STATUS_OK;
}

static int m_read(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		  const char *method, struct blob_attr *msg)
{
	const char *conv;
	uint32_t *u, last = 0;
	int i;

	(void)obj; (void)method;
	parse(msg);
	conv = arg_str(A_CONV);
	if (!conv || !conv[0] || strlen(conv) > 15)
		return reply_error(c, req, "conv: a contact's or channel's, as contacts and channels have it");
	for (i = nmsgs - 1; i >= 0; i--)
		if (!strcmp(msgs[i].conv, conv)) {
			last = msgs[i].id;
			break;
		}
	u = read_upto(conv, true);
	if (u && last > *u) {
		*u = last;
		store_line("r\t%s\t%u\n", conv, last);
		meta_seq = ++seq;
	}
	blob_buf_init(&rb, 0);
	blobmsg_add_u8(&rb, "ok", 1);
	ubus_send_reply(c, req, rb.head);
	return UBUS_STATUS_OK;
}

/* Commands answered once the radio has: deferred */
static int op_deferred(struct ubus_context *c, struct ubus_request_data *req, enum op_kind kind,
		       const uint8_t *f, size_t n, int arg)
{
	const char *err = not_ready();
	struct op *o;

	if (err)
		return reply_error(c, req, err);
	o = op_new(kind, f, n);
	if (!o)
		return reply_error(c, req, "out of memory");
	o->arg = arg;
	ubus_defer_request(c, req, &o->req);
	o->has_req = true;
	op_add(o);
	return UBUS_STATUS_OK;
}

static int m_advert(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		    const char *method, struct blob_attr *msg)
{
	uint8_t f[2] = { CMD_SEND_SELF_ADVERT, 0 };

	(void)obj; (void)method;
	parse(msg);
	/* Zero hop (its neighbours) or flooded (the whole mesh) */
	f[1] = arg_bool(A_FLOOD) == 1;
	return op_deferred(c, req, OP_ADVERT, f, 2, 0);
}

static int m_set_name(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		      const char *method, struct blob_attr *msg)
{
	uint8_t f[1 + MAX_NAME];
	const char *name;
	size_t n, i;

	(void)obj; (void)method;
	parse(msg);
	name = arg_str(A_NAME);
	if (!name || !name[0])
		return reply_error(c, req, "name: what the mesh knows this radio by");
	n = strlen(name);
	if (n > MAX_NAME - 1)
		return reply_error(c, req, "name: 31 bytes at most");
	for (i = 0; i < n; i++)
		if ((unsigned char)name[i] < 32)
			return reply_error(c, req, "name: no control characters");
	f[0] = CMD_SET_ADVERT_NAME;
	memcpy(f + 1, name, n);
	if (state == ST_READY)
		snprintf(self.name, sizeof(self.name), "%s", name);
	meta_seq = ++seq;
	return op_deferred(c, req, OP_NAME, f, 1 + n, 0);
}

static int m_gps(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		 const char *method, struct blob_attr *msg)
{
	uint8_t f[8];
	int on;

	(void)obj; (void)method;
	parse(msg);
	on = arg_bool(A_ENABLED);
	if (on < 0)
		return reply_error(c, req, "enabled: true or false");
	if (state == ST_READY && !gps_known)
		return reply_error(c, req, "this radio has no GPS");
	f[0] = CMD_SET_CUSTOM_VAR;
	memcpy(f + 1, on ? "gps:1" : "gps:0", 5);
	return op_deferred(c, req, OP_SETVAR, f, 6, on);
}

/* A channel into a slot: a hashtag one (its key is the first half of the
 * SHA-256 of its name, so anyone who knows the name can join), one with a
 * key given (32 hex digits), or a new private one (a random key). An empty
 * name and no key clears the slot. */
static int m_channel_set(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
			 const char *method, struct blob_attr *msg)
{
	uint8_t f[50], secret[32];
	const char *name, *sec;
	int64_t idx;
	size_t n;
	int i;

	(void)obj; (void)method;
	parse(msg);
	if (!arg_num(A_INDEX, &idx) || idx < 0 || idx >= max_channels)
		return reply_error(c, req, "index: a channel slot, 0 up");
	name = arg_str(A_NAME);
	sec = arg_str(A_SECRET);
	if (!name)
		name = "";
	n = strlen(name);
	if (n > 31)
		return reply_error(c, req, "name: 31 bytes at most");
	for (i = 0; name[i]; i++)
		if ((unsigned char)name[i] < 32)
			return reply_error(c, req, "name: no control characters");
	memset(f, 0, sizeof(f));
	f[0] = CMD_SET_CHANNEL;
	f[1] = idx;
	memcpy(f + 2, name, n);
	if (!n) {
		/* Cleared: no name, no key */
	} else if (sec && sec[0]) {
		if (unhex(secret, 16, sec) != 16)
			return reply_error(c, req, "secret: 32 hex digits (16 bytes)");
		memcpy(f + 34, secret, 16);
	} else if (name[0] == '#') {
		sha256((const uint8_t *)name, n, secret);
		memcpy(f + 34, secret, 16);
	} else {
		FILE *r = fopen("/dev/urandom", "r");
		size_t got = r ? fread(f + 34, 1, 16, r) : 0;

		if (r)
			fclose(r);
		if (got != 16)
			return reply_error(c, req, "no random numbers for a key");
	}
	/* Answered once the radio has it, and that slot fetched again */
	{
		const char *err = not_ready();
		struct op *o;
		int j;

		if (err)
			return reply_error(c, req, err);
		o = op_new(OP_SETCH, f, 50);
		if (!o)
			return reply_error(c, req, "out of memory");
		o->arg = idx;
		ubus_defer_request(c, req, &o->req);
		o->has_req = true;
		op_add(o);
		for (j = 0; j < nchannels && channels[j].idx != idx; j++)
			;
		if (j < nchannels) {
			memmove(&channels[j], &channels[j + 1], (nchannels - j - 1) * sizeof(*channels));
			nchannels--;
		}
		if (n && nchannels < MAX_CHANNELS) {
			struct channel *ch = &channels[nchannels++];

			ch->idx = idx;
			snprintf(ch->name, sizeof(ch->name), "%s", name);
			memcpy(ch->secret, f + 34, 16);
		}
		meta_seq = ++seq;
	}
	return UBUS_STATUS_OK;
}

static int contact_op(struct ubus_context *c, struct ubus_request_data *req, struct blob_attr *msg,
		      uint8_t cmd, enum op_kind kind)
{
	uint8_t f[1 + PUB_KEY], key[PUB_KEY];
	const char *k;
	struct contact *ct;
	int kl;

	parse(msg);
	k = arg_str(A_KEY);
	if (!k)
		return reply_error(c, req, "key: a contact's");
	if (k[0] == 'c' && strlen(k) == 13)
		k++;
	kl = unhex(key, sizeof(key), k);
	if (kl < 6)
		return reply_error(c, req, "key: a contact's (12 hex digits at least)");
	ct = contact_by_prefix(key, kl);
	if (!ct)
		return reply_error(c, req, "no such contact");
	f[0] = cmd;
	memcpy(f + 1, ct->key, PUB_KEY);
	if (kind == OP_REMOVE && state == ST_READY) {
		/* Gone at once; the radio confirms */
		int r = op_deferred(c, req, kind, f, sizeof(f), 0);

		memmove(ct, ct + 1, (contacts + ncontacts - ct - 1) * sizeof(*ct));
		ncontacts--;
		meta_seq = ++seq;
		return r;
	}
	if (kind == OP_RESETPATH && state == ST_READY) {
		ct->path_len = 0xff;
		meta_seq = ++seq;
	}
	return op_deferred(c, req, kind, f, sizeof(f), 0);
}

static int m_contact_remove(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
			    const char *method, struct blob_attr *msg)
{
	(void)obj; (void)method;
	if (not_ready())
		return reply_error(c, req, not_ready());
	return contact_op(c, req, msg, CMD_REMOVE_CONTACT, OP_REMOVE);
}

static int m_contact_reset_path(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
				const char *method, struct blob_attr *msg)
{
	(void)obj; (void)method;
	if (not_ready())
		return reply_error(c, req, not_ready());
	return contact_op(c, req, msg, CMD_RESET_PATH, OP_RESETPATH);
}

static int m_refresh(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		     const char *method, struct blob_attr *msg)
{
	const char *err = not_ready();

	(void)obj; (void)method; (void)msg;
	if (err)
		return reply_error(c, req, err);
	contacts_refresh();
	sync_messages();
	batt_cb(&batt_t);
	blob_buf_init(&rb, 0);
	blobmsg_add_u8(&rb, "ok", 1);
	ubus_send_reply(c, req, rb.head);
	return UBUS_STATUS_OK;
}

static const struct ubus_method methods[] = {
	UBUS_METHOD_NOARG("status", m_status),
	UBUS_METHOD_NOARG("position", m_position),
	UBUS_METHOD_NOARG("contacts", m_contacts),
	UBUS_METHOD_NOARG("channels", m_channels),
	UBUS_METHOD("messages", m_messages, p_messages),
	UBUS_METHOD("poll", m_poll, p_since),
	UBUS_METHOD("send", m_send, p_send),
	UBUS_METHOD("resend", m_resend, p_id),
	UBUS_METHOD("read", m_read, p_conv),
	UBUS_METHOD("advert", m_advert, p_advert),
	UBUS_METHOD("set_name", m_set_name, p_name),
	UBUS_METHOD("gps", m_gps, p_enabled),
	UBUS_METHOD("channel_set", m_channel_set, p_channel),
	UBUS_METHOD("contact_remove", m_contact_remove, p_key),
	UBUS_METHOD("contact_reset_path", m_contact_reset_path, p_key),
	UBUS_METHOD_NOARG("refresh", m_refresh),
};

static struct ubus_object_type obj_type = UBUS_OBJECT_TYPE("pirate.meshcore", methods);

static struct ubus_object obj = {
	.name = "pirate.meshcore",
	.type = &obj_type,
	.methods = methods,
	.n_methods = ARRAY_SIZE(methods),
};

static void on_connect(struct ubus_context *c)
{
	int r = ubus_add_object(c, &obj);

	if (r)
		logmsg("can't add pirate.meshcore to ubus: %s", ubus_strerror(r));
}

static void usage(void)
{
	fprintf(stderr, "usage: pirate-meshcore [-d device] [-s sysfs] [-m messages-file] [-u ubus-socket]\n"
		"                       [-p position-ms] [-a ack-wait-ms]\n");
	exit(2);
}

int main(int argc, char **argv)
{
	int c;

	while ((c = getopt(argc, argv, "d:s:m:u:p:a:")) != -1) {
		switch (c) {
		case 'p':
			pos_ms = atoi(optarg) > 100 ? atoi(optarg) : 100;
			break;
		case 'a':
			ack_min_ms = atoi(optarg) > 0 ? atoi(optarg) : 0;
			break;
		case 'd':
			opt_dev = optarg;
			break;
		case 's':
			opt_sysfs = optarg;
			break;
		case 'm':
			opt_store = optarg;
			break;
		case 'u':
			conn.path = optarg;
			break;
		default:
			usage();
		}
	}
	if (optind != argc)
		usage();
	msgs = calloc(MAX_MSGS, sizeof(*msgs));
	if (!msgs) {
		logmsg("out of memory");
		return 1;
	}
	signal(SIGPIPE, SIG_IGN);
	setvbuf(stderr, NULL, _IOLBF, 0);
	store_load();
	uloop_init();
	scan_t.cb = scan_cb;
	hs_t.cb = hs_cb;
	op_t.cb = op_timeout;
	close_t.cb = close_cb;
	pos_t.cb = pos_cb;
	batt_t.cb = batt_cb;
	ack_t.cb = ack_cb;
	refresh_t.cb = refresh_cb;
	conn.cb = on_connect;
	ubus_auto_connect(&conn);
	uloop_timeout_set(&scan_t, 0);
	uloop_run();
	if (fd >= 0)
		close(fd);
	uloop_done();
	return 0;
}
