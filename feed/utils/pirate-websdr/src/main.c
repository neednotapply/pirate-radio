/*
 * pirate-websdr: the radio behind the web UI's Listen page.
 *
 * Moves the raw 8-bit IQ samples of the HackRF or the RTL-SDR (through
 * SoapySDR) into a WebSocket, and takes the tuning back. No signal
 * processing: the browser does that, the router could not. DESIGN.md has
 * the protocol (Part 1) and the rules kept here (Part 3).
 *
 * One process, one thread, poll(). Sockets never block; a client too slow
 * for the stream loses frames, it never holds up the others or the radio.
 *
 * This is free software, licensed under the MIT license.
 */
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/types.h>

#include "clock.h"
#include "json.h"
#include "source.h"
#include "ws.h"

#define VERSION "0.1.1"
#define PROTO 1

#define DEFAULT_PORT 8073
#define DEFAULT_FREQ 98000000.0
#define DEFAULT_RATE 2400000.0

#define MAX_CLIENTS_LIMIT 8		/* --max-clients, at most */
#define MAX_SLOTS (MAX_CLIENTS_LIMIT + 2)	/* sockets: two more, to turn the extra away politely */
#define RX_SIZE 4096			/* a handshake's request, or a few commands */
#define TEXT_MAX 512			/* a command, at most */
#define FRAME_SAMPLES_MAX 48000
#define IQ_HEADER 8
#define TX_SIZE (WS_MAX_HEADER + IQ_HEADER + 2 * FRAME_SAMPLES_MAX)
#define MSG_MAX 1280			/* a text message to a client, at most */
#define MSG_QUEUE 12

#define HANDSHAKE_MS 5000		/* to send the request */
#define CLOSING_MS 1000			/* to hang up after being told to */
#define STALL_MS 10000			/* a socket that takes nothing for this long is dead */
#define STATUS_MS 1000
#define WATCHDOG_MS 3000		/* the radio, silent this long, has failed */
#define REOPEN_GAP_MS 2000		/* between closing a device and opening one */
#define RESTART_GAP_MS 500		/* between stopping its stream and starting it */
#define READ_MS 20			/* the longest wait for samples: the loop's beat */
#define IDLE_MS 250			/* the same, when nothing streams */

/* ---------- options ---------- */

static int opt_port = DEFAULT_PORT;
static const char *opt_bind;
static const char *opt_state_file;
static int opt_sim;
static long opt_linger_ms = 5000;
static int opt_max_clients = 4;
static int opt_any_origin;
static int opt_verbose;

static char my_name[65];		/* this machine's host name: a page under it is ours */

static volatile sig_atomic_t got_term, got_release;

/* ---------- clients ---------- */

struct msg {
	unsigned char op;
	unsigned short len;
	char data[MSG_MAX];
};

struct bufs {
	unsigned char tx[TX_SIZE];	/* the message on its way out, as on the wire */
	struct msg q[MSG_QUEUE];	/* text (and control) messages waiting, in order */
};

enum { ST_FREE, ST_HTTP, ST_OPEN, ST_CLOSING };

struct client {
	int state;
	int fd;
	int ws;				/* got as far as a WebSocket */
	char addr[INET6_ADDRSTRLEN];
	long long t_state;		/* when it came into this state */
	long long t_progress;		/* when the socket last took something */
	unsigned char rx[RX_SIZE];
	size_t rxlen;
	struct bufs *b;
	size_t txlen, txoff;
	int qhead, qcount;
	int tail_status;		/* the last message queued is a status: a newer one replaces it */
	int close_after;		/* nothing more will be said: hang up once tx is out */
	int streaming;			/* gets IQ frames */
	int discont;			/* its next frame follows a gap */
	unsigned long dropped;		/* frames it missed since it opened */
};

static struct client clients[MAX_SLOTS];
static int n_slots;
static int n_streaming;

/* ---------- the radio ---------- */

static struct {
	const struct source_ops *ops;
	void *h;			/* NULL: no device open */
	char radio[8];			/* "hackrf" or "rtlsdr" */
	struct src_info info;
	int active;			/* the stream runs */
	int frame;			/* samples in a frame */
	int filled;			/* samples in the frame being put together */
	uint32_t seq;
	int discont_all;		/* the next frame follows a change, for everybody */
	unsigned long overflows;
	long long idle_since;		/* nobody has listened since (0: somebody does) */
	long long last_data;		/* samples last came */
	long long closed_at;		/* a device was last closed (0: never) */
	long long stopped_at;		/* its stream was last stopped (0: never) */
	unsigned long frames;		/* frames made since the log last said */
	long long said_at;		/* the log last said how it goes (--verbose) */
} dev;

static int8_t framebuf[2 * FRAME_SAMPLES_MAX];
static long long last_status;

static void client_pump(struct client *c);
static void client_drop(struct client *c, const char *why);
static void device_close(const char *why);

/* ---------- log: stderr, which procd sends to the system log ---------- */

