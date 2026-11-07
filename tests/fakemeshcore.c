/*
 * fakemeshcore: a MeshCore companion radio (a USB build) as pirate-meshcore
 * sees one, on a pseudo-terminal, for testing pirate-meshcore without one.
 * It answers the companion protocol (MeshCore's docs/companion_protocol.md)
 * with three contacts (Alice, two hops away via the repeater and another;
 * Bob, no route; a repeater), two channels (Public and #test), two
 * messages waiting, and a GPS whose position moves a little each time it
 * is asked while it is on. A message to Alice is delivered (confirmed a
 * moment later); one to Bob never is. A trace along repeaters it knows
 * comes back; Alice answers a telemetry request (her battery, temperature
 * and position); a route to Bob is found (through the repeater); anyone
 * else asked stays quiet.
 *
 *   fakemeshcore [-l link] [-c control-fifo] [-s]
 *
 *   -l  a symlink to its tty (default /tmp/fakemeshcore)
 *   -c  a FIFO: "msg <text>" (from Alice), "chan <text>" (on Public, from
 *       Bob) and "advert" (Carol, new) make it tell what it heard
 *   -s  silent: says nothing, as a Bluetooth build says nothing over USB
 *
 * Prints an event a line to stdout: "query", "start", "time <secs>",
 * "send <key prefix> <attempt> <text>", "chan <index> <text>", "advert
 * <flood>", "name <name>", "var <name:value>", "channel <index> <name>
 * <secret>", "remove <key prefix>", "reset <key prefix>", "trace <hop
 * ids>", "discover <key prefix>", "telemetry <key prefix>", "path <key
 * prefix> <path_len> <hop ids>", "unknown <code>".
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

static int mfd = -1;
static bool gps_on;
static uint32_t pos_n, acks, rtc = 1700000000;
static char name[33] = "PirateTest";

struct contact {
	uint8_t key[32], type, flags, path_len, path[64];
	char name[33];
	uint32_t last_advert;
	int32_t lat, lon;
};
static struct contact contacts[8];
static int ncontacts;

struct channel {
	char name[33];
	uint8_t secret[16];
};
static struct channel channels[8];

/* Messages waiting, as frames */
static uint8_t queue[16][200];
static size_t qlen[16];
static int nq;

/* A delivery to confirm, when it is due */
static uint32_t due_ack;
static long due_ms;

/* News to tell later: a trace come back, an answer to a request */
static struct { long at; size_t n; uint8_t f[200]; } laters[8];
static int nlaters;

static long now_ms(void)
{
	struct timespec t;

	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec * 1000L + t.tv_nsec / 1000000L;
}

static void wr32(uint8_t *p, uint32_t v) { p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24; }
static uint32_t rd32(const uint8_t *p) { return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24; }

static void out(const uint8_t *p, size_t n)
{
	uint8_t h[3] = { '>', n & 0xff, n >> 8 };

	if (write(mfd, h, 3) != 3 || write(mfd, p, n) != (ssize_t)n)
		exit(1);
}

static void later(const uint8_t *f, size_t n, long ms)
{
	if (nlaters == 8 || n > sizeof(laters[0].f))
		return;
	laters[nlaters].at = now_ms() + ms;
	laters[nlaters].n = n;
	memcpy(laters[nlaters].f, f, n);
	nlaters++;
}

static void sent(uint8_t flood, uint32_t tag, uint32_t est)
{
	uint8_t o[10] = { 6, flood };

	wr32(o + 2, tag);
	wr32(o + 6, est);
	out(o, 10);
}

static struct contact *by_key(const uint8_t *k)
{
	int i;

	for (i = 0; i < ncontacts; i++)
		if (!memcmp(contacts[i].key, k, 32))
			return &contacts[i];
	return NULL;
}

static void ok(void)
{
	uint8_t f[1] = { 0 };

	out(f, 1);
}

static void err(uint8_t code)
{
	uint8_t f[2] = { 1, code };

	out(f, 2);
}

static void prefix(char *s, const uint8_t *k)
{
	int i;

	for (i = 0; i < 6; i++)
		sprintf(s + 2 * i, "%02x", k[i]);
}

static void add_contact(const char *n, uint8_t b, uint8_t type, uint8_t path)
{
	struct contact *c = &contacts[ncontacts++];

	memset(c, 0, sizeof(*c));
	memset(c->key, b, 32);
	c->type = type;
	c->path_len = path;
	snprintf(c->name, sizeof(c->name), "%s", n);
	c->last_advert = rtc - 600 * ncontacts;
	if (b == 0xa1) {
		c->lat = 37422000;
		c->lon = -122084000;
	}
}

