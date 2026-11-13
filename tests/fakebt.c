/*
 * fakebt: a Bluetooth adapter as pirate-bluetooth sees one through the
 * kernel's HCI socket, on a Unix socket (SOCK_SEQPACKET: an HCI packet a
 * message, led by its type), for testing pirate-bluetooth without a dongle.
 * It answers the few HCI commands pirate-bluetooth has, and while its scan
 * is on it reports the advertising of three devices, one every 100 ms. As
 * an adapter from before Low Energy (-o) it takes inquiries instead, each
 * of which finds three other devices and is over in 300 ms, and tells the
 * name of the one that has one to tell.
 *
 *   fakebt -l socket [-c fifo] [-n] [-x] [-o] [-q]
 *
 *   -l  the socket it listens on
 *   -c  a FIFO: "adv <hex>" makes it report an advertisement with these
 *       bytes for its data, from AA:BB:CC:DD:EE:FF at -60 dBm (while it
 *       scans); "many <n>" n of its own at once; "error" a hardware error;
 *       "slow": its inquiries take a minute from now on (and it says
 *       "slow"); "quit" ends it
 *   -n  nobody advertises by themselves: it reports only what the FIFO says
 *   -x  a Bluetooth 5 adapter as the kernel leaves one: the scan commands
 *       every LE adapter has are refused (Command Disallowed), the extended
 *       ones taken, and what it hears comes as extended advertising reports
 *   -o  one from before Bluetooth 4.0: it knows no Low Energy command, and
 *       takes inquiries and name requests
 *   -q  one that answers nothing
 *
 * Prints an event a line to stdout: "open", "close", "version", "address",
 * "scan on passive" ("active"; "filtered" after it when duplicates are to
 * be left out), "scan off", "xscan on passive", "xscan off", "refused
 * <opcode>", "unknown <opcode>"; and of the older way "inquiry <how long,
 * x 1.28 s>", "inquiry over", "inquiry cancel", and "name <address> psrm
 * <how it listens for a page> clock <its offset, as it was sent>".
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define TICK_MS 100

static int lfd = -1, cfd = -1, ffd = -1;
static bool opt_n, opt_x, opt_old, opt_q;
static bool scanning, active;
static unsigned turn;
/* (the older way: an inquiry is out, and what it finds has been said; when
 * it is over; when the name that was asked for is due, and whose) */
static bool inquiring, inq_said;
static int64_t inq_end, name_due, inq_ms = 300;
static uint8_t name_addr[6];

/* Three devices that advertise: who (address type, address as it is sent,
 * lowest byte first), how (the advertising PDU: 0 can be connected to, 3
 * cannot), how strong, and the data */
struct cast {
	uint8_t addr_type, addr[6], pdu;
	int8_t rssi;
	const char *data;
};
static const struct cast CAST[] = {
	/* A thermometer with a name: flags, a service (0x181a), its name */
	{ 0, { 0x55, 0x44, 0x33, 0x22, 0x11, 0x00 }, 0, -48,
	  "020106" "03031a18" "0b09" "50697261746554656d70" },
	/* An iBeacon: flags, Apple's data, type 2 */
	{ 1, { 0x01, 0x02, 0x03, 0x04, 0x05, 0xc6 }, 3, -71,
	  "020106" "1aff4c000215" "f7826da64fa24e988024bc5b71e0893e" "0001" "0002" "c5" },
	/* What a lost tracker of Apple's network sends: Apple's data, type 0x12 */
	{ 1, { 0x0f, 0x0e, 0x0d, 0x0c, 0x0b, 0xea }, 0, -83,
	  "1eff4c001219" "10" "a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6" "0100" },
};
#define NCAST (sizeof(CAST) / sizeof(CAST[0]))

static void say(const char *fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vprintf(fmt, ap);
	va_end(ap);
	putchar('\n');
	fflush(stdout);
}

