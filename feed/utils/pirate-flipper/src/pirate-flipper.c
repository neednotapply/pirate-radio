/*
 * pirate-flipper: a Flipper Zero plugged into the router's USB port, for the
 * Pirate Radio web UI's Flipper tab: its screen and buttons, its files and
 * its details, as qFlipper shows them on a computer. On ubus as
 * pirate.flipper.
 *
 * It talks to the Flipper as qFlipper does: "start_rpc_session" typed at the
 * CLI on the Flipper's USB serial port, then the Flipper's RPC protocol,
 * protobuf messages each led by its length. The few messages used here are
 * encoded and decoded by hand, after their definitions in
 * https://github.com/flipperdevices/flipperzero-protobuf. One request is out
 * at a time; screen frames come in between, unasked.
 *
 *   pirate-flipper [-d device] [-s sysfs] [-u ubus-socket]
 *
 *   -d  the Flipper's serial device (default: the ttyACM device of a USB
 *       device 0483:5740, looked for every second while none is open)
 *   -s  where sysfs is (default /sys; for tests)
 *   -u  ubusd's socket (default: libubus's)
 *
 * pirate.flipper methods (errors come back as {"error": "..."}):
 *   status                  state (absent, dfu, connecting, ready), name,
 *                           firmware, battery, SD card, the last error
 *   info                    everything the Flipper reports about itself
 *   screen {seq}            the screen (128x64, a bit a pixel, a byte for 8
 *                           rows of a column, base64) once it is no longer
 *                           frame <seq>; waits up to 1 s for a new one
 *   input {key, type}       a button: up, down, left, right, ok or back;
 *                           press, release, short, long or repeat, or a few
 *                           joined with "+" (click: press+short+release,
 *                           hold: press+long+release)
 *   list {path}             a folder's files
 *   read {path[, offset]}   a file: without an offset, read it into memory
 *                           (busy until then, 8 MiB at most); with one, up to
 *                           64 KiB of it from there, base64
 *   write {path, offset, data, more}
 *                           a file, a piece (base64, 48 KiB at most) a call:
 *                           offset 0 starts it, more: false ends it; pieces go
 *                           on to the Flipper as they come
 *   mkdir {path}, delete {path, recursive}, rename {path, to}
 *   storage {path}          total and free space
 *   alert                   beep and blink, to find it
 *   time {year, month, day, hour, minute, second, weekday}
 *                           set its clock (default: the router's)
 *   reboot {mode}           os (default), dfu or update
 */
#define _GNU_SOURCE
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
#include <termios.h>
#include <time.h>
#include <unistd.h>

#include <libubox/blobmsg.h>
#include <libubox/list.h>
#include <libubox/uloop.h>
#include <libubox/utils.h>
#include <libubus.h>

#define FLIPPER_VID     "0483"
#define FLIPPER_PID     "5740"
#define FLIPPER_DFU_PID "df11"

#define MAX_MSG     (64 * 1024)        /* an RPC message, at most */
#define CHUNK       512                /* file data in a message (storage.options) */
#define MAX_READ    (8 * 1024 * 1024)  /* a file read into memory, at most */
#define READ_SLICE  (64 * 1024)
#define MAX_PIECE   (48 * 1024)        /* a piece of a file being written */
#define MAX_LISTED  2000
#define OUT_HIGH    (8 * 1024)         /* file data waits while this much is unsent */
#define FRAME_LEN   1024
#define MAX_PATH    255
#define MAX_QUEUE   24
#define MAX_WAITERS 8
#define MAX_INFO    128
#define MAX_POWER   32

#define SCREEN_WAIT_MS 1000
#define STREAM_IDLE_MS 10000
#define OP_TIMEOUT_MS  15000
#define PIECE_WAIT_MS  30000
#define HS_FIRST_MS    300
#define HS_RETRY_MS    2500
#define HS_TRIES       3
#define SCAN_MS        1000
#define RETRY_MS       5000
#define RESTART_MS     500
#define CACHE_KEEP_MS  60000
#define POWER_MAX_AGE  30

/* Main's content fields (flipper.proto) */
enum {
	PB_EMPTY = 4,
	PB_PING_REQ = 5, PB_PING_RESP = 6,
	PB_LIST_REQ = 7, PB_LIST_RESP = 8,
	PB_READ_REQ = 9, PB_READ_RESP = 10,
	PB_WRITE_REQ = 11, PB_DELETE_REQ = 12, PB_MKDIR_REQ = 13,
	PB_STREAM_START = 20, PB_STREAM_STOP = 21, PB_FRAME = 22, PB_INPUT = 23,
	PB_STORAGE_REQ = 28, PB_STORAGE_RESP = 29,
	PB_RENAME_REQ = 30, PB_REBOOT_REQ = 31,
	PB_DEVINFO_REQ = 32, PB_DEVINFO_RESP = 33,
	PB_TIME_REQ = 37, PB_ALERT_REQ = 38,
	PB_VERSION_REQ = 39, PB_VERSION_RESP = 40,
	PB_POWER_REQ = 44, PB_POWER_RESP = 45,
};

static const char *const KEYS[] = { "up", "down", "right", "left", "ok", "back" };
static const char *const TYPES[] = { "press", "release", "short", "long", "repeat" };
static const char *const ORIENT[] = { "horizontal", "horizontal_flip", "vertical", "vertical_flip" };
static const char *const MODES[] = { "os", "dfu", "update" };

/* ---------- buffers, protobuf ---------- */

struct buf {
	uint8_t *d;
	size_t len, cap;
};