static size_t contact_frame(uint8_t *f, uint8_t code, const struct contact *c)
{
	memset(f, 0, 148);
	f[0] = code;
	memcpy(f + 1, c->key, 32);
	f[33] = c->type;
	f[34] = c->flags;
	f[35] = c->path_len;
	memcpy(f + 36, c->path, 64);
	memcpy(f + 100, c->name, strlen(c->name));
	wr32(f + 132, c->last_advert);
	wr32(f + 136, (uint32_t)c->lat);
	wr32(f + 140, (uint32_t)c->lon);
	wr32(f + 144, c->last_advert);
	return 148;
}

static void queue_contact_msg(const char *text)
{
	uint8_t *f = queue[nq];
	size_t n = strlen(text);

	f[0] = 16;                    /* contact message, v3 */
	f[1] = 40;                    /* SNR 10 dB */
	f[2] = f[3] = 0;
	memcpy(f + 4, contacts[0].key, 6);
	f[10] = 1;                    /* a hop */
	f[11] = 0;                    /* plain */
	wr32(f + 12, rtc - 5);
	memcpy(f + 16, text, n);
	qlen[nq++] = 16 + n;
}

static void queue_channel_msg(int idx, const char *text)
{
	uint8_t *f = queue[nq];
	size_t n = strlen(text);

	f[0] = 17;                    /* channel message, v3 */
	f[1] = (uint8_t)-22;          /* SNR -5.5 dB */
	f[2] = f[3] = 0;
	f[4] = idx;
	f[5] = 2;
	f[6] = 0;
	wr32(f + 7, rtc - 3);
	memcpy(f + 11, text, n);
	qlen[nq++] = 11 + n;
}

static void tickle(void)
{
	uint8_t f[1] = { 0x83 };

	out(f, 1);
}

