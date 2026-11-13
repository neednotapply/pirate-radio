/*
 * pirate-bluetooth: a Bluetooth dongle on the router's USB port, for the
 * Pirate Radio web UI's Bluetooth page: what it hears of the Bluetooth
 * devices around, passed on as it comes. On ubus as pirate.bluetooth.
 *
 * With an adapter that has Low Energy (Bluetooth 4.0 and later) it only
 * listens. The adapter scans passively for Low Energy advertising: it asks
 * nothing of the devices it hears (no scan requests, no inquiry, no
 * connections), and can be neither found nor connected to itself.
 *
 * An adapter from before that has nothing to listen to, and finds what is
 * about the older way, by asking: an inquiry (ten seconds of it, a pause,
 * and again), which the devices that are set to be found answer with their
 * address and their class; and each one found is asked its name, where it
 * has not said it. That sends, and a device asked its name can tell by
 * whom. The adapter itself still cannot be found or connected to.
 *
 * What the adapter reports goes to the page as it is, an HCI event a record;
 * the page (bt/scanner.js) makes devices of it. Nothing is kept here beyond
 * the last few seconds (and, the older way, which devices were found and
 * asked their names), and nothing is written anywhere.
 *
 * The adapter is the kernel's (hci0, through an HCI socket, as hcitool has
 * it). It is brought up when a page asks what it hears, and put down again
 * 10 s after the last one asked.
 *
 *   pirate-bluetooth [-d socket] [-s sysfs] [-u ubus-socket] [-i ms]
 *
 *   -d  an adapter on a Unix socket (SOCK_SEQPACKET: an HCI packet a
 *       message, led by its type, as the kernel's HCI socket has them) in
 *       place of the kernel's; for tests (tests/fakebt)
 *   -s  where sysfs is (default /sys; for tests)
 *   -u  ubusd's socket (default: libubus's)
 *   -i  how long after the last "reports" the adapter is put down, ms
 *       (default 10000)
 *
 * pirate.bluetooth methods:
 *   status          state: absent (no adapter), idle (one, not in use),
 *                   starting, listening or failed; the adapter (its name,
 *                   its USB ids and product, its address, its HCI and LMP
 *                   versions and its maker's number, once it has been
 *                   started), how many records it has heard this time, and
 *                   the last error. "classic": it is from before Low
 *                   Energy and searches the older way (then "inquiring":
 *                   an inquiry is out; "searches": how many have ended)
 *   reports {seq}   what the adapter has heard, from record <seq> on
 *                   (without one: all that is held), and "seq" to ask with
 *                   next. Asking is what makes it listen. Nothing new: the
 *                   answer waits for something, up to 1 s. "data" is base64
 *                   of the records, each
 *                       2 bytes  the length of the rest (5 + n), little-endian
 *                       4 bytes  when it came: ms on this daemon's clock,
 *                                little-endian ("now" is that clock's time)
 *                       1 byte   the HCI event's code (0x3e: LE Meta)
 *                       n bytes  the event's parameters
 *                   of which there are LE Advertising Reports (subevent
 *                   0x02), LE Direct Advertising Reports (0x0b) and, from
 *                   an adapter that scans with the extended commands, LE
 *                   Extended Advertising Reports (0x0d). From an adapter
 *                   that searches the older way the events are others:
 *                   Inquiry Result (0x02; 0x22 with how strong; 0x2f with
 *                   what the device says of itself), Inquiry Complete
 *                   (0x01), and Remote Name Request Complete (0x07, the
 *                   name cut at its end). "lost": records that were let
 *                   go before this caller took them.
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
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include <libubox/blobmsg.h>
#include <libubox/uloop.h>
#include <libubox/utils.h>
#include <libubus.h>

/* The kernel's HCI sockets, as BlueZ's <bluetooth/hci.h> has them (its
 * headers are not needed for this little) */
#ifndef AF_BLUETOOTH
#define AF_BLUETOOTH 31
#endif
#define BTPROTO_HCI 1
#define SOL_HCI     0
#define HCI_FILTER  2
#define HCIDEVUP    _IOW('H', 201, int)
#define HCIDEVDOWN  _IOW('H', 202, int)

struct sockaddr_hci {
	sa_family_t hci_family;
	unsigned short hci_dev;
	unsigned short hci_channel;
};

struct hci_filter {
	uint32_t type_mask;
	uint32_t event_mask[2];
	uint16_t opcode;
};

#define HCI_COMMAND_PKT 0x01
#define HCI_EVENT_PKT   0x04

#define EVT_CMD_COMPLETE   0x0e
#define EVT_CMD_STATUS     0x0f
#define EVT_HARDWARE_ERROR 0x10
#define EVT_LE_META        0x3e
/* (the older way) */
#define EVT_INQUIRY_COMPLETE 0x01
#define EVT_INQUIRY_RESULT   0x02
#define EVT_REMOTE_NAME      0x07
#define EVT_INQUIRY_RSSI     0x22
#define EVT_INQUIRY_EXTENDED 0x2f

#define LE_ADV_REPORT        0x02
#define LE_DIRECT_ADV_REPORT 0x0b
#define LE_EXT_ADV_REPORT    0x0d

#define OP_READ_LOCAL_VERSION     0x1001
#define OP_READ_BD_ADDR           0x1009
#define OP_LE_SET_SCAN_PARAM      0x200b
#define OP_LE_SET_SCAN_ENABLE     0x200c
#define OP_LE_SET_EXT_SCAN_PARAM  0x2041
#define OP_LE_SET_EXT_SCAN_ENABLE 0x2042
#define OP_INQUIRY                0x0401
#define OP_INQUIRY_CANCEL         0x0402
#define OP_REMOTE_NAME_REQ        0x0419

/* The scan: all the time (the window as long as the interval), 40 ms on each
 * of the three advertising channels in turn; in units of 0.625 ms */
#define SCAN_INTERVAL 0x0040

#define RING      (128 * 1024)   /* records held: a few seconds of a busy place */
#define MAX_REPLY (30 * 1024)    /* records in one answer (40 KiB as base64) */
#define MAX_WAITERS 8