#ifdef __GNUC__
static void logmsg(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
#endif

static void logmsg(const char *fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vfprintf(stderr, fmt, ap);
	va_end(ap);
	fputc('\n', stderr);
}

static const char *radio_name(const char *radio)
{
	return strcmp(radio, "hackrf") == 0 ? "HackRF" : "RTL-SDR";
}

static int same_hz(double a, double b)
{
	return a - b < 0.5 && b - a < 0.5;
}

/* ---------- writing JSON ---------- */

struct sbuf {
	char *p;
	size_t cap, len;
	int bad;			/* it did not fit */
};

static void sb_init(struct sbuf *b, char *p, size_t cap)
{
	b->p = p;
	b->cap = cap;
	b->len = 0;
	b->bad = 0;
	p[0] = '\0';
}

static void sb_puts(struct sbuf *b, const char *s)
{
	size_t n = strlen(s);

	if (b->bad || b->len + n + 1 > b->cap) {
		b->bad = 1;
		return;
	}
	memcpy(b->p + b->len, s, n + 1);
	b->len += n;
}

/* A text as a JSON string. Only ASCII goes through: a text frame has to be
   valid UTF-8, and what a driver calls itself is not ours to vouch for. */
static void sb_str(struct sbuf *b, const char *s)
{
	char tmp[8];

	sb_puts(b, "\"");
	for (; *s; s++) {
		unsigned char ch = (unsigned char)*s;

		if (ch == '"' || ch == '\\') {
			tmp[0] = '\\';
			tmp[1] = (char)ch;
			tmp[2] = '\0';
		} else if (ch < 0x20) {
			snprintf(tmp, sizeof(tmp), "\\u%04x", (unsigned)ch);
		} else {
			tmp[0] = ch < 0x7f ? (char)ch : '?';
			tmp[1] = '\0';
		}
		sb_puts(b, tmp);
	}
	sb_puts(b, "\"");
}

/* A number: whole ones without a fraction, the others with as few digits
   as give the same number back (49.6, not 49.600000000000001). */
static void sb_num(struct sbuf *b, double v)
{
	char tmp[40];

	if (!(v == v) || v > 1e300 || v < -1e300)
		v = 0;
	if (v > -1e15 && v < 1e15 && v == (double)(long long)v) {
		snprintf(tmp, sizeof(tmp), "%.0f", v);
	} else {
		snprintf(tmp, sizeof(tmp), "%.15g", v);
		if (strtod(tmp, NULL) != v)
			snprintf(tmp, sizeof(tmp), "%.17g", v);
	}
	sb_puts(b, tmp);
}

static void sb_int(struct sbuf *b, unsigned long v)
{
	char tmp[24];

	snprintf(tmp, sizeof(tmp), "%lu", v);
	sb_puts(b, tmp);
}

/* ---------- messages out ---------- */

/* Queues a message for a client, behind what it is still being sent; text
   is never dropped, so one that lets its queue fill up is let go of. A
   status waiting at the end of the queue is replaced by a newer one. */
static void queue_msg(struct client *c, int op, const void *data, size_t len, int is_status)
{
	struct msg *m;

	if (c->state != ST_OPEN || c->close_after)
		return;
	if (len > MSG_MAX) {
		logmsg("%s: a message of %u bytes does not fit", c->addr, (unsigned)len);
		return;
	}
	if (is_status && c->qcount > 0 && c->tail_status) {
		m = &c->b->q[(c->qhead + c->qcount - 1) % MSG_QUEUE];
	} else {
		if (c->qcount == MSG_QUEUE) {
			client_drop(c, "it reads nothing");
			return;
		}
		m = &c->b->q[(c->qhead + c->qcount) % MSG_QUEUE];
		c->qcount++;
	}
	m->op = (unsigned char)op;
	m->len = (unsigned short)len;
	memcpy(m->data, data, len);
	c->tail_status = is_status;
	client_pump(c);
}

static void send_json(struct client *c, struct sbuf *b, int is_status)
{
	if (b->bad) {
		logmsg("%s: a message did not fit, and was not sent", c->addr);
		return;
	}
	queue_msg(c, WS_OP_TEXT, b->p, b->len, is_status);
}

static void send_hello(struct client *c)
{
	char buf[MSG_MAX];
	struct sbuf b;

	sb_init(&b, buf, sizeof(buf));
	sb_puts(&b, "{\"type\":\"hello\",\"proto\":");
	sb_int(&b, PROTO);
	sb_puts(&b, ",\"server\":\"pirate-websdr " VERSION "\",\"sim\":");
	sb_puts(&b, opt_sim ? "true" : "false");
	sb_puts(&b, ",\"open\":");
	/* a device only kept open for a while, with nobody on it, is nobody's */
	if (dev.h && n_streaming > 0)
		sb_str(&b, dev.radio);
	else
		sb_puts(&b, "null");
	sb_puts(&b, "}");
	send_json(c, &b, 0);
}

static void send_info(struct client *c)
{
	char buf[MSG_MAX];
	struct sbuf b;
	int i;

	sb_init(&b, buf, sizeof(buf));
	sb_puts(&b, "{\"type\":\"info\",\"radio\":");
	sb_str(&b, dev.radio);
	sb_puts(&b, ",\"label\":");
	sb_str(&b, dev.info.label);
	sb_puts(&b, ",\"freq\":");
	sb_num(&b, dev.info.freq);
	sb_puts(&b, ",\"rate\":");
	sb_num(&b, dev.info.rate);
	sb_puts(&b, ",\"frame\":");
	sb_int(&b, (unsigned long)dev.frame);
	sb_puts(&b, ",\"rates\":[");
	for (i = 0; i < dev.info.nrates; i++) {
		if (i)
			sb_puts(&b, ",");
		sb_num(&b, dev.info.rates[i]);
	}
	sb_puts(&b, "],\"range\":[");
	sb_num(&b, dev.info.range_lo);
	sb_puts(&b, ",");
	sb_num(&b, dev.info.range_hi);
	sb_puts(&b, "],\"gains\":[");
	for (i = 0; i < dev.info.ngains; i++) {
		const struct src_gain *g = &dev.info.gains[i];

		sb_puts(&b, i ? ",{\"name\":" : "{\"name\":");
		sb_str(&b, g->name);
		sb_puts(&b, ",\"min\":");
		sb_num(&b, g->min);
		sb_puts(&b, ",\"max\":");
		sb_num(&b, g->max);
		sb_puts(&b, ",\"step\":");
		sb_num(&b, g->step);
		sb_puts(&b, ",\"value\":");
		sb_num(&b, g->value);
		sb_puts(&b, "}");
	}
	sb_puts(&b, "]}");
	send_json(c, &b, 0);
}

static void send_status(struct client *c)
{
	char buf[MSG_MAX];
	struct sbuf b;
	int i;

	sb_init(&b, buf, sizeof(buf));
	sb_puts(&b, "{\"type\":\"status\",\"freq\":");
	sb_num(&b, dev.info.freq);
	sb_puts(&b, ",\"rate\":");
	sb_num(&b, dev.info.rate);
	sb_puts(&b, ",\"gains\":{");
	for (i = 0; i < dev.info.ngains; i++) {
		if (i)
			sb_puts(&b, ",");
		sb_str(&b, dev.info.gains[i].name);
		sb_puts(&b, ":");
		sb_num(&b, dev.info.gains[i].value);
	}
	sb_puts(&b, "},\"clients\":");
	sb_int(&b, (unsigned long)n_streaming);
	sb_puts(&b, ",\"dropped\":");
	sb_int(&b, c->dropped);
	sb_puts(&b, ",\"overflows\":");
	sb_int(&b, dev.overflows);
	sb_puts(&b, "}");
	send_json(c, &b, 1);
}

static void send_error(struct client *c, const char *code, const char *message)
{
	char buf[MSG_MAX];
	struct sbuf b;

	sb_init(&b, buf, sizeof(buf));
	sb_puts(&b, "{\"type\":\"error\",\"code\":");
	sb_str(&b, code);
	sb_puts(&b, ",\"message\":");
	sb_str(&b, message);
	sb_puts(&b, "}");
	send_json(c, &b, 0);
}

static void send_closed(struct client *c, const char *reason)
{
	char buf[MSG_MAX];
	struct sbuf b;

	sb_init(&b, buf, sizeof(buf));
	sb_puts(&b, "{\"type\":\"closed\",\"reason\":");
	sb_str(&b, reason);
	sb_puts(&b, "}");
	send_json(c, &b, 0);
}

/* To every client that gets the stream. */
static void info_all(void)
{
	int i;

	for (i = 0; i < n_slots; i++)
		if (clients[i].state == ST_OPEN && clients[i].streaming)
			send_info(&clients[i]);
}

static void status_all(void)
{
	int i;

	for (i = 0; i < n_slots; i++)
		if (clients[i].state == ST_OPEN && clients[i].streaming)
			send_status(&clients[i]);
	last_status = mono_ms();
}

/* ---------- sockets out ---------- */

/* The kernel's buffer for a client that gets the stream: about 150 ms of
   it. What does not fit there is not sent (see send_frame). */
static void size_sndbuf(const struct client *c)
{
	long long want = (long long)dev.info.rate * 2 * 150 / 1000;
	int v;

	if (want < 262144)
		want = 262144;
	if (want > 2097152)
		want = 2097152;
	v = (int)want;
	setsockopt(c->fd, SOL_SOCKET, SO_SNDBUF, &v, sizeof(v));
}

/* Sends what is waiting for a client, as far as its socket takes it. */
static void client_pump(struct client *c)
{
	while (c->state != ST_FREE) {
		ssize_t n;

		if (c->txlen == 0) {
			const struct msg *m;
			size_t h;

			if (c->qcount == 0)
				break;
			m = &c->b->q[c->qhead];
			h = ws_write_header(c->b->tx, m->op, m->len);
			memcpy(c->b->tx + h, m->data, m->len);
			c->txlen = h + m->len;
			c->txoff = 0;
			c->qhead = (c->qhead + 1) % MSG_QUEUE;
			if (--c->qcount == 0)
				c->tail_status = 0;
			c->t_progress = mono_ms();
		}
		n = send(c->fd, c->b->tx + c->txoff, c->txlen - c->txoff, MSG_NOSIGNAL);
		if (n > 0) {
			c->txoff += (size_t)n;
			c->t_progress = mono_ms();
			if (c->txoff >= c->txlen)
				c->txlen = c->txoff = 0;
			continue;
		}
		if (n < 0 && errno == EINTR)
			continue;
		if (n == 0 || errno == EAGAIN || errno == EWOULDBLOCK)
			return;				/* full: poll() says when to go on */
		client_drop(c, "the connection broke");
		return;
	}
	if (c->state != ST_FREE && c->state != ST_CLOSING && c->close_after &&
	    c->txlen == 0 && c->qcount == 0) {
		/* all said: our side is done, the other end hangs up (or is hung up on) */
		shutdown(c->fd, SHUT_WR);
		c->state = ST_CLOSING;
		c->t_state = mono_ms();
	}
}

/* ---------- who listens ---------- */

/* A client stops getting frames. With the last one gone the stream stops,
   and the device stays open a while (--linger) for whoever comes back. */
static void stream_leave(struct client *c)
{
	if (!c->streaming)
		return;
	c->streaming = 0;
	n_streaming--;
	if (n_streaming == 0 && dev.h) {
		if (dev.active) {
			dev.ops->stop(dev.h);
			dev.active = 0;
			dev.stopped_at = mono_ms();
		}
		dev.idle_since = mono_ms();
		logmsg("%s: nobody is listening", dev.radio);
	}
}

static void client_drop(struct client *c, const char *why)
{
	if (c->state == ST_FREE)
		return;
	if (c->ws || opt_verbose)
		logmsg("%s: gone (%s)", c->addr, why);
	close(c->fd);
	free(c->b);
	c->b = NULL;
	c->fd = -1;
	c->state = ST_FREE;
	c->rxlen = 0;
	c->txlen = c->txoff = 0;
	c->qcount = 0;
	stream_leave(c);
}

/* Everybody off the stream, each told why. */
static void kick_all(const char *reason)
{
	int i;

	for (i = 0; i < n_slots; i++) {
		struct client *c = &clients[i];

		if (c->state != ST_OPEN || !c->streaming)
			continue;
		c->streaming = 0;
		n_streaming--;
		send_closed(c, reason);
	}
}

/* ---------- the device ---------- */

static int frame_samples(double rate)
{
	int n = (int)(rate / 50 + 0.5);		/* 20 ms */

	if (n > FRAME_SAMPLES_MAX)
		n = FRAME_SAMPLES_MAX;
	if (n < 1)
		n = 1;
	return n;
}

static void state_write(const char *radio)
{
	FILE *f;

	if (!opt_state_file)
		return;
	f = fopen(opt_state_file, "w");
	if (!f) {
		logmsg("cannot write %s: %s", opt_state_file, strerror(errno));
		return;
	}
	fprintf(f, "%s\n", radio);
	fclose(f);
}

static void state_clear(void)
{
	if (opt_state_file)
		unlink(opt_state_file);
}

/* Waits until gap_ms have passed since <since> (0: nothing to wait for).
   Nothing streams meanwhile: this is only ever between a stop and a start. */
static void wait_out(long long since, long gap_ms)
{
	long long left;

	if (!since)
		return;
	while (!got_term && (left = since + gap_ms - mono_ms()) > 0)
		sleep_ns((left > 50 ? 50 : left) * 1000000LL);
}

/* Opens a radio, not sooner than 2 s after one was closed: a HackRF opened
   and closed in quick succession can drop off USB until it is replugged. */
static int device_open(const char *radio, double freq, double rate, char *err)
{
	wait_out(dev.closed_at, REOPEN_GAP_MS);
	dev.h = dev.ops->open(radio, freq, rate, err);
	if (!dev.h) {
		dev.closed_at = mono_ms();	/* it may have been opened for a moment */
		logmsg("%s: %s", radio, err);
		return -1;
	}
	snprintf(dev.radio, sizeof(dev.radio), "%s", radio);
	dev.info = *dev.ops->info(dev.h);
	dev.active = 0;
	dev.frame = frame_samples(dev.info.rate);
	dev.filled = 0;
	dev.seq = 0;
	dev.discont_all = 1;
	dev.overflows = 0;
	dev.idle_since = mono_ms();
	dev.stopped_at = 0;
	state_write(radio);
	logmsg("%s: open (%s), %.0f samples a second at %.0f Hz", radio, dev.info.label,
		dev.info.rate, dev.info.freq);
	return 0;
}

static void device_close(const char *why)
{
	if (!dev.h)
		return;
	if (dev.active)
		dev.ops->stop(dev.h);
	dev.ops->close(dev.h);
	dev.h = NULL;
	dev.active = 0;
	dev.idle_since = 0;
	dev.closed_at = mono_ms();
	state_clear();
	logmsg("%s: closed (%s)", dev.radio, why);
}

/* The radio failed, or is wanted elsewhere: the listeners are told, and it
   is closed at once. It is not opened again until a client asks. */
static void device_drop(const char *reason)
{
	if (!dev.h)
		return;
	kick_all(reason);
	device_close(reason);
}

/* A new centre or rate holds: what was read before it is no longer a frame. */
static void device_changed(void)
{
	dev.info = *dev.ops->info(dev.h);
	dev.frame = frame_samples(dev.info.rate);
	dev.filled = 0;
	dev.discont_all = 1;
	dev.last_data = mono_ms();
}

/* 0, or -1 with the error sent to c */
static int apply_freq(struct client *c, double hz)
{
	char err[SRC_ERR_LEN];

	if (hz < dev.info.range_lo || hz > dev.info.range_hi) {
		send_error(c, "failed", "that frequency is outside what the radio tunes");
		return -1;
	}
	if (dev.ops->set_freq(dev.h, hz, err) != 0) {
		send_error(c, "failed", err);
		return -1;
	}
	device_changed();
	return 0;
}

static int apply_rate(struct client *c, double hz)
{
	char err[SRC_ERR_LEN];
	int i, rc = dev.ops->set_rate(dev.h, hz, err);

	device_changed();
	if (rc != 0) {
		send_error(c, "failed", err);
		return -1;
	}
	for (i = 0; i < n_slots; i++)
		if (clients[i].state == ST_OPEN && clients[i].streaming)
			size_sndbuf(&clients[i]);
	return 0;
}

/* ---------- commands ---------- */

static int rate_offered(const double *rates, int n, double hz)
{
	int i;

	for (i = 0; i < n; i++)
		if (same_hz(rates[i], hz))
			return 1;
	return 0;
}

static void cmd_open(struct client *c, const struct json_obj *o)
{
	const struct json_field *radio = json_get(o, "radio");
	const struct json_field *ffreq = json_get(o, "freq");
	const struct json_field *frate = json_get(o, "rate");
	double rates[SRC_MAX_RATES], freq = 0, rate = 0;
	char err[SRC_ERR_LEN], text[SRC_ERR_LEN + 64];
	int others;

	if (!radio || radio->type != JSON_STRING ||
	    (strcmp(radio->str, "hackrf") != 0 && strcmp(radio->str, "rtlsdr") != 0)) {
		send_error(c, "badrequest", "open: radio is \"hackrf\" or \"rtlsdr\"");
		return;
	}
	if (ffreq) {
		/* (no radio here goes anywhere near 100 GHz: a number beyond it
		   is not handed to a driver to make something of) */
		if (ffreq->type != JSON_NUMBER || ffreq->num < 1 || ffreq->num > 1e11) {
			send_error(c, "badrequest", "open: freq is a frequency in Hz");
			return;
		}
		freq = ffreq->num;
	}
	if (frate) {
		if (frate->type != JSON_NUMBER ||
		    !rate_offered(rates, src_rates_for(radio->str, rates), frate->num)) {
			send_error(c, "badrequest", "open: rate is not one that radio offers");
			return;
		}
		rate = frate->num;
	}
	others = n_streaming - (c->streaming ? 1 : 0);

	if (dev.h && strcmp(dev.radio, radio->str) != 0) {
		if (others > 0) {
			snprintf(text, sizeof(text), "the %s is in use here: one radio at a time",
				radio_name(dev.radio));
			send_error(c, "busy", text);
			return;
		}
		/* nobody else is on the other radio (this client's own, or one
		   kept open for a while): it goes, the one asked for comes */
		if (c->streaming) {
			c->streaming = 0;
			n_streaming--;
		}
		device_close("the other radio is asked for");
	}

	if (!dev.h) {
		if (device_open(radio->str, freq > 0 ? freq : DEFAULT_FREQ,
				rate > 0 ? rate : DEFAULT_RATE, err) != 0) {
			snprintf(text, sizeof(text), "the %s: %s", radio_name(radio->str), err);
			send_error(c, "nodevice", text);
			return;
		}
		/* what it tunes is only known now: a centre asked for outside
		   of it becomes the nearest it has */
		if (dev.info.freq < dev.info.range_lo || dev.info.freq > dev.info.range_hi) {
			double hz = dev.info.freq < dev.info.range_lo ? dev.info.range_lo : dev.info.range_hi;

			if (dev.ops->set_freq(dev.h, hz, err) == 0)
				dev.info = *dev.ops->info(dev.h);
		}
	} else if (others == 0) {
		/* open, and nobody else on it: this client's to set */
		if (rate > 0 && !same_hz(rate, dev.info.rate))
			apply_rate(c, rate);
		if (freq > 0 && !same_hz(freq, dev.info.freq))
			apply_freq(c, freq);
	}

	if (!c->streaming) {
		c->streaming = 1;
		n_streaming++;
		c->dropped = 0;
	}
	c->discont = 1;
	dev.idle_since = 0;
	size_sndbuf(c);
	send_info(c);
	if (c->state != ST_OPEN)
		return;				/* it went while being answered */
	if (!dev.active) {
		/* a listener who stops and starts in a hurry does not have the
		   radio's receiver switched off and on as fast */
		wait_out(dev.stopped_at, RESTART_GAP_MS);
		if (dev.ops->start(dev.h, err) != 0) {
			logmsg("%s: %s", dev.radio, err);
			send_error(c, "failed", err);
			device_drop("the radio's stream did not start");
			return;
		}
		dev.active = 1;
		dev.filled = 0;
		dev.discont_all = 1;
		dev.last_data = mono_ms();
		dev.frames = 0;
		dev.said_at = mono_ms();
	}
	logmsg("%s: %s listens (%d in all)", dev.radio, c->addr, n_streaming);
	status_all();
}

static void cmd_freq(struct client *c, const struct json_obj *o)
{
	const struct json_field *hz = json_get(o, "hz");

	if (!c->streaming) {
		send_error(c, "badrequest", "freq: open a radio first");
		return;
	}
	if (!hz || hz->type != JSON_NUMBER) {
		send_error(c, "badrequest", "freq: hz is a frequency in Hz");
		return;
	}
	if (apply_freq(c, hz->num) == 0)
		status_all();
}

static void cmd_rate(struct client *c, const struct json_obj *o)
{
	const struct json_field *hz = json_get(o, "hz");

	if (!c->streaming) {
		send_error(c, "badrequest", "rate: open a radio first");
		return;
	}
	if (!hz || hz->type != JSON_NUMBER ||
	    !rate_offered(dev.info.rates, dev.info.nrates, hz->num)) {
		send_error(c, "badrequest", "rate: hz is one of the radio's rates");
		return;
	}
	if (same_hz(hz->num, dev.info.rate)) {
		status_all();
		return;
	}
	if (apply_rate(c, hz->num) == 0) {
		info_all();
		status_all();
	}
}

static void cmd_gain(struct client *c, const struct json_obj *o)
{
	const struct json_field *name = json_get(o, "name");
	const struct json_field *value = json_get(o, "value");
	char err[SRC_ERR_LEN];
	int i;

	if (!c->streaming) {
		send_error(c, "badrequest", "gain: open a radio first");
		return;
	}
	if (!name || name->type != JSON_STRING || !value || value->type != JSON_NUMBER) {
		send_error(c, "badrequest", "gain: name is a gain element, value its dB");
		return;
	}
	for (i = 0; i < dev.info.ngains; i++)
		if (strcmp(dev.info.gains[i].name, name->str) == 0)
			break;
	if (i == dev.info.ngains) {
		send_error(c, "badrequest", "gain: the radio has no such gain element");
		return;
	}
	if (dev.ops->set_gain(dev.h, name->str, value->num, err) != 0) {
		send_error(c, "failed", err);
		return;
	}
	dev.info = *dev.ops->info(dev.h);
	status_all();
}

static void cmd_close(struct client *c)
{
	if (c->streaming)
		logmsg("%s: %s stops listening", dev.radio, c->addr);
	stream_leave(c);
	send_closed(c, "closed, as asked");
	if (n_streaming > 0)
		status_all();
}

static void cmd_ping(struct client *c, const struct json_obj *o)
{
	const struct json_field *t = json_get(o, "t");
	char buf[96];
	struct sbuf b;

	sb_init(&b, buf, sizeof(buf));
	sb_puts(&b, "{\"type\":\"pong\",\"t\":");
	sb_num(&b, (t && t->type == JSON_NUMBER) ? t->num : 0);
	sb_puts(&b, "}");
	send_json(c, &b, 0);
}

static void handle_command(struct client *c, const char *text, size_t len)
{
	struct json_obj o;
	const struct json_field *cmd;

	if (json_parse_flat(text, len, &o) != 0) {
		send_error(c, "badrequest", "a command is one flat JSON object");
		return;
	}
	cmd = json_get(&o, "cmd");
	if (!cmd || cmd->type != JSON_STRING) {
		send_error(c, "badrequest", "a command has a cmd");
		return;
	}
	if (strcmp(cmd->str, "open") == 0)
		cmd_open(c, &o);
	else if (strcmp(cmd->str, "freq") == 0)
		cmd_freq(c, &o);
	else if (strcmp(cmd->str, "rate") == 0)
		cmd_rate(c, &o);
	else if (strcmp(cmd->str, "gain") == 0)
		cmd_gain(c, &o);
	else if (strcmp(cmd->str, "close") == 0)
		cmd_close(c);
	else if (strcmp(cmd->str, "ping") == 0)
		cmd_ping(c, &o);
	else
		send_error(c, "badrequest", "unknown cmd");
}

/* ---------- WebSocket frames in ---------- */

/* Says goodbye (a Close frame with that payload) and hangs up once it is out. */
static void ws_shut(struct client *c, const unsigned char *payload, size_t len)
{
	stream_leave(c);
	queue_msg(c, WS_OP_CLOSE, payload, len, 0);
	if (c->state == ST_FREE)
		return;
	c->close_after = 1;
	client_pump(c);
}

static void ws_fail(struct client *c, int code, const char *reason)
{
	unsigned char p[2 + 64];
	size_t n = strlen(reason);

	if (n > 64)
		n = 64;
	p[0] = (unsigned char)((code >> 8) & 0xff);
	p[1] = (unsigned char)(code & 0xff);
	memcpy(p + 2, reason, n);
	logmsg("%s: %s (closing with %d)", c->addr, reason, code);
	ws_shut(c, p, 2 + n);
}

static void handle_frames(struct client *c)
{
	while (c->state == ST_OPEN && !c->close_after && c->rxlen > 0) {
		struct ws_frame f;
		int used = ws_parse_frame(c->rx, c->rxlen, TEXT_MAX, &f);

		if (used == WS_NEED_MORE)
			return;
		if (used == WS_ERR_TOO_BIG) {
			ws_fail(c, 1009, "a message is 512 bytes at most");
			break;
		}
		if (used < 0) {
			ws_fail(c, 1002, "not a frame a client may send");
			break;
		}
		if (f.opcode >= 0x8 && (!f.fin || f.len > 125)) {
			ws_fail(c, 1002, "a control frame is whole, and 125 bytes at most");
			break;
		}
		switch (f.opcode) {
		case WS_OP_TEXT:
			if (!f.fin) {
				ws_fail(c, 1009, "messages in pieces are not taken");
				break;
			}
			handle_command(c, (const char *)f.payload, f.len);
			break;
		case WS_OP_CONT:
			ws_fail(c, 1009, "messages in pieces are not taken");
			break;
		case WS_OP_BINARY:
			ws_fail(c, 1003, "only text is taken");
			break;
		case WS_OP_PING:
			queue_msg(c, WS_OP_PONG, f.payload, f.len, 0);
			break;
		case WS_OP_PONG:
			break;
		case WS_OP_CLOSE:
			/* its goodbye: ours back, with its status code if it gave one */
			ws_shut(c, f.payload, f.len >= 2 ? 2 : 0);
			break;
		default:
			ws_fail(c, 1002, "not a frame a client may send");
			break;
		}
		if (c->state != ST_OPEN || c->close_after)
			break;
		memmove(c->rx, c->rx + used, c->rxlen - (size_t)used);
		c->rxlen -= (size_t)used;
	}
	if (c->state != ST_OPEN || c->close_after)
		c->rxlen = 0;			/* whatever else it sent is not read */
}

/* ---------- the handshake ---------- */

static void http_reply(struct client *c, const char *status, const char *extra, const char *body)
{
	int n = snprintf((char *)c->b->tx, TX_SIZE,
		"HTTP/1.1 %s\r\n%sContent-Type: text/plain; charset=utf-8\r\n"
		"Content-Length: %u\r\nConnection: close\r\n\r\n%s",
		status, extra, (unsigned)strlen(body), body);

	if (n < 0 || n >= TX_SIZE) {
		client_drop(c, "no answer could be made");
		return;
	}
	c->txlen = (size_t)n;
	c->txoff = 0;
	c->t_progress = mono_ms();
	c->close_after = 1;
	c->rxlen = 0;
	client_pump(c);
}

static int ws_clients(void)
{
	int i, n = 0;

	for (i = 0; i < n_slots; i++)
		if (clients[i].state == ST_OPEN)
			n++;
	return n;
}

static void handle_http(struct client *c)
{
	static const char what[] =
		"This is pirate-websdr: the radio's stream for the Listen page of the router's\n"
		"web interface, a WebSocket. There is nothing to see here: open the web interface.\n";
	char *req = (char *)c->rx, *end;
	const char *v, *host;
	char key[WS_KEY_MAX + 1], accept[WS_ACCEPT_LEN + 1];
	size_t vlen, hlen, head;
	int n;

	if (c->close_after) {
		c->rxlen = 0;
		return;
	}
	req[c->rxlen] = '\0';			/* rx keeps a byte for this */
	end = strstr(req, "\r\n\r\n");
	if (!end) {
		if (c->rxlen >= RX_SIZE - 1)
			http_reply(c, "400 Bad Request", "", "The request is too long.\n");
		return;				/* more to come */
	}
	head = (size_t)(end - req) + 4;
	end[2] = '\0';				/* the head, its last line's CRLF included */

	if (strncmp(req, "GET ", 4) != 0) {
		http_reply(c, "400 Bad Request", "", what);
		return;
	}
	v = ws_http_header(req, "Upgrade", &vlen);
	if (!v || !ws_has_token(v, vlen, "websocket") ||
	    !(v = ws_http_header(req, "Connection", &vlen)) || !ws_has_token(v, vlen, "upgrade")) {
		http_reply(c, "426 Upgrade Required", "Upgrade: websocket\r\n", what);
		return;
	}
	v = ws_http_header(req, "Sec-WebSocket-Version", &vlen);
	if (!v || vlen != 2 || memcmp(v, "13", 2) != 0) {
		http_reply(c, "426 Upgrade Required", "Sec-WebSocket-Version: 13\r\n",
			"WebSocket version 13 is the one spoken here.\n");
		return;
	}
	v = ws_http_header(req, "Sec-WebSocket-Key", &vlen);
	if (!v || vlen < 16 || vlen > WS_KEY_MAX) {
		http_reply(c, "400 Bad Request", "", "No usable Sec-WebSocket-Key.\n");
		return;
	}
	memcpy(key, v, vlen);
	key[vlen] = '\0';

	/* a page of another site may not use the radio through its visitor's
	   browser: a browser always says which page asks (Origin) */
	v = ws_http_header(req, "Origin", &vlen);
	if (v && !opt_any_origin) {
		host = ws_http_header(req, "Host", &hlen);
		if (!host || !ws_same_host(v, vlen, host, hlen)) {
			logmsg("%s: refused, the page that asks is not this router's", c->addr);
			http_reply(c, "403 Forbidden", "", "Only the router's own web interface may use this.\n");
			return;
		}
		/* nor a page under a name that somebody else's DNS has pointed at
		   this router (DNS rebinding), where page and request do agree: the
		   router is reached by an address, or by its own name */
		if (!ws_host_is_address(host, hlen) && !ws_host_is_name(host, hlen, my_name)) {
			logmsg("%s: refused, the page that asks is under a name that is not this router's", c->addr);
			http_reply(c, "403 Forbidden", "", "Only the router's own web interface may use this.\n");
			return;
		}
	}
	if (ws_clients() >= opt_max_clients) {
		http_reply(c, "503 Service Unavailable", "", "Too many listeners already.\n");
		return;
	}

	ws_accept_key(key, accept);
	n = snprintf((char *)c->b->tx, TX_SIZE,
		"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
		"Connection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", accept);
	c->txlen = (size_t)n;
	c->txoff = 0;
	c->t_progress = mono_ms();
	c->state = ST_OPEN;
	c->t_state = mono_ms();
	c->ws = 1;
	/* what came after the request is the first frames */
	memmove(c->rx, c->rx + head, c->rxlen - head);
	c->rxlen -= head;
	logmsg("%s: connected", c->addr);
	send_hello(c);
	if (c->state == ST_OPEN)
		handle_frames(c);
}

/* ---------- sockets in ---------- */

static int set_nonblock(int fd)
{
	int fl = fcntl(fd, F_GETFL, 0);

	if (fl < 0)
		return -1;
	return fcntl(fd, F_SETFL, fl | O_NONBLOCK);
}

static void addr_text(const struct sockaddr_storage *ss, char *out, size_t n)
{
	char host[INET6_ADDRSTRLEN] = "?";

	if (ss->ss_family == AF_INET6) {
		const struct sockaddr_in6 *a = (const struct sockaddr_in6 *)ss;

		inet_ntop(AF_INET6, &a->sin6_addr, host, sizeof(host));
		if (strncmp(host, "::ffff:", 7) == 0)	/* IPv4 on the IPv6 socket */
			memmove(host, host + 7, strlen(host + 7) + 1);
	} else if (ss->ss_family == AF_INET) {
		const struct sockaddr_in *a = (const struct sockaddr_in *)ss;

		inet_ntop(AF_INET, &a->sin_addr, host, sizeof(host));
	}
	snprintf(out, n, "%s", host);
}

static int listen_on(const char *addr, int port)
{
	int fd, on = 1, off = 0;

	if (!addr || strchr(addr, ':')) {
		/* every address, IPv4 too, through the IPv6 socket; or the IPv6 one given */
		struct sockaddr_in6 a6;

		memset(&a6, 0, sizeof(a6));
		a6.sin6_family = AF_INET6;
		a6.sin6_port = htons((uint16_t)port);
		if (!addr)
			a6.sin6_addr = in6addr_any;
		else if (inet_pton(AF_INET6, addr, &a6.sin6_addr) != 1) {
			errno = EINVAL;
			return -1;
		}
		fd = socket(AF_INET6, SOCK_STREAM, 0);
		if (fd >= 0) {
			setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
			if (!addr)
				setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &off, sizeof(off));
			if (bind(fd, (struct sockaddr *)&a6, sizeof(a6)) == 0 && listen(fd, 8) == 0)
				return fd;
			close(fd);
		}
		if (addr)
			return -1;
		/* no IPv6 here: IPv4 alone */
	}
	{
		struct sockaddr_in a4;

		memset(&a4, 0, sizeof(a4));
		a4.sin_family = AF_INET;
		a4.sin_port = htons((uint16_t)port);
		if (!addr)
			a4.sin_addr.s_addr = htonl(INADDR_ANY);
		else if (inet_pton(AF_INET, addr, &a4.sin_addr) != 1) {
			errno = EINVAL;
			return -1;
		}
		fd = socket(AF_INET, SOCK_STREAM, 0);
		if (fd < 0)
			return -1;
		setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
		if (bind(fd, (struct sockaddr *)&a4, sizeof(a4)) != 0 || listen(fd, 8) != 0) {
			close(fd);
			return -1;
		}
		return fd;
	}
}