static void on_frame(const uint8_t *f, size_t n)
{
	uint8_t o[200];
	char p[13];
	int i;

	switch (f[0]) {
	case 22:
		printf("query\n");
		memset(o, 0, 82);
		o[0] = 13;
		o[1] = 9;
		o[2] = 175;
		o[3] = 8;
		memcpy(o + 8, "05-Nov-2026", 11);
		memcpy(o + 20, "LilyGo T-Echo", 13);
		memcpy(o + 60, "v1.18.0", 7);
		out(o, 82);
		break;
	case 1: {
		int32_t lat = 37421925, lon = -122084102;
		size_t l = strlen(name);

		printf("start\n");
		if (gps_on) {
			lat += pos_n % 3;
			lon -= pos_n % 2;
			pos_n++;
		}
		memset(o, 0, 58);
		o[0] = 5;
		o[1] = 1;
		o[2] = 22;
		o[3] = 22;
		memset(o + 4, 0xee, 32);
		wr32(o + 36, (uint32_t)lat);
		wr32(o + 40, (uint32_t)lon);
		wr32(o + 48, 910525);
		wr32(o + 52, 62500);
		o[56] = 7;
		o[57] = 5;
		memcpy(o + 58, name, l);
		out(o, 58 + l);
		break;
	}
	case 6:
		if (n >= 5) {
			uint32_t t = rd32(f + 1);

			printf("time %u\n", t);
			if (t >= rtc) {
				rtc = t;
				ok();
			} else {
				err(6);
			}
		}
		break;
	case 40: {
		const char *v = gps_on ? "gps:1" : "gps:0";

		o[0] = 21;
		memcpy(o + 1, v, 5);
		out(o, 6);
		break;
	}
	case 41: {
		char s[64];

		snprintf(s, sizeof(s), "%.*s", (int)(n - 1), f + 1);
		printf("var %s\n", s);
		if (!strcmp(s, "gps:1"))
			gps_on = true;
		else if (!strcmp(s, "gps:0"))
			gps_on = false;
		else {
			err(6);
			break;
		}
		ok();
		break;
	}
	case 20:
		o[0] = 12;
		o[1] = 4012 & 0xff;
		o[2] = 4012 >> 8;
		wr32(o + 3, 128);
		wr32(o + 7, 4096);
		out(o, 11);
		break;
	case 4:
		o[0] = 2;
		wr32(o + 1, ncontacts);
		out(o, 5);
		for (i = 0; i < ncontacts; i++)
			out(o, contact_frame(o, 3, &contacts[i]));
		o[0] = 4;
		wr32(o + 1, rtc);
		out(o, 5);
		break;
	case 31:
		if (n < 2 || f[1] >= 8) {
			err(2);
			break;
		}
		memset(o, 0, 50);
		o[0] = 18;
		o[1] = f[1];
		memcpy(o + 2, channels[f[1]].name, strlen(channels[f[1]].name));
		memcpy(o + 34, channels[f[1]].secret, 16);
		out(o, 50);
		break;
	case 32:
		if (n < 50 || f[1] >= 8) {
			err(2);
			break;
		}
		{
			char s[33];

			snprintf(channels[f[1]].name, 33, "%.32s", (const char *)f + 2);
			memcpy(channels[f[1]].secret, f + 34, 16);
			for (i = 0; i < 16; i++)
				sprintf(s + 2 * i, "%02x", f[34 + i]);
			printf("channel %u %s %s\n", f[1], channels[f[1]].name[0] ? channels[f[1]].name : "-", s);
		}
		ok();
		break;
	case 10:
		if (nq) {
			out(queue[0], qlen[0]);
			memmove(queue, queue + 1, sizeof(queue[0]) * (nq - 1));
			memmove(qlen, qlen + 1, sizeof(qlen[0]) * (nq - 1));
			nq--;
		} else {
			o[0] = 10;
			out(o, 1);
		}
		break;
	case 2: {
		struct contact *c = NULL;

		if (n < 14)
			break;
		for (i = 0; i < ncontacts; i++)
			if (!memcmp(contacts[i].key, f + 7, 6))
				c = &contacts[i];
		prefix(p, f + 7);
		printf("send %s %u %.*s\n", p, f[2], (int)(n - 13), f + 13);
		if (!c) {
			err(2);
			break;
		}
		o[0] = 6;
		o[1] = c->path_len == 0xff;
		wr32(o + 2, 0x11223344 + ++acks);
		wr32(o + 6, 3000);
		out(o, 10);
		/* Alice answers (a moment later); Bob never does */
		if (c->key[0] == 0xa1) {
			due_ack = 0x11223344 + acks;
			due_ms = now_ms() + 300;
		}
		break;
	}
	case 3:
		if (n < 7)
			break;
		printf("chan %u %.*s\n", f[2], (int)(n - 7), f + 7);
		if (f[2] >= 8 || !channels[f[2]].name[0])
			err(2);
		else
			ok();
		break;
	case 7:
		printf("advert %u\n", n >= 2 ? f[1] : 0);
		ok();
		break;
	case 8:
		snprintf(name, sizeof(name), "%.*s", (int)(n - 1), f + 1);
		printf("name %s\n", name);
		ok();
		break;
	case 15:
	case 13:
		if (n < 33)
			break;
		prefix(p, f + 1);
		printf("%s %s\n", f[0] == 15 ? "remove" : "reset", p);
		for (i = 0; i < ncontacts; i++)
			if (!memcmp(contacts[i].key, f + 1, 32))
				break;
		if (i == ncontacts) {
			err(2);
			break;
		}
		if (f[0] == 15) {
			memmove(&contacts[i], &contacts[i + 1], (ncontacts - i - 1) * sizeof(*contacts));
			ncontacts--;
		} else {
			contacts[i].path_len = 0xff;
		}
		ok();
		break;
	case 9: {
		/* A contact, as the app has it: here, its route */
		struct contact *c = n >= 36 ? by_key(f + 1) : NULL;
		char h[3 * 64 + 1] = "";
		size_t pl = (f[35] & 63) * ((f[35] >> 6) + 1), k;

		if (!c) {
			err(2);
			break;
		}
		if (f[35] == 0xff)
			pl = 0;
		for (k = 0; k < pl && 36 + k < n; k++)
			sprintf(h + 3 * k, " %02x", f[36 + k]);
		prefix(p, f + 1);
		printf("path %s %u%s\n", p, f[35], h);
		c->path_len = f[35];
		memset(c->path, 0, 64);
		memcpy(c->path, f + 36, pl);
		ok();
		break;
	}
	case 36: {
		/* A trace: back along repeaters it knows, each one's SNR on it */
		size_t hs = (size_t)1 << (f[9] & 3), pl, k, ne;
		bool known = true;
		char h[3 * 64 + 1] = "";

		if (n <= 10 || n - 10 > 64)
			break;
		pl = n - 10;
		ne = pl / hs;
		for (k = 0; k < pl; k += hs) {
			sprintf(h + 3 * (k / hs), " %02x", f[10 + k]);
			if (f[10 + k] != 0xc2 && f[10 + k] != 0x77)
				known = false;
		}
		printf("trace%s\n", h);
		sent(0, rd32(f + 1), 1200);
		if (known) {
			o[0] = 0x89;
			o[1] = 0;
			o[2] = pl;
			o[3] = f[9];
			memcpy(o + 4, f + 1, 8);
			memcpy(o + 12, f + 10, pl);
			for (k = 0; k < ne; k++)
				o[12 + pl + k] = (uint8_t)(int8_t)(4 * (8 - (int)k));
			o[12 + pl + ne] = 22;
			later(o, 13 + pl + ne, 300);
		}
		break;
	}
	case 39: {
		/* Telemetry: Alice's battery, temperature and position */
		struct contact *c = n >= 36 ? by_key(f + 4) : NULL;
		static const uint8_t lpp[] = {
			1, 116, 0x01, 0x9c,                     /* 4.12 V */
			1, 103, 0x00, 0xd7,                     /* 21.5 C */
			1, 136, 0x05, 0xb5, 0xcc, 0xed, 0x5f, 0x18, 0x00, 0x04, 0xb0,
			                                        /* 37.4220, -122.0840, 12 m */
		};

		if (!c) {
			err(2);
			break;
		}
		prefix(p, f + 4);
		printf("telemetry %s\n", p);
		sent(c->path_len == 0xff, 0x7e1e0000 + c->key[0], 1000);
		if (c->key[0] == 0xa1) {
			o[0] = 0x8b;
			o[1] = 0;
			memcpy(o + 2, c->key, 6);
			memcpy(o + 8, lpp, sizeof(lpp));
			later(o, 8 + sizeof(lpp), 300);
		}
		break;
	}
	case 52: {
		/* A route found: to Bob, through the repeater, both ways */
		struct contact *c = n >= 34 ? by_key(f + 2) : NULL;

		if (!c) {
			err(2);
			break;
		}
		prefix(p, f + 2);
		printf("discover %s\n", p);
		sent(1, 0xd15c0000 + c->key[0], 1000);
		if (c->key[0] == 0xb0) {
			o[0] = 0x8d;
			o[1] = 0;
			memcpy(o + 2, c->key, 6);
			o[8] = 1;
			o[9] = 0xc2;
			o[10] = 1;
			o[11] = 0xc2;
			later(o, 12, 400);
		}
		break;
	}
	default:
		printf("unknown %u\n", f[0]);
		err(1);
	}
}

