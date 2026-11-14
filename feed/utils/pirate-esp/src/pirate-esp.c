/*
 * pirate-esp: an ESP32 board on the router's USB port, for the Pirate Radio
 * UI. For now it is the flasher: it talks to the loader in the chip's ROM,
 * as esptool does, to say what chip a board has and to write firmware to
 * it, from the router itself.
 *
 *   pirate-esp identify <tty>
 *   pirate-esp md5 <tty> <offset> <size>
 *   pirate-esp flash <tty> <offset> <file> [<offset> <file> ...]
 *
 * identify: the board is restarted into its ROM loader and asked what it
 * is: its chip, by the chip id it gives (or, on the first ESP32 and the S2,
 * which give none, by a register only each has), and its MAC address. Then
 * it is restarted to run what it had. Nothing is written. The answer is a
 * line of JSON.
 *
 * md5: the same, and what the board has in its flash, so many bytes from
 * an offset, as an MD5 sum the chip makes of it. Nothing is written either:
 * to tell what a board has, or to check it against a file.
 *
 * flash: the same, then each file is written where it is to go, the chip
 * reads what it now has back as an MD5 sum, which must be the file's, and
 * the board is restarted to run it. A firmware image made for another chip
 * is refused, and so is a bootloader put anywhere but where the chip looks
 * for it. Progress goes to stderr, the answer to stdout as JSON.
 *
 * Only the ROM's own loader is used (esptool sends a "stub" loader to the
 * chip's RAM first, by default, to go faster): there is nothing more to
 * carry, and every chip's ROM has the commands used here.
 *
 * How a chip is put into its loader is what esptool does: on a board with
 * a USB-to-serial chip, the serial port's DTR and RTS lines drive its
 * reset and its boot pin through two transistors; on a chip's own USB
 * (Espressif's 303a:1001, the "USB JTAG/serial debug unit") the same lines
 * are read by the chip, in a sequence of their own.
 *
 * The protocol is Espressif's, after esptool's documentation and source
 * (GPL-2.0-or-later); the code is this project's own (MIT).
 */

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

/* The ROM loader's commands */
#define OP_FLASH_BEGIN    0x02
#define OP_FLASH_DATA     0x03
#define OP_SYNC           0x08
#define OP_READ_REG       0x0a
#define OP_SPI_SET_PARAMS 0x0b
#define OP_SPI_ATTACH     0x0d
#define OP_SPI_FLASH_MD5  0x13
#define OP_SECURITY_INFO  0x14

#define BLOCK          0x400       /* what one FLASH_DATA carries, to the ROM */
#define MAGIC_REG      0x40001000  /* on chips that give no chip id, a value only each has */
#define ESP32_EFUSE    0x3ff5a000  /* the first ESP32's eFuses, where its MAC is */
#define INVALID_MSG    0x05        /* the ROM's answer to a command it does not know */
#define CHECKSUM_SEED  0xef
#define MAX_IMAGE      (16u << 20)

/* Timeouts (ms), as esptool's: a command; a SYNC; the ROM erasing what it
 * is to write (it does that at FLASH_BEGIN), and reading it back as MD5,
 * each by the megabyte */
#define CMD_MS         3000
#define SYNC_MS        100
#define ERASE_MS_MB    40000
#define MD5_MS_MB      8000

/* What differs from chip to chip (esptool's targets/): its name; its chip
 * id, in its images and from GET_SECURITY_INFO; for those that give none,
 * the value at MAGIC_REG; where its bootloader goes in flash; whether
 * FLASH_BEGIN takes a fifth word (encrypted or not: 0); and where its MAC
 * is in its eFuses (0: the first ESP32's own way) */
struct chip {
	const char *name;
	int id;
	uint32_t magic, boot_at;
	bool begin5;
	uint32_t mac_reg;
};

static const struct chip CHIPS[] = {
	{ "ESP32",     0,  0x00f01d83, 0x1000, false, 0 },
	{ "ESP32-S2",  2,  0x000007c6, 0x1000, true,  0x3f41a044 },
	{ "ESP32-S3",  9,  0,          0x0,    true,  0x60007044 },
	{ "ESP32-C3",  5,  0,          0x0,    true,  0x60008844 },
	{ "ESP32-C2",  12, 0,          0x0,    true,  0x60008840 },
	{ "ESP32-C6",  13, 0,          0x0,    true,  0x600b0844 },
	{ "ESP32-H2",  16, 0,          0x0,    true,  0x600b0844 },
	{ "ESP32-C5",  23, 0,          0x2000, true,  0x600b4844 },
	{ "ESP32-C61", 20, 0,          0x0,    true,  0x600b4844 },
	{ "ESP32-P4",  18, 0,          0x2000, true,  0x5012d044 },
};
#define NCHIPS (sizeof(CHIPS) / sizeof(CHIPS[0]))