static void accept_clients(int lfd)
{
	for (;;) {
		struct sockaddr_storage ss;
		socklen_t slen = sizeof(ss);
		struct client *c = NULL;
		struct bufs *b;
		int fd, i, on = 1;

		memset(&ss, 0, sizeof(ss));
		fd = accept(lfd, (struct sockaddr *)&ss, &slen);
		if (fd < 0) {
			if (errno == EINTR)
				continue;
			return;			/* none waiting */
		}
		for (i = 0; i < n_slots; i++) {
			if (clients[i].state == ST_FREE) {
				c = &clients[i];
				break;
			}
		}
		b = c ? malloc(sizeof(*b)) : NULL;
		if (!c || !b || set_nonblock(fd) != 0) {
			free(b);
			close(fd);		/* no room for it */
			continue;
		}
		memset(c, 0, sizeof(*c));
		c->fd = fd;
		c->b = b;
		c->state = ST_HTTP;
		c->t_state = c->t_progress = mono_ms();
		addr_text(&ss, c->addr, sizeof(c->addr));
		setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, sizeof(on));
		/* a listener whose machine went away without a word is noticed */
		setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &on, sizeof(on));
#if defined(TCP_KEEPIDLE) && defined(TCP_KEEPINTVL) && defined(TCP_KEEPCNT)
		{
			int idle = 30, intvl = 10, cnt = 3;

			setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &idle, sizeof(idle));
			setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &intvl, sizeof(intvl));
			setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &cnt, sizeof(cnt));
		}