static void on_control(char *line)
{
	uint8_t o[200];
	char *r, *w;

	line[strcspn(line, "\n")] = 0;
	/* A line down, in a message (a reaction's), written as \n */
	for (r = w = line; *r; r++, w++) {
		if (r[0] == '\\' && r[1] == 'n') {
			*w = '\n';
			r++;
		} else {
			*w = *r;
		}
	}
	*w = 0;
	if (!strncmp(line, "msg ", 4)) {
		queue_contact_msg(line + 4);
		tickle();
	} else if (!strncmp(line, "chan ", 5)) {
		char t[160];

		snprintf(t, sizeof(t), "Bob: %s", line + 5);
		queue_channel_msg(0, t);
		tickle();
	} else if (!strncmp(line, "data ", 5)) {
		/* Binary channel data: "data <index> <type, 4 hex> <payload hex>",
		 * as RESP_CODE_CHANNEL_DATA_RECV brings it (SNR 7.5, no path) */
		unsigned idx, type, b;
		char hexs[400];
		uint8_t *f = queue[nq];
		size_t k = 0;

		if (sscanf(line + 5, "%u %4x %399s", &idx, &type, hexs) != 3 || nq == 16)
			return;
		f[0] = 27;
		f[1] = 30;
		f[2] = f[3] = 0;
		f[4] = idx;
		f[5] = 0xff;
		f[6] = type & 0xff;
		f[7] = type >> 8;
		while (hexs[2 * k] && hexs[2 * k + 1] && k < 165 && sscanf(hexs + 2 * k, "%2x", &b) == 1) {
			f[9 + k] = b;
			k++;
		}
		f[8] = k;
		qlen[nq++] = 9 + k;
		tickle();
	} else if (!strcmp(line, "advert")) {
		add_contact("Carol", 0xd3, 1, 0xff);
		out(o, contact_frame(o, 0x8a, &contacts[ncontacts - 1]));
	}
}