/* What the ROM says went wrong (its error byte) */
static const char *rom_error(uint8_t e)
{
	switch (e) {
	case 0x01: return "a parameter was invalid";
	case 0x02: return "it ran out of memory";
	case 0x03: return "it could not send";
	case 0x04: return "it could not receive";
	case 0x05: return "the message was malformed";
	case 0x06: return "the result was wrong";
	case 0x07: return "the checksum was wrong";
	case 0x08: return "what was written to flash read back otherwise";
	case 0x09: return "flash could not be read";
	case 0x0a: return "a flash read was too long";
	case 0x0b: case 0x0c: case 0x0d: return "compressed data was bad";
	default: return "an error it does not name";
	}
}

static char err[256];

static bool fail(const char *fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vsnprintf(err, sizeof(err), fmt, ap);
	va_end(ap);
	return false;
}

/* ---------- small things ---------- */

static int64_t now_ms(void)
{
	struct timespec ts;

	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void sleep_ms(int ms)
{
	struct timespec ts = { ms / 1000, (long)(ms % 1000) * 1000000 };

	while (nanosleep(&ts, &ts) && errno == EINTR)
		;
}

static void put32(uint8_t *p, uint32_t v)
{
	p[0] = v;
	p[1] = v >> 8;
	p[2] = v >> 16;
	p[3] = v >> 24;
}

static uint32_t get32(const uint8_t *p)
{
	return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24;
}

/* As long a time as so many bytes take, at so many ms a megabyte; 3 s at least */
static int ms_for(uint32_t bytes, int ms_mb)
{
	int64_t ms = (int64_t)ms_mb * bytes / (1 << 20);

	return ms < CMD_MS ? CMD_MS : ms > INT_MAX ? INT_MAX : (int)ms;
}

/* ---------- MD5 (RFC 1321), for what was written ---------- */

struct md5 {
	uint32_t h[4];
	uint64_t len;
	uint8_t buf[64];
};

static const uint32_t MD5_K[64] = {
	0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
	0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
	0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
	0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
	0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
	0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
	0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
	0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
};
static const uint8_t MD5_R[64] = {
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
	5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
	4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
	6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
};

static void md5_block(struct md5 *m, const uint8_t *p)
{
	uint32_t a = m->h[0], b = m->h[1], c = m->h[2], d = m->h[3], w[16], f, t;
	int i, g;

	for (i = 0; i < 16; i++)
		w[i] = get32(p + 4 * i);
	for (i = 0; i < 64; i++) {
		if (i < 16) {
			f = (b & c) | (~b & d);
			g = i;
		} else if (i < 32) {
			f = (d & b) | (~d & c);
			g = (5 * i + 1) & 15;
		} else if (i < 48) {
			f = b ^ c ^ d;
			g = (3 * i + 5) & 15;
		} else {
			f = c ^ (b | ~d);
			g = (7 * i) & 15;
		}
		t = d;
		d = c;
		c = b;
		f += a + MD5_K[i] + w[g];
		b += f << MD5_R[i] | f >> (32 - MD5_R[i]);
		a = t;
	}
	m->h[0] += a;
	m->h[1] += b;
	m->h[2] += c;
	m->h[3] += d;
}

static void md5_init(struct md5 *m)
{
	m->h[0] = 0x67452301;
	m->h[1] = 0xefcdab89;
	m->h[2] = 0x98badcfe;
	m->h[3] = 0x10325476;
	m->len = 0;
}

static void md5_add(struct md5 *m, const uint8_t *p, size_t n)
{
	size_t have = m->len & 63, take;

	m->len += n;
	while (n) {
		take = 64 - have < n ? 64 - have : n;
		memcpy(m->buf + have, p, take);
		have += take;
		p += take;
		n -= take;
		if (have == 64) {
			md5_block(m, m->buf);
			have = 0;
		}
	}
}

/* The sum as 32 hex digits, as the ROM gives it */
static void md5_hex(struct md5 *m, char out[33])
{
	uint64_t bits = m->len * 8;
	uint8_t pad = 0x80, len[8], z = 0;
	int i;

	md5_add(m, &pad, 1);
	while ((m->len & 63) != 56)
		md5_add(m, &z, 1);
	for (i = 0; i < 8; i++)
		len[i] = bits >> (8 * i);
	md5_add(m, len, 8);
	for (i = 0; i < 16; i++)
		snprintf(out + 2 * i, 3, "%02x", (unsigned)(m->h[i / 4] >> (8 * (i % 4)) & 0xff));
}

/* ---------- the serial port ---------- */

struct port {
	int fd;
	const char *path;
	bool usb_jtag;          /* the chip's own USB: its reset sequence */
	char usb[10];           /* vendor:product, where USB says */
	/* the SLIP reader: what has been read, and the packet being put together */
	uint8_t raw[512];
	size_t raw_len, raw_at;
	uint8_t pkt[1024];
	size_t pkt_len;
	bool in_pkt, esc, dropped;
};

/* The USB vendor:product of the device a tty is, from sysfs */
static void usb_id(struct port *p)
{
	char path[PATH_MAX], real[PATH_MAX], vid[8] = "", pid[8] = "";
	const char *name = strrchr(p->path, '/');
	char *slash;
	FILE *f;

	p->usb[0] = 0;
	snprintf(path, sizeof(path), "/sys/class/tty/%s/device", name ? name + 1 : p->path);
	if (!realpath(path, real))
		return;
	for (;;) {
		snprintf(path, sizeof(path), "%s/idVendor", real);
		if (!access(path, R_OK))
			break;
		slash = strrchr(real, '/');
		if (!slash || slash == real)
			return;
		*slash = 0;
	}
	if ((f = fopen(path, "r"))) {
		if (!fgets(vid, sizeof(vid), f))
			vid[0] = 0;
		fclose(f);
	}
	snprintf(path, sizeof(path), "%s/idProduct", real);
	if ((f = fopen(path, "r"))) {
		if (!fgets(pid, sizeof(pid), f))
			pid[0] = 0;
		fclose(f);
	}
	vid[strcspn(vid, "\n")] = 0;
	pid[strcspn(pid, "\n")] = 0;
	if (vid[0] && pid[0])
		snprintf(p->usb, sizeof(p->usb), "%.4s:%.4s", vid, pid);
	p->usb_jtag = !strcmp(p->usb, "303a:1001");
}

static bool port_open(struct port *p, const char *path)
{
	struct termios t;

	memset(p, 0, sizeof(*p));
	p->path = path;
	p->fd = open(path, O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
	if (p->fd < 0)
		return fail("can't open %s: %s", path, strerror(errno));
	/* Nobody else (gpsd and the like) while it is ours */
	if (ioctl(p->fd, TIOCEXCL) && errno != ENOTTY)
		return fail("can't have %s to itself: %s", path, strerror(errno));
	if (tcgetattr(p->fd, &t))
		return fail("%s is no serial port: %s", path, strerror(errno));
	cfmakeraw(&t);
	t.c_cflag |= CLOCAL | CREAD;
	/* (closing it leaves the lines as they are: a chip is not reset by it) */
	t.c_cflag &= ~HUPCL;
	t.c_cc[VMIN] = 0;
	t.c_cc[VTIME] = 0;
	/* The ROM loader begins at 115200 (on the chip's own USB it is not used) */
	cfsetispeed(&t, B115200);
	cfsetospeed(&t, B115200);
	if (tcsetattr(p->fd, TCSANOW, &t))
		return fail("can't set up %s: %s", path, strerror(errno));
	usb_id(p);
	return true;
}

/* DTR or RTS on (asserted) or off, each by itself, as pyserial sets them */
static void dtr(struct port *p, bool on)
{
	int b = TIOCM_DTR;

	ioctl(p->fd, on ? TIOCMBIS : TIOCMBIC, &b);
}

static void rts(struct port *p, bool on)
{
	int b = TIOCM_RTS;

	ioctl(p->fd, on ? TIOCMBIS : TIOCMBIC, &b);
}

/* Both at once */
static void dtr_rts(struct port *p, bool d, bool r)
{
	int s = 0;

	if (ioctl(p->fd, TIOCMGET, &s))
		return;
	s = d ? s | TIOCM_DTR : s & ~TIOCM_DTR;
	s = r ? s | TIOCM_RTS : s & ~TIOCM_RTS;
	ioctl(p->fd, TIOCMSET, &s);
}

/* Into the ROM loader. Through a USB-to-serial chip (DTR: the boot pin,
 * low; RTS: the chip held in reset), as esptool's UnixTightReset, both
 * lines at once ... */
static void reset_tight(struct port *p, int delay)
{
	dtr_rts(p, false, false);
	dtr_rts(p, true, true);
	dtr_rts(p, false, true);     /* boot pin high, in reset */
	sleep_ms(100);
	dtr_rts(p, true, false);     /* boot pin low, out of reset: the loader */
	sleep_ms(delay);
	dtr_rts(p, false, false);
	dtr(p, false);
}

/* ... or one after the other (its ClassicReset) ... */
static void reset_classic(struct port *p, int delay)
{
	dtr(p, false);
	rts(p, true);                /* in reset */
	sleep_ms(100);
	dtr(p, true);                /* boot pin low */
	rts(p, false);               /* out of reset */
	sleep_ms(delay);
	dtr(p, false);
}

/* ... or on a chip's own USB (its USBJTAGSerialReset) */
static void reset_usb_jtag(struct port *p)
{
	rts(p, false);
	dtr(p, false);               /* idle */
	sleep_ms(100);
	dtr(p, true);                /* the boot pin */
	rts(p, false);
	sleep_ms(100);
	rts(p, true);                /* reset, by way of both on */
	dtr(p, false);
	rts(p, true);
	sleep_ms(100);
	dtr(p, false);
	rts(p, false);               /* out of reset */
}

/* A plain restart, to run what is in flash (its HardReset) */
static void reset_run(struct port *p)
{
	dtr(p, false);
	rts(p, true);
	sleep_ms(p->usb_jtag ? 200 : 100);
	rts(p, false);
	if (p->usb_jtag)
		sleep_ms(200);
}

static void port_flush(struct port *p)
{
	tcflush(p->fd, TCIFLUSH);
	p->raw_len = p->raw_at = 0;
	p->pkt_len = 0;
	p->in_pkt = p->esc = false;
}

static bool port_write(struct port *p, const uint8_t *d, size_t n)
{
	struct pollfd pf = { p->fd, POLLOUT, 0 };
	ssize_t w;

	while (n) {
		w = write(p->fd, d, n);
		if (w > 0) {
			d += w;
			n -= w;
			continue;
		}
		if (w < 0 && errno != EAGAIN && errno != EINTR)
			return fail("writing to %s: %s", p->path, strerror(errno));
		if (poll(&pf, 1, CMD_MS) <= 0)
			return fail("writing to %s: it takes nothing", p->path);
	}
	return true;
}

/* One SLIP packet, its escapes undone, within ms: its length, or -1 */
static int slip_read(struct port *p, uint8_t *out, size_t cap, int ms)
{
	int64_t end = now_ms() + ms;
	struct pollfd pf = { p->fd, POLLIN, 0 };
	ssize_t r;
	uint8_t c;
	int left;

	for (;;) {
		while (p->raw_at < p->raw_len) {
			c = p->raw[p->raw_at++];
			if (c == 0xc0) {
				if (p->in_pkt && p->pkt_len && !p->dropped) {
					size_t n = p->pkt_len < cap ? p->pkt_len : cap;

					memcpy(out, p->pkt, n);
					p->in_pkt = false;
					p->pkt_len = 0;
					return (int)n;
				}
				/* (the start of one; or the end of one that was too long) */
				p->in_pkt = true;
				p->pkt_len = 0;
				p->esc = p->dropped = false;
				continue;
			}
			/* (outside a packet: what the chip prints, its boot text) */
			if (!p->in_pkt)
				continue;
			if (p->esc) {
				c = c == 0xdc ? 0xc0 : c == 0xdd ? 0xdb : c;
				p->esc = false;
			} else if (c == 0xdb) {
				p->esc = true;
				continue;
			}
			if (p->pkt_len < sizeof(p->pkt))
				p->pkt[p->pkt_len++] = c;
			else
				p->dropped = true;
		}
		left = (int)(end - now_ms());
		if (left <= 0)
			return -1;
		if (poll(&pf, 1, left) <= 0)
			continue;
		r = read(p->fd, p->raw, sizeof(p->raw));
		if (r < 0 && errno != EAGAIN && errno != EINTR) {
			fail("reading from %s: %s", p->path, strerror(errno));
			return -2;
		}
		if (r == 0 && (pf.revents & (POLLHUP | POLLERR))) {
			fail("%s went away", p->path);
			return -2;
		}
		p->raw_len = r > 0 ? (size_t)r : 0;
		p->raw_at = 0;
	}
}

/* Nothing more within ms: what is still coming (more answers to a SYNC) is let go */
static void drain(struct port *p, int ms)
{
	uint8_t junk[64];

	while (slip_read(p, junk, sizeof(junk), ms) >= 0)
		;
}

/* ---------- the ROM loader's commands ---------- */

/* A command, and the answer to it: the answer's value, its data (status
 * bytes and all) in out and their length; -1 if none came in time, -2 if
 * the ROM does not know the command */
static int command(struct port *p, uint8_t op, const uint8_t *d, size_t n, uint32_t chk, int ms,
		   uint32_t *val, uint8_t *out, size_t cap)
{
	static uint8_t frame[2 * (8 + 16 + BLOCK) + 2];
	uint8_t hdr[8], pkt[1024];
	size_t f = 0, i;
	int64_t end = now_ms() + ms;
	int r, left;

	hdr[0] = 0x00;
	hdr[1] = op;
	hdr[2] = n;
	hdr[3] = n >> 8;
	put32(hdr + 4, chk);
	frame[f++] = 0xc0;
	for (i = 0; i < 8 + n; i++) {
		uint8_t c = i < 8 ? hdr[i] : d[i - 8];

		if (c == 0xc0) {
			frame[f++] = 0xdb;
			frame[f++] = 0xdc;
		} else if (c == 0xdb) {
			frame[f++] = 0xdb;
			frame[f++] = 0xdd;
		} else {
			frame[f++] = c;
		}
	}
	frame[f++] = 0xc0;
	if (!port_write(p, frame, f))
		return -2;
	for (;;) {
		left = (int)(end - now_ms());
		if (left <= 0)
			return -1;
		r = slip_read(p, pkt, sizeof(pkt), left);
		if (r == -2)
			return -2;
		if (r < 0)
			return -1;
		if (r < 8 || pkt[0] != 0x01)
			continue;
		if (pkt[1] != op) {
			/* One the ROM did not know: it says so, maybe more than once */
			if (r >= 10 && pkt[8] && pkt[9] == INVALID_MSG) {
				drain(p, 200);
				fail("the chip's loader does not know command 0x%02x", op);
				return -2;
			}
			continue;
		}
		if (val)
			*val = get32(pkt + 4);
		r -= 8;
		if (out)
			memcpy(out, pkt + 8, (size_t)r < cap ? (size_t)r : cap);
		return r;
	}
}

/* A command that must succeed: want, the bytes of data the answer has
 * before its two status bytes (the ROM sends two more, unused) */
static bool check(struct port *p, const char *what, uint8_t op, const uint8_t *d, size_t n, uint32_t chk,
		  size_t want, int ms, uint32_t *val, uint8_t *out, size_t cap)
{
	uint8_t buf[256];
	int r = command(p, op, d, n, chk, ms, val, buf, sizeof(buf));

	if (r == -1)
		return fail("no answer to %s", what);
	if (r < 0)
		return fail("%s: %s", what, err[0] ? err : "failed");
	if ((size_t)r < want + 2) {
		if (r >= 2 && buf[0])
			return fail("%s failed: %s (0x%02x)", what, rom_error(buf[1]), buf[1]);
		return fail("%s: the answer was too short (%d bytes)", what, r);
	}
	if (buf[want])
		return fail("%s failed: %s (0x%02x)", what, rom_error(buf[want + 1]), buf[want + 1]);
	if (out && want)
		memcpy(out, buf, want < cap ? want : cap);
	return true;
}

static bool read_reg(struct port *p, uint32_t addr, uint32_t *v)
{
	uint8_t a[4];

	put32(a, addr);
	return check(p, "reading a register", OP_READ_REG, a, 4, 0, 0, CMD_MS, v, NULL, 0);
}

static bool sync_once(struct port *p)
{
	uint8_t d[36];
	uint32_t v = 0;

	d[0] = 0x07;
	d[1] = 0x07;
	d[2] = 0x12;
	d[3] = 0x20;
	memset(d + 4, 0x55, 32);
	if (command(p, OP_SYNC, d, sizeof(d), 0, SYNC_MS, &v, NULL, 0) < 0)
		return false;
	/* (it answers one SYNC eight times) */
	drain(p, 100);
	return true;
}

/* Into the ROM loader, and talking: a few resets, each way there is for
 * the port, with a few SYNCs after each */
static bool connect(struct port *p)
{
	int attempt, i;

	for (attempt = 0; attempt < 8; attempt++) {
		if (p->usb_jtag)
			reset_usb_jtag(p);
		else if (attempt % 2 == 0)
			reset_tight(p, attempt & 2 ? 550 : 50);
		else
			reset_classic(p, attempt & 2 ? 550 : 50);
		/* (what it printed coming up is not wanted) */
		sleep_ms(50);
		port_flush(p);
		for (i = 0; i < 5; i++)
			if (sync_once(p))
				return true;
	}
	return fail("the chip did not answer in its loader (is it an ESP32? a board whose "
		    "BOOT button must be held while it is reset?)");
}

/* What chip it is: by the chip id GET_SECURITY_INFO gives (20 bytes: its
 * flags, a count, seven key purposes, the chip id, its ECO version); the
 * first ESP32 knows no such command, and the S2 gives no chip id: those
 * are told by MAGIC_REG */
static const struct chip *detect(struct port *p)
{
	uint8_t info[20];
	uint32_t v, id;
	size_t i;

	if (check(p, "asking what chip it is", OP_SECURITY_INFO, NULL, 0, 0, sizeof(info), CMD_MS,
		  NULL, info, sizeof(info))) {
		id = get32(info + 12);
		for (i = 0; i < NCHIPS; i++)
			if (CHIPS[i].id == (int)id && !CHIPS[i].magic)
				return &CHIPS[i];
		fail("a chip this does not know (chip id %u)", id);
		return NULL;
	}
	drain(p, 100);
	if (!read_reg(p, MAGIC_REG, &v))
		return NULL;
	for (i = 0; i < NCHIPS; i++)
		if (CHIPS[i].magic && CHIPS[i].magic == v)
			return &CHIPS[i];
	fail("a chip this does not know (0x%08x at 0x%08x)", v, MAGIC_REG);
	return NULL;
}

/* Its MAC address: two eFuse words, the higher one's two lowest bytes first */
static bool read_mac(struct port *p, const struct chip *c, uint8_t mac[6])
{
	uint32_t lo, hi;

	if (c->mac_reg) {
		if (!read_reg(p, c->mac_reg, &lo) || !read_reg(p, c->mac_reg + 4, &hi))
			return false;
	} else {
		/* (the first ESP32: words 1 and 2 of its first eFuse block) */
		if (!read_reg(p, ESP32_EFUSE + 4, &lo) || !read_reg(p, ESP32_EFUSE + 8, &hi))
			return false;
	}
	mac[0] = hi >> 8;
	mac[1] = hi;
	mac[2] = lo >> 24;
	mac[3] = lo >> 16;
	mac[4] = lo >> 8;
	mac[5] = lo;
	return true;
}

/* ---------- writing ---------- */

struct image {
	uint32_t at;
	const char *path;
	uint8_t *d;
	size_t n;
};

static const char *chip_named(int id)
{
	size_t i;

	for (i = 0; i < NCHIPS; i++)
		if (CHIPS[i].id == id)
			return CHIPS[i].name;
	return "a chip this does not know";
}

/* Is a file fit for this chip, where it is to go? Where a firmware image
 * (0xE9) begins in it, at the bootloader's place or at its own start, its
 * header says what chip it was made for (bytes 12 and 13); and a
 * bootloader goes where the chip looks for it */
static bool fit(const struct chip *c, const struct image *im)
{
	size_t at;
	int id;

	if (im->at <= c->boot_at && c->boot_at < im->at + im->n && im->d[c->boot_at - im->at] == 0xe9)
		at = c->boot_at - im->at;
	else if (im->n && im->d[0] == 0xe9)
		at = 0;
	else
		return true;
	if (at + 24 > im->n)
		return fail("%s: an image too short to be one", im->path);
	id = im->d[at + 12] | im->d[at + 13] << 8;
	if (id != c->id)
		return fail("%s is made for %s, and the board has %s", im->path, chip_named(id), c->name);
	if (im->at + at < 0x8000 && im->at + at != c->boot_at)
		return fail("%s: a bootloader at 0x%x, where %s looks for it at 0x%x",
			    im->path, (unsigned)(im->at + at), c->name, (unsigned)c->boot_at);
	return true;
}

/* What the chip has in its flash from at, n bytes, as an MD5 sum (32 hex
 * digits, as the ROM gives it) */
static bool flash_md5(struct port *p, uint32_t at, uint32_t n, char out[33])
{
	uint8_t req[16], got[32];
	int i;

	put32(req, at);
	put32(req + 4, n);
	put32(req + 8, 0);
	put32(req + 12, 0);
	if (!check(p, "reading its flash as an MD5 sum", OP_SPI_FLASH_MD5, req, 16, 0, sizeof(got),
		   ms_for(n, MD5_MS_MB), NULL, got, sizeof(got)))
		return false;
	for (i = 0; i < 32; i++) {
		if (!((got[i] >= '0' && got[i] <= '9') || ((got[i] | 0x20) >= 'a' && (got[i] | 0x20) <= 'f')))
			return fail("its MD5 sum came back as no hex digits");
		out[i] = got[i] | 0x20;
	}
	out[32] = 0;
	return true;
}

static bool write_image(struct port *p, const struct chip *c, const struct image *im)
{
	static uint8_t data[16 + BLOCK];
	uint8_t begin[20];
	uint32_t blocks = (im->n + BLOCK - 1) / BLOCK, seq, chk;
	char want[33], got[33];
	struct md5 m;
	size_t off, take, i;
	int tries, pct = -1;

	put32(begin, im->n);
	put32(begin + 4, blocks);
	put32(begin + 8, BLOCK);
	put32(begin + 12, im->at);
	put32(begin + 16, 0);
	fprintf(stderr, "0x%06x %s: erasing %zu bytes\n", (unsigned)im->at, im->path, im->n);
	if (!check(p, "beginning to write", OP_FLASH_BEGIN, begin, c->begin5 ? 20 : 16, 0, 0,
		   ms_for(im->n, ERASE_MS_MB), NULL, NULL, 0))
		return false;
	for (seq = 0; seq < blocks; seq++) {
		off = (size_t)seq * BLOCK;
		take = im->n - off < BLOCK ? im->n - off : BLOCK;
		put32(data, BLOCK);
		put32(data + 4, seq);
		put32(data + 8, 0);
		put32(data + 12, 0);
		memcpy(data + 16, im->d + off, take);
		/* (the last block filled out as erased flash is) */
		memset(data + 16 + take, 0xff, BLOCK - take);
		chk = CHECKSUM_SEED;
		for (i = 0; i < BLOCK; i++)
			chk ^= data[16 + i];
		for (tries = 0;; tries++) {
			if (check(p, "writing", OP_FLASH_DATA, data, sizeof(data), chk, 0, CMD_MS, NULL, NULL, 0))
				break;
			if (tries == 2)
				return fail("block %u of %s: %s", seq, im->path, err);
		}
		if ((int)(100 * (seq + 1) / blocks) / 10 != pct) {
			pct = (int)(100 * (seq + 1) / blocks) / 10;
			fprintf(stderr, "0x%06x %s: %d%%\n", (unsigned)im->at, im->path, pct * 10);
		}
	}
	/* What it has now, read back */
	if (!flash_md5(p, im->at, im->n, got))
		return false;
	md5_init(&m);
	md5_add(&m, im->d, im->n);
	md5_hex(&m, want);
	if (strcmp(got, want))
		return fail("%s read back otherwise than it was written (MD5 %s, not %s)", im->path, got, want);
	fprintf(stderr, "0x%06x %s: written, and read back the same (MD5 %s)\n", (unsigned)im->at, im->path, want);
	return true;
}

/* The flash set up for writing: attached (on the chips that can have it
 * on other pins: the usual ones), and its size; esptool's when it cannot
 * tell, 4 MB, or as much as the images need */
static bool flash_setup(struct port *p, uint32_t end)
{
	uint8_t attach[8] = { 0 }, params[24];
	uint32_t size = 4u << 20;

	while (size < end)
		size <<= 1;
	if (!check(p, "attaching its flash", OP_SPI_ATTACH, attach, sizeof(attach), 0, 0, CMD_MS, NULL, NULL, 0))
		return false;
	put32(params, 0);
	put32(params + 4, size);
	put32(params + 8, 64 * 1024);
	put32(params + 12, 4 * 1024);
	put32(params + 16, 256);
	put32(params + 20, 0xffff);
	return check(p, "setting up its flash", OP_SPI_SET_PARAMS, params, sizeof(params), 0, 0, CMD_MS, NULL, NULL, 0);
}

static bool load(struct image *im)
{
	struct stat st;
	FILE *f = fopen(im->path, "rb");

	if (!f)
		return fail("can't open %s: %s", im->path, strerror(errno));
	if (fstat(fileno(f), &st) || st.st_size <= 0 || (uint64_t)st.st_size > MAX_IMAGE) {
		fclose(f);
		return fail("%s: empty, or larger than 16 MB", im->path);
	}
	im->n = (size_t)st.st_size;
	im->d = malloc(im->n);
	if (!im->d || fread(im->d, 1, im->n, f) != im->n) {
		fclose(f);
		return fail("can't read %s", im->path);
	}
	fclose(f);
	return true;
}

/* ---------- what it is asked ---------- */

static void json_str(const char *s)
{
	putchar('"');
	for (; *s; s++) {
		if (*s == '"' || *s == '\\')
			printf("\\%c", *s);
		else if ((unsigned char)*s < 0x20)
			printf("\\u%04x", *s);
		else
			putchar(*s);
	}
	putchar('"');
}

static int answer_error(void)
{
	printf("{\"error\":");
	json_str(err);
	printf("}\n");
	return 1;
}

static void answer_board(struct port *p, const struct chip *c, const uint8_t mac[6], bool more)
{
	printf("{\"chip\":\"%s\",\"chip_id\":%d,\"mac\":\"%02x:%02x:%02x:%02x:%02x:%02x\",\"usb\":",
	       c->name, c->id, mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
	json_str(p->usb);
	printf(",\"usb_jtag\":%s,\"bootloader_at\":%u%s", p->usb_jtag ? "true" : "false",
	       (unsigned)c->boot_at, more ? "" : "}\n");
}

static unsigned long number(const char *s, bool *ok)
{
	char *end;
	unsigned long v;

	errno = 0;
	v = strtoul(s, &end, 0);
	*ok = !errno && end != s && !*end;
	return v;
}

static int usage(void)
{
	fprintf(stderr, "usage: pirate-esp identify <tty>\n"
			"       pirate-esp md5 <tty> <offset> <size>\n"
			"       pirate-esp flash <tty> <offset> <file> [<offset> <file> ...]\n");
	return 2;
}

int main(int argc, char **argv)
{
	struct port p;
	const struct chip *c;
	struct image ims[8];
	uint8_t mac[6];
	uint32_t end = 0, md5_at = 0, md5_n = 0;
	char sum[33];
	int n = 0, i, j;
	bool ok, ok2, flash, md5;

	if (argc < 3)
		return usage();
	flash = !strcmp(argv[1], "flash");
	md5 = !strcmp(argv[1], "md5");
	if (!flash && !md5 && strcmp(argv[1], "identify"))
		return usage();
	if (md5) {
		if (argc != 5)
			return usage();
		md5_at = number(argv[3], &ok);
		md5_n = number(argv[4], &ok2);
		if (!ok || !ok2 || !md5_n || md5_at >= MAX_IMAGE || md5_n > MAX_IMAGE - md5_at) {
			fail("%s %s: not a part of flash (an offset and a size, within 16 MB)", argv[3], argv[4]);
			return answer_error();
		}
		end = md5_at + md5_n;
	} else if (!flash && argc != 3) {
		return usage();
	}
	if (flash) {
		if (argc < 5 || (argc - 3) % 2 || (argc - 3) / 2 > 8)
			return usage();
		for (i = 3; i < argc; i += 2) {
			struct image *im = &ims[n++];

			im->at = number(argv[i], &ok);
			im->path = argv[i + 1];
			if (!ok || im->at >= MAX_IMAGE || im->at % 0x1000) {
				fail("%s: not an offset in flash on a 4 KB boundary", argv[i]);
				return answer_error();
			}
			if (!load(im))
				return answer_error();
			if (im->at + im->n > end)
				end = im->at + im->n;
		}
		for (i = 0; i < n; i++)
			for (j = 0; j < n; j++)
				if (i != j && ims[i].at <= ims[j].at && ims[j].at < ims[i].at + ims[i].n) {
					fail("%s and %s overlap", ims[i].path, ims[j].path);
					return answer_error();
				}
	}
	if (!port_open(&p, argv[2]))
		return answer_error();
	if (!connect(&p) || !(c = detect(&p)) || !read_mac(&p, c, mac)) {
		/* (whatever happened, the board is let go to run what it has) */
		reset_run(&p);
		return answer_error();
	}
	if (md5) {
		/* (nothing is written: the chip reads what it has) */
		if (!flash_setup(&p, end) || !flash_md5(&p, md5_at, md5_n, sum)) {
			reset_run(&p);
			return answer_error();
		}
		reset_run(&p);
		answer_board(&p, c, mac, true);
		printf(",\"md5\":{\"offset\":%u,\"size\":%u,\"sum\":\"%s\"}}\n", (unsigned)md5_at, (unsigned)md5_n, sum);
		return 0;
	}
	if (flash) {
		for (i = 0; i < n; i++)
			if (!fit(c, &ims[i])) {
				reset_run(&p);
				return answer_error();
			}
		if (!flash_setup(&p, end)) {
			reset_run(&p);
			return answer_error();
		}
		for (i = 0; i < n; i++)
			if (!write_image(&p, c, &ims[i])) {
				reset_run(&p);
				return answer_error();
			}
	}
	reset_run(&p);
	answer_board(&p, c, mac, flash);
	if (flash)
		printf(",\"written\":%d}\n", n);
	return 0;
}