static int64_t now_ms(void)
{
	struct timespec t;

	clock_gettime(CLOCK_MONOTONIC, &t);
	return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static size_t unhex(const char *s, uint8_t *out, size_t max)
{
	size_t n = 0;
	unsigned v;

	while (n < max && s[0] && s[1] && sscanf(s, "%2x", &v) == 1) {
		out[n++] = v;
		s += 2;
	}
	return n;
}

/* ---------- what it sends ---------- */

static void send_evt(uint8_t evt, const uint8_t *p, size_t n)
{
	uint8_t pkt[3 + 255];

	if (cfd < 0 || n > 255)
		return;
	pkt[0] = 0x04;
	pkt[1] = evt;
	pkt[2] = n;
	memcpy(pkt + 3, p, n);
	if (send(cfd, pkt, 3 + n, MSG_NOSIGNAL) < 0 && errno != EAGAIN)
		perror("fakebt: send");
}

/* Command Complete: one more command may come, the command's opcode, what
 * it returns (a status first) */
static void complete(uint16_t op, const uint8_t *ret, size_t n)
{
	uint8_t p[3 + 64];

	p[0] = 1;
	p[1] = op & 0xff;
	p[2] = op >> 8;
	memcpy(p + 3, ret, n);
	send_evt(0x0e, p, 3 + n);
}

static void done(uint16_t op, uint8_t status)
{
	complete(op, &status, 1);
}

/* Command Status: a command whose answer comes later has begun, or (a
 * status other than 0) will not */
static void begun(uint16_t op, uint8_t status)
{
	uint8_t p[4] = { status, 1, op & 0xff, op >> 8 };

	send_evt(0x0f, p, sizeof(p));
}

/* A command it does not know: Command Status, Unknown HCI Command */
static void unknown(uint16_t op)
{
	uint8_t p[4] = { 0x01, 1, op & 0xff, op >> 8 };

	say("unknown %04x", op);
	send_evt(0x0f, p, sizeof(p));
}

/* One it knows and will not take now: Command Disallowed */
static void refused(uint16_t op)
{
	say("refused %04x", op);
	done(op, 0x0c);
}

/* An advertisement heard: as an LE Advertising Report, or (-x) as an LE
 * Extended Advertising Report of the same, old-style, advertising */
static void report(uint8_t addr_type, const uint8_t *addr, uint8_t pdu, int8_t rssi,
		   const uint8_t *data, size_t n)
{
	uint8_t p[255];
	size_t o = 0;

	if (!scanning || n > 31)
		return;
	if (!opt_x) {
		p[o++] = 0x02;          /* subevent: advertising report */
		p[o++] = 1;             /* one report */
		p[o++] = pdu;
		p[o++] = addr_type;
		memcpy(p + o, addr, 6);
		o += 6;
		p[o++] = n;
		memcpy(p + o, data, n);
		o += n;
		p[o++] = (uint8_t)rssi;
	} else {
		/* legacy advertising, and what kind: ADV_IND 0x13, ADV_NONCONN_IND 0x10 */
		uint16_t type = pdu == 0 ? 0x0013 : 0x0010;

		p[o++] = 0x0d;          /* subevent: extended advertising report */
		p[o++] = 1;
		p[o++] = type & 0xff;
		p[o++] = type >> 8;
		p[o++] = addr_type;
		memcpy(p + o, addr, 6);
		o += 6;
		p[o++] = 1;             /* heard on the 1M PHY */
		p[o++] = 0;             /* nothing on a secondary channel */
		p[o++] = 0xff;          /* no advertising set */
		p[o++] = 0x7f;          /* transmit power not said */
		p[o++] = (uint8_t)rssi;
		p[o++] = 0;             /* not periodic */
		p[o++] = 0;
		p[o++] = 0;             /* not directed */
		memset(p + o, 0, 6);
		o += 6;
		p[o++] = n;
		memcpy(p + o, data, n);
		o += n;
	}
	send_evt(0x3e, p, o);
}

static void cast_report(unsigned i)
{
	const struct cast *c = &CAST[i % NCAST];
	uint8_t data[31];
	size_t n = unhex(c->data, data, sizeof(data));

	/* (a little stronger and weaker from one time to the next) */
	report(c->addr_type, c->addr, c->pdu, c->rssi + (int)(turn / NCAST % 3) - 1, data, n);
}

/* ---------- the older way ---------- */

/* Three devices an inquiry finds: who (the address as it is sent, lowest
 * byte first), its class (lowest byte first), how far its clock is off,
 * how strong, its name (none: it answers no page), and the form it is
 * reported in: 0x02 the plain Inquiry Result, 0x22 the one with how strong,
 * 0x2f the one with what the device says of itself (here its name) */
struct found {
	uint8_t addr[6], cod[3];
	uint16_t clock;
	int8_t rssi;
	const char *name;
	uint8_t form;
};
static const struct found FOUND[] = {
	/* A TV, 11:22:33:44:55:66 (class 0x08043c: audio and video, a display with loudspeakers) */
	{ { 0x66, 0x55, 0x44, 0x33, 0x22, 0x11 }, { 0x3c, 0x04, 0x08 }, 0x1234, 0, "Living Room TV", 0x02 },
	/* A phone, 21:43:65:87:A9:CB (0x5a020c: a smartphone), which answers no page */
	{ { 0xcb, 0xa9, 0x87, 0x65, 0x43, 0x21 }, { 0x0c, 0x02, 0x5a }, 0x0abc, -58, NULL, 0x22 },
	/* Headphones, 0F:1E:2D:3C:4B:5A (0x240404: a headset), which say their name themselves */
	{ { 0x5a, 0x4b, 0x3c, 0x2d, 0x1e, 0x0f }, { 0x04, 0x04, 0x24 }, 0x7fff, -70, "Pocket Buds", 0x2f },
};
#define NFOUND (sizeof(FOUND) / sizeof(FOUND[0]))

/* What an inquiry finds: an event a device, each of one answer */
static void found_all(void)
{
	size_t i;

	for (i = 0; i < NFOUND; i++) {
		const struct found *f = &FOUND[i];
		uint8_t p[255];
		size_t o = 0;

		memset(p, 0, sizeof(p));
		p[o++] = 1;             /* one answer */
		memcpy(p + o, f->addr, 6);
		o += 6;
		p[o++] = 1;             /* how it listens for a page (R1) */
		p[o++] = 0;             /* (kept) */
		if (f->form == 0x02)
			p[o++] = 0;     /* (the plain form keeps two) */
		memcpy(p + o, f->cod, 3);
		o += 3;
		p[o++] = f->clock & 0xff;
		p[o++] = f->clock >> 8;
		if (f->form != 0x02)
			p[o++] = (uint8_t)f->rssi;
		if (f->form == 0x2f) {
			/* what it says of itself, in 240 bytes: its whole name, and nothing after */
			size_t l = strlen(f->name);

			p[o] = 1 + l;
			p[o + 1] = 0x09;
			memcpy(p + o + 2, f->name, l);
			o += 240;
		}
		send_evt(f->form, p, o);
	}
}

/* The answer to a name asked for: Remote Name Request Complete (status,
 * the address, the name in 248 bytes); of one that answers no page, Page
 * Timeout */
static void name_answer(void)
{
	uint8_t p[255];
	size_t i;

	memset(p, 0, sizeof(p));
	p[0] = 0x04;
	memcpy(p + 1, name_addr, 6);
	for (i = 0; i < NFOUND; i++)
		if (!memcmp(FOUND[i].addr, name_addr, 6) && FOUND[i].name) {
			p[0] = 0;
			memcpy(p + 7, FOUND[i].name, strlen(FOUND[i].name));
		}
	send_evt(0x07, p, sizeof(p));
}

/* ---------- what it is told ---------- */

static void on_cmd(const uint8_t *b, size_t n)
{
	uint16_t op;
	const uint8_t *p;
	bool on;

	if (n < 4 || b[0] != 0x01 || (size_t)b[3] + 4 > n || opt_q)
		return;
	op = b[1] | b[2] << 8;
	p = b + 4;
	n = b[3];
	switch (op) {
	case 0x1001: {
		/* Read Local Version: status, HCI version and revision, LMP
		 * version, maker, LMP subversion. As a CSR8510 (Bluetooth 4.0)
		 * says; -x: Bluetooth 5.0; -o: Bluetooth 2.1 */
		uint8_t v = opt_x ? 9 : opt_old ? 4 : 6;
		uint8_t ret[9] = { 0, v, 0xbb, 0x22, v, 0x0a, 0x00, 0xbb, 0x22 };

		say("version");
		complete(op, ret, sizeof(ret));
		break;
	}
	case 0x1009: {
		/* Read BD_ADDR: 00:1A:7D:DA:71:13 */
		uint8_t ret[7] = { 0, 0x13, 0x71, 0xda, 0x7d, 0x1a, 0x00 };

		say("address");
		complete(op, ret, sizeof(ret));
		break;
	}
	case 0x200b:
		/* LE Set Scan Parameters: not while it scans */
		if (opt_old)
			unknown(op);
		else if (opt_x || scanning || n < 7)
			refused(op);
		else {
			active = p[0] == 1;
			done(op, 0);
		}
		break;
	case 0x200c:
		/* LE Set Scan Enable: enable, filter duplicates */
		if (opt_old)
			unknown(op);
		else if (opt_x || n < 2)
			refused(op);
		else {
			on = p[0] == 1;
			if (on != scanning) {
				scanning = on;
				if (on)
					say("scan on %s%s", active ? "active" : "passive", p[1] ? " filtered" : "");
				else
					say("scan off");
			}
			done(op, 0);
		}
		break;
	case 0x2041:
		/* LE Set Extended Scan Parameters: own address type, policy,
		 * PHYs, then for the 1M PHY the type, interval and window */
		if (!opt_x)
			unknown(op);
		else if (scanning || n < 8)
			refused(op);
		else {
			active = p[3] == 1;
			done(op, 0);
		}
		break;
	case 0x2042:
		/* LE Set Extended Scan Enable: enable, filter duplicates, duration, period */
		if (!opt_x)
			unknown(op);
		else if (n < 6)
			refused(op);
		else {
			on = p[0] == 1;
			if (on != scanning) {
				scanning = on;
				if (on)
					say("xscan on %s%s", active ? "active" : "passive", p[1] ? " filtered" : "");
				else
					say("xscan off");
			}
			done(op, 0);
		}
		break;
	case 0x0401:
		/* Inquiry: the access code, how long (x 1.28 s), how many answers.
		 * It begins, finds its three at once, and is over in 300 ms whatever
		 * was asked for (a minute, once it was told "slow") */
		if (!opt_old) {
			unknown(op);
		} else if (inquiring || n < 5) {
			say("refused %04x", op);
			begun(op, 0x0c);
		} else {
			say("inquiry %u", p[3]);
			inquiring = true;
			inq_said = false;
			inq_end = now_ms() + inq_ms;
			begun(op, 0);
		}
		break;
	case 0x0402:
		/* Inquiry Cancel: of one that is out */
		if (!opt_old) {
			unknown(op);
		} else if (!inquiring) {
			refused(op);
		} else {
			inquiring = false;
			say("inquiry cancel");
			done(op, 0);
		}
		break;
	case 0x0419:
		/* Remote Name Request: the address, how the device listens for a
		 * page, a byte kept, how far its clock is off. Answered 100 ms on */
		if (!opt_old) {
			unknown(op);
		} else if (n < 10) {
			say("refused %04x", op);
			begun(op, 0x0c);
		} else {
			say("name %02X:%02X:%02X:%02X:%02X:%02X psrm %u clock %04x",
			    p[5], p[4], p[3], p[2], p[1], p[0], p[6], p[8] | p[9] << 8);
			memcpy(name_addr, p, 6);
			name_due = now_ms() + 100;
			begun(op, 0);
		}
		break;
	default:
		unknown(op);
	}
}

/* What the daemon has sent meanwhile, without waiting for more */
static void pump(void)
{
	uint8_t buf[512];
	ssize_t r;

	while (cfd >= 0 && (r = recv(cfd, buf, sizeof(buf), MSG_DONTWAIT)) > 0)
		on_cmd(buf, r);
}

static void on_line(char *l)
{
	static const uint8_t who[6] = { 0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa };
	uint8_t data[31];
	int i, n;

	l[strcspn(l, "\r\n")] = 0;
	if (!strncmp(l, "adv ", 4)) {
		report(0, who, 0, -60, data, unhex(l + 4, data, sizeof(data)));
	} else if (!strncmp(l, "many ", 5)) {
		n = atoi(l + 5);
		/* (and a command that comes while it is at it is answered) */
		for (i = 0; i < n; i++) {
			cast_report(0);
			if (i % 64 == 63)
				pump();
		}
	} else if (!strcmp(l, "slow")) {
		inq_ms = 60000;
		say("slow");
	} else if (!strcmp(l, "error")) {
		uint8_t code = 0x42;

		send_evt(0x10, &code, 1);
	} else if (!strcmp(l, "quit")) {
		exit(0);
	}
}

static void usage(void)
{
	fprintf(stderr, "usage: fakebt -l socket [-c fifo] [-n] [-x] [-o] [-q]\n");
	exit(2);
}

int main(int argc, char **argv)
{
	const char *path = NULL, *fifo = NULL;
	struct sockaddr_un a = { .sun_family = AF_UNIX };
	char line[256];
	size_t have = 0;
	int64_t last = 0;
	int c;

	while ((c = getopt(argc, argv, "l:c:nxoq")) != -1) {
		switch (c) {
		case 'l':
			path = optarg;
			break;
		case 'c':
			fifo = optarg;
			break;
		case 'n':
			opt_n = true;
			break;
		case 'x':
			opt_x = true;
			break;
		case 'o':
			opt_old = true;
			break;
		case 'q':
			opt_q = true;
			break;
		default:
			usage();
		}
	}
	if (!path || optind != argc)
		usage();
	signal(SIGPIPE, SIG_IGN);
	lfd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
	snprintf(a.sun_path, sizeof(a.sun_path), "%s", path);
	unlink(path);
	if (lfd < 0 || bind(lfd, (struct sockaddr *)&a, sizeof(a)) < 0 || listen(lfd, 1) < 0) {
		perror("fakebt: socket");
		return 1;
	}
	if (fifo) {
		unlink(fifo);
		/* Read and write: it does not end when a writer goes */
		if (mkfifo(fifo, 0600) < 0 || (ffd = open(fifo, O_RDWR | O_NONBLOCK | O_CLOEXEC)) < 0) {
			perror("fakebt: fifo");
			return 1;
		}
	}
	for (;;) {
		struct pollfd p[2];
		uint8_t buf[512];
		ssize_t r;
		int n = 1;

		p[0].fd = cfd >= 0 ? cfd : lfd;
		p[0].events = POLLIN;
		p[0].revents = 0;
		if (ffd >= 0) {
			p[1].fd = ffd;
			p[1].events = POLLIN;
			p[1].revents = 0;
			n = 2;
		}
		if (poll(p, n, TICK_MS) < 0 && errno != EINTR)
			break;
		if (p[0].revents && cfd < 0) {
			cfd = accept(lfd, NULL, NULL);
			if (cfd >= 0) {
				scanning = active = false;
				say("open");
			}
		} else if (p[0].revents) {
			r = recv(cfd, buf, sizeof(buf), 0);
			if (r > 0) {
				on_cmd(buf, r);
			} else if (!r || errno != EINTR) {
				close(cfd);
				cfd = -1;
				scanning = false;
				inquiring = false;
				name_due = 0;
				say("close");
			}
		}
		if (n == 2 && p[1].revents) {
			r = read(ffd, line + have, sizeof(line) - 1 - have);
			if (r > 0) {
				char *nl;

				have += r;
				line[have] = 0;
				while ((nl = strchr(line, '\n'))) {
					*nl = 0;
					on_line(line);
					have -= nl + 1 - line;
					memmove(line, nl + 1, have + 1);
				}
				if (have >= sizeof(line) - 1)
					have = 0;
			}
		}
		if (scanning && !opt_n && now_ms() - last >= TICK_MS) {
			last = now_ms();
			cast_report(turn++);
		}
		if (inquiring && !inq_said) {
			inq_said = true;
			found_all();
		} else if (inquiring && now_ms() >= inq_end) {
			uint8_t ok = 0;

			inquiring = false;
			say("inquiry over");
			send_evt(0x01, &ok, 1);
		}
		if (name_due && now_ms() >= name_due) {
			name_due = 0;
			name_answer();
		}
	}
	return 0;
}