#endif
	}
}

static void client_read(struct client *c)
{
	size_t room = RX_SIZE - 1 - c->rxlen;
	ssize_t n;

	if (room == 0) {
		client_drop(c, "it sent too much");
		return;
	}
	n = recv(c->fd, c->rx + c->rxlen, room, 0);
	if (n == 0) {
		client_drop(c, "it hung up");
		return;
	}
	if (n < 0) {
		if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)
			return;
		client_drop(c, "the connection broke");
		return;
	}
	c->rxlen += (size_t)n;
	if (c->state == ST_HTTP)
		handle_http(c);
	else if (c->state == ST_OPEN)
		handle_frames(c);
	else
		c->rxlen = 0;			/* told to go: not listened to any more */
}

/* ---------- the stream ---------- */

/* A whole frame is in framebuf: to every listener whose socket is free for
   it. One still busy with the frame before misses this one. */
static void send_frame(void)
{
	size_t payload = IQ_HEADER + 2 * (size_t)dev.frame;
	int i;

	for (i = 0; i < n_slots; i++) {
		struct client *c = &clients[i];
		unsigned char *p;
		size_t h;

		if (c->state != ST_OPEN || !c->streaming)
			continue;
		if (c->txlen != 0 || c->qcount != 0) {
			c->dropped++;
			c->discont = 1;
			continue;
		}
		p = c->b->tx;
		h = ws_write_header(p, WS_OP_BINARY, payload);
		p[h] = 0x01;				/* IQ, signed 8-bit */
		p[h + 1] = (c->discont || dev.discont_all) ? 0x01 : 0x00;
		p[h + 2] = 0;
		p[h + 3] = 0;
		p[h + 4] = (unsigned char)(dev.seq & 0xff);
		p[h + 5] = (unsigned char)((dev.seq >> 8) & 0xff);
		p[h + 6] = (unsigned char)((dev.seq >> 16) & 0xff);
		p[h + 7] = (unsigned char)((dev.seq >> 24) & 0xff);
		memcpy(p + h + IQ_HEADER, framebuf, 2 * (size_t)dev.frame);
		c->txlen = h + payload;
		c->txoff = 0;
		c->t_progress = mono_ms();
		c->discont = 0;
		client_pump(c);
	}
	dev.discont_all = 0;
	dev.seq++;
	dev.frames++;
}