#define PRESENT_MS 2000    /* looking for an adapter, and whether it is still there */
#define UP_MS      30000   /* the kernel bringing the adapter up, at most */
#define CMD_MS     3000    /* a command's answer, at most */
#define STOP_MS    500     /* the scan's end, before the adapter is put down */
#define PROBE_MS   15000   /* while listening: is the adapter still answering? */
#define RETRY_MS   5000    /* after a failure, before it is tried again */
#define WAIT_MS    1000    /* "reports" with nothing new waits this long */
#define FLUSH_MS   120     /* what comes within this of a first record goes in one answer */
#define IDLE_MS    10000

/* The older way */
#define INQUIRY_UNITS 8      /* an inquiry: 8 x 1.28 s, as a phone's is */
#define INQUIRY_MS    (INQUIRY_UNITS * 1280 + 5000)   /* its end, at most */
#define NAME_MS       12000  /* a name's answer, at most (a device that answers no page is given up on after 5 s) */
#define GAP_MS        2000   /* between the last of one search and the next */
#define NAMES_A_ROUND 4      /* names asked for after one inquiry, at most */
#define SEEN          48     /* devices found, kept for their names */

enum state { ST_ABSENT, ST_IDLE, ST_STARTING, ST_LISTENING, ST_FAILED };

/* What is being waited for from the adapter */
enum step {
	S_NONE,
	S_VERSION, S_ADDRESS,             /* what it is */
	S_QUIET, S_PARAMS, S_ENABLE,      /* the scan, with the commands every LE adapter has */
	S_XQUIET, S_XPARAMS, S_XENABLE,   /* the scan, with the extended ones */
	S_PROBE,                          /* listening: does it still answer? */
	S_INQUIRY, S_NAME,                /* the older way: an inquiry begun, a name asked for */
	S_STOP,                           /* the scan's end */
};

struct waiter {
	bool used, has_seq;
	uint64_t seq;
	struct ubus_request_data req;
	struct uloop_timeout t;
};

static const char *opt_dev, *opt_sysfs = "/sys";
static int opt_idle = IDLE_MS;
static struct ubus_auto_conn conn;
#define UBUS (&conn.ctx)

static enum state state = ST_ABSENT;
static enum step step = S_NONE;
static int dev_id = -1;
static int hfd = -1;
static struct uloop_fd hufd;
static struct uloop_process up_proc;
static bool up_pending, is_up, extended, stopping;
static uint8_t legacy_status;

/* The older way: the devices found, for their names (named: it has told
 * its name, in the record numbered name_seq; that counts while the record
 * is still held for a page to take); what is under way */
struct seen {
	bool used, named;
	uint8_t tries, addr[6], psrm;
	uint16_t clock;
	uint32_t round;
	uint64_t name_seq;
};
static struct seen seen[SEEN];
static bool inquiring, naming;
static uint8_t naming_addr[6];
static uint32_t round_no;
static unsigned searches, names_asked;
static char last_error[240];
static int64_t failed_at, listening_at;

/* The adapter, as far as it is known */
static char usb_id[16], usb_bcd[8], usb_product[64], usb_maker[64], address[18];
static bool have_version;
static unsigned hci_ver, hci_rev, lmp_ver, lmp_subver, maker;

static uint8_t ring[RING];
static size_t ring_start, ring_end;
static uint64_t seq_first, seq_next, heard;

static struct waiter waiters[MAX_WAITERS];
static struct uloop_timeout present_t, up_t, cmd_t, probe_t, idle_t, flush_t, search_t;
static struct blob_buf rb;

static void adapter_begin(void);
static void waiters_answer(bool all);

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
	static const char *const n[] = { "absent", "idle", "starting", "listening", "failed" };

	return n[state];
}

/* An adapter from before Bluetooth 4.0 (HCI version 6): it has no Low
 * Energy, and searches the older way */
static bool is_classic(void)
{
	return have_version && hci_ver < 6;
}

/* ---------- the records ---------- */

static size_t rec_size(size_t at)
{
	return 2 + (ring[at] | ring[at + 1] << 8);
}

static void ring_clear(void)
{
	/* (the numbers go on: a page asking with one from before gets what is new) */
	seq_first = seq_next;
	ring_start = ring_end = 0;
}

static void ring_add(uint8_t evt, const uint8_t *p, size_t n)
{
	size_t need = 7 + n;
	uint32_t t = (uint32_t)now_ms();
	uint8_t *r;

	if (need > RING)
		return;
	/* No room: the oldest go */
	while (ring_end - ring_start + need > RING) {
		ring_start += rec_size(ring_start);
		seq_first++;
	}
	if (ring_end + need > RING) {
		memmove(ring, ring + ring_start, ring_end - ring_start);
		ring_end -= ring_start;
		ring_start = 0;
	}
	r = ring + ring_end;
	r[0] = (5 + n) & 0xff;
	r[1] = (5 + n) >> 8;
	r[2] = t & 0xff;
	r[3] = t >> 8 & 0xff;
	r[4] = t >> 16 & 0xff;
	r[5] = t >> 24 & 0xff;
	r[6] = evt;
	memcpy(r + 7, p, n);
	ring_end += need;
	seq_next++;
	heard++;
}

/* Is there anything for one who has had all before <seq>? */
static bool ring_has(bool has_seq, uint64_t seq)
{
	if (!has_seq || seq > seq_next || seq < seq_first)
		return seq_first < seq_next;
	return seq < seq_next;
}

