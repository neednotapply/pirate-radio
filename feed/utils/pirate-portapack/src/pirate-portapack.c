/*
 * pirate-portapack: a HackRF with a PortaPack on Mayhem firmware, plugged into
 * the router's USB port while it's in its "device" (Mayhem) mode, for the
 * Pirate Radio web UI's PortaPack tab: its screen and buttons, its files and
 * its details, as hackrf.app (MayhemHub) shows them on a computer. On ubus as
 * pirate.portapack.
 *
 * A PortaPack on Mayhem firmware shows up as a USB serial console (1d50:6018)
 * running Mayhem's command shell: a line of text a command, each answer ending
 * with the "ch> " prompt. This daemon speaks that shell (after Mayhem's own
 * firmware and MayhemHub, both GPL-2.0; the code here is Pirate Radio's own)
 * and offers it on ubus. One command is out at a time.
 *
 *   pirate-portapack [-d device] [-s sysfs] [-u ubus-socket]
 *
 *   -d  the console's serial device (default: the ttyACM device of a USB
 *       device 1d50:6018, looked for every second while none is open)
 *   -s  where sysfs is (default /sys; for tests)
 *   -u  ubusd's socket (default: libubus's)
 *
 * pirate.portapack methods (errors come back as {"error": "..."}):
 *   status                  state (absent, connecting, ready), device path,
 *                           model, firmware, board, screen size, last error
 *   info                    everything the shell reports (info's key: value)
 *   screen {seq}            the screen, scaled to fit (a byte a pixel, in
 *                           MayhemHub's 2-bit-a-channel colour, base64), once
 *                           it is no longer frame <seq>; waits up to ~1 s
 *   button {key}            a button: up, down, left, right, select, dial_left,
 *                           dial_right (or {n} 1..8, the raw switch)
 *   touch {x, y}            a tap at a screen pixel
 *   keyboard {text}         type ASCII text into the PortaPack
 *   list {path}             a folder's files (/ is the SD card)
 *   read {path[, offset]}   a file: without an offset, read it into memory
 *                           (busy until then, 4 MiB at most); with one, up to
 *                           64 KiB of it from there, base64
 *   write {path, offset, data, more}
 *                           a file, a piece (base64, 32 KiB at most) a call:
 *                           offset 0 starts it, more: false ends it
 *   mkdir {path}, delete {path}
 *   reboot {mode}           os (default) or dfu
 *   hackrf                  switch it into HackRF mode (it leaves the console
 *                           and comes back as a HackRF the SDR jobs can use)
 *   flash {path}            flash a firmware file already on the SD card
 *                           (.bin or Mayhem's .ppfw.tar); it reboots
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

#define PP_VID "1d50"
#define PP_PID "6018"

#define RX_MAX      (2 * 1024 * 1024)  /* the shell's answer, held while it comes */
#define MAX_READ    (4 * 1024 * 1024)  /* a file read into memory, at most */
#define READ_SLICE  (64 * 1024)
#define MAX_PIECE   (32 * 1024)        /* a piece of a file being written, raw */
#define FREAD_CHUNK 2048               /* bytes a "fread" (hex) */
#define MAX_PATH    255
#define MAX_LINE    80                 /* Mayhem's shell takes 64 a line; stay under */
#define MAX_QUEUE   16
#define MAX_WAITERS 8
#define MAX_KV      96
#define SCREEN_MAX  24000              /* a scaled frame's pixels, at most */

#define SCREEN_WAIT_MS 1200
#define STREAM_IDLE_MS 8000
#define OP_TIMEOUT_MS  20000
#define HS_FIRST_MS    400
#define HS_RETRY_MS    2500
#define HS_TRIES       4
#define SCAN_MS        1000
#define RETRY_MS       5000
#define CACHE_KEEP_MS  60000
#define PIECE_WAIT_MS  30000
#define FRAME_MIN_MS   700             /* between screen grabs while streaming */

static const char PROMPT[] = "ch> ";
static const char WRITE_GO[] = "bytes\r\n";

/* ---------- buffers ---------- */

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

static int hexval(int c)
{
	if (c >= '0' && c <= '9')
		return c - '0';
	if (c >= 'a' && c <= 'f')
		return c - 'a' + 10;
	if (c >= 'A' && c <= 'F')
		return c - 'A' + 10;
	return -1;
}

/* ---------- state ---------- */

enum state { ST_ABSENT, ST_CONNECTING, ST_READY };

enum phase { PH_PROMPT, PH_WRITE };    /* read to the prompt, or send data first */

struct cmd {
	struct list_head list;
	char line[MAX_LINE];
	enum phase phase;
	struct buf wdata;              /* PH_WRITE: the bytes to send after the go-ahead */
	bool wrote;                    /* PH_WRITE: the go-ahead has come, data sent */
	bool deferred;                 /* a plain ubus caller waits for ok/error */
	struct ubus_request_data req;
	/* a handler that builds the whole answer itself (and clears deferred) */
	void (*done)(struct cmd *, const char *body, size_t len);
};

struct kv {
	char k[48], v[128];
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
static bool broken;
static int hs_tries;
static char dev_path[256], last_error[200], fail_reason[200];
static struct buf rx, out;
static LIST_HEAD(cmds);
static int ncmds;
static struct cmd *cur;
static struct uloop_timeout scan_t, hs_t, op_t, stream_t, piece_t, close_t, rc_t, frame_t;

static struct kv info[MAX_KV];
static int ninfo;
static char pp_model[48], pp_firmware[64], pp_board[48], pp_devtype[48];
static int scr_w, scr_h;               /* the PortaPack's own screen size */

/* the scaled-down frame we hand the browser */
static uint8_t frame[SCREEN_MAX];
static int frame_w, frame_h;
static size_t frame_len;
static uint32_t frame_seq;
static bool have_frame, streaming;
static int64_t last_screen;
static struct waiter waiters[MAX_WAITERS];

/* a file being read into memory, then sliced to the browser */
static struct {
	bool active, busy, too_big;
	char path[MAX_PATH + 1], err[160];
	uint64_t size;
	struct buf data;
} rc;

/* the one upload in flight, if any */
static struct {
	bool active, open, final, waiting;
	char path[MAX_PATH + 1];
	uint64_t received;
	struct ubus_request_data req;
} wj;

static struct blob_buf rb;

static void out_flush(void);
static void cmd_next(void);
static void begin_read(const char *path);
static void on_fread(struct cmd *c, const char *body, size_t len);

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
	static const char *const n[] = { "absent", "connecting", "ready" };