/* Takes what the radio has, for at most READ_MS; sends every frame that fills. */
static void pump_radio(void)
{
	char err[SRC_ERR_LEN], text[SRC_ERR_LEN + 32];
	int overflow = 0, n;

	n = dev.ops->read(dev.h, framebuf + 2 * dev.filled, dev.frame - dev.filled, READ_MS, &overflow, err);
	if (overflow) {
		dev.overflows++;
		dev.discont_all = 1;
	}
	if (n < 0) {
		snprintf(text, sizeof(text), "the radio failed: %s", err);
		logmsg("%s: %s", dev.radio, text);
		device_drop(text);
		return;
	}
	if (n == 0) {
		if (mono_ms() - dev.last_data > WATCHDOG_MS) {
			logmsg("%s: no samples for %d s", dev.radio, WATCHDOG_MS / 1000);
			device_drop("the radio stopped answering");
		}
		return;
	}
	dev.last_data = mono_ms();
	dev.filled += n;
	if (dev.filled >= dev.frame) {
		dev.filled = 0;
		send_frame();
	}
}

/* ---------- the rest ---------- */

static void on_term(int sig)
{
	(void)sig;
	got_term = 1;
}

static void on_release(int sig)
{
	(void)sig;
	got_release = 1;
}

static void timers(void)
{
	long long now = mono_ms();
	int i;

	for (i = 0; i < n_slots; i++) {
		struct client *c = &clients[i];

		if (c->state == ST_HTTP && now - c->t_state > HANDSHAKE_MS)
			client_drop(c, "no request came");
		else if (c->state == ST_CLOSING && now - c->t_state > CLOSING_MS)
			client_drop(c, "told to go");
		else if (c->state != ST_FREE && c->txlen > 0 && now - c->t_progress > STALL_MS)
			client_drop(c, "it takes nothing");
	}
	if (dev.h && n_streaming == 0) {
		if (!dev.idle_since)
			dev.idle_since = now;
		if (now - dev.idle_since >= opt_linger_ms)
			device_close("nobody came back");
	}
	if (n_streaming > 0 && now - last_status >= STATUS_MS)
		status_all();
	if (opt_verbose && dev.h && dev.active && now - dev.said_at >= 10000) {
		unsigned long dropped = 0;

		for (i = 0; i < n_slots; i++)
			if (clients[i].state == ST_OPEN && clients[i].streaming)
				dropped += clients[i].dropped;
		logmsg("%s: %lu frames in %ld s to %d, %lu not sent so far, %lu overflows", dev.radio,
			dev.frames, (long)((now - dev.said_at) / 1000), n_streaming, dropped, dev.overflows);
		dev.frames = 0;
		dev.said_at = now;
	}
}