/* An answer to "reports" */
static void reports_fill(struct blob_buf *b, bool has_seq, uint64_t seq)
{
	uint64_t lost = 0, s;
	size_t from, to;

	/* A page that begins, or one that asks with a number from before this
	 * daemon began: all that is held */
	if (!has_seq || seq > seq_next)
		seq = seq_first;
	if (seq < seq_first) {
		lost = seq_first - seq;
		seq = seq_first;
	}
	from = ring_start;
	for (s = seq_first; s < seq; s++)
		from += rec_size(from);
	for (to = from; to < ring_end && to + rec_size(to) - from <= MAX_REPLY; s++)
		to += rec_size(to);
	blobmsg_add_string(b, "state", state_name());
	blobmsg_add_u64(b, "seq", s);
	blobmsg_add_u64(b, "now", (uint32_t)now_ms());
	if (lost)
		blobmsg_add_u64(b, "lost", lost);
	if (last_error[0])
		blobmsg_add_string(b, "error", last_error);
	if (to > from) {
		char *d = blobmsg_alloc_string_buffer(b, "data", B64_ENCODE_LEN(to - from));

		b64_encode(ring + from, to - from, d, B64_ENCODE_LEN(to - from));
		blobmsg_add_string_buffer(b);
	}
}

/* ---------- the adapter ---------- */

static void set_state(enum state s)
{
	if (s == state)
		return;
	state = s;
	if (s == ST_LISTENING) {
		listening_at = now_ms();
		heard = 0;
	}
	/* Whoever waits for records is told of a change at once */
	waiters_answer(s != ST_STARTING && s != ST_LISTENING);
}

/* The socket shut; the kernel's adapter put down, if this brought it up */
static void adapter_close(void)
{
	uloop_timeout_cancel(&cmd_t);
	uloop_timeout_cancel(&probe_t);
	uloop_timeout_cancel(&search_t);
	step = S_NONE;
	stopping = false;
	inquiring = naming = false;
	if (hfd >= 0) {
		uloop_fd_delete(&hufd);
		close(hfd);
		hfd = -1;
	}
	if (is_up && !opt_dev) {
		int s = socket(AF_BLUETOOTH, SOCK_RAW | SOCK_CLOEXEC, BTPROTO_HCI);

		if (s >= 0) {
			ioctl(s, HCIDEVDOWN, dev_id);
			close(s);
		}
	}
	is_up = false;
	ring_clear();
	/* (with the records go the names in them: whoever asks next is told
	 * them afresh) */
	memset(seen, 0, sizeof(seen));
}

static void fail(const char *fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vsnprintf(last_error, sizeof(last_error), fmt, ap);
	va_end(ap);
	logmsg("hci%d: %s", dev_id, last_error);
	adapter_close();
	failed_at = now_ms();
	set_state(ST_FAILED);
}

static bool hci_cmd(enum step next, uint16_t op, const void *p, uint8_t n)
{
	uint8_t pkt[4 + 255];

	pkt[0] = HCI_COMMAND_PKT;
	pkt[1] = op & 0xff;
	pkt[2] = op >> 8;
	pkt[3] = n;
	if (n)
		memcpy(pkt + 4, p, n);
	if (write(hfd, pkt, 4 + n) != 4 + n) {
		fail("the adapter took no command: %s", strerror(errno));
		return false;
	}
	step = next;
	uloop_timeout_set(&cmd_t, step == S_STOP ? STOP_MS : CMD_MS);
	return true;
}

static uint16_t step_op(void)
{
	switch (step) {
	case S_VERSION:
		return OP_READ_LOCAL_VERSION;
	case S_ADDRESS:
	case S_PROBE:
		return OP_READ_BD_ADDR;
	case S_PARAMS:
		return OP_LE_SET_SCAN_PARAM;
	case S_QUIET:
	case S_ENABLE:
		return OP_LE_SET_SCAN_ENABLE;
	case S_XPARAMS:
		return OP_LE_SET_EXT_SCAN_PARAM;
	case S_XQUIET:
	case S_XENABLE:
		return OP_LE_SET_EXT_SCAN_ENABLE;
	case S_INQUIRY:
		return OP_INQUIRY;
	case S_NAME:
		return OP_REMOTE_NAME_REQ;
	case S_STOP:
		return is_classic() ? OP_INQUIRY_CANCEL : extended ? OP_LE_SET_EXT_SCAN_ENABLE : OP_LE_SET_SCAN_ENABLE;
	default:
		return 0;
	}
}

/* The scan on or off, with the commands in use */
static bool scan_enable(enum step next, bool ext, bool on)
{
	/* enable; duplicates not filtered (every advertisement is wanted: how
	 * strong it is tells how near); and, extended, no duration and no period */
	uint8_t p[6] = { on, 0, 0, 0, 0, 0 };

	return hci_cmd(next, ext ? OP_LE_SET_EXT_SCAN_ENABLE : OP_LE_SET_SCAN_ENABLE, p, ext ? 6 : 2);
}

static bool scan_params(bool ext)
{
	/* Passive (type 0), from the adapter's public address, anything heard */
	uint8_t leg[7] = { 0, SCAN_INTERVAL & 0xff, SCAN_INTERVAL >> 8, SCAN_INTERVAL & 0xff, SCAN_INTERVAL >> 8, 0, 0 };
	/* The same, on the 1M PHY (the one the advertising channels are heard on) */
	uint8_t x[8] = { 0, 0, 0x01, 0, SCAN_INTERVAL & 0xff, SCAN_INTERVAL >> 8, SCAN_INTERVAL & 0xff, SCAN_INTERVAL >> 8 };

	return ext ? hci_cmd(S_XPARAMS, OP_LE_SET_EXT_SCAN_PARAM, x, sizeof(x)) :
		hci_cmd(S_PARAMS, OP_LE_SET_SCAN_PARAM, leg, sizeof(leg));
}

static void listening(bool ext)
{
	extended = ext;
	step = S_NONE;
	logmsg("hci%d: listening (a passive scan%s)", dev_id, ext ? ", extended" : "");
	uloop_timeout_set(&probe_t, PROBE_MS);
	set_state(ST_LISTENING);
}

/* ---------- the older way: an adapter with no Low Energy ---------- */

/* A device an inquiry found, kept for its name; one more, if asked to add */
static struct seen *seen_at(const uint8_t *addr, bool add)
{
	int i, spare = -1, oldest = 0;