	return n[state];
}

static void kv_set(const char *k, const char *v)
{
	char key[sizeof(info[0].k)], *c;
	int i;

	snprintf(key, sizeof(key), "%s", k);
	for (c = key; *c; c++)
		if (*c == '.' || *c == ' ')
			*c = '_';
	for (i = 0; i < ninfo; i++)
		if (!strcmp(info[i].k, key))
			break;
	if (i == ninfo) {
		if (ninfo >= MAX_KV)
			return;
		ninfo++;
	}
	snprintf(info[i].k, sizeof(info[i].k), "%s", key);
	snprintf(info[i].v, sizeof(info[i].v), "%s", v);
}

/* ---------- the serial port ---------- */

static void dev_fail(const char *why)
{
	if (broken)
		return;
	broken = true;
	snprintf(fail_reason, sizeof(fail_reason), "%s", why ? why : "");
	logmsg("%s: %s", dev_path, why ? why : "the PortaPack went away");
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

static void send_line(const char *line)
{
	buf_add(&out, line, strlen(line));
	buf_add(&out, "\r", 1);
	out_flush();
}

/* ---------- commands ---------- */

static struct cmd *cmd_new(const char *line)
{
	struct cmd *c = calloc(1, sizeof(*c));

	if (c)
		snprintf(c->line, sizeof(c->line), "%s", line);
	return c;
}

static void cmd_free(struct cmd *c)
{
	if (!c)
		return;
	buf_free(&c->wdata);
	free(c);
}

static void cmd_add(struct cmd *c)
{
	if (!c)
		return;
	list_add_tail(&c->list, &cmds);
	ncmds++;
	cmd_next();
}

static void reply_send(struct ubus_request_data *req, struct blob_buf *b)
{
	ubus_send_reply(UBUS, req, b->head);
	ubus_complete_deferred_request(UBUS, req, UBUS_STATUS_OK);
}

static void reply_str(struct ubus_request_data *req, const char *key, const char *val)
{
	struct blob_buf b = { 0 };

	blob_buf_init(&b, 0);
	blobmsg_add_string(&b, key, val);
	reply_send(req, &b);
	blob_buf_free(&b);
}

static void reply_okmsg(struct ubus_request_data *req)
{
	struct blob_buf b = { 0 };

	blob_buf_init(&b, 0);
	blobmsg_add_u8(&b, "ok", 1);
	reply_send(req, &b);
	blob_buf_free(&b);
}

/* The shell's lines, trimmed of \r and trailing spaces, one at a time. */
struct lines {
	const char *p, *end;
};
static void lines_init(struct lines *l, const char *body, size_t len)
{
	l->p = body;
	l->end = body + len;
}
static bool lines_next(struct lines *l, const char **out, size_t *olen)
{
	const char *nl;
	size_t ll;

	if (l->p >= l->end)
		return false;
	nl = memchr(l->p, '\n', l->end - l->p);
	ll = (nl ? nl : l->end) - l->p;
	*out = l->p;
	while (ll && ((*out)[ll - 1] == '\r' || (*out)[ll - 1] == ' '))
		ll--;
	*olen = ll;
	l->p = nl ? nl + 1 : l->end;
	return true;
}

/* drop the first line (the shell echoes the command back) */
static void skip_echo(const char **body, size_t *len)
{
	const uint8_t *nl = memchr(*body, '\n', *len);

	if (nl) {
		size_t n = (nl - (const uint8_t *)*body) + 1;

		*body += n;
		*len -= n;
	}
}

/* Did the command succeed? Mayhem's "ok"-style commands end with an "ok" line;
 * an error prints a message instead. Returns NULL on success, else the message. */
static const char *body_error(const char *body, size_t len)
{
	static char err[160];
	struct lines l;
	const char *line, *first = NULL;
	size_t ll, firstl = 0;
	bool ok = false, skipped = false;

	lines_init(&l, body, len);
	while (lines_next(&l, &line, &ll)) {
		if (!skipped) {        /* the echo */
			skipped = true;
			continue;
		}
		if (!ll)
			continue;
		if (ll == 2 && !memcmp(line, "ok", 2)) {
			ok = true;
			continue;
		}
		if (!first) {
			first = line;
			firstl = ll;
		}
	}
	if (ok)
		return NULL;
	if (first) {
		snprintf(err, sizeof(err), "%.*s", (int)(firstl < sizeof(err) - 1 ? firstl : sizeof(err) - 1), first);
		return err;
	}
	return "the PortaPack refused it";
}

static void cmd_finish(struct cmd *c, const char *body, size_t len)
{
	if (c == cur) {
		cur = NULL;
		uloop_timeout_cancel(&op_t);
	}
	list_del(&c->list);
	ncmds--;
	if (c->done)
		c->done(c, body, len);
	if (c->deferred) {
		const char *err = body ? body_error(body, len) : "the PortaPack went away";

		c->deferred = false;
		if (err)
			reply_str(&c->req, "error", err);
		else
			reply_okmsg(&c->req);
	}
	cmd_free(c);
	cmd_next();
}

static void cmd_next(void)
{
	if (cur || fd < 0 || broken || state == ST_ABSENT || list_empty(&cmds))
		return;
	cur = list_first_entry(&cmds, struct cmd, list);
	rx.len = 0;
	if (cur->phase == PH_WRITE)
		cur->wrote = false;
	send_line(cur->line);
	uloop_timeout_set(&op_t, OP_TIMEOUT_MS);
}

/* ---------- on-connect probes ---------- */

static void on_info(struct cmd *c, const char *body, size_t len)
{
	struct lines l;
	const char *line;
	size_t ll;
	bool first = true;
	int i;

	(void)c;
	lines_init(&l, body, len);
	while (lines_next(&l, &line, &ll)) {
		const char *colon;

		if (first) {               /* echo */
			first = false;
			continue;
		}
		colon = memchr(line, ':', ll);
		if (colon) {
			char k[48], v[128];
			const char *vs = colon + 1;
			size_t kl = colon - line, vl;

			while (vs < line + ll && *vs == ' ')
				vs++;
			vl = (line + ll) - vs;
			snprintf(k, sizeof(k), "%.*s", (int)(kl < sizeof(k) - 1 ? kl : sizeof(k) - 1), line);
			snprintf(v, sizeof(v), "%.*s", (int)(vl < sizeof(v) - 1 ? vl : sizeof(v) - 1), vs);
			kv_set(k, v);
		}
	}
	for (i = 0; i < ninfo; i++) {
		if (!strcasecmp(info[i].k, "Device"))
			snprintf(pp_model, sizeof(pp_model), "%s", info[i].v);
		else if (!strcasecmp(info[i].k, "Mayhem_Version"))
			snprintf(pp_firmware, sizeof(pp_firmware), "%s", info[i].v);
		else if (!strcasecmp(info[i].k, "HackRF_Board_Rev"))
			snprintf(pp_board, sizeof(pp_board), "%s", info[i].v);
	}
}

static void on_getres(struct cmd *c, const char *body, size_t len)
{
	const char *p = body;
	int w = 0, h = 0;

	(void)c;
	skip_echo(&p, &len);
	if (sscanf(p, "%dx%d", &w, &h) == 2 && w > 0 && h > 0 && w <= 2048 && h <= 2048) {
		scr_w = w;
		scr_h = h;
	}
}

static void on_getdevtype(struct cmd *c, const char *body, size_t len)
{
	const char *p = body;
	size_t n = 0;

	(void)c;
	skip_echo(&p, &len);
	while (p[n] && p[n] != '\r' && p[n] != '\n' && n < sizeof(pp_devtype) - 1)
		n++;
	if (n)
		snprintf(pp_devtype, sizeof(pp_devtype), "%.*s", (int)n, p);
}

/* ---------- a directory listing ---------- */

static void on_list(struct cmd *c, const char *body, size_t len)
{
	struct lines l;
	const char *line, *path = c->line + 3;   /* we sent "ls <path>" */
	size_t ll;
	struct blob_buf b = { 0 };
	void *arr;
	bool first = true;

	blob_buf_init(&b, 0);
	arr = blobmsg_open_array(&b, "files");
	lines_init(&l, body, len);
	while (lines_next(&l, &line, &ll)) {
		bool dir = false;
		char name[MAX_PATH + 1];
		void *t;

		if (first) {               /* echo */
			first = false;
			continue;
		}
		if (ll >= 2 && line[ll - 1] == '*' && line[ll - 2] == ' ')
			ll -= 2;
		if (ll && line[ll - 1] == '/') {
			dir = true;
			ll--;
		}
		if (!ll)
			continue;
		snprintf(name, sizeof(name), "%.*s", (int)(ll < MAX_PATH ? ll : MAX_PATH), line);
		t = blobmsg_open_table(&b, NULL);
		blobmsg_add_string(&b, "name", name);
		blobmsg_add_u8(&b, "dir", dir);
		blobmsg_close_table(&b, t);
	}
	blobmsg_close_array(&b, arr);
	blobmsg_add_string(&b, "path", path);
	if (c->deferred) {
		c->deferred = false;
		reply_send(&c->req, &b);
	}
	blob_buf_free(&b);
}

/* ---------- the screen ---------- */

static void waiter_answer(struct waiter *w)
{
	struct blob_buf b = { 0 };

	blob_buf_init(&b, 0);
	blobmsg_add_string(&b, "state", state_name());
	blobmsg_add_u32(&b, "seq", frame_seq);
	if (state == ST_READY && have_frame && w->seq != frame_seq) {
		char *s;

		blobmsg_add_u32(&b, "width", frame_w);
		blobmsg_add_u32(&b, "height", frame_h);
		s = blobmsg_alloc_string_buffer(&b, "frame", B64_ENCODE_LEN(frame_len));
		b64_encode(frame, frame_len, s, B64_ENCODE_LEN(frame_len));
		blobmsg_add_string_buffer(&b);
	}
	reply_send(&w->req, &b);
	blob_buf_free(&b);
	uloop_timeout_cancel(&w->t);
	w->used = false;
}

/* screenframeshort: an echo line, then <scr_h> rows of <scr_w> printable bytes
 * (each a pixel, value+32; MayhemHub reads charCode-32), then "ok". Scale it
 * down so the browser gets a frame that fits one reply, in the same colours. */
static void on_screen(struct cmd *c, const char *body, size_t len)
{
	struct lines l;
	const char *line;
	size_t ll;
	const char *rows[1536];
	int rlen[1536], nrows = 0, w = 0, step, fw, fh, x, y, i;
	uint8_t nf[SCREEN_MAX];
	size_t oi = 0;
	bool first = true;

	(void)c;
	lines_init(&l, body, len);
	while (lines_next(&l, &line, &ll) && nrows < (int)(sizeof(rows) / sizeof(rows[0]))) {
		bool data = true;
		size_t k;

		if (first) {               /* echo */
			first = false;
			continue;
		}
		if (ll < 16)
			continue;              /* "ok", blanks: not a pixel row */
		for (k = 0; k < ll; k++)
			if (line[k] < 0x20 || line[k] > 0x5f) {
				data = false;
				break;
			}
		if (!data)
			continue;
		rows[nrows] = line;
		rlen[nrows] = ll;
		if ((int)ll > w)
			w = ll;
		nrows++;
	}
	if (nrows < 8 || w < 8)
		return;                        /* not a frame; keep the last one */
	if (!scr_w || !scr_h) {
		scr_w = w;
		scr_h = nrows;
	}
	step = 1;
	while ((w / step) * (nrows / step) > SCREEN_MAX)
		step++;
	fw = w / step;
	fh = nrows / step;
	for (y = 0; y < fh; y++) {
		const char *row = rows[y * step];
		int rl = rlen[y * step];

		for (x = 0; x < fw; x++) {
			int sx = x * step;

			nf[oi++] = (sx < rl) ? (uint8_t)row[sx] : 0x20;
		}
	}
	/* an unchanged screen: leave the waiters waiting (don't churn the browser) */
	if (have_frame && oi == frame_len && !memcmp(nf, frame, oi))
		return;
	memcpy(frame, nf, oi);
	frame_len = oi;
	frame_w = fw;
	frame_h = fh;
	have_frame = true;
	if (!++frame_seq)
		frame_seq = 1;
	for (i = 0; i < MAX_WAITERS; i++)
		if (waiters[i].used && waiters[i].seq != frame_seq)
			waiter_answer(&waiters[i]);
}

static void queue_screen(void)
{
	struct cmd *c = cmd_new("screenframeshort");

	if (!c)
		return;
	c->done = on_screen;
	cmd_add(c);
}

/* ---------- reading a file into memory ---------- */

static void rc_clear(void)
{
	buf_free(&rc.data);
	memset(&rc, 0, sizeof(rc));
	uloop_timeout_cancel(&rc_t);
}

static void read_fail(const char *err)
{
	rc.busy = false;
	snprintf(rc.err, sizeof(rc.err), "%s", err);
	uloop_timeout_set(&rc_t, CACHE_KEEP_MS);
}

static void queue_fread(void)
{
	uint64_t rem = rc.size - rc.data.len, chunk = rem < FREAD_CHUNK ? rem : FREAD_CHUNK;
	char line[MAX_LINE];
	struct cmd *n;

	snprintf(line, sizeof(line), "fread %llu", (unsigned long long)chunk);
	n = cmd_new(line);
	if (!n) {
		read_fail("out of memory");
		return;
	}
	n->done = on_fread;
	cmd_add(n);
}

static void on_fread(struct cmd *c, const char *body, size_t len)
{
	struct lines l;
	const char *line;
	size_t ll, before = rc.data.len;
	const char *err;
	bool first = true;

	(void)c;
	if (!rc.active || !rc.busy)
		return;
	if ((err = body_error(body, len)) && strcmp(err, "the PortaPack refused it")) {
		read_fail(err);
		cmd_add(cmd_new("fclose"));
		return;
	}
	lines_init(&l, body, len);
	while (lines_next(&l, &line, &ll)) {
		size_t i;

		if (first) {               /* echo */
			first = false;
			continue;
		}
		if (ll == 2 && !memcmp(line, "ok", 2))
			continue;
		for (i = 0; i + 1 < ll; i += 2) {
			int hi = hexval(line[i]), lo = hexval(line[i + 1]);
			uint8_t byte;

			if (hi < 0 || lo < 0)
				break;
			byte = (hi << 4) | lo;
			if (rc.data.len >= MAX_READ) {
				rc.too_big = true;
				break;
			}
			buf_add(&rc.data, &byte, 1);
		}
	}
	if (rc.too_big) {
		read_fail("too big to download here (4 MB at most)");
		cmd_add(cmd_new("fclose"));
		return;
	}
	/* the file was shorter than its size said, or EOF: stop with what we have
	 * rather than ask the shell for the same empty read forever */
	if (rc.data.len >= rc.size || rc.data.len == before) {
		rc.busy = false;
		uloop_timeout_set(&rc_t, CACHE_KEEP_MS);
		cmd_add(cmd_new("fclose"));
		return;
	}
	queue_fread();
}

static void on_filesize(struct cmd *c, const char *body, size_t len)
{
	const char *p = body, *err;
	unsigned long long sz = 0;

	(void)c;
	if (!rc.active || !rc.busy)
		return;
	if ((err = body_error(body, len)) && strcmp(err, "the PortaPack refused it")) {
		read_fail(err);
		return;
	}
	skip_echo(&p, &len);
	if (sscanf(p, "%llu", &sz) != 1) {
		read_fail("couldn't read the file size");
		return;
	}
	rc.size = sz;
	if (sz > MAX_READ) {
		read_fail("too big to download here (4 MB at most)");
		return;
	}
	if (sz == 0) {
		rc.busy = false;
		uloop_timeout_set(&rc_t, CACHE_KEEP_MS);
		return;
	}
	{
		char line[MAX_LINE];
		struct cmd *a, *b2;

		snprintf(line, sizeof(line), "fopen %s", rc.path);
		a = cmd_new(line);
		b2 = cmd_new("fseek 0");
		if (!a || !b2) {
			read_fail("out of memory");
			cmd_free(a);
			cmd_free(b2);
			return;
		}
		cmd_add(a);
		cmd_add(b2);
		queue_fread();
	}
}

static void begin_read(const char *path)
{
	char line[MAX_LINE];
	struct cmd *fc, *fs;

	rc_clear();
	rc.active = rc.busy = true;
	snprintf(rc.path, sizeof(rc.path), "%s", path);
	fc = cmd_new("fclose");
	snprintf(line, sizeof(line), "filesize %s", path);
	fs = cmd_new(line);
	if (!fc || !fs) {
		read_fail("out of memory");
		cmd_free(fc);
		cmd_free(fs);
		return;
	}
	fs->done = on_filesize;
	cmd_add(fc);
	cmd_add(fs);
}

/* ---------- writing a file ---------- */

static void wj_err(const char *err)
{
	uloop_timeout_cancel(&piece_t);
	if (wj.waiting) {
		wj.waiting = false;
		reply_str(&wj.req, "error", err);
	}
	wj.active = false;
}

static void wj_ok(void)
{
	struct blob_buf b = { 0 };

	if (!wj.waiting)
		return;
	wj.waiting = false;
	blob_buf_init(&b, 0);
	blobmsg_add_u8(&b, "ok", 1);
	blobmsg_add_u64(&b, wj.final ? "size" : "received", wj.received);
	reply_send(&wj.req, &b);
	blob_buf_free(&b);
}

/* the last command of a write piece has come back */
static void on_write_done(struct cmd *c, const char *body, size_t len)
{
	const char *err;

	(void)c;
	if (!wj.active)
		return;
	err = body_error(body, len);
	if (err && strcmp(err, "the PortaPack refused it")) {
		wj_err(err);
		if (wj.open)
			cmd_add(cmd_new("fclose"));
		wj.open = false;
		return;
	}
	wj_ok();
	if (wj.final) {
		wj.active = wj.open = false;
	} else {
		uloop_timeout_set(&piece_t, PIECE_WAIT_MS);
	}
}

/* ---------- what the shell sends ---------- */

/* Feed rx: detect the end of the current command's answer. */
static void rx_feed(void)
{
	if (!cur) {
		if (rx.len > 65536)
			buf_drop(&rx, rx.len - 4096);
		return;
	}
	if (cur->phase == PH_WRITE && !cur->wrote) {
		/* wait for the "send N bytes" go-ahead, then push the data */
		if (rx.len >= sizeof(WRITE_GO) - 1 &&
		    memmem(rx.d, rx.len, WRITE_GO, sizeof(WRITE_GO) - 1)) {
			cur->wrote = true;
			rx.len = 0;
			buf_add(&out, cur->wdata.d, cur->wdata.len);
			out_flush();
			uloop_timeout_set(&op_t, OP_TIMEOUT_MS);
		}
		return;
	}
	if (rx.len >= sizeof(PROMPT) - 1 &&
	    !memcmp(rx.d + rx.len - (sizeof(PROMPT) - 1), PROMPT, sizeof(PROMPT) - 1)) {
		size_t blen = rx.len - (sizeof(PROMPT) - 1);
		struct cmd *c = cur;

		if (blen >= 2 && rx.d[blen - 1] == '\n' && rx.d[blen - 2] == '\r')
			blen -= 2;
		uloop_timeout_cancel(&op_t);
		cmd_finish(c, (const char *)rx.d, blen);
	}
}

static void fd_cb(struct uloop_fd *u, unsigned int events)
{
	uint8_t tmp[4096];
	ssize_t r;

	if (broken || fd < 0)
		return;
	if (events & ULOOP_WRITE)
		out_flush();
	if (!broken && (events & ULOOP_READ)) {
		for (;;) {
			r = read(fd, tmp, sizeof(tmp));
			if (r > 0) {
				if (rx.len + r > RX_MAX) {
					dev_fail("the PortaPack sent more than expected");
					return;
				}
				if (!buf_add(&rx, tmp, r)) {
					dev_fail("out of memory");
					return;
				}
				if (state != ST_CONNECTING)
					rx_feed();
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

/* ---------- finding the PortaPack, connecting ---------- */

static bool read_sysfs(const char *path, char *s, size_t n)
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
	if (!read_sysfs(p, v, sizeof(v)) || strcasecmp(v, vid))
		return false;
	snprintf(p, sizeof(p), "%s/idProduct", dir);
	return read_sysfs(p, v, sizeof(v)) && !strcasecmp(v, pid);
}

static bool find_portapack(char *path, size_t n)
{
	char d[512];
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
		if (!usb_id_is(d, PP_VID, PP_PID))
			continue;
		snprintf(path, n, "/dev/%s", e->d_name);
		found = true;
	}
	closedir(dir);
	return found;
}

static void reset_session(void)
{
	struct cmd *c, *tmp;

	list_for_each_entry_safe(c, tmp, &cmds, list) {
		if (c->deferred)
			reply_str(&c->req, "error", "the PortaPack went away");
		list_del(&c->list);
		cmd_free(c);
	}
	ncmds = 0;
	cur = NULL;
	ninfo = 0;
	pp_model[0] = pp_firmware[0] = pp_board[0] = pp_devtype[0] = 0;
	scr_w = scr_h = 0;
	have_frame = streaming = false;
	frame_seq = 0;
	if (wj.active && wj.waiting)
		reply_str(&wj.req, "error", "the PortaPack went away");
	memset(&wj, 0, sizeof(wj));
	rc_clear();
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
		t.c_cflag |= CLOCAL | CREAD;
		t.c_cc[VMIN] = 1;
		t.c_cc[VTIME] = 0;
		cfsetispeed(&t, B115200);
		cfsetospeed(&t, B115200);
		tcsetattr(fd, TCSANOW, &t);
	}
	ioctl(fd, TIOCEXCL);
	tcflush(fd, TCIOFLUSH);
	snprintf(dev_path, sizeof(dev_path), "%s", path);
	state = ST_CONNECTING;
	broken = false;
	rx.len = out.len = 0;
	hs_tries = 0;
	reset_session();
	ufd.fd = fd;
	ufd.cb = fd_cb;
	uloop_fd_add(&ufd, ULOOP_READ);
	uloop_timeout_set(&hs_t, HS_FIRST_MS);
	logmsg("%s: a PortaPack console, looking for its shell", path);
}

static void queue_probes(void)
{
	struct cmd *a, *b, *c;

	a = cmd_new("info");
	b = cmd_new("getres");
	c = cmd_new("getdevtype");
	if (!a || !b || !c) {
		cmd_free(a);
		cmd_free(b);
		cmd_free(c);
		dev_fail("out of memory");
		return;
	}
	a->done = on_info;
	b->done = on_getres;
	c->done = on_getdevtype;
	cmd_add(a);
	cmd_add(b);
	cmd_add(c);
}

static void hs_cb(struct uloop_timeout *t)
{
	if (fd < 0 || broken || state != ST_CONNECTING)
		return;
	if (rx.len >= sizeof(PROMPT) - 1 &&
	    memmem(rx.d, rx.len, PROMPT, sizeof(PROMPT) - 1)) {
		rx.len = 0;
		state = ST_READY;
		last_error[0] = 0;
		logmsg("%s: Mayhem shell up", dev_path);
		queue_probes();
		return;
	}
	if (hs_tries++ >= HS_TRIES) {
		dev_fail("no shell prompt: is it on Mayhem firmware, in its device (console) mode?");
		return;
	}
	buf_add(&out, "\r", 1);
	out_flush();
	uloop_timeout_set(t, HS_RETRY_MS);
}

static void scan_cb(struct uloop_timeout *t)
{
	char path[256];

	if (fd >= 0)
		return;
	if (!find_portapack(path, sizeof(path))) {
		state = ST_ABSENT;
		last_error[0] = 0;
		uloop_timeout_set(t, SCAN_MS);
		return;
	}
	dev_open(path);
}

static void close_cb(struct uloop_timeout *t)
{
	int i;

	(void)t;
	if (fd >= 0) {
		uloop_fd_delete(&ufd);
		ioctl(fd, TIOCNXCL);
		close(fd);
		fd = -1;
	}
	rx.len = out.len = 0;
	uloop_timeout_cancel(&hs_t);
	uloop_timeout_cancel(&op_t);
	uloop_timeout_cancel(&piece_t);
	uloop_timeout_cancel(&stream_t);
	uloop_timeout_cancel(&frame_t);
	state = ST_ABSENT;
	reset_session();
	for (i = 0; i < MAX_WAITERS; i++)
		if (waiters[i].used)
			waiter_answer(&waiters[i]);
	snprintf(last_error, sizeof(last_error), "%s", fail_reason);
	broken = false;
	uloop_timeout_set(&scan_t, fail_reason[0] ? RETRY_MS : SCAN_MS);
	fail_reason[0] = 0;
}

static void op_timeout(struct uloop_timeout *t)
{
	(void)t;
	if (!cur)
		return;
	dev_fail("the PortaPack stopped answering");
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
	streaming = false;
	uloop_timeout_cancel(&frame_t);
}

static void frame_tick(struct uloop_timeout *t)
{
	if (!streaming || state != ST_READY || broken)
		return;
	if (!cur && ncmds == 0)
		queue_screen();
	uloop_timeout_set(t, FRAME_MIN_MS);
}

static void piece_idle(struct uloop_timeout *t)
{
	(void)t;
	if (!wj.active)
		return;
	wj_err("the upload stopped coming");
	if (wj.open)
		cmd_add(cmd_new("fclose"));
	wj.open = false;
}

static void rc_expire(struct uloop_timeout *t)
{
	(void)t;
	if (!rc.busy)
		rc_clear();
}

static void waiter_timeout(struct uloop_timeout *t)
{
	waiter_answer(container_of(t, struct waiter, t));
}

/* ---------- ubus ---------- */

enum {
	A_PATH, A_OFFSET, A_DATA, A_MORE, A_KEY, A_N, A_X, A_Y, A_TEXT, A_SEQ, A_MODE,
	__A_MAX
};

static const struct blobmsg_policy pol[__A_MAX] = {
	[A_PATH] = { "path", BLOBMSG_TYPE_UNSPEC },
	[A_OFFSET] = { "offset", BLOBMSG_TYPE_UNSPEC },
	[A_DATA] = { "data", BLOBMSG_TYPE_UNSPEC },
	[A_MORE] = { "more", BLOBMSG_TYPE_UNSPEC },
	[A_KEY] = { "key", BLOBMSG_TYPE_UNSPEC },
	[A_N] = { "n", BLOBMSG_TYPE_UNSPEC },
	[A_X] = { "x", BLOBMSG_TYPE_UNSPEC },
	[A_Y] = { "y", BLOBMSG_TYPE_UNSPEC },
	[A_TEXT] = { "text", BLOBMSG_TYPE_UNSPEC },
	[A_SEQ] = { "seq", BLOBMSG_TYPE_UNSPEC },
	[A_MODE] = { "mode", BLOBMSG_TYPE_UNSPEC },
};
static struct blob_attr *tb[__A_MAX];

static const struct blobmsg_policy p_path[] = { { "path", BLOBMSG_TYPE_STRING } };
static const struct blobmsg_policy p_read[] = {
	{ "path", BLOBMSG_TYPE_STRING }, { "offset", BLOBMSG_TYPE_INT32 },
};
static const struct blobmsg_policy p_write[] = {
	{ "path", BLOBMSG_TYPE_STRING }, { "offset", BLOBMSG_TYPE_INT32 },
	{ "data", BLOBMSG_TYPE_STRING }, { "more", BLOBMSG_TYPE_BOOL },
};
static const struct blobmsg_policy p_button[] = {
	{ "key", BLOBMSG_TYPE_STRING }, { "n", BLOBMSG_TYPE_INT32 },
};
static const struct blobmsg_policy p_touch[] = {
	{ "x", BLOBMSG_TYPE_INT32 }, { "y", BLOBMSG_TYPE_INT32 },
};
static const struct blobmsg_policy p_keyboard[] = { { "text", BLOBMSG_TYPE_STRING } };
static const struct blobmsg_policy p_screen[] = { { "seq", BLOBMSG_TYPE_INT32 } };
static const struct blobmsg_policy p_reboot[] = { { "mode", BLOBMSG_TYPE_STRING } };

static void parse(struct blob_attr *msg)
{
	blobmsg_parse(pol, __A_MAX, tb, blob_data(msg), blob_len(msg));
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

static int reply_ok(struct ubus_context *c, struct ubus_request_data *req)
{
	blob_buf_init(&rb, 0);
	blobmsg_add_u8(&rb, "ok", 1);
	ubus_send_reply(c, req, rb.head);
	return UBUS_STATUS_OK;
}

static const char *not_ready(void)
{
	if (broken)
		return "the PortaPack went away";
	switch (state) {
	case ST_READY:
		return NULL;
	case ST_CONNECTING:
		return "the PortaPack is still connecting";
	default:
		return "no PortaPack in device mode is plugged in";
	}
}

/* A path on the SD card: /..., printable, no "..", short enough that the whole
 * shell command still fits Mayhem's 64-char line. */
static const char *bad_path(const char *p)
{
	size_t n;

	if (!p || p[0] != '/')
		return "path: give a full path, such as /FIRMWARE";
	n = strlen(p);
	if (n > 48)
		return "path: too long for the PortaPack's shell (48 characters)";
	for (; *p; p++)
		if (*p < 0x20 || *p > 0x7e)
			return "the PortaPack takes plain ASCII names only";
	p -= n;
	if (n > 1 && p[n - 1] == '/')
		return "path: no / at the end";
	if (strstr(p, "//") || strstr(p, "/../") || (n >= 3 && !strcmp(p + n - 3, "/..")) ||
	    strstr(p, "/./") || (n >= 2 && !strcmp(p + n - 2, "/.")))
		return "path: no . or .. parts";
	return NULL;
}

static int queue_simple(struct ubus_context *c, struct ubus_request_data *req, const char *line)
{
	struct cmd *cmd;

	if (ncmds >= MAX_QUEUE)
		return reply_error(c, req, "the PortaPack is busy: try again in a moment");
	cmd = cmd_new(line);
	if (!cmd)
		return reply_error(c, req, "out of memory");
	ubus_defer_request(c, req, &cmd->req);
	cmd->deferred = true;
	cmd_add(cmd);
	return UBUS_STATUS_OK;
}

/* a cmd that answers nothing (reboot/dfu/hackrf/flash: the device then goes) */
static int queue_fire(struct ubus_context *c, struct ubus_request_data *req, const char *line)
{
	struct cmd *cmd = cmd_new(line);

	if (!cmd)
		return reply_error(c, req, "out of memory");
	cmd_add(cmd);
	return reply_ok(c, req);
}

static int m_status(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		    const char *method, struct blob_attr *msg)
{
	(void)obj; (void)method; (void)msg;
	blob_buf_init(&rb, 0);
	blobmsg_add_string(&rb, "state", state_name());
	if (state == ST_CONNECTING || state == ST_READY)
		blobmsg_add_string(&rb, "device", dev_path);
	if (last_error[0])
		blobmsg_add_string(&rb, "error", last_error);
	if (state == ST_READY) {
		if (pp_model[0])
			blobmsg_add_string(&rb, "model", pp_model);
		if (pp_devtype[0])
			blobmsg_add_string(&rb, "devtype", pp_devtype);
		if (pp_firmware[0])
			blobmsg_add_string(&rb, "firmware", pp_firmware);
		if (pp_board[0])
			blobmsg_add_string(&rb, "board", pp_board);
		if (scr_w && scr_h) {
			blobmsg_add_u32(&rb, "screen_w", scr_w);
			blobmsg_add_u32(&rb, "screen_h", scr_h);
		}
	}
	ubus_send_reply(c, req, rb.head);
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
	ubus_send_reply(c, req, rb.head);
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
	if (state == ST_READY && !broken && !streaming) {
		streaming = true;
		uloop_timeout_set(&stream_t, STREAM_IDLE_MS);
		uloop_timeout_set(&frame_t, 0);
	}
	for (i = 0; i < MAX_WAITERS; i++)
		if (!waiters[i].used)
			break;
	if (i >= MAX_WAITERS) {
		blob_buf_init(&rb, 0);
		blobmsg_add_string(&rb, "state", state_name());
		blobmsg_add_u32(&rb, "seq", frame_seq);
		ubus_send_reply(c, req, rb.head);
		return UBUS_STATUS_OK;
	}
	{
		struct waiter *w = &waiters[i];

		w->used = true;
		w->seq = seq;
		ubus_defer_request(c, req, &w->req);
		/* answer now if there's news (or we're not ready); else wait for a frame */
		if (state != ST_READY || (have_frame && (uint32_t)seq != frame_seq))
			waiter_answer(w);
		else
			uloop_timeout_set(&w->t, SCREEN_WAIT_MS);
	}
	return UBUS_STATUS_OK;
}

static int m_button(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		    const char *method, struct blob_attr *msg)
{
	static const char *const keys[] = {
		"right", "left", "down", "up", "select", "dfu", "dial_left", "dial_right"
	};
	const char *key;
	char line[MAX_LINE];
	int64_t n = 0;
	int i, num = 0;

	(void)obj; (void)method;
	parse(msg);
	key = arg_str(A_KEY);
	if (key) {
		for (i = 0; i < (int)(sizeof(keys) / sizeof(keys[0])); i++)
			if (!strcmp(keys[i], key)) {
				num = i + 1;
				break;
			}
		if (!num)
			return reply_error(c, req, "key: up, down, left, right, select, dial_left or dial_right");
	} else if (arg_num(A_N, &n)) {
		num = n;
	} else {
		return reply_error(c, req, "button: give a key or n (1..8)");
	}
	if (num < 1 || num > 8)
		return reply_error(c, req, "button: n is 1..8");
	if (not_ready())
		return reply_error(c, req, not_ready());
	snprintf(line, sizeof(line), "button %d", num);
	return queue_simple(c, req, line);
}

static int m_touch(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		   const char *method, struct blob_attr *msg)
{
	int64_t x, y;
	char line[MAX_LINE];

	(void)obj; (void)method;
	parse(msg);
	if (!arg_num(A_X, &x) || !arg_num(A_Y, &y) || x < 0 || y < 0 || x > 4095 || y > 4095)
		return reply_error(c, req, "touch: x and y, screen pixels");
	if (not_ready())
		return reply_error(c, req, not_ready());
	snprintf(line, sizeof(line), "touch %d %d", (int)x, (int)y);
	return queue_simple(c, req, line);
}

static int m_keyboard(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		      const char *method, struct blob_attr *msg)
{
	const char *text;
	char line[MAX_LINE];
	size_t n, i, w;

	(void)obj; (void)method;
	parse(msg);
	text = arg_str(A_TEXT);
	if (!text || !*text)
		return reply_error(c, req, "text: the characters to type");
	n = strlen(text);
	if (n > 24)                      /* 2 hex a char, inside the 64-char line */
		return reply_error(c, req, "text: up to 24 characters a call");
	for (i = 0; i < n; i++)
		if (text[i] < 0x20 || text[i] > 0x7e)
			return reply_error(c, req, "text: plain ASCII only");
	if (not_ready())
		return reply_error(c, req, not_ready());
	w = snprintf(line, sizeof(line), "keyboard ");
	for (i = 0; i < n; i++)
		w += snprintf(line + w, sizeof(line) - w, "%02X", (unsigned char)text[i]);
	return queue_simple(c, req, line);
}

static int m_list(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		  const char *method, struct blob_attr *msg)
{
	const char *p, *err;
	char line[MAX_LINE];
	struct cmd *cmd;

	(void)obj; (void)method;
	parse(msg);
	p = arg_str(A_PATH);
	if (!p || p[0] != '/' || strlen(p) > 48)
		return reply_error(c, req, "path: a full path on the SD card, such as /FIRMWARE");
	if ((err = not_ready()))
		return reply_error(c, req, err);
	if (ncmds >= MAX_QUEUE)
		return reply_error(c, req, "the PortaPack is busy: try again in a moment");
	snprintf(line, sizeof(line), "ls %s", p);
	cmd = cmd_new(line);
	if (!cmd)
		return reply_error(c, req, "out of memory");
	cmd->done = on_list;
	ubus_defer_request(c, req, &cmd->req);
	cmd->deferred = true;
	cmd_add(cmd);
	return UBUS_STATUS_OK;
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
		if (ncmds >= MAX_QUEUE)
			return reply_error(c, req, "the PortaPack is busy: try again in a moment");
		begin_read(p);
		blob_buf_init(&rb, 0);
		blobmsg_add_u8(&rb, "busy", 1);
		blobmsg_add_u64(&rb, "got", 0);
		ubus_send_reply(c, req, rb.head);
		return UBUS_STATUS_OK;
	}
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

/* queue the shell commands that send one piece of the file. The last one
 * answers the write caller (on_write_done). */
static bool queue_write(const uint8_t *data, size_t n, bool first, bool last)
{
	char line[MAX_LINE];
	struct cmd *last_cmd = NULL;

	if (first) {
		struct cmd *fc = cmd_new("fclose"), *fo, *fs;

		snprintf(line, sizeof(line), "fopen %s", wj.path);
		fo = cmd_new(line);
		fs = cmd_new("fseek 0");
		if (!fc || !fo || !fs) {
			cmd_free(fc);
			cmd_free(fo);
			cmd_free(fs);
			return false;
		}
		cmd_add(fc);
		cmd_add(fo);
		cmd_add(fs);
		last_cmd = fs;
	}
	if (n) {
		struct cmd *fw;

		snprintf(line, sizeof(line), "fwb %zu", n);
		fw = cmd_new(line);
		if (!fw)
			return false;
		fw->phase = PH_WRITE;
		if (!buf_add(&fw->wdata, data, n)) {
			cmd_free(fw);
			return false;
		}
		cmd_add(fw);
		last_cmd = fw;
	}
	if (last) {
		struct cmd *ft = cmd_new("ftruncate"), *fc = cmd_new("fclose");

		if (!ft || !fc) {
			cmd_free(ft);
			cmd_free(fc);
			return false;
		}
		cmd_add(ft);
		cmd_add(fc);
		last_cmd = fc;
	}
	if (last_cmd)
		last_cmd->done = on_write_done;
	else
		on_write_done(NULL, "ok", 2);   /* empty, non-final piece */
	return true;
}

static int m_write(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		   const char *method, struct blob_attr *msg)
{
	const char *p, *err, *s;
	uint8_t *data = NULL;
	int64_t off;
	int n = 0;
	size_t l;
	bool more, first;

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
		return reply_error(c, req, "data: 32 KiB a piece at most");
	if (l) {
		data = malloc(B64_DECODE_LEN(l) + 1);
		if (!data)
			return reply_error(c, req, "out of memory");
		n = b64_decode(s, data, B64_DECODE_LEN(l) + 1);
		if (n < 0) {
			free(data);
			return reply_error(c, req, "data: not base64");
		}
	}
	first = (off == 0);
	if (first) {
		if (wj.active) {
			free(data);
			return reply_error(c, req, "a file is being sent already: wait for it to finish");
		}
		if ((err = not_ready())) {
			free(data);
			return reply_error(c, req, err);
		}
		if (ncmds + 6 >= MAX_QUEUE) {
			free(data);
			return reply_error(c, req, "the PortaPack is busy: try again in a moment");
		}
		memset(&wj, 0, sizeof(wj));
		wj.active = wj.open = true;
		snprintf(wj.path, sizeof(wj.path), "%s", p);
	} else {
		if (!wj.active || strcmp(wj.path, p)) {
			free(data);
			return reply_error(c, req, "that file isn't being sent: start again from offset 0");
		}
		if ((uint64_t)off != wj.received) {
			char e[96];

			free(data);
			snprintf(e, sizeof(e), "offset: the next piece goes at %llu", (unsigned long long)wj.received);
			return reply_error(c, req, e);
		}
		if (wj.waiting) {
			free(data);
			return reply_error(c, req, "the last piece is still on its way");
		}
	}
	wj.received = off + n;
	wj.final = !more;
	ubus_defer_request(c, req, &wj.req);
	wj.waiting = true;
	uloop_timeout_cancel(&piece_t);
	if (!queue_write(data, n, first, wj.final)) {
		free(data);
		wj_err("out of memory");
		if (wj.open)
			cmd_add(cmd_new("fclose"));
		wj.open = false;
		return UBUS_STATUS_OK;
	}
	free(data);
	return UBUS_STATUS_OK;
}

static int m_mkdir(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		   const char *method, struct blob_attr *msg)
{
	const char *p, *err;
	char line[MAX_LINE];

	(void)obj; (void)method;
	parse(msg);
	p = arg_str(A_PATH);
	if ((err = bad_path(p)))
		return reply_error(c, req, err);
	if ((err = not_ready()))
		return reply_error(c, req, err);
	snprintf(line, sizeof(line), "mkdir %s", p);
	return queue_simple(c, req, line);
}

static int m_delete(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		    const char *method, struct blob_attr *msg)
{
	const char *p, *err;
	char line[MAX_LINE];

	(void)obj; (void)method;
	parse(msg);
	p = arg_str(A_PATH);
	if ((err = bad_path(p)))
		return reply_error(c, req, err);
	if (!strchr(p + 1, '/'))
		return reply_error(c, req, "path: not a whole storage");
	if ((err = not_ready()))
		return reply_error(c, req, err);
	snprintf(line, sizeof(line), "unlink %s", p);
	return queue_simple(c, req, line);
}

static int m_reboot(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		    const char *method, struct blob_attr *msg)
{
	const char *mode;

	(void)obj; (void)method;
	parse(msg);
	mode = arg_str(A_MODE) ? arg_str(A_MODE) : "os";
	if (strcmp(mode, "os") && strcmp(mode, "dfu"))
		return reply_error(c, req, "mode: os or dfu");
	if (not_ready())
		return reply_error(c, req, not_ready());
	return queue_fire(c, req, strcmp(mode, "dfu") ? "reboot" : "dfu");
}

static int m_hackrf(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		    const char *method, struct blob_attr *msg)
{
	(void)obj; (void)method; (void)msg;
	if (not_ready())
		return reply_error(c, req, not_ready());
	return queue_fire(c, req, "hackrf");
}

static int m_flash(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		   const char *method, struct blob_attr *msg)
{
	const char *p, *err;
	char line[MAX_LINE];

	(void)obj; (void)method;
	parse(msg);
	p = arg_str(A_PATH);
	if ((err = bad_path(p)))
		return reply_error(c, req, err);
	if ((err = not_ready()))
		return reply_error(c, req, err);
	snprintf(line, sizeof(line), "flash %s", p);
	return queue_fire(c, req, line);
}

static const struct ubus_method methods[] = {
	UBUS_METHOD_NOARG("status", m_status),
	UBUS_METHOD_NOARG("info", m_info),
	UBUS_METHOD("screen", m_screen, p_screen),
	UBUS_METHOD("button", m_button, p_button),
	UBUS_METHOD("touch", m_touch, p_touch),
	UBUS_METHOD("keyboard", m_keyboard, p_keyboard),
	UBUS_METHOD("list", m_list, p_path),
	UBUS_METHOD("read", m_read, p_read),
	UBUS_METHOD("write", m_write, p_write),
	UBUS_METHOD("mkdir", m_mkdir, p_path),
	UBUS_METHOD("delete", m_delete, p_path),
	UBUS_METHOD("reboot", m_reboot, p_reboot),
	UBUS_METHOD_NOARG("hackrf", m_hackrf),
	UBUS_METHOD("flash", m_flash, p_path),
};

static struct ubus_object_type obj_type = UBUS_OBJECT_TYPE("pirate.portapack", methods);

static struct ubus_object obj = {
	.name = "pirate.portapack",
	.type = &obj_type,
	.methods = methods,
	.n_methods = ARRAY_SIZE(methods),
};

static void on_connect(struct ubus_context *c)
{
	int r = ubus_add_object(c, &obj);

	if (r)
		logmsg("can't add pirate.portapack to ubus: %s", ubus_strerror(r));
}

static void usage(void)
{
	fprintf(stderr, "usage: pirate-portapack [-d device] [-s sysfs] [-u ubus-socket]\n");
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
	uloop_init();
	scan_t.cb = scan_cb;
	hs_t.cb = hs_cb;
	op_t.cb = op_timeout;
	stream_t.cb = stream_idle;
	frame_t.cb = frame_tick;
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