static void usage(FILE *f)
{
	fputs("usage: pirate-websdr [--port 8073] [--bind ADDR] [--state-file PATH] [--sim]\n"
	      "                     [--linger SEC] [--max-clients N] [--any-origin] [--verbose]\n"
	      "\n"
	      "The radio's samples for the web interface's Listen page, over a WebSocket.\n"
	      "  --port N          the port to listen on (8073)\n"
	      "  --bind ADDR       one address to listen on (every address)\n"
	      "  --state-file PATH while a radio is open: a file holding its kind\n"
	      "  --sim             a simulated radio stands in for the real ones\n"
	      "  --linger SEC      keep the radio open this long after the last listener (5)\n"
	      "  --max-clients N   listeners at a time, 1 to 8 (4)\n"
	      "  --any-origin      take pages of other hosts and names too (for trying things\n"
	      "                    out, or a router reached by a name that is not its own)\n"
	      "  --verbose         say more in the log\n"
	      "SIGUSR1 makes it let go of the radio at once.\n", f);
}

static int parse_args(int argc, char **argv)
{
	int i;

	for (i = 1; i < argc; i++) {
		const char *a = argv[i], *v = (i + 1 < argc) ? argv[i + 1] : NULL;
		char *e;

		if (strcmp(a, "--sim") == 0) {
			opt_sim = 1;
		} else if (strcmp(a, "--verbose") == 0) {
			opt_verbose = 1;
		} else if (strcmp(a, "--any-origin") == 0) {
			opt_any_origin = 1;
		} else if (strcmp(a, "--help") == 0 || strcmp(a, "-h") == 0) {
			usage(stdout);
			exit(0);
		} else if (strcmp(a, "--version") == 0) {
			puts("pirate-websdr " VERSION);
			exit(0);
		} else if (!v) {
			return -1;			/* the rest take a value */
		} else if (strcmp(a, "--port") == 0) {
			long p = strtol(v, &e, 10);

			if (*e || p < 1 || p > 65535)
				return -1;
			opt_port = (int)p;
			i++;
		} else if (strcmp(a, "--bind") == 0) {
			opt_bind = v;
			i++;
		} else if (strcmp(a, "--state-file") == 0) {
			opt_state_file = v;
			i++;
		} else if (strcmp(a, "--linger") == 0) {
			double s = strtod(v, &e);

			if (*e || !(s >= 0) || s > 3600)
				return -1;
			opt_linger_ms = (long)(s * 1000 + 0.5);
			i++;
		} else if (strcmp(a, "--max-clients") == 0) {
			long m = strtol(v, &e, 10);

			if (*e || m < 1 || m > MAX_CLIENTS_LIMIT)
				return -1;
			opt_max_clients = (int)m;
			i++;
		} else {
			return -1;
		}
	}
	return 0;
}