	for (i = 0; i < SEEN; i++) {
		if (seen[i].used && !memcmp(seen[i].addr, addr, 6))
			return &seen[i];
		if (!seen[i].used && spare < 0)
			spare = i;
		if (seen[i].round < seen[oldest].round)
			oldest = i;
	}
	if (!add)
		return NULL;
	/* No room: the one not found for longest makes it */
	if (spare < 0)
		spare = oldest;
	memset(&seen[spare], 0, sizeof(seen[spare]));
	seen[spare].used = true;
	memcpy(seen[spare].addr, addr, 6);
	return &seen[spare];
}

/* Is a device's whole name in what it says of itself (its extended
 * inquiry response: structures of a length, a type and data, as in an
 * advertisement; the whole name is type 0x09)? */
static bool eir_named(const uint8_t *d, size_t n)
{
	size_t o = 0;

	while (o + 1 < n && d[o] && o + 1 + d[o] <= n) {
		if (d[o + 1] == 0x09)
			return true;
		o += 1 + d[o];
	}
	return false;
}

/* What an inquiry found: an Inquiry Result event's parameters, which are
 * how many devices and then for each its address, how it listens for a
 * page, its class and how far its clock is off, 14 bytes; the later forms
 * have how strong it was in them as well (14 bytes too, or 15 from early
 * adapters that kept a byte the plain form has), and the last form what
 * the device says of itself, 240 bytes more. Each device is noted, with
 * what asking its name takes */
static void found(uint8_t evt, const uint8_t *p, size_t n)
{
	size_t each, o, clock_at;
	int i;

	if (n < 15 || !p[0])
		return;
	each = (n - 1) / p[0];
	if (each < 14)
		return;
	clock_at = evt == EVT_INQUIRY_RESULT || each == 15 ? 12 : 11;
	for (i = 0, o = 1; i < p[0] && o + each <= n; i++, o += each) {
		struct seen *s = seen_at(p + o, true);

		s->psrm = p[o + 6];
		s->clock = p[o + clock_at] | p[o + clock_at + 1] << 8;
		s->round = round_no;
		/* (its name is in this very record, the next to be numbered) */
		if (evt == EVT_INQUIRY_EXTENDED && each > 14 && eir_named(p + o + 14, each - 14)) {
			s->named = true;
			s->name_seq = seq_next;
		}
	}
}

/* An inquiry: of anybody (the general inquiry access code, 0x9e8b33), for
 * INQUIRY_UNITS x 1.28 s, as many answers as come */
static void search_begin(void)
{
	static const uint8_t p[5] = { 0x33, 0x8b, 0x9e, INQUIRY_UNITS, 0 };

	round_no++;
	names_asked = 0;
	hci_cmd(S_INQUIRY, OP_INQUIRY, p, sizeof(p));
}

/* The next device this inquiry found whose name is not known is asked for
 * it: its address, how it listens for a page, and how far its clock is off
 * (measured: bit 15). One that does not answer is asked twice at most */
static bool name_ask(void)
{
	uint8_t p[10];
	int i;

	if (names_asked >= NAMES_A_ROUND)
		return false;
	for (i = 0; i < SEEN; i++)
		if (seen[i].used && seen[i].round == round_no && seen[i].tries < 2 &&
		    (!seen[i].named || seen[i].name_seq < seq_first))
			break;
	if (i == SEEN)
		return false;
	seen[i].tries++;
	names_asked++;
	memcpy(naming_addr, seen[i].addr, 6);
	memcpy(p, seen[i].addr, 6);
	p[6] = seen[i].psrm;
	p[7] = 0;
	p[8] = seen[i].clock & 0xff;
	p[9] = seen[i].clock >> 8 | 0x80;
	return hci_cmd(S_NAME, OP_REMOTE_NAME_REQ, p, sizeof(p));
}

/* An inquiry has ended, or a name has come or will not: the next name,
 * or after a pause the next inquiry */
static void search_on(void)
{
	if (state != ST_LISTENING || stopping)
		return;
	if (name_ask() || state != ST_LISTENING)
		return;
	uloop_timeout_set(&search_t, GAP_MS);
}

/* The pause is over; or what was under way has not ended in its time */
static void search_cb(struct uloop_timeout *t)
{
	(void)t;
	if (state != ST_LISTENING || stopping)
		return;
	if (inquiring) {
		fail("the adapter stopped answering (an inquiry did not end)");
	} else if (naming) {
		/* (the name never came: the next) */
		naming = false;
		search_on();
	} else {
		search_begin();
	}
}

static void searching(void)
{
	step = S_NONE;
	inquiring = naming = false;
	searches = 0;
	logmsg("hci%d: searching (inquiries: an adapter from before Low Energy)", dev_id);
	set_state(ST_LISTENING);
	search_begin();
}

