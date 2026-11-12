/*
 * fakebt: a Bluetooth adapter as pirate-bluetooth sees one through the
 * kernel's HCI socket, on a Unix socket (SOCK_SEQPACKET: an HCI packet a
 * message, led by its type), for testing pirate-bluetooth without a dongle.
 * It answers the few HCI commands pirate-bluetooth has, and while its scan
 * is on it reports the advertising of three devices, one every 100 ms.
 *
 *   fakebt -l socket [-c fifo] [-n] [-x] [-o] [-q]
 *
 *   -l  the socket it listens on
 *   -c  a FIFO: "adv <hex>" makes it report an advertisement with these
 *       bytes for its data, from AA:BB:CC:DD:EE:FF at -60 dBm (while it
 *       scans); "many <n>" n of its own at once; "error" a hardware error;
 *       "quit" ends it
 *   -n  nobody advertises by themselves: it reports only what the FIFO says
 *   -x  a Bluetooth 5 adapter as the kernel leaves one: the scan commands
 *       every LE adapter has are refused (Command Disallowed), the extended
 *       ones taken, and what it hears comes as extended advertising reports
 *   -o  one from before Bluetooth 4.0: it knows no Low Energy command
 *   -q  one that answers nothing
 *
 * Prints an event a line to stdout: "open", "close", "version", "address",
 * "scan on passive" ("active"; "filtered" after it when duplicates are to
 * be left out), "scan off", "xscan on passive", "xscan off", "refused
 * <opcode>", "unknown <opcode>".
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
	}
	return 0;
}