static bool buf_add(struct buf *b, const void *p, size_t n)
{
	if (!n)
		return true;
	if (b->len + n > b->cap) {
		size_t c = b->cap ? b->cap : 256;
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

/* Drop the first n bytes */
static void buf_drop(struct buf *b, size_t n)
{
	if (n >= b->len) {
		b->len = 0;
		return;
	}
	memmove(b->d, b->d + n, b->len - n);
	b->len -= n;
}

static void buf_free(struct buf *b)
{
	free(b->d);
	b->d = NULL;
	b->len = b->cap = 0;
}

static void pb_varint(struct buf *b, uint64_t v)
{
	uint8_t t[10];
	int n = 0;

	do {
		t[n] = v & 0x7f;
		v >>= 7;
		if (v)
			t[n] |= 0x80;
		n++;
	} while (v);
	buf_add(b, t, n);
}

/* proto3: a zero is the default, and left out */
static void pb_uint(struct buf *b, unsigned field, uint64_t v)
{
	if (!v)
		return;
	pb_varint(b, (uint64_t)field << 3);
	pb_varint(b, v);
}

static void pb_bytes(struct buf *b, unsigned field, const void *p, size_t n)
{
	pb_varint(b, ((uint64_t)field << 3) | 2);
	pb_varint(b, n);
	buf_add(b, p, n);
}

static void pb_str(struct buf *b, unsigned field, const char *s)
{
	if (s && *s)
		pb_bytes(b, field, s, strlen(s));
}

struct pbf {
	unsigned field, wt;
	uint64_t v;
	const uint8_t *p;
	size_t len;
};

/* 1: read; 0: not all there yet; -1: too long */
static int pb_varint_get(const uint8_t **p, const uint8_t *end, uint64_t *v)
{
	const uint8_t *q = *p;
	uint64_t r = 0;
	int s;

	for (s = 0; s < 70; s += 7) {
		if (q >= end)
			return 0;
		r |= (uint64_t)(*q & 0x7f) << s;
		if (!(*q++ & 0x80)) {
			*v = r;
			*p = q;
			return 1;
		}
	}
	return -1;
}

/* The next field: 1, or 0 at the end, -1 if garbled */
static int pb_next(const uint8_t **p, const uint8_t *end, struct pbf *f)
{
	uint64_t k, n;

	if (*p >= end)
		return 0;
	if (pb_varint_get(p, end, &k) != 1)
		return -1;
	f->field = k >> 3;
	f->wt = k & 7;
	f->v = 0;
	f->p = NULL;
	f->len = 0;
	switch (f->wt) {
	case 0:
		return pb_varint_get(p, end, &f->v) == 1 ? 1 : -1;
	case 1:
		n = 8;
		break;
	case 5:
		n = 4;
		break;
	case 2:
		if (pb_varint_get(p, end, &n) != 1)
			return -1;
		break;
	default:
		return -1;
	}
	if (n > (uint64_t)(end - *p))
		return -1;
	f->p = *p;
	f->len = n;
	*p += n;
	return 1;
}

/* A message's field (its last, as protobuf has it) */
static bool pb_field(const uint8_t *p, size_t n, unsigned field, struct pbf *out)
{
	const uint8_t *end = p + n;
	struct pbf f;
	bool found = false;

	while (pb_next(&p, end, &f) == 1)
		if (f.field == field) {
			*out = f;
			found = true;
		}
	return found;
}

static uint64_t pb_get_uint(const uint8_t *p, size_t n, unsigned field)
{
	struct pbf f;

	return pb_field(p, n, field, &f) && f.wt == 0 ? f.v : 0;
}

static void pb_get_str(const uint8_t *p, size_t n, unsigned field, char *s, size_t size)
{
	struct pbf f;
	size_t l = 0;

	if (pb_field(p, n, field, &f) && f.wt == 2) {
		l = f.len < size - 1 ? f.len : size - 1;
		memcpy(s, f.p, l);
	}
	s[l] = 0;
}

struct rpc_msg {
	uint32_t id;
	unsigned status, content;
	bool has_next;
	const uint8_t *body;
	size_t len;
};

static bool rpc_decode(const uint8_t *p, size_t n, struct rpc_msg *m)
{
	const uint8_t *end = p + n;
	struct pbf f;
	int r;

	memset(m, 0, sizeof(*m));
	while ((r = pb_next(&p, end, &f)) == 1) {
		if (f.wt == 0 && f.field == 1)
			m->id = f.v;
		else if (f.wt == 0 && f.field == 2)
			m->status = f.v;
		else if (f.wt == 0 && f.field == 3)
			m->has_next = !!f.v;
		else if (f.wt == 2 && f.field >= 4) {
			m->content = f.field;
			m->body = f.p;
			m->len = f.len;
		}
	}
	return r == 0;
}

/* CommandStatus (flipper.proto), as the UI shows it */
static const char *status_text(unsigned s)
{
	switch (s) {
	case 2: return "the Flipper couldn't make out the request";
	case 3: return "this Flipper's firmware can't do that";
	case 4: return "the Flipper is busy: close the app that has it";
	case 5: return "the Flipper's SD card isn't ready";
	case 6: return "already exists";
	case 7: return "no such file or folder";
	case 8: case 15: return "the Flipper refused the request's details";
	case 9: return "access denied";
	case 10: return "the Flipper takes plain ASCII names only";
	case 11: return "the Flipper's storage failed";
	case 12: return "the Flipper's storage can't do that";
	case 13: return "the file is open already";
	case 14: return "interrupted";
	case 16: return "the app couldn't start";
	case 17: return "another app is running on the Flipper";
	case 18: return "the folder isn't empty";
	default: return "the Flipper reported an error";
	}
}

/* ---------- state ---------- */

enum state { ST_ABSENT, ST_DFU, ST_CONNECTING, ST_READY };

enum op_kind {
	OP_PING, OP_VERSION, OP_INFO, OP_POWER, OP_STORAGE, OP_LIST, OP_READ, OP_WRITE,
	OP_DELETE, OP_MKDIR, OP_RENAME, OP_INPUT, OP_STREAM_START, OP_STREAM_STOP,
	OP_ALERT, OP_TIME, OP_REBOOT,
};

struct op {
	struct list_head list;
	enum op_kind kind;
	uint32_t id;
	bool deferred;                  /* a ubus caller waits for the answer */
	struct ubus_request_data req;
	struct blob_buf b;              /* the answer, built as it comes */
	void *nest;
	unsigned count;
	bool initial;                   /* the last of the requests made on connecting */
	char path[MAX_PATH + 1], path2[MAX_PATH + 1];
	bool recursive;
	unsigned mode;
	unsigned key, types[8];
	int ntypes, next_type;
	unsigned dt[7];
	/* OP_WRITE: the data still to send, from pos */
	struct buf data;
	size_t pos;
	uint64_t received;
	bool final, last_sent, piece_waiting;
	struct ubus_request_data piece_req;
};

struct kv {
	char k[48], v[96];
};

struct waiter {
	bool used;
	uint32_t seq;
	struct ubus_request_data req;
	struct uloop_timeout t;
};

static const char *opt_dev, *opt_sysfs = "/sys";
static struct ubus_auto_conn conn;
#define UBUS (&conn.ctx)

static enum state state = ST_ABSENT;
static int fd = -1;
static struct uloop_fd ufd;
static bool rpc_up, broken, restart;
static int hs_tries;
static char dev_path[256], last_error[200], fail_reason[200];
static struct buf in, out;
static uint32_t next_id = 1;
static LIST_HEAD(ops);
static int nops;
static struct op *cur;
static struct uloop_timeout scan_t, hs_t, op_t, stream_t, piece_t, close_t, rc_t;

static struct kv info[MAX_INFO], power[MAX_POWER];
static int ninfo, npower;
static time_t power_at;
static bool power_pending, have_version, have_sd;
static unsigned pb_major, pb_minor;
static uint64_t sd_total, sd_free;

static uint8_t frame[FRAME_LEN];
static unsigned frame_orient;
static uint32_t frame_seq;
static bool have_frame, streaming;
static int64_t last_screen;
static struct waiter waiters[MAX_WAITERS];

static struct {
	bool active, busy, too_big;
	char path[MAX_PATH + 1], err[160];
	struct buf data;
} rc;

static struct blob_buf rb;

static void out_flush(void);
static void write_pump(void);
static void op_next(void);

static int64_t now_ms(void)
{
	struct timespec t;

	clock_gettime(CLOCK_MONOTONIC, &t);
	return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static void logmsg(const char *fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vfprintf(stderr, fmt, ap);
	va_end(ap);
	fputc('\n', stderr);
}

static const char *state_name(void)
{
	static const char *const n[] = { "absent", "dfu", "connecting", "ready" };

	return n[state];
}

static void kv_set(struct kv *a, int *n, int max, const char *k, const char *v)
{
	char key[sizeof(a->k)], *c;
	int i;

	snprintf(key, sizeof(key), "%s", k);
	for (c = key; *c; c++)
		if (*c == '.')
			*c = '_';
	for (i = 0; i < *n; i++)
		if (!strcmp(a[i].k, key))
			break;
	if (i == *n) {
		if (*n >= max)
			return;
		(*n)++;
	}
	snprintf(a[i].k, sizeof(a[i].k), "%s", key);
	snprintf(a[i].v, sizeof(a[i].v), "%s", v);
}

static const char *kv_get(const struct kv *a, int n, const char *k)
{
	int i;

	for (i = 0; i < n; i++)
		if (!strcmp(a[i].k, k))
			return a[i].v;
	return NULL;
}

/* ---------- the serial port ---------- */

/* Close the device and look for it again, once back in the main loop; why:
 * what went wrong, if anything did (the Flipper unplugged: NULL). */
static void dev_fail(const char *why)
{
	if (broken)
		return;
	broken = true;
	snprintf(fail_reason, sizeof(fail_reason), "%s", why ? why : "");
	logmsg("%s: %s", dev_path, why ? why : "the Flipper went away");
	uloop_timeout_set(&close_t, 0);
}

/* Start the RPC session over, at once: the session itself is the trouble
 * (a file left half sent), not the Flipper */
static void dev_restart(const char *why)
{
	if (broken)
		return;
	dev_fail(why);
	restart = true;
}

static void rpc_send(uint32_t id, bool has_next, unsigned field, const struct buf *content)
{
	struct buf m = { 0 };

	pb_uint(&m, 1, id);
	if (has_next)
		pb_uint(&m, 3, 1);
	pb_bytes(&m, field, content ? content->d : NULL, content ? content->len : 0);
	pb_varint(&out, m.len);
	buf_add(&out, m.d, m.len);
	buf_free(&m);
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
			if (cur)
				uloop_timeout_set(&op_t, OP_TIMEOUT_MS);
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

/* ---------- requests ---------- */

static struct op *op_new(enum op_kind kind)
{
	struct op *o = calloc(1, sizeof(*o));

	if (o)
		o->kind = kind;
	return o;
}

static void op_free(struct op *o)
{
	blob_buf_free(&o->b);
	buf_free(&o->data);
	free(o);
}

static void op_add(struct op *o)
{
	if (!o)
		return;
	list_add_tail(&o->list, &ops);
	nops++;
	op_next();
}

static void send_reply(struct ubus_request_data *req, struct blob_buf *b)
{
	ubus_send_reply(UBUS, req, b->head);
	ubus_complete_deferred_request(UBUS, req, UBUS_STATUS_OK);
}

/* A write's caller, waiting for its piece to be taken (or for the end) */
static void piece_reply(struct op *o, const char *err)
{
	struct blob_buf b = { 0 };

	if (!o->piece_waiting)
		return;
	o->piece_waiting = false;
	blob_buf_init(&b, 0);
	if (err) {
		blobmsg_add_string(&b, "error", err);
	} else {
		blobmsg_add_u8(&b, "ok", 1);
		blobmsg_add_u64(&b, o->final ? "size" : "received", o->received);
	}
	send_reply(&o->piece_req, &b);
	blob_buf_free(&b);
	if (!err && !o->final && o == cur)
		uloop_timeout_set(&piece_t, PIECE_WAIT_MS);
}

static void rc_clear(void)
{
	buf_free(&rc.data);
	memset(&rc, 0, sizeof(rc));
	uloop_timeout_cancel(&rc_t);
}

/* What finishing o does here, besides answering its caller */
static void op_effects(struct op *o, const char *err)
{
	struct op *n;

	switch (o->kind) {
	case OP_PING:
		if (err) {
			dev_fail("the Flipper doesn't answer RPC requests");
			break;
		}
		op_add(op_new(OP_VERSION));
		op_add(op_new(OP_INFO));
		op_add(op_new(OP_POWER));
		n = op_new(OP_STORAGE);
		if (n) {
			strcpy(n->path, "/ext");
			n->initial = true;
			op_add(n);
		}
		break;
	case OP_POWER:
		power_pending = false;
		power_at = time(NULL);
		break;
	case OP_LIST:
		if (!err) {
			blobmsg_close_array(&o->b, o->nest);
			blobmsg_add_string(&o->b, "path", o->path);
			if (o->count > MAX_LISTED)
				blobmsg_add_u32(&o->b, "total", o->count);
		}
		break;
	case OP_READ:
		if (!rc.active || strcmp(rc.path, o->path))
			break;
		rc.busy = false;
		if (err)
			snprintf(rc.err, sizeof(rc.err), "%s", err);
		else if (rc.too_big)
			snprintf(rc.err, sizeof(rc.err), "too big to download here (8 MB at most)");
		uloop_timeout_set(&rc_t, CACHE_KEEP_MS);
		break;
	case OP_STREAM_START:
		if (err)
			streaming = false;
		break;
	default:
		break;
	}
	if (o->initial && !broken) {
		state = ST_READY;
		last_error[0] = 0;
		logmsg("%s: ready: %s, firmware %s", dev_path,
		       kv_get(info, ninfo, "hardware_name") ? kv_get(info, ninfo, "hardware_name") : "?",
		       kv_get(info, ninfo, "firmware_version") ? kv_get(info, ninfo, "firmware_version") : "?");
	}
}

static void op_finish(struct op *o, const char *err)
{
	if (o == cur) {
		cur = NULL;
		uloop_timeout_cancel(&op_t);
		uloop_timeout_cancel(&piece_t);
	}
	list_del(&o->list);
	nops--;
	op_effects(o, err);
	if (o->deferred) {
		o->deferred = false;
		if (err || !o->b.head) {
			blob_buf_init(&o->b, 0);
			if (err)
				blobmsg_add_string(&o->b, "error", err);
			else
				blobmsg_add_u8(&o->b, "ok", 1);
		}
		send_reply(&o->req, &o->b);
	}
	if (o->kind == OP_WRITE)
		piece_reply(o, err);
	op_free(o);
	op_next();
}

static void input_send(struct op *o)
{
	struct buf c = { 0 };

	pb_uint(&c, 1, o->key);
	pb_uint(&c, 2, o->types[o->next_type]);
	rpc_send(o->id, false, PB_INPUT, &c);
	buf_free(&c);
}

static uint32_t new_id(void)
{
	uint32_t id = next_id++;

	if (!next_id)
		next_id = 1;
	return id;
}

static void op_start(struct op *o)
{
	struct buf c = { 0 }, s = { 0 };
	unsigned field = PB_EMPTY;
	int i;

	switch (o->kind) {
	case OP_PING:
		pb_str(&c, 1, "pirate-radio");
		field = PB_PING_REQ;
		break;
	case OP_VERSION:
		field = PB_VERSION_REQ;
		break;
	case OP_INFO:
		field = PB_DEVINFO_REQ;
		break;
	case OP_POWER:
		field = PB_POWER_REQ;
		break;
	case OP_STORAGE:
		pb_str(&c, 1, o->path);
		field = PB_STORAGE_REQ;
		break;
	case OP_LIST:
		pb_str(&c, 1, o->path);
		field = PB_LIST_REQ;
		break;
	case OP_READ:
		pb_str(&c, 1, o->path);
		field = PB_READ_REQ;
		break;
	case OP_DELETE:
		pb_str(&c, 1, o->path);
		pb_uint(&c, 2, o->recursive);
		field = PB_DELETE_REQ;
		break;
	case OP_MKDIR:
		pb_str(&c, 1, o->path);
		field = PB_MKDIR_REQ;
		break;
	case OP_RENAME:
		pb_str(&c, 1, o->path);
		pb_str(&c, 2, o->path2);
		field = PB_RENAME_REQ;
		break;
	case OP_STREAM_START:
		field = PB_STREAM_START;
		break;
	case OP_STREAM_STOP:
		field = PB_STREAM_STOP;
		break;
	case OP_ALERT:
		field = PB_ALERT_REQ;
		break;
	case OP_TIME:
		for (i = 0; i < 7; i++)
			pb_uint(&s, i + 1, o->dt[i]);
		pb_bytes(&c, 1, s.d, s.len);
		field = PB_TIME_REQ;
		break;
	case OP_REBOOT:
		pb_uint(&c, 1, o->mode);
		field = PB_REBOOT_REQ;
		break;
	case OP_INPUT:
		input_send(o);
		field = 0;
		break;
	case OP_WRITE:
		field = 0;
		break;
	}
	if (field)
		rpc_send(o->id, false, field, &c);
	buf_free(&c);
	buf_free(&s);
	uloop_timeout_set(&op_t, OP_TIMEOUT_MS);
	if (o->kind == OP_WRITE)
		write_pump();
	else
		out_flush();
}

static void op_next(void)
{
	if (cur || fd < 0 || !rpc_up || broken || list_empty(&ops))
		return;
	cur = list_first_entry(&ops, struct op, list);
	cur->id = new_id();
	op_start(cur);
	/* The Flipper restarts rather than answer */
	if (cur && cur->kind == OP_REBOOT && !broken)
		op_finish(cur, NULL);
}

/* ---------- writing files ---------- */

static void write_chunk(struct op *o, const uint8_t *p, size_t n, bool last)
{
	struct buf file = { 0 }, c = { 0 };

	if (n)
		pb_bytes(&file, 4, p, n);
	pb_str(&c, 1, o->path);
	pb_bytes(&c, 2, file.d, file.len);
	rpc_send(o->id, !last, PB_WRITE_REQ, &c);
	buf_free(&file);
	buf_free(&c);
}

/* Whether another message of the file can be framed now */
static bool write_more(const struct op *o)
{
	return !o->last_sent && out.len < OUT_HIGH &&
	       (o->final || o->data.len - o->pos >= CHUNK);
}

/* Hand the file's data on to the Flipper, CHUNK bytes a message, as the
 * serial port takes it; the last message (has_next false) ends the file.
 * It goes on until the port is full (it asks for more then), the piece is
 * used up or the file has ended: a port that took it all asks for nothing. */
static void write_pump(void)
{
	struct op *o = cur;

	if (!o || o->kind != OP_WRITE || fd < 0 || broken)
		return;
	do {
		while (write_more(o)) {
			size_t avail = o->data.len - o->pos, n = avail < CHUNK ? avail : CHUNK;
			bool last = o->final && n == avail;

			write_chunk(o, o->data.d + o->pos, n, last);
			o->pos += n;
			if (last)
				o->last_sent = true;
		}
		if (o->pos == o->data.len) {
			o->data.len = 0;
			o->pos = 0;
		} else if (o->pos >= 4 * CHUNK) {
			buf_drop(&o->data, o->pos);
			o->pos = 0;
		}
		out_flush();
		if (broken)
			return;
	} while (write_more(o));
	/* The caller sends the next piece once this one is on its way */
	if (o->piece_waiting && !o->final && o->data.len - o->pos < CHUNK && out.len < OUT_HIGH)
		piece_reply(o, NULL);
}

/* ---------- what the Flipper sends ---------- */

static void waiter_reply(struct waiter *w)
{
	struct blob_buf b = { 0 };

	blob_buf_init(&b, 0);
	blobmsg_add_string(&b, "state", state_name());
	blobmsg_add_u32(&b, "seq", frame_seq);
	if (have_frame && w->seq != frame_seq) {
		char *s = blobmsg_alloc_string_buffer(&b, "frame", B64_ENCODE_LEN(FRAME_LEN));

		b64_encode(frame, FRAME_LEN, s, B64_ENCODE_LEN(FRAME_LEN));
		blobmsg_add_string_buffer(&b);
		blobmsg_add_string(&b, "orientation", ORIENT[frame_orient & 3]);
	}
	send_reply(&w->req, &b);
	blob_buf_free(&b);
	uloop_timeout_cancel(&w->t);
	w->used = false;
}

static void waiters_answer(void)
{
	int i;

	for (i = 0; i < MAX_WAITERS; i++)
		if (waiters[i].used)
			waiter_reply(&waiters[i]);
}

static void on_frame(const uint8_t *p, size_t n)
{
	unsigned orient = pb_get_uint(p, n, 2);
	struct pbf f;

	if (!pb_field(p, n, 1, &f) || f.wt != 2 || f.len != FRAME_LEN)
		return;
	if (have_frame && orient == frame_orient && !memcmp(frame, f.p, FRAME_LEN))
		return;
	memcpy(frame, f.p, FRAME_LEN);
	frame_orient = orient;
	have_frame = true;
	if (!++frame_seq)
		frame_seq = 1;
	waiters_answer();
}

static void list_files(struct op *o, const uint8_t *p, size_t n)
{
	const uint8_t *end = p + n;
	char name[MAX_PATH + 1];
	struct pbf f;
	void *t;

	while (pb_next(&p, end, &f) == 1) {
		if (f.field != 1 || f.wt != 2)
			continue;
		if (++o->count > MAX_LISTED)
			continue;
		pb_get_str(f.p, f.len, 2, name, sizeof(name));
		t = blobmsg_open_table(&o->b, NULL);
		blobmsg_add_string(&o->b, "name", name);
		blobmsg_add_u8(&o->b, "dir", pb_get_uint(f.p, f.len, 1) == 1);
		blobmsg_add_u64(&o->b, "size", pb_get_uint(f.p, f.len, 3));
		blobmsg_close_table(&o->b, t);
	}
}

static void on_answer(struct op *o, const struct rpc_msg *m)
{
	char k[64], v[128];
	struct pbf f, d;

	switch (o->kind) {
	case OP_VERSION:
		if (m->content == PB_VERSION_RESP) {
			pb_major = pb_get_uint(m->body, m->len, 1);
			pb_minor = pb_get_uint(m->body, m->len, 2);
			have_version = true;
		}
		break;
	case OP_INFO:
	case OP_POWER:
		if (m->content == PB_DEVINFO_RESP || m->content == PB_POWER_RESP) {
			pb_get_str(m->body, m->len, 1, k, sizeof(k));
			pb_get_str(m->body, m->len, 2, v, sizeof(v));
			if (o->kind == OP_INFO)
				kv_set(info, &ninfo, MAX_INFO, k, v);
			else
				kv_set(power, &npower, MAX_POWER, k, v);
		}
		break;
	case OP_STORAGE:
		if (m->content == PB_STORAGE_RESP) {
			uint64_t total = pb_get_uint(m->body, m->len, 1), fr = pb_get_uint(m->body, m->len, 2);

			if (o->initial) {
				sd_total = total;
				sd_free = fr;
				have_sd = true;
			} else {
				blob_buf_init(&o->b, 0);
				blobmsg_add_string(&o->b, "path", o->path);
				blobmsg_add_u64(&o->b, "total", total);
				blobmsg_add_u64(&o->b, "free", fr);
			}
		}
		break;
	case OP_LIST:
		if (m->content == PB_LIST_RESP)
			list_files(o, m->body, m->len);
		break;
	case OP_READ:
		if (m->content == PB_READ_RESP && pb_field(m->body, m->len, 1, &f) && f.wt == 2 &&
		    pb_field(f.p, f.len, 4, &d) && d.wt == 2 && rc.active && !strcmp(rc.path, o->path)) {
			if (rc.data.len + d.len > MAX_READ)
				rc.too_big = true;
			if (!rc.too_big && !buf_add(&rc.data, d.p, d.len))
				rc.too_big = true;
		}
		break;
	case OP_INPUT:
		if (++o->next_type < o->ntypes) {
			o->id = new_id();
			input_send(o);
			out_flush();
			return;
		}
		break;
	default:
		break;
	}
	if (m->has_next)
		return;
	op_finish(o, NULL);
}

static void on_msg(const uint8_t *p, size_t n)
{
	struct rpc_msg m;
	char err[160];

	if (!rpc_decode(p, n, &m)) {
		logmsg("%s: a garbled message from the Flipper", dev_path);
		return;
	}
	if (m.content == PB_FRAME) {
		on_frame(m.body, m.len);
		return;
	}
	/* Unasked for, or for a request given up on */
	if (!cur || m.id != cur->id)
		return;
	uloop_timeout_set(&op_t, OP_TIMEOUT_MS);
	if (m.status) {
		bool writing = cur->kind == OP_WRITE && !cur->last_sent;

		snprintf(err, sizeof(err), "%s", status_text(m.status));
		op_finish(cur, err);
		/* The rest of the file, on its way, would be taken for a new one */
		if (writing)
			dev_restart("starting over after a failed upload");
		return;
	}
	on_answer(cur, &m);
}

static void rpc_parse(void)
{
	while (in.len && !broken) {
		const uint8_t *p = in.d;
		uint64_t n;
		size_t hdr;
		int r = pb_varint_get(&p, in.d + in.len, &n);

		if (r == 0)
			return;
		if (r < 0 || n > MAX_MSG) {
			dev_fail("garbled data from the Flipper");
			return;
		}
		hdr = p - in.d;
		if (in.len - hdr < n)
			return;
		on_msg(p, n);
		buf_drop(&in, hdr + n);
	}
}

/* At the CLI still: the session starts once "start_rpc_session" comes back */
static void on_cli(const uint8_t *p, size_t n)
{
	static const char echo[] = "start_rpc_session\r\n";
	uint8_t *m;

	buf_add(&in, p, n);
	m = memmem(in.d, in.len, echo, sizeof(echo) - 1);
	if (!m) {
		if (in.len > 16384)
			buf_drop(&in, in.len - 64);
		return;
	}
	buf_drop(&in, (m - in.d) + sizeof(echo) - 1);
	rpc_up = true;
	uloop_timeout_cancel(&hs_t);
	logmsg("%s: RPC session started", dev_path);
	op_add(op_new(OP_PING));
	rpc_parse();
}

static void fd_cb(struct uloop_fd *u, unsigned int events)
{
	uint8_t tmp[4096];
	ssize_t r;

	if (broken || fd < 0)
		return;
	if (events & ULOOP_WRITE) {
		out_flush();
		write_pump();
	}
	if (!broken && (events & ULOOP_READ)) {
		for (;;) {
			r = read(fd, tmp, sizeof(tmp));
			if (r > 0) {
				if (rpc_up) {
					if (!buf_add(&in, tmp, r)) {
						dev_fail("out of memory");
						return;
					}
					rpc_parse();
				} else {
					on_cli(tmp, r);
				}
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

/* ---------- finding the Flipper, connecting ---------- */

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

static bool usb_id_is(const char *dir, const char *vid, const char *pid)
{
	char p[512], v[16];

	snprintf(p, sizeof(p), "%s/idVendor", dir);
	if (!read_line(p, v, sizeof(v)) || strcasecmp(v, vid))
		return false;
	snprintf(p, sizeof(p), "%s/idProduct", dir);
	return read_line(p, v, sizeof(v)) && !strcasecmp(v, pid);
}

static bool find_flipper(char *path, size_t n)
{
	char d[512], s[16];
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
		snprintf(d, sizeof(d), "%s/class/tty/%s/device/..", opt_sysfs, e->d_name);
		if (!usb_id_is(d, FLIPPER_VID, FLIPPER_PID))
			continue;
		/* The first interface is the CLI; a second, if any, the USB-UART bridge */
		snprintf(d, sizeof(d), "%s/class/tty/%s/device/bInterfaceNumber", opt_sysfs, e->d_name);
		if (read_line(d, s, sizeof(s)) && strtol(s, NULL, 16) != 0)
			continue;
		snprintf(path, n, "/dev/%s", e->d_name);
		found = true;
	}
	closedir(dir);
	return found;
}

/* A Flipper in DFU (recovery) mode: no serial port, nothing to do but say so */
static bool dfu_present(void)
{
	char d[512];
	struct dirent *e;
	bool found = false;
	DIR *dir;

	snprintf(d, sizeof(d), "%s/bus/usb/devices", opt_sysfs);
	dir = opendir(d);
	if (!dir)
		return false;
	while (!found && (e = readdir(dir))) {
		if (e->d_name[0] == '.')
			continue;
		snprintf(d, sizeof(d), "%s/bus/usb/devices/%s", opt_sysfs, e->d_name);
		found = usb_id_is(d, FLIPPER_VID, FLIPPER_DFU_PID);
	}
	closedir(dir);
	return found;
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
		cfsetispeed(&t, B230400);
		cfsetospeed(&t, B230400);
		tcsetattr(fd, TCSANOW, &t);
	}
	/* gpsd and the like keep off it */
	ioctl(fd, TIOCEXCL);
	tcflush(fd, TCIOFLUSH);
	snprintf(dev_path, sizeof(dev_path), "%s", path);
	state = ST_CONNECTING;
	rpc_up = broken = false;
	in.len = out.len = 0;
	hs_tries = 0;
	ufd.fd = fd;
	ufd.cb = fd_cb;
	uloop_fd_add(&ufd, ULOOP_READ);
	/* The CLI's greeting goes by first */
	uloop_timeout_set(&hs_t, HS_FIRST_MS);
	logmsg("%s: a Flipper Zero, starting an RPC session", path);
}

static void hs_cb(struct uloop_timeout *t)
{
	static const char cmd[] = "\rstart_rpc_session\r";

	if (fd < 0 || rpc_up || broken)
		return;
	if (hs_tries++ >= HS_TRIES) {
		dev_fail("no answer from the Flipper: if it is locked with a PIN, unlock it; "
			 "close any app using its USB port (such as the USB-UART bridge)");
		return;
	}
	buf_add(&out, cmd, sizeof(cmd) - 1);
	out_flush();
	uloop_timeout_set(t, HS_RETRY_MS);
}

static void scan_cb(struct uloop_timeout *t)
{
	char path[256];

	if (fd >= 0)
		return;
	if (!find_flipper(path, sizeof(path))) {
		state = dfu_present() ? ST_DFU : ST_ABSENT;
		last_error[0] = 0;
		uloop_timeout_set(t, SCAN_MS);
		return;
	}
	dev_open(path);
}

static void close_cb(struct uloop_timeout *t)
{
	const char *why = fail_reason[0] ? fail_reason : "the Flipper went away";
	struct op *o, *tmp;

	(void)t;
	if (fd >= 0) {
		uloop_fd_delete(&ufd);
		/* Exclusive no more: the tty may outlive this (another holds it) */
		ioctl(fd, TIOCNXCL);
		close(fd);
		fd = -1;
	}
	rpc_up = false;
	in.len = out.len = 0;
	uloop_timeout_cancel(&hs_t);
	uloop_timeout_cancel(&op_t);
	uloop_timeout_cancel(&piece_t);
	uloop_timeout_cancel(&stream_t);
	state = ST_ABSENT;
	cur = NULL;
	list_for_each_entry_safe(o, tmp, &ops, list)
		op_finish(o, why);
	streaming = have_frame = false;
	waiters_answer();
	ninfo = npower = 0;
	have_version = have_sd = power_pending = false;
	snprintf(last_error, sizeof(last_error), "%s", restart ? "" : fail_reason);
	broken = false;
	uloop_timeout_set(&scan_t, restart ? RESTART_MS : fail_reason[0] ? RETRY_MS : SCAN_MS);
	fail_reason[0] = 0;
	restart = false;
}

static void op_timeout(struct uloop_timeout *t)
{
	(void)t;
	if (!cur)
		return;
	/* Waiting for the next piece of a file: piece_t's to time */
	if (cur->kind == OP_WRITE && !cur->final && !cur->piece_waiting)
		return;
	op_finish(cur, "the Flipper didn't answer");
	dev_fail("the Flipper stopped answering");
}

static void piece_idle(struct uloop_timeout *t)
{
	(void)t;
	if (!cur || cur->kind != OP_WRITE || cur->final)
		return;
	op_finish(cur, "the upload stopped coming");
	dev_restart("starting over after an unfinished upload");
}

static void stream_idle(struct uloop_timeout *t)
{
	int64_t idle = now_ms() - last_screen;

	if (!streaming || state != ST_READY)
		return;
	if (idle < STREAM_IDLE_MS) {
		uloop_timeout_set(t, STREAM_IDLE_MS - idle + 50);
		return;
	}
	streaming = have_frame = false;
	op_add(op_new(OP_STREAM_STOP));
}

static void rc_expire(struct uloop_timeout *t)
{
	(void)t;
	if (!rc.busy)
		rc_clear();
}

static void waiter_timeout(struct uloop_timeout *t)
{
	waiter_reply(container_of(t, struct waiter, t));
}

/* ---------- ubus ---------- */

enum {
	A_PATH, A_TO, A_OFFSET, A_DATA, A_MORE, A_RECURSIVE, A_KEY, A_TYPE, A_SEQ, A_MODE,
	A_YEAR, A_MONTH, A_DAY, A_HOUR, A_MINUTE, A_SECOND, A_WEEKDAY,
	__A_MAX
};

/* Parsed loosely: a number may come as a string, a flag as a number */
static const struct blobmsg_policy pol_all[__A_MAX] = {
	[A_PATH] = { "path", BLOBMSG_TYPE_UNSPEC },
	[A_TO] = { "to", BLOBMSG_TYPE_UNSPEC },
	[A_OFFSET] = { "offset", BLOBMSG_TYPE_UNSPEC },
	[A_DATA] = { "data", BLOBMSG_TYPE_UNSPEC },
	[A_MORE] = { "more", BLOBMSG_TYPE_UNSPEC },
	[A_RECURSIVE] = { "recursive", BLOBMSG_TYPE_UNSPEC },
	[A_KEY] = { "key", BLOBMSG_TYPE_UNSPEC },
	[A_TYPE] = { "type", BLOBMSG_TYPE_UNSPEC },
	[A_SEQ] = { "seq", BLOBMSG_TYPE_UNSPEC },
	[A_MODE] = { "mode", BLOBMSG_TYPE_UNSPEC },
	[A_YEAR] = { "year", BLOBMSG_TYPE_UNSPEC },
	[A_MONTH] = { "month", BLOBMSG_TYPE_UNSPEC },
	[A_DAY] = { "day", BLOBMSG_TYPE_UNSPEC },
	[A_HOUR] = { "hour", BLOBMSG_TYPE_UNSPEC },
	[A_MINUTE] = { "minute", BLOBMSG_TYPE_UNSPEC },
	[A_SECOND] = { "second", BLOBMSG_TYPE_UNSPEC },
	[A_WEEKDAY] = { "weekday", BLOBMSG_TYPE_UNSPEC },
};
static struct blob_attr *tb[__A_MAX];

/* What `ubus -v list` shows for each method */
static const struct blobmsg_policy p_path[] = { { "path", BLOBMSG_TYPE_STRING } };
static const struct blobmsg_policy p_read[] = {
	{ "path", BLOBMSG_TYPE_STRING }, { "offset", BLOBMSG_TYPE_INT32 },
};
static const struct blobmsg_policy p_write[] = {
	{ "path", BLOBMSG_TYPE_STRING }, { "offset", BLOBMSG_TYPE_INT32 },
	{ "data", BLOBMSG_TYPE_STRING }, { "more", BLOBMSG_TYPE_BOOL },
};
static const struct blobmsg_policy p_delete[] = {
	{ "path", BLOBMSG_TYPE_STRING }, { "recursive", BLOBMSG_TYPE_BOOL },
};
static const struct blobmsg_policy p_rename[] = {
	{ "path", BLOBMSG_TYPE_STRING }, { "to", BLOBMSG_TYPE_STRING },
};
static const struct blobmsg_policy p_input[] = {
	{ "key", BLOBMSG_TYPE_STRING }, { "type", BLOBMSG_TYPE_STRING },
};
static const struct blobmsg_policy p_screen[] = { { "seq", BLOBMSG_TYPE_INT32 } };
static const struct blobmsg_policy p_reboot[] = { { "mode", BLOBMSG_TYPE_STRING } };
static const struct blobmsg_policy p_time[] = {
	{ "year", BLOBMSG_TYPE_INT32 }, { "month", BLOBMSG_TYPE_INT32 }, { "day", BLOBMSG_TYPE_INT32 },
	{ "hour", BLOBMSG_TYPE_INT32 }, { "minute", BLOBMSG_TYPE_INT32 }, { "second", BLOBMSG_TYPE_INT32 },
	{ "weekday", BLOBMSG_TYPE_INT32 },
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

static bool arg_bool(int i)
{
	const char *s = arg_str(i);
	int64_t v;

	if (s)
		return !strcmp(s, "1") || !strcmp(s, "true");
	return arg_num(i, &v) && v;
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
	if (broken)
		return "the Flipper went away";
	switch (state) {
	case ST_READY:
		return NULL;
	case ST_DFU:
		return "the Flipper is in DFU (recovery) mode: update it with qFlipper";
	case ST_CONNECTING:
		return "the Flipper is still connecting";
	default:
		return "no Flipper is plugged in";
	}
}

/* A path on the Flipper: /ext/..., plain ASCII, no .. */
static const char *bad_path(const char *p)
{
	size_t n;

	if (!p || p[0] != '/')
		return "path: give a full path, such as /ext/subghz";
	n = strlen(p);
	if (n > MAX_PATH)
		return "path: too long";
	for (; *p; p++)
		if (*p < 0x20 || *p > 0x7e)
			return "the Flipper takes plain ASCII names only";
	p -= n;
	if (n > 1 && p[n - 1] == '/')
		return "path: no / at the end";
	if (strstr(p, "//") || strstr(p, "/../") || (n >= 3 && !strcmp(p + n - 3, "/..")) ||
	    strstr(p, "/./") || (n >= 2 && !strcmp(p + n - 2, "/.")))
		return "path: no . or .. parts";
	return NULL;
}

/* Queue o; req, if any, is answered once it is done */
static int op_queue(struct ubus_context *c, struct ubus_request_data *req, struct op *o)
{
	if (!o)
		return reply_error(c, req, "out of memory");
	if (nops >= MAX_QUEUE) {
		op_free(o);
		return reply_error(c, req, "the Flipper is busy: try again in a moment");
	}
	if (req) {
		ubus_defer_request(c, req, &o->req);
		o->deferred = true;
	}
	op_add(o);
	return UBUS_STATUS_OK;
}

static void power_refresh(void)
{
	struct op *o;

	if (state != ST_READY || power_pending || time(NULL) - power_at < POWER_MAX_AGE)
		return;
	if (nops >= MAX_QUEUE || !(o = op_new(OP_POWER)))
		return;
	power_pending = true;
	op_add(o);
}

static void add_info(struct blob_buf *b, const char *name, const char *key)
{
	const char *v = kv_get(info, ninfo, key);

	if (v && *v)
		blobmsg_add_string(b, name, v);
}

static int m_status(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		    const char *method, struct blob_attr *msg)
{
	const char *v;

	(void)obj; (void)method; (void)msg;
	blob_buf_init(&rb, 0);
	blobmsg_add_string(&rb, "state", state_name());
	if (state == ST_CONNECTING || state == ST_READY)
		blobmsg_add_string(&rb, "device", dev_path);
	if (last_error[0])
		blobmsg_add_string(&rb, "error", last_error);
	if (state == ST_READY) {
		add_info(&rb, "name", "hardware_name");
		add_info(&rb, "model", "hardware_model");
		add_info(&rb, "firmware", "firmware_version");
		add_info(&rb, "branch", "firmware_branch");
		add_info(&rb, "build_date", "firmware_build_date");
		add_info(&rb, "commit", "firmware_commit");
		v = kv_get(power, npower, "charge_level");
		if (v && *v)
			blobmsg_add_u32(&rb, "battery", atoi(v));
		v = kv_get(power, npower, "charge_state");
		if (v && *v)
			blobmsg_add_string(&rb, "charging", v);
		if (have_version) {
			char s[24];

			snprintf(s, sizeof(s), "%u.%u", pb_major, pb_minor);
			blobmsg_add_string(&rb, "protobuf", s);
		}
		blobmsg_add_u8(&rb, "sd", have_sd);
		if (have_sd) {
			blobmsg_add_u64(&rb, "sd_total", sd_total);
			blobmsg_add_u64(&rb, "sd_free", sd_free);
		}
	}
	ubus_send_reply(c, req, rb.head);
	power_refresh();
	return UBUS_STATUS_OK;
}

static int m_info(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		  const char *method, struct blob_attr *msg)
{
	void *t;
	int i;

	(void)obj; (void)method; (void)msg;
	if (not_ready())
		return reply_error(c, req, not_ready());
	blob_buf_init(&rb, 0);
	t = blobmsg_open_table(&rb, "info");
	for (i = 0; i < ninfo; i++)
		blobmsg_add_string(&rb, info[i].k, info[i].v);
	blobmsg_close_table(&rb, t);
	t = blobmsg_open_table(&rb, "power");
	for (i = 0; i < npower; i++)
		blobmsg_add_string(&rb, power[i].k, power[i].v);
	blobmsg_close_table(&rb, t);
	ubus_send_reply(c, req, rb.head);
	power_refresh();
	return UBUS_STATUS_OK;
}

static int m_screen(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		    const char *method, struct blob_attr *msg)
{
	int64_t seq = 0;
	int i;

	(void)obj; (void)method;
	parse(msg);
	arg_num(A_SEQ, &seq);
	last_screen = now_ms();
	if (state == ST_READY && !broken && !streaming && nops < MAX_QUEUE) {
		streaming = true;
		op_add(op_new(OP_STREAM_START));
		uloop_timeout_set(&stream_t, STREAM_IDLE_MS);
	}
	for (i = 0; i < MAX_WAITERS; i++)
		if (!waiters[i].used)
			break;
	if (i < MAX_WAITERS) {
		struct waiter *w = &waiters[i];

		w->used = true;
		w->seq = seq;
		ubus_defer_request(c, req, &w->req);
		/* Now, if there is something new to show; else on the next frame */
		if (state != ST_READY || (have_frame && (uint32_t)seq != frame_seq))
			waiter_reply(w);
		else
			uloop_timeout_set(&w->t, SCREEN_WAIT_MS);
		return UBUS_STATUS_OK;
	}
	blob_buf_init(&rb, 0);
	blobmsg_add_string(&rb, "state", state_name());
	blobmsg_add_u32(&rb, "seq", frame_seq);
	ubus_send_reply(c, req, rb.head);
	return UBUS_STATUS_OK;
}

static int find_name(const char *const *names, int n, const char *s)
{
	int i;

	for (i = 0; s && i < n; i++)
		if (!strcmp(names[i], s))
			return i;
	return -1;
}

static int m_input(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		   const char *method, struct blob_attr *msg)
{
	char types[64], *tok, *save;
	const char *type;
	struct op *o;
	int key, t;

	(void)obj; (void)method;
	parse(msg);
	key = find_name(KEYS, ARRAY_SIZE(KEYS), arg_str(A_KEY));
	if (key < 0)
		return reply_error(c, req, "key: up, down, left, right, ok or back");
	type = arg_str(A_TYPE) ? arg_str(A_TYPE) : "click";
	if (!strcmp(type, "click"))
		type = "press+short+release";
	else if (!strcmp(type, "hold"))
		type = "press+long+release";
	if (not_ready())
		return reply_error(c, req, not_ready());
	o = op_new(OP_INPUT);
	if (!o)
		return reply_error(c, req, "out of memory");
	o->key = key;
	snprintf(types, sizeof(types), "%s", type);
	for (tok = strtok_r(types, "+", &save); tok; tok = strtok_r(NULL, "+", &save)) {
		t = find_name(TYPES, ARRAY_SIZE(TYPES), tok);
		if (t < 0 || o->ntypes >= (int)ARRAY_SIZE(o->types)) {
			op_free(o);
			return reply_error(c, req, "type: press, release, short, long or repeat (or click, hold)");
		}
		o->types[o->ntypes++] = t;
	}
	if (!o->ntypes) {
		op_free(o);
		return reply_error(c, req, "type: press, release, short, long or repeat (or click, hold)");
	}
	return op_queue(c, req, o);
}

/* The path argument, checked, for requests needing a Flipper */
static const char *path_arg(int i, const char **err)
{
	const char *p = arg_str(i);

	*err = bad_path(p);
	if (!*err)
		*err = not_ready();
	return p;
}

static int m_list(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		  const char *method, struct blob_attr *msg)
{
	const char *p, *err;
	struct op *o;

	(void)obj; (void)method;
	parse(msg);
	p = path_arg(A_PATH, &err);
	if (err)
		return reply_error(c, req, err);
	o = op_new(OP_LIST);
	if (!o)
		return reply_error(c, req, "out of memory");
	snprintf(o->path, sizeof(o->path), "%s", p);
	blob_buf_init(&o->b, 0);
	o->nest = blobmsg_open_array(&o->b, "files");
	return op_queue(c, req, o);
}

static int m_read(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		  const char *method, struct blob_attr *msg)
{
	const char *p, *err;
	int64_t off;
	size_t n;
	char *s;

	(void)obj; (void)method;
	parse(msg);
	p = arg_str(A_PATH);
	if ((err = bad_path(p)))
		return reply_error(c, req, err);
	blob_buf_init(&rb, 0);
	if (!arg_num(A_OFFSET, &off)) {
		/* Start reading it, or say how far along it is */
		if (rc.active && !strcmp(rc.path, p)) {
			if (rc.busy) {
				blobmsg_add_u8(&rb, "busy", 1);
				blobmsg_add_u64(&rb, "got", rc.data.len);
			} else if (rc.err[0]) {
				blobmsg_add_string(&rb, "error", rc.err);
				rc_clear();
			} else {
				blobmsg_add_u8(&rb, "ready", 1);
				blobmsg_add_u64(&rb, "size", rc.data.len);
				uloop_timeout_set(&rc_t, CACHE_KEEP_MS);
			}
			ubus_send_reply(c, req, rb.head);
			return UBUS_STATUS_OK;
		}
		if (rc.active && rc.busy)
			return reply_error(c, req, "another file is being read: try again in a moment");
		if ((err = not_ready()))
			return reply_error(c, req, err);
		if (nops >= MAX_QUEUE)
			return reply_error(c, req, "the Flipper is busy: try again in a moment");
		rc_clear();
		rc.active = rc.busy = true;
		snprintf(rc.path, sizeof(rc.path), "%s", p);
		{
			struct op *o = op_new(OP_READ);

			if (!o) {
				rc_clear();
				return reply_error(c, req, "out of memory");
			}
			snprintf(o->path, sizeof(o->path), "%s", p);
			op_add(o);
		}
		blob_buf_init(&rb, 0);
		blobmsg_add_u8(&rb, "busy", 1);
		blobmsg_add_u64(&rb, "got", 0);
		ubus_send_reply(c, req, rb.head);
		return UBUS_STATUS_OK;
	}
	/* A slice of it */
	if (!rc.active || strcmp(rc.path, p) || rc.busy || rc.err[0])
		return reply_error(c, req, "read the file first (without an offset)");
	if (off < 0 || (uint64_t)off > rc.data.len)
		return reply_error(c, req, "offset: past the end of the file");
	n = rc.data.len - off;
	if (n > READ_SLICE)
		n = READ_SLICE;
	blobmsg_add_u64(&rb, "size", rc.data.len);
	blobmsg_add_u64(&rb, "offset", off);
	s = blobmsg_alloc_string_buffer(&rb, "data", B64_ENCODE_LEN(n));
	if (n)
		b64_encode(rc.data.d + off, n, s, B64_ENCODE_LEN(n));
	else
		s[0] = 0;
	blobmsg_add_string_buffer(&rb);
	blobmsg_add_u8(&rb, "more", off + n < rc.data.len);
	ubus_send_reply(c, req, rb.head);
	if (off + n >= rc.data.len)
		rc_clear();
	else
		uloop_timeout_set(&rc_t, CACHE_KEEP_MS);
	return UBUS_STATUS_OK;
}

static struct op *writing(void)
{
	struct op *o;

	list_for_each_entry(o, &ops, list)
		if (o->kind == OP_WRITE)
			return o;
	return NULL;
}

static int m_write(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		   const char *method, struct blob_attr *msg)
{
	const char *p, *err, *s;
	uint8_t *data = NULL;
	int64_t off;
	int n = 0;
	size_t l;
	struct op *o;
	bool more;

	(void)obj; (void)method;
	parse(msg);
	p = arg_str(A_PATH);
	if ((err = bad_path(p)))
		return reply_error(c, req, err);
	if (!arg_num(A_OFFSET, &off) || off < 0)
		return reply_error(c, req, "offset: where in the file this piece goes (0 to start it)");
	s = arg_str(A_DATA) ? arg_str(A_DATA) : "";
	more = arg_bool(A_MORE);
	l = strlen(s);
	if (l > B64_ENCODE_LEN(MAX_PIECE))
		return reply_error(c, req, "data: 48 KiB a piece at most");
	if (l) {
		data = malloc(B64_DECODE_LEN(l));
		if (!data)
			return reply_error(c, req, "out of memory");
		n = b64_decode(s, data, B64_DECODE_LEN(l));
		if (n < 0) {
			free(data);
			return reply_error(c, req, "data: not base64");
		}
	}
	o = writing();
	if (off == 0) {
		if (o) {
			free(data);
			return reply_error(c, req, "a file is being sent to the Flipper already: wait for it to finish");
		}
		if ((err = not_ready())) {
			free(data);
			return reply_error(c, req, err);
		}
		if (nops >= MAX_QUEUE || !(o = op_new(OP_WRITE))) {
			free(data);
			return reply_error(c, req, "the Flipper is busy: try again in a moment");
		}
		snprintf(o->path, sizeof(o->path), "%s", p);
		buf_add(&o->data, data, n);
		free(data);
		o->received = n;
		o->final = !more;
		ubus_defer_request(c, req, &o->piece_req);
		o->piece_waiting = true;
		op_add(o);
		return UBUS_STATUS_OK;
	}
	if (!o || strcmp(o->path, p) || o->final) {
		free(data);
		return reply_error(c, req, "that file isn't being sent: start again from offset 0");
	}
	if ((uint64_t)off != o->received) {
		char e[96];

		free(data);
		snprintf(e, sizeof(e), "offset: the next piece goes at %llu", (unsigned long long)o->received);
		return reply_error(c, req, e);
	}
	if (o->piece_waiting) {
		free(data);
		return reply_error(c, req, "the last piece is still on its way");
	}
	if (!buf_add(&o->data, data, n)) {
		free(data);
		return reply_error(c, req, "out of memory");
	}
	free(data);
	o->received += n;
	o->final = !more;
	ubus_defer_request(c, req, &o->piece_req);
	o->piece_waiting = true;
	if (o == cur) {
		uloop_timeout_cancel(&piece_t);
		uloop_timeout_set(&op_t, OP_TIMEOUT_MS);
		write_pump();
	}
	return UBUS_STATUS_OK;
}

static int simple_path_op(struct ubus_context *c, struct ubus_request_data *req,
			  struct blob_attr *msg, enum op_kind kind)
{
	const char *p, *err;
	struct op *o;

	parse(msg);
	p = path_arg(A_PATH, &err);
	if (err)
		return reply_error(c, req, err);
	/* Not a whole storage: /ext, /int */
	if ((kind == OP_DELETE || kind == OP_RENAME || kind == OP_MKDIR) && !strchr(p + 1, '/'))
		return reply_error(c, req, "path: not a whole storage, such as /ext");
	o = op_new(kind);
	if (!o)
		return reply_error(c, req, "out of memory");
	snprintf(o->path, sizeof(o->path), "%s", p);
	o->recursive = arg_bool(A_RECURSIVE);
	if (kind == OP_RENAME) {
		const char *to = arg_str(A_TO);

		if ((err = bad_path(to)) || !strchr(to + 1, '/')) {
			op_free(o);
			return reply_error(c, req, err ? err : "to: not a whole storage, such as /ext");
		}
		snprintf(o->path2, sizeof(o->path2), "%s", to);
	}
	return op_queue(c, req, o);
}

static int m_mkdir(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		   const char *method, struct blob_attr *msg)
{
	(void)obj; (void)method;
	return simple_path_op(c, req, msg, OP_MKDIR);
}

static int m_delete(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		    const char *method, struct blob_attr *msg)
{
	(void)obj; (void)method;
	return simple_path_op(c, req, msg, OP_DELETE);
}

static int m_rename(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		    const char *method, struct blob_attr *msg)
{
	(void)obj; (void)method;
	return simple_path_op(c, req, msg, OP_RENAME);
}

static int m_storage(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		     const char *method, struct blob_attr *msg)
{
	(void)obj; (void)method;
	return simple_path_op(c, req, msg, OP_STORAGE);
}

static int m_alert(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		   const char *method, struct blob_attr *msg)
{
	(void)obj; (void)method; (void)msg;
	if (not_ready())
		return reply_error(c, req, not_ready());
	return op_queue(c, req, op_new(OP_ALERT));
}

static int m_time(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		  const char *method, struct blob_attr *msg)
{
	static const int lo[7] = { 0, 0, 0, 1, 1, 2000, 1 }, hi[7] = { 23, 59, 59, 31, 12, 2099, 7 };
	static const int arg[7] = { A_HOUR, A_MINUTE, A_SECOND, A_DAY, A_MONTH, A_YEAR, A_WEEKDAY };
	static const char *const name[7] = { "hour", "minute", "second", "day", "month", "year", "weekday" };
	unsigned dt[7];
	struct op *o;
	int64_t v;
	int i;

	(void)obj; (void)method;
	parse(msg);
	if (tb[A_YEAR]) {
		for (i = 0; i < 7; i++) {
			if (!arg_num(arg[i], &v) || v < lo[i] || v > hi[i]) {
				char e[64];

				snprintf(e, sizeof(e), "%s: %d to %d", name[i], lo[i], hi[i]);
				return reply_error(c, req, e);
			}
			dt[i] = v;
		}
	} else {
		/* The router's own clock, in its time zone */
		time_t now = time(NULL);
		struct tm tm;

		localtime_r(&now, &tm);
		dt[0] = tm.tm_hour;
		dt[1] = tm.tm_min;
		dt[2] = tm.tm_sec;
		dt[3] = tm.tm_mday;
		dt[4] = tm.tm_mon + 1;
		dt[5] = tm.tm_year + 1900;
		dt[6] = tm.tm_wday ? tm.tm_wday : 7;
	}
	if (not_ready())
		return reply_error(c, req, not_ready());
	o = op_new(OP_TIME);
	if (o)
		memcpy(o->dt, dt, sizeof(dt));
	return op_queue(c, req, o);
}

static int m_reboot(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		    const char *method, struct blob_attr *msg)
{
	struct op *o;
	int mode = 0;

	(void)obj; (void)method;
	parse(msg);
	if (arg_str(A_MODE) && (mode = find_name(MODES, ARRAY_SIZE(MODES), arg_str(A_MODE))) < 0)
		return reply_error(c, req, "mode: os, dfu or update");
	if (not_ready())
		return reply_error(c, req, not_ready());
	o = op_new(OP_REBOOT);
	if (o)
		o->mode = mode;
	return op_queue(c, req, o);
}

static const struct ubus_method methods[] = {
	UBUS_METHOD_NOARG("status", m_status),
	UBUS_METHOD_NOARG("info", m_info),
	UBUS_METHOD("screen", m_screen, p_screen),
	UBUS_METHOD("input", m_input, p_input),
	UBUS_METHOD("list", m_list, p_path),
	UBUS_METHOD("read", m_read, p_read),
	UBUS_METHOD("write", m_write, p_write),
	UBUS_METHOD("mkdir", m_mkdir, p_path),
	UBUS_METHOD("delete", m_delete, p_delete),
	UBUS_METHOD("rename", m_rename, p_rename),
	UBUS_METHOD("storage", m_storage, p_path),
	UBUS_METHOD_NOARG("alert", m_alert),
	UBUS_METHOD("time", m_time, p_time),
	UBUS_METHOD("reboot", m_reboot, p_reboot),
};

static struct ubus_object_type obj_type = UBUS_OBJECT_TYPE("pirate.flipper", methods);

static struct ubus_object obj = {
	.name = "pirate.flipper",
	.type = &obj_type,
	.methods = methods,
	.n_methods = ARRAY_SIZE(methods),
};

static void on_connect(struct ubus_context *c)
{
	int r = ubus_add_object(c, &obj);

	if (r)
		logmsg("can't add pirate.flipper to ubus: %s", ubus_strerror(r));
}

/* The router's time zone, for "time" without one given (procd's services
 * get no TZ) */
static void tz_init(void)
{
	char s[64];

	if (!getenv("TZ") && read_line("/etc/TZ", s, sizeof(s)) && s[0])
		setenv("TZ", s, 1);
	tzset();
}

static void usage(void)
{
	fprintf(stderr, "usage: pirate-flipper [-d device] [-s sysfs] [-u ubus-socket]\n");
	exit(2);
}

int main(int argc, char **argv)
{
	int c, i;

	while ((c = getopt(argc, argv, "d:s:u:")) != -1) {
		switch (c) {
		case 'd':
			opt_dev = optarg;
			break;
		case 's':
			opt_sysfs = optarg;
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
	signal(SIGPIPE, SIG_IGN);
	setvbuf(stderr, NULL, _IOLBF, 0);
	tz_init();
	uloop_init();
	scan_t.cb = scan_cb;
	hs_t.cb = hs_cb;
	op_t.cb = op_timeout;
	stream_t.cb = stream_idle;
	piece_t.cb = piece_idle;
	close_t.cb = close_cb;
	rc_t.cb = rc_expire;
	for (i = 0; i < MAX_WAITERS; i++)
		waiters[i].t.cb = waiter_timeout;
	conn.cb = on_connect;
	ubus_auto_connect(&conn);
	uloop_timeout_set(&scan_t, 0);
	uloop_run();
	if (fd >= 0) {
		ioctl(fd, TIOCNXCL);
		close(fd);
	}
	uloop_done();
	return 0;
}