/* The answer to the command that was out: its status and what came with it */
static void cmd_done(uint8_t status, const uint8_t *p, size_t n)
{
	enum step was = step;

	uloop_timeout_cancel(&cmd_t);
	step = S_NONE;
	switch (was) {
	case S_VERSION:
		if (!status && n >= 8) {
			hci_ver = p[0];
			hci_rev = p[1] | p[2] << 8;
			lmp_ver = p[3];
			maker = p[4] | p[5] << 8;
			lmp_subver = p[6] | p[7] << 8;
			have_version = true;
		}
		hci_cmd(S_ADDRESS, OP_READ_BD_ADDR, NULL, 0);
		break;
	case S_ADDRESS:
		if (!status && n >= 6)
			snprintf(address, sizeof(address), "%02X:%02X:%02X:%02X:%02X:%02X",
				 p[5], p[4], p[3], p[2], p[1], p[0]);
		/* From before Bluetooth 4.0: no Low Energy to listen to, so what is
		 * about is found by asking */
		if (is_classic()) {
			searching();
			break;
		}
		/* A scan left running (by whoever had the adapter up before) would
		 * refuse new settings: off first, whatever that answers */
		scan_enable(S_QUIET, false, false);
		break;
	case S_QUIET:
		scan_params(false);
		break;
	case S_PARAMS:
		if (!status) {
			scan_enable(S_ENABLE, false, true);
			break;
		}
		/* Refused: a Bluetooth 5 adapter that the kernel has set up with
		 * the extended commands takes only those from then on */
		legacy_status = status;
		scan_enable(S_XQUIET, true, false);
		break;
	case S_ENABLE:
		if (status)
			fail("the adapter would not listen (scan enable: HCI status 0x%02x)", status);
		else
			listening(false);
		break;
	case S_XQUIET:
		scan_params(true);
		break;
	case S_XPARAMS:
		if (!status)
			scan_enable(S_XENABLE, true, true);
		else
			fail("the adapter would not listen (scan settings: HCI status 0x%02x, extended 0x%02x)",
			     legacy_status, status);
		break;
	case S_XENABLE:
		if (status)
			fail("the adapter would not listen (extended scan enable: HCI status 0x%02x)", status);
		else
			listening(true);
		break;
	case S_INQUIRY:
		if (status) {
			fail("the adapter would not search (inquiry: HCI status 0x%02x)", status);
		} else {
			inquiring = true;
			uloop_timeout_set(&search_t, INQUIRY_MS);
		}
		break;
	case S_NAME:
		if (status) {
			/* (not asked after all: the next) */
			search_on();
		} else {
			naming = true;
			uloop_timeout_set(&search_t, NAME_MS);
		}
		break;
	case S_PROBE:
		uloop_timeout_set(&probe_t, PROBE_MS);
		break;
	case S_STOP:
		adapter_close();
		set_state(ST_IDLE);
		break;
	default:
		break;
	}
}

static void cmd_timeout(struct uloop_timeout *t)
{
	(void)t;
	if (step == S_STOP) {
		adapter_close();
		set_state(ST_IDLE);
	} else if (step == S_PROBE) {
		fail("the adapter stopped answering");
	} else if (step != S_NONE) {
		fail("the adapter did not answer (HCI command 0x%04x)", step_op());
	}
}

static void probe_cb(struct uloop_timeout *t)
{
	(void)t;
	if (state == ST_LISTENING && step == S_NONE)
		hci_cmd(S_PROBE, OP_READ_BD_ADDR, NULL, 0);
}

/* What it heard is passed on within FLUSH_MS, in one answer */
static void flush_cb(struct uloop_timeout *t)
{
	(void)t;
	waiters_answer(false);
}

static void on_packet(const uint8_t *p, size_t n)
{
	uint8_t evt;

	if (n < 3 || p[0] != HCI_EVENT_PKT)
		return;
	evt = p[1];
	p += 3;
	n -= 3;
	switch (evt) {
	case EVT_CMD_COMPLETE:
		/* commands it takes now, the command's opcode, what it returns: a status first */
		if (n >= 4 && step != S_NONE && (p[1] | p[2] << 8) == step_op())
			cmd_done(p[3], p + 4, n - 4);
		break;
	case EVT_CMD_STATUS:
		/* status, commands it takes now, opcode: a command refused before it
		 * began; or, of an inquiry or a name asked for, that it has begun
		 * (what comes of those comes later, as events of their own) */
		if (n >= 4 && step != S_NONE && (p[2] | p[3] << 8) == step_op() &&
		    (p[0] || step == S_INQUIRY || step == S_NAME))
			cmd_done(p[0], NULL, 0);
		break;
	case EVT_HARDWARE_ERROR:
		fail("the adapter reported a hardware error (0x%02x)", n ? p[0] : 0);
		break;
	case EVT_LE_META:
		if (state != ST_LISTENING || stopping || !n)
			break;
		if (p[0] != LE_ADV_REPORT && p[0] != LE_DIRECT_ADV_REPORT && p[0] != LE_EXT_ADV_REPORT)
			break;
		ring_add(evt, p, n);
		if (!flush_t.pending)
			uloop_timeout_set(&flush_t, FLUSH_MS);
		break;
	case EVT_INQUIRY_RESULT:
	case EVT_INQUIRY_RSSI:
	case EVT_INQUIRY_EXTENDED:
		if (state != ST_LISTENING || !is_classic() || stopping || !n)
			break;
		found(evt, p, n);
		ring_add(evt, p, n);
		if (!flush_t.pending)
			uloop_timeout_set(&flush_t, FLUSH_MS);
		break;
	case EVT_INQUIRY_COMPLETE:
		if (state != ST_LISTENING || !is_classic() || !inquiring || stopping)
			break;
		inquiring = false;
		searches++;
		uloop_timeout_cancel(&search_t);
		/* (to the page as well: it tells it what was not found this time) */
		ring_add(evt, p, n);
		if (!flush_t.pending)
			uloop_timeout_set(&flush_t, FLUSH_MS);
		search_on();
		break;
	case EVT_REMOTE_NAME: {
		/* status, the address, the name: 248 bytes, ended by a zero where
		 * it is shorter, and passed on without what is after it */
		struct seen *s;
		size_t len = 7;

		if (state != ST_LISTENING || !is_classic() || stopping || n < 7)
			break;
		while (len < n && p[len])
			len++;
		ring_add(evt, p, len);
		if (!flush_t.pending)
			uloop_timeout_set(&flush_t, FLUSH_MS);
		s = seen_at(p + 1, false);
		if (s && !p[0]) {
			s->named = true;
			s->name_seq = seq_next - 1;
			s->tries = 0;
		}
		if (naming && !memcmp(p + 1, naming_addr, 6)) {
			naming = false;
			uloop_timeout_cancel(&search_t);
			search_on();
		}
		break;
	}
	}
}

/* The adapter went away under a socket that was open on it */
static void adapter_lost(void)
{
	if (state == ST_ABSENT)
		return;
	logmsg("hci%d: gone", dev_id);
	is_up = false;          /* (there is nothing left to put down) */
	adapter_close();
	last_error[0] = 0;
	set_state(ST_ABSENT);
}