int main(int argc, char **argv)
{
	struct sigaction sa;
	int lfd, i;

	if (parse_args(argc, argv) != 0) {
		usage(stderr);
		return 2;
	}

#ifdef WITH_SOAPY
	dev.ops = opt_sim ? &source_sim : &source_soapy;
#else
	if (!opt_sim)
		logmsg("built without SoapySDR: the radio is a simulated one");
	opt_sim = 1;
	dev.ops = &source_sim;
#endif

	memset(&sa, 0, sizeof(sa));
	sigemptyset(&sa.sa_mask);
	sa.sa_handler = on_term;
	sigaction(SIGTERM, &sa, NULL);
	sigaction(SIGINT, &sa, NULL);
	sa.sa_handler = on_release;
	sigaction(SIGUSR1, &sa, NULL);
	sa.sa_handler = SIG_IGN;
	sigaction(SIGPIPE, &sa, NULL);

	if (gethostname(my_name, sizeof(my_name) - 1) != 0)
		my_name[0] = '\0';
	my_name[sizeof(my_name) - 1] = '\0';

	n_slots = opt_max_clients + 2;
	for (i = 0; i < MAX_SLOTS; i++) {
		clients[i].state = ST_FREE;
		clients[i].fd = -1;
	}
	state_clear();				/* one left behind by a run that was killed */

	lfd = listen_on(opt_bind, opt_port);
	if (lfd < 0 || set_nonblock(lfd) != 0) {
		logmsg("cannot listen on %s%sport %d: %s", opt_bind ? opt_bind : "", opt_bind ? ", " : "",
			opt_port, strerror(errno));
		return 1;
	}
	logmsg("pirate-websdr " VERSION ": listening on port %d%s", opt_port,
		opt_sim ? ", with a simulated radio" : "");

	while (!got_term) {
		struct pollfd fds[1 + MAX_SLOTS];
		int slot[1 + MAX_SLOTS];
		int nfds = 1;

		if (got_release) {
			got_release = 0;
			if (dev.h)
				device_drop("the radio was handed to another job");
		}

		fds[0].fd = lfd;
		fds[0].events = POLLIN;
		fds[0].revents = 0;
		for (i = 0; i < n_slots; i++) {
			if (clients[i].state == ST_FREE)
				continue;
			fds[nfds].fd = clients[i].fd;
			fds[nfds].events = (short)(POLLIN | (clients[i].txlen > 0 ? POLLOUT : 0));
			fds[nfds].revents = 0;
			slot[nfds] = i;
			nfds++;
		}

		/* while the stream runs, waiting for samples (pump_radio) is the pause */
		if (poll(fds, (nfds_t)nfds, (dev.h && dev.active) ? 0 : IDLE_MS) > 0) {
			for (i = 1; i < nfds; i++) {
				struct client *c = &clients[slot[i]];

				if (c->state != ST_FREE && (fds[i].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)))
					client_read(c);
				if (c->state != ST_FREE && (fds[i].revents & POLLOUT))
					client_pump(c);
			}
			if (fds[0].revents & POLLIN)
				accept_clients(lfd);
		}

		timers();
		if (dev.h && dev.active)
			pump_radio();
	}

	/* told to stop: the radio first, in order; then the listeners */
	if (dev.h) {
		kick_all("the receiver's stream is shutting down");
		device_close("shutting down");
	}
	for (i = 0; i < n_slots; i++) {
		if (clients[i].state != ST_FREE) {
			close(clients[i].fd);
			free(clients[i].b);
		}
	}
	close(lfd);
	state_clear();
	logmsg("stopped");
	return 0;
}