int main(int argc, char **argv)
{
	const char *link = "/tmp/fakemeshcore", *ctl = NULL;
	struct pollfd pfd[2];
	uint8_t in[4096], tmp[1024];
	size_t il = 0;
	struct termios t;
	bool silent = false;
	char cl[256];
	size_t cll = 0;
	int c, sfd, cfd = -1, np;
	ssize_t r;

	while ((c = getopt(argc, argv, "l:c:s")) != -1) {
		if (c == 'l')
			link = optarg;
		else if (c == 'c')
			ctl = optarg;
		else if (c == 's')
			silent = true;
		else
			return 2;
	}
	setvbuf(stdout, NULL, _IOLBF, 0);
	add_contact("Alice", 0xa1, 1, 2);
	contacts[0].path[0] = 0xc2;   /* via the repeater, and one it doesn't know */
	contacts[0].path[1] = 0x77;
	add_contact("Bob", 0xb0, 1, 0xff);
	add_contact("Hilltop Repeater", 0xc2, 2, 0);
	snprintf(channels[0].name, 33, "Public");
	memcpy(channels[0].secret, "\x8b\x33\x87\xe9\xc5\xcd\xea\x6a\xc9\xe5\xed\xba\xa1\x15\xcd\x72", 16);
	snprintf(channels[1].name, 33, "#test");
	memcpy(channels[1].secret, "\x9c\xd8\xfc\xf2\x2a\x47\x33\x3b\x59\x1d\x96\xa2\xb8\x48\xb7\x3f", 16);
	queue_contact_msg("hello router");
	queue_channel_msg(0, "Bob: hi all");
	mfd = posix_openpt(O_RDWR | O_NOCTTY);
	if (mfd < 0 || grantpt(mfd) || unlockpt(mfd)) {
		perror("pty");
		return 1;
	}
	/* Held open here too, so the pty stays up between its users */
	sfd = open(ptsname(mfd), O_RDWR | O_NOCTTY);
	if (sfd < 0 || tcgetattr(sfd, &t)) {
		perror("pts");
		return 1;
	}
	cfmakeraw(&t);
	tcsetattr(sfd, TCSANOW, &t);
	unlink(link);
	if (symlink(ptsname(mfd), link)) {
		perror("symlink");
		return 1;
	}
	if (ctl) {
		unlink(ctl);
		if (mkfifo(ctl, 0600) || (cfd = open(ctl, O_RDWR | O_NONBLOCK)) < 0) {
			perror("fifo");
			return 1;
		}
	}
	printf("ready %s\n", ptsname(mfd));
	for (;;) {
		long wait = -1;

		pfd[0].fd = mfd;
		pfd[0].events = POLLIN;
		np = 1;
		if (cfd >= 0) {
			pfd[1].fd = cfd;
			pfd[1].events = POLLIN;
			np = 2;
		}
		if (due_ack) {
			wait = due_ms - now_ms();
			if (wait < 0)
				wait = 0;
		}
		for (int i = 0; i < nlaters; i++) {
			long w = laters[i].at - now_ms();

			if (w < 0)
				w = 0;
			if (wait < 0 || w < wait)
				wait = w;
		}
		if (poll(pfd, np, wait) < 0) {
			if (errno == EINTR)
				continue;
			return 1;
		}
		if (due_ack && now_ms() >= due_ms) {
			uint8_t o[9] = { 0x82 };

			wr32(o + 1, due_ack);
			wr32(o + 5, 850);
			out(o, 9);
			due_ack = 0;
		}
		for (int i = 0; i < nlaters; ) {
			if (now_ms() >= laters[i].at) {
				out(laters[i].f, laters[i].n);
				memmove(&laters[i], &laters[i + 1], (nlaters - i - 1) * sizeof(laters[0]));
				nlaters--;
			} else {
				i++;
			}
		}
		if (np == 2 && (pfd[1].revents & POLLIN)) {
			r = read(cfd, tmp, sizeof(tmp));
			for (ssize_t i = 0; i < r; i++) {
				if (tmp[i] == '\n' || cll == sizeof(cl) - 1) {
					cl[cll] = 0;
					on_control(cl);
					cll = 0;
				} else {
					cl[cll++] = tmp[i];
				}
			}
		}
		if (!(pfd[0].revents & POLLIN))
			continue;
		r = read(mfd, tmp, sizeof(tmp));
		if (r < 0 && (errno == EINTR || errno == EAGAIN))
			continue;
		if (r <= 0)
			return 1;
		if (silent)
			continue;
		if (il + r > sizeof(in))
			il = 0;
		memcpy(in + il, tmp, r);
		il += r;
		/* Frames: '<', length, frame */
		while (il) {
			size_t n;

			if (in[0] != '<') {
				memmove(in, in + 1, --il);
				continue;
			}
			if (il < 3)
				break;
			n = in[1] | in[2] << 8;
			if (il < 3 + n)
				break;
			{
				uint8_t f[300];

				memcpy(f, in + 3, n < sizeof(f) ? n : sizeof(f));
				memmove(in, in + 3 + n, il - 3 - n);
				il -= 3 + n;
				on_frame(f, n);
			}
		}
	}
}