static void hci_cb(struct uloop_fd *u, unsigned int events)
{
	uint8_t p[1024];
	ssize_t r;

	if (hfd < 0)
		return;
	if (events & ULOOP_READ) {
		for (;;) {
			r = read(hfd, p, sizeof(p));
			if (r > 0) {
				on_packet(p, r);
				if (hfd < 0)
					return;
				continue;
			}
			if (r < 0 && errno == EINTR)
				continue;
			if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
				break;
			adapter_lost();
			return;
		}
	}
	if (u->eof || u->error)
		adapter_lost();
}

/* The adapter is up: a socket on it, and what it is asked first */
static void adapter_open(void)
{
	if (opt_dev) {
		struct sockaddr_un a = { .sun_family = AF_UNIX };

		hfd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
		snprintf(a.sun_path, sizeof(a.sun_path), "%s", opt_dev);
		if (hfd < 0 || connect(hfd, (struct sockaddr *)&a, sizeof(a)) < 0) {
			fail("the adapter would not open: %s", strerror(errno));
			return;
		}
		fcntl(hfd, F_SETFL, fcntl(hfd, F_GETFL) | O_NONBLOCK);
	} else {
		struct sockaddr_hci a = { .hci_family = AF_BLUETOOTH, .hci_dev = dev_id };
		struct hci_filter f = { 0 };

		/* Events only, and of those the answers to commands, a hardware
		 * error, what Low Energy reports, and what the older way's inquiries
		 * and name requests bring */
		f.type_mask = 1u << HCI_EVENT_PKT;
		f.event_mask[0] = 1u << EVT_CMD_COMPLETE | 1u << EVT_CMD_STATUS | 1u << EVT_HARDWARE_ERROR |
				  1u << EVT_INQUIRY_COMPLETE | 1u << EVT_INQUIRY_RESULT | 1u << EVT_REMOTE_NAME;
		f.event_mask[1] = 1u << (EVT_LE_META - 32) | 1u << (EVT_INQUIRY_RSSI - 32) |
				  1u << (EVT_INQUIRY_EXTENDED - 32);
		hfd = socket(AF_BLUETOOTH, SOCK_RAW | SOCK_CLOEXEC | SOCK_NONBLOCK, BTPROTO_HCI);
		if (hfd < 0 || setsockopt(hfd, SOL_HCI, HCI_FILTER, &f, sizeof(f)) < 0 ||
		    bind(hfd, (struct sockaddr *)&a, sizeof(a)) < 0) {
			fail("the adapter would not open: %s", strerror(errno));
			return;
		}
	}
	hufd.fd = hfd;
	hufd.cb = hci_cb;
	uloop_fd_add(&hufd, ULOOP_READ);
	hci_cmd(S_VERSION, OP_READ_LOCAL_VERSION, NULL, 0);
}

/* The kernel has brought the adapter up, or has not */
static void up_done(struct uloop_process *c, int ret)
{
	int e = WIFEXITED(ret) ? WEXITSTATUS(ret) : -1;

	(void)c;
	up_pending = false;
	uloop_timeout_cancel(&up_t);
	if (state != ST_STARTING)
		return;
	if (e < 0)
		fail("the adapter would not start: the kernel did not answer");
	else if (e)
		fail("the adapter would not start: %s", strerror(e));
	else {
		is_up = true;
		adapter_open();
	}
}

static void up_timeout(struct uloop_timeout *t)
{
	(void)t;
	if (up_pending)
		kill(up_proc.pid, SIGKILL);
}

/* Somebody wants to know what it hears: the adapter up and scanning */
static void adapter_begin(void)
{
	pid_t pid;

	/* (The kernel is still at an earlier start, of an adapter that went
	 * away meanwhile: the next one who asks) */
	if (up_pending)
		return;
	last_error[0] = 0;
	set_state(ST_STARTING);
	if (opt_dev) {
		is_up = true;
		adapter_open();
		return;
	}
	/* HCIDEVUP returns once the kernel has set the adapter up, which takes
	 * a second or so (and ten for one that does not answer): not here */
	pid = fork();
	if (pid < 0) {
		fail("the adapter would not start: %s", strerror(errno));
		return;
	}
	if (!pid) {
		int s = socket(AF_BLUETOOTH, SOCK_RAW | SOCK_CLOEXEC, BTPROTO_HCI), e = 0;

		if (s < 0 || (ioctl(s, HCIDEVUP, dev_id) < 0 && errno != EALREADY))
			e = errno > 0 && errno < 255 ? errno : 255;
		_exit(e);
	}
	up_pending = true;
	up_proc.pid = pid;
	up_proc.cb = up_done;
	uloop_process_add(&up_proc);
	uloop_timeout_set(&up_t, UP_MS);
}

/* Nobody has asked for a while: the scan off, then the adapter down */
static void idle_cb(struct uloop_timeout *t)
{
	if (state == ST_LISTENING && step != S_NONE && step != S_STOP) {
		/* (the answer to the command that is out first) */
		uloop_timeout_set(t, 200);
	} else if (state == ST_LISTENING && !stopping) {
		logmsg("hci%d: nobody is listening: stopped", dev_id);
		stopping = true;
		uloop_timeout_cancel(&probe_t);
		uloop_timeout_cancel(&search_t);
		if (!is_classic()) {
			scan_enable(S_STOP, extended, false);
		} else if (inquiring) {
			hci_cmd(S_STOP, OP_INQUIRY_CANCEL, NULL, 0);
		} else {
			/* (a name that was asked for is let go with the adapter) */
			adapter_close();
			set_state(ST_IDLE);
		}
	} else if (state == ST_STARTING) {
		/* (once it has started) */
		uloop_timeout_set(t, 1000);
	}
}

/* "reports" was asked: that is what keeps it listening */
static void wanted(void)
{
	uloop_timeout_set(&idle_t, opt_idle);
	if (state == ST_IDLE || (state == ST_FAILED && now_ms() - failed_at >= RETRY_MS))
		adapter_begin();
}

/* ---------- finding the adapter ---------- */

static bool read_line(const char *path, char *s, size_t n)
{
	FILE *f = fopen(path, "r");

	s[0] = 0;
	if (!f)
		return false;
	if (!fgets(s, n, f))
		s[0] = 0;
	fclose(f);
	s[strcspn(s, "\r\n")] = 0;
	return true;
}

/* The first adapter the kernel has: hci<N> in class/bluetooth (a name with
 * more to it, hci0:256, is a connection) */
static int find_adapter(void)
{
	char d[512];
	struct dirent *e;
	int found = -1;
	DIR *dir;

	snprintf(d, sizeof(d), "%s/class/bluetooth", opt_sysfs);
	dir = opendir(d);
	if (!dir)
		return -1;
	while ((e = readdir(dir))) {
		char *end;
		long n;

		if (strncmp(e->d_name, "hci", 3) || !e->d_name[3])
			continue;
		n = strtol(e->d_name + 3, &end, 10);
		if (*end || n < 0 || n > 0xfffe)
			continue;
		if (found < 0 || n < found)
			found = n;
	}
	closedir(dir);
	return found;
}

/* What the USB device at <dir> says it is */
static void usb_identity(const char *dir)
{
	char p[600], v[16], q[16];

	usb_id[0] = usb_bcd[0] = usb_product[0] = usb_maker[0] = 0;
	snprintf(p, sizeof(p), "%s/idVendor", dir);
	if (!read_line(p, v, sizeof(v)) || !v[0])
		return;
	snprintf(p, sizeof(p), "%s/idProduct", dir);
	read_line(p, q, sizeof(q));
	snprintf(usb_id, sizeof(usb_id), "%.4s:%.4s", v, q);
	snprintf(p, sizeof(p), "%s/bcdDevice", dir);
	read_line(p, usb_bcd, sizeof(usb_bcd));
	snprintf(p, sizeof(p), "%s/product", dir);
	read_line(p, usb_product, sizeof(usb_product));
	snprintf(p, sizeof(p), "%s/manufacturer", dir);
	read_line(p, usb_maker, sizeof(usb_maker));
}

static bool usb_class_is(const char *dir, const char *what, const char *cls, const char *sub, const char *proto)
{
	char p[600], v[16];

	snprintf(p, sizeof(p), "%s/b%sClass", dir, what);
	if (!read_line(p, v, sizeof(v)) || strcasecmp(v, cls))
		return false;
	snprintf(p, sizeof(p), "%s/b%sSubClass", dir, what);
	if (!read_line(p, v, sizeof(v)) || strcasecmp(v, sub))
		return false;
	snprintf(p, sizeof(p), "%s/b%sProtocol", dir, what);
	return read_line(p, v, sizeof(v)) && !strcasecmp(v, proto);
}

/* A Bluetooth dongle on USB (class e0, subclass 01, protocol 01: a radio
 * that speaks HCI) of which the kernel has made no adapter: said, since the
 * page would otherwise only say that there is none */
static void dongle_without_driver(void)
{
	char d[512];
	struct dirent *e;
	bool found = false;
	DIR *dir;

	last_error[0] = 0;
	snprintf(d, sizeof(d), "%s/bus/usb/devices", opt_sysfs);
	dir = opendir(d);
	if (!dir)
		return;
	while (!found && (e = readdir(dir))) {
		if (e->d_name[0] == '.')
			continue;
		snprintf(d, sizeof(d), "%s/bus/usb/devices/%s", opt_sysfs, e->d_name);
		if (usb_class_is(d, "Device", "e0", "01", "01")) {
			found = true;
		} else if (usb_class_is(d, "Interface", "e0", "01", "01")) {
			/* (an interface: the device is the folder it is in) */
			snprintf(d, sizeof(d), "%s/bus/usb/devices/%s/..", opt_sysfs, e->d_name);
			found = true;
		}
	}
	closedir(dir);
	if (!found)
		return;
	usb_identity(d);
	snprintf(last_error, sizeof(last_error), "a Bluetooth dongle is plugged in (%s%s%s), but the kernel has made "
		 "no adapter of it: this firmware may be without the Bluetooth driver (kmod-btusb)",
		 usb_id, usb_product[0] ? " " : "", usb_product);
}

static void present_cb(struct uloop_timeout *t)
{
	int id = find_adapter();
	char d[512];

	if (id < 0 || (state != ST_ABSENT && id != dev_id)) {
		/* None, or another than the one that was there */
		adapter_lost();
		if (id < 0)
			dongle_without_driver();
	}
	if (id >= 0 && state == ST_ABSENT) {
		dev_id = id;
		address[0] = 0;
		have_version = false;
		last_error[0] = 0;
		snprintf(d, sizeof(d), "%s/class/bluetooth/hci%d/device/..", opt_sysfs, id);
		usb_identity(d);
		if (usb_id[0])
			logmsg("hci%d: an adapter on USB: %s %s (version %s)", id, usb_id, usb_product, usb_bcd);
		else
			logmsg("hci%d: an adapter", id);
		set_state(ST_IDLE);
	}
	uloop_timeout_set(t, PRESENT_MS);
}

/* ---------- ubus ---------- */

static void send_reply(struct ubus_request_data *req, struct blob_buf *b)
{
	ubus_send_reply(UBUS, req, b->head);
	ubus_complete_deferred_request(UBUS, req, 0);
}

static void waiter_reply(struct waiter *w)
{
	struct blob_buf b = { 0 };

	blob_buf_init(&b, 0);
	reports_fill(&b, w->has_seq, w->seq);
	send_reply(&w->req, &b);
	blob_buf_free(&b);
	uloop_timeout_cancel(&w->t);
	w->used = false;
}

/* Those who wait and have something to take; all of them, when the state is
 * what they are to be told */
static void waiters_answer(bool all)
{
	int i;

	for (i = 0; i < MAX_WAITERS; i++)
		if (waiters[i].used && (all || ring_has(waiters[i].has_seq, waiters[i].seq)))
			waiter_reply(&waiters[i]);
}

static void waiter_timeout(struct uloop_timeout *t)
{
	waiter_reply(container_of(t, struct waiter, t));
}

/* A number that may come as a string, or as any of ubus's number types */
static bool arg_num(struct blob_attr *a, int64_t *v)
{
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

static int m_status(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		    const char *method, struct blob_attr *msg)
{
	char name[16];

	(void)obj; (void)method; (void)msg;
	blob_buf_init(&rb, 0);
	blobmsg_add_string(&rb, "state", state_name());
	if (last_error[0])
		blobmsg_add_string(&rb, "error", last_error);
	if (state != ST_ABSENT) {
		snprintf(name, sizeof(name), "hci%d", dev_id);
		blobmsg_add_string(&rb, "adapter", name);
		if (usb_id[0])
			blobmsg_add_string(&rb, "usb", usb_id);
		if (usb_bcd[0])
			blobmsg_add_string(&rb, "usb_version", usb_bcd);
		if (usb_product[0])
			blobmsg_add_string(&rb, "product", usb_product);
		if (usb_maker[0])
			blobmsg_add_string(&rb, "usb_maker", usb_maker);
		if (address[0])
			blobmsg_add_string(&rb, "address", address);
		if (have_version) {
			blobmsg_add_u32(&rb, "hci_version", hci_ver);
			blobmsg_add_u32(&rb, "hci_revision", hci_rev);
			blobmsg_add_u32(&rb, "lmp_version", lmp_ver);
			blobmsg_add_u32(&rb, "lmp_subversion", lmp_subver);
			blobmsg_add_u32(&rb, "maker", maker);
			if (is_classic())
				blobmsg_add_u8(&rb, "classic", 1);
		}
	}
	if (state == ST_LISTENING) {
		if (is_classic()) {
			blobmsg_add_u8(&rb, "inquiring", inquiring);
			blobmsg_add_u32(&rb, "searches", searches);
		} else {
			blobmsg_add_u8(&rb, "extended", extended);
		}
		blobmsg_add_u64(&rb, "heard", heard);
		blobmsg_add_u64(&rb, "listening_ms", now_ms() - listening_at);
	}
	ubus_send_reply(c, req, rb.head);
	return UBUS_STATUS_OK;
}

static const struct blobmsg_policy p_reports[] = { { "seq", BLOBMSG_TYPE_UNSPEC } };

static int m_reports(struct ubus_context *c, struct ubus_object *obj, struct ubus_request_data *req,
		     const char *method, struct blob_attr *msg)
{
	struct blob_attr *tb[1];
	bool has_seq;
	int64_t seq = 0;
	int i;

	(void)obj; (void)method;
	blobmsg_parse(p_reports, 1, tb, blob_data(msg), blob_len(msg));
	has_seq = arg_num(tb[0], &seq) && seq >= 0;
	wanted();
	/* Something to wait for, nothing to say yet, and room to wait in */
	if ((state == ST_STARTING || state == ST_LISTENING) && !ring_has(has_seq, seq)) {
		for (i = 0; i < MAX_WAITERS; i++)
			if (!waiters[i].used)
				break;
		if (i < MAX_WAITERS) {
			struct waiter *w = &waiters[i];

			w->used = true;
			w->has_seq = has_seq;
			w->seq = seq;
			ubus_defer_request(c, req, &w->req);
			uloop_timeout_set(&w->t, WAIT_MS);
			return UBUS_STATUS_OK;
		}
	}
	blob_buf_init(&rb, 0);
	reports_fill(&rb, has_seq, seq);
	ubus_send_reply(c, req, rb.head);
	return UBUS_STATUS_OK;
}

/* What `ubus -v list` shows */
static const struct blobmsg_policy p_reports_shown[] = { { "seq", BLOBMSG_TYPE_INT32 } };

static const struct ubus_method methods[] = {
	UBUS_METHOD_NOARG("status", m_status),
	UBUS_METHOD("reports", m_reports, p_reports_shown),
};

static struct ubus_object_type obj_type = UBUS_OBJECT_TYPE("pirate.bluetooth", methods);

static struct ubus_object obj = {
	.name = "pirate.bluetooth",
	.type = &obj_type,
	.methods = methods,
	.n_methods = ARRAY_SIZE(methods),
};

static void on_connect(struct ubus_context *c)
{
	int r = ubus_add_object(c, &obj);

	if (r)
		logmsg("can't add pirate.bluetooth to ubus: %s", ubus_strerror(r));
}

static void usage(void)
{
	fprintf(stderr, "usage: pirate-bluetooth [-d socket] [-s sysfs] [-u ubus-socket] [-i idle-ms]\n");
	exit(2);
}

int main(int argc, char **argv)
{
	int c, i;

	while ((c = getopt(argc, argv, "d:s:u:i:")) != -1) {
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
		case 'i':
			opt_idle = atoi(optarg);
			if (opt_idle < 500)
				usage();
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
	present_t.cb = present_cb;
	up_t.cb = up_timeout;
	cmd_t.cb = cmd_timeout;
	probe_t.cb = probe_cb;
	idle_t.cb = idle_cb;
	flush_t.cb = flush_cb;
	search_t.cb = search_cb;
	for (i = 0; i < MAX_WAITERS; i++)
		waiters[i].t.cb = waiter_timeout;
	conn.cb = on_connect;
	ubus_auto_connect(&conn);
	uloop_timeout_set(&present_t, 0);
	uloop_run();
	/* Left as it was found: the scan off (or the inquiry that is out
	 * called off), the adapter down */
	if (hfd >= 0 && state == ST_LISTENING && (!is_classic() || inquiring)) {
		uint8_t off[4 + 6] = { HCI_COMMAND_PKT, 0, 0, 0 };
		uint16_t op = is_classic() ? OP_INQUIRY_CANCEL : extended ? OP_LE_SET_EXT_SCAN_ENABLE : OP_LE_SET_SCAN_ENABLE;

		off[1] = op & 0xff;
		off[2] = op >> 8;
		off[3] = is_classic() ? 0 : extended ? 6 : 2;
		if (write(hfd, off, 4 + off[3]) > 0)
			usleep(100000);
	}
	adapter_close();
	uloop_done();
	return 0;
}
