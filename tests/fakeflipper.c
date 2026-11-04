/*
 * fakeflipper: a Flipper Zero as pirate-flipper sees one, on a
 * pseudo-terminal, for testing pirate-flipper without one. At its CLI it
 * echoes what is typed; "start_rpc_session" starts its RPC session, where it
 * answers the requests pirate-flipper makes (after flipperzero-protobuf's
 * definitions) over a small file system in memory, and streams a screen that
 * changes as buttons are pressed.
 *
 *   fakeflipper [-l link]
 *
 *   -l  a symlink to its tty (default /tmp/fakeflipper)
 *
 * Prints an event a line to stdout: "cli <line>", "input <key> <type>",
 * "write <path> <bytes> <messages>", "delete <path>", "alert",
 * "time <yyyy-mm-dd hh:mm:ss> <weekday>", "stream on" / "stream off",
 * "reboot <mode>", "unknown <content field>". A reboot ends it, as a Flipper
 * leaves the USB bus when it restarts.
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
#include <termios.h>
#include <unistd.h>

static int mfd = -1;
static bool rpc, streaming;
static unsigned presses;

/* ---------- buffers and protobuf, as in pirate-flipper ---------- */

struct buf {
	uint8_t *d;
	size_t len, cap;
};

static void buf_add(struct buf *b, const void *p, size_t n)
{
	if (!n)
		return;
	if (b->len + n > b->cap) {
		size_t c = b->cap ? b->cap : 256;

		while (c < b->len + n)
			c *= 2;
		b->d = realloc(b->d, c);
		if (!b->d)
			exit(1);
		b->cap = c;
	}
	memcpy(b->d + b->len, p, n);
	b->len += n;
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

/* ---------- the serial port ---------- */

static void out(const void *p, size_t n)
{
	const uint8_t *c = p;
	ssize_t w;

	while (n) {
		w = write(mfd, c, n);
		if (w < 0) {
			if (errno == EINTR || errno == EAGAIN) {
				usleep(1000);
				continue;
			}
			exit(1);
		}
		c += w;
		n -= w;
	}
}

static void send_main(uint32_t id, unsigned status, bool has_next, unsigned field, const struct buf *body)
{
	struct buf m = { 0 }, f = { 0 };

	pb_uint(&m, 1, id);
	pb_uint(&m, 2, status);
	if (has_next)
		pb_uint(&m, 3, 1);
	pb_bytes(&m, field, body ? body->d : NULL, body ? body->len : 0);
	pb_varint(&f, m.len);
	buf_add(&f, m.d, m.len);
	out(f.d, f.len);
	buf_free(&m);
	buf_free(&f);
}

static void send_status(uint32_t id, unsigned status)
{
	send_main(id, status, false, 4, NULL);
}

/* ---------- the file system ---------- */

struct ent {
	bool used, dir;
	char path[256];
	struct buf data;
};

static struct ent fs[256];

static bool is_dir(const char *path)
{
	int i;

	if (!strcmp(path, "/"))
		return true;
	for (i = 0; i < 256; i++)
		if (fs[i].used && fs[i].dir && !strcmp(fs[i].path, path))
			return true;
	return false;
}

static struct ent *find(const char *path)
{
	int i;

	for (i = 0; i < 256; i++)
		if (fs[i].used && !strcmp(fs[i].path, path))
			return &fs[i];
	return NULL;
}

static struct ent *add(const char *path, bool dir, const void *data, size_t n)
{
	int i;

	for (i = 0; i < 256; i++)
		if (!fs[i].used) {
			fs[i].used = true;
			fs[i].dir = dir;
			snprintf(fs[i].path, sizeof(fs[i].path), "%s", path);
			fs[i].data.len = 0;
			buf_add(&fs[i].data, data, n);
			return &fs[i];
		}
	return NULL;
}

static void parent_of(const char *path, char *p)
{
	char *s;

	strcpy(p, path);
	s = strrchr(p, '/');
	if (s == p)
		p[1] = 0;
	else if (s)
		*s = 0;
}

static bool in_dir(const struct ent *e, const char *dir)
{
	char p[256];

	parent_of(e->path, p);
	return !strcmp(p, dir);
}

/* Under dir, at any depth */
static bool under(const struct ent *e, const char *dir)
{
	size_t n = strlen(dir);

	return !strncmp(e->path, dir, n) && e->path[n] == '/';
}

static void fs_init(void)
{
	char p[64];
	int i;

	add("/int", true, NULL, 0);
	add("/ext", true, NULL, 0);
	add("/ext/subghz", true, NULL, 0);
	add("/ext/infrared", true, NULL, 0);
	add("/ext/notes.txt", false, "hello flipper\n", 14);
	add("/ext/subghz/garage.sub", false, "Filetype: Flipper SubGhz Key File\n", 34);
	add("/ext/many", true, NULL, 0);
	for (i = 0; i < 10; i++) {
		snprintf(p, sizeof(p), "/ext/many/f%d", i);
		add(p, false, "x", 1);
	}
}

/* ---------- RPC ---------- */

static const char *const KEYS[] = { "up", "down", "right", "left", "ok", "back" };
static const char *const TYPES[] = { "press", "release", "short", "long", "repeat" };
static const char *const MODES[] = { "os", "dfu", "update" };

static void send_frame(void)
{
	uint8_t px[1024];
	struct buf f = { 0 };

	memset(px, 0, sizeof(px));
	px[0] = presses;
	px[1] = 0xff;
	pb_bytes(&f, 1, px, sizeof(px));
	send_main(0, 0, false, 22, &f);
	buf_free(&f);
}

static void send_pairs(uint32_t id, unsigned field, const char *const *kv)
{
	struct buf b = { 0 };
	int i;

	for (i = 0; kv[i]; i += 2) {
		b.len = 0;
		pb_str(&b, 1, kv[i]);
		pb_str(&b, 2, kv[i + 1]);
		send_main(id, 0, kv[i + 2] != NULL, field, &b);
	}
	buf_free(&b);
}

static void do_list(uint32_t id, const char *path)
{
	struct buf resp = { 0 }, file = { 0 };
	int i, total = 0, n = 0;

	if (!is_dir(path)) {
		send_status(id, 7);
		return;
	}
	for (i = 0; i < 256; i++)
		if (fs[i].used && in_dir(&fs[i], path))
			total++;
	if (!total) {
		send_main(id, 0, false, 8, NULL);
		return;
	}
	for (i = 0; i < 256; i++) {
		if (!fs[i].used || !in_dir(&fs[i], path))
			continue;
		file.len = 0;
		pb_uint(&file, 1, fs[i].dir);
		pb_str(&file, 2, strrchr(fs[i].path, '/') + 1);
		pb_uint(&file, 3, fs[i].dir ? 0 : fs[i].data.len);
		pb_bytes(&resp, 1, file.d, file.len);
		n++;
		if (n % 8 == 0 || n == total) {
			send_main(id, 0, n < total, 8, &resp);
			resp.len = 0;
		}
	}
	buf_free(&resp);
	buf_free(&file);
}

static void do_read(uint32_t id, const char *path)
{
	struct ent *e = find(path);
	struct buf file = { 0 }, resp = { 0 };
	size_t off = 0, n;

	if (!e || e->dir) {
		send_status(id, 7);
		return;
	}
	do {
		n = e->data.len - off < 512 ? e->data.len - off : 512;
		file.len = resp.len = 0;
		if (n)
			pb_bytes(&file, 4, e->data.d + off, n);
		pb_bytes(&resp, 1, file.d, file.len);
		off += n;
		send_main(id, 0, off < e->data.len, 10, &resp);
	} while (off < e->data.len);
	buf_free(&file);
	buf_free(&resp);
}

static struct {
	bool on;
	uint32_t id;
	char path[256];
	struct buf data;
	int msgs;
} wr;

static void do_write(uint32_t id, bool has_next, const uint8_t *b, size_t n)
{
	char path[256], parent[256];
	struct pbf f, d;
	struct ent *e;

	pb_get_str(b, n, 1, path, sizeof(path));
	if (!wr.on || wr.id != id || strcmp(wr.path, path)) {
		parent_of(path, parent);
		if (!is_dir(parent)) {
			send_status(id, 7);
			return;
		}
		wr.on = true;
		wr.id = id;
		snprintf(wr.path, sizeof(wr.path), "%s", path);
		wr.data.len = 0;
		wr.msgs = 0;
	}
	if (pb_field(b, n, 2, &f) && f.wt == 2 && pb_field(f.p, f.len, 4, &d) && d.wt == 2)
		buf_add(&wr.data, d.p, d.len);
	wr.msgs++;
	if (has_next)
		return;
	wr.on = false;
	e = find(path);
	if (e && e->dir) {
		send_status(id, 6);
		return;
	}
	if (!e)
		e = add(path, false, NULL, 0);
	e->data.len = 0;
	buf_add(&e->data, wr.data.d, wr.data.len);
	printf("write %s %zu %d\n", path, wr.data.len, wr.msgs);
	send_status(id, 0);
}

static void do_delete(uint32_t id, const char *path, bool recursive)
{
	struct ent *e = find(path);
	bool children = false;
	int i;

	if (!e) {
		send_status(id, 7);
		return;
	}
	for (i = 0; i < 256; i++)
		if (fs[i].used && under(&fs[i], path))
			children = true;
	if (children && !recursive) {
		send_status(id, 18);
		return;
	}
	for (i = 0; i < 256; i++)
		if (fs[i].used && under(&fs[i], path))
			fs[i].used = false;
	e->used = false;
	printf("delete %s\n", path);
	send_status(id, 0);
}

static void do_mkdir(uint32_t id, const char *path)
{
	char parent[256];

	if (find(path)) {
		send_status(id, 6);
		return;
	}
	parent_of(path, parent);
	if (!is_dir(parent)) {
		send_status(id, 7);
		return;
	}
	add(path, true, NULL, 0);
	send_status(id, 0);
}

static void do_rename(uint32_t id, const char *from, const char *to)
{
	struct ent *e = find(from);
	size_t n = strlen(from);
	char p[256];
	int i;

	if (!e) {
		send_status(id, 7);
		return;
	}
	if (find(to)) {
		send_status(id, 6);
		return;
	}
	for (i = 0; i < 256; i++)
		if (fs[i].used && under(&fs[i], from)) {
			snprintf(p, sizeof(p), "%s%s", to, fs[i].path + n);
			strcpy(fs[i].path, p);
		}
	snprintf(e->path, sizeof(e->path), "%s", to);
	send_status(id, 0);
}

static void on_msg(const uint8_t *p, size_t n)
{
	static const char *const info[] = {
		"hardware_model", "Flipper Zero", "hardware_name", "Pirate",
		"firmware_version", "1.3.4", "firmware_branch", "release",
		"firmware_commit", "a1b2c3d4", "firmware_build_date", "04-11-2026",
		"radio.alive", "true", NULL
	};
	static const char *const power[] = {
		"charge_level", "87", "charge_state", "charging", "battery_voltage", "4.05", NULL
	};
	const uint8_t *q = p, *end = p + n, *body = NULL;
	char s1[256], s2[256];
	unsigned content = 0;
	uint32_t id = 0;
	bool has_next = false;
	size_t len = 0;
	struct buf b = { 0 };
	struct pbf f;

	while (pb_next(&q, end, &f) == 1) {
		if (f.wt == 0 && f.field == 1)
			id = f.v;
		else if (f.wt == 0 && f.field == 3)
			has_next = f.v;
		else if (f.wt == 2 && f.field >= 4) {
			content = f.field;
			body = f.p;
			len = f.len;
		}
	}
	/* Another request in the middle of a file being written */
	if (wr.on && content != 11) {
		send_status(wr.id, 14);
		wr.on = false;
	}
	switch (content) {
	case 5: /* ping */
		if (pb_field(body, len, 1, &f) && f.wt == 2)
			pb_bytes(&b, 1, f.p, f.len);
		send_main(id, 0, false, 6, &b);
		break;
	case 39: /* protobuf version */
		pb_uint(&b, 2, 25);
		send_main(id, 0, false, 40, &b);
		break;
	case 32:
		send_pairs(id, 33, info);
		break;
	case 44:
		send_pairs(id, 45, power);
		break;
	case 28: /* storage info */
		pb_get_str(body, len, 1, s1, sizeof(s1));
		if (!strcmp(s1, "/ext")) {
			pb_uint(&b, 1, 31914983424ULL);
			pb_uint(&b, 2, 30000000000ULL);
		} else if (!strcmp(s1, "/int")) {
			pb_uint(&b, 1, 262144);
			pb_uint(&b, 2, 131072);
		} else {
			send_status(id, 7);
			break;
		}
		send_main(id, 0, false, 29, &b);
		break;
	case 7:
		pb_get_str(body, len, 1, s1, sizeof(s1));
		do_list(id, s1);
		break;
	case 9:
		pb_get_str(body, len, 1, s1, sizeof(s1));
		do_read(id, s1);
		break;
	case 11:
		do_write(id, has_next, body, len);
		break;
	case 12:
		pb_get_str(body, len, 1, s1, sizeof(s1));
		do_delete(id, s1, pb_get_uint(body, len, 2));
		break;
	case 13:
		pb_get_str(body, len, 1, s1, sizeof(s1));
		do_mkdir(id, s1);
		break;
	case 30:
		pb_get_str(body, len, 1, s1, sizeof(s1));
		pb_get_str(body, len, 2, s2, sizeof(s2));
		do_rename(id, s1, s2);
		break;
	case 20:
		send_status(id, 0);
		streaming = true;
		printf("stream on\n");
		send_frame();
		break;
	case 21:
		streaming = false;
		printf("stream off\n");
		send_status(id, 0);
		break;
	case 23: {
		unsigned key = pb_get_uint(body, len, 1), type = pb_get_uint(body, len, 2);

		printf("input %s %s\n", key < 6 ? KEYS[key] : "?", type < 5 ? TYPES[type] : "?");
		send_status(id, 0);
		if (type == 2) {
			presses++;
			if (streaming)
				send_frame();
		}
		break;
	}
	case 38:
		printf("alert\n");
		send_status(id, 0);
		break;
	case 37:
		if (pb_field(body, len, 1, &f) && f.wt == 2)
			printf("time %04u-%02u-%02u %02u:%02u:%02u %u\n",
			       (unsigned)pb_get_uint(f.p, f.len, 6), (unsigned)pb_get_uint(f.p, f.len, 5),
			       (unsigned)pb_get_uint(f.p, f.len, 4), (unsigned)pb_get_uint(f.p, f.len, 1),
			       (unsigned)pb_get_uint(f.p, f.len, 2), (unsigned)pb_get_uint(f.p, f.len, 3),
			       (unsigned)pb_get_uint(f.p, f.len, 7));
		send_status(id, 0);
		break;
	case 31: {
		unsigned mode = pb_get_uint(body, len, 1);

		printf("reboot %s\n", mode < 3 ? MODES[mode] : "?");
		exit(0);
	}
	default:
		printf("unknown %u\n", content);
		send_status(id, 3);
		break;
	}
	buf_free(&b);
}

static void on_rpc(struct buf *in)
{
	for (;;) {
		const uint8_t *p = in->d;
		uint64_t n;
		int r = pb_varint_get(&p, in->d + in->len, &n);

		if (r == 0)
			return;
		if (r < 0) {
			printf("garbled\n");
			exit(1);
		}
		if ((size_t)(in->d + in->len - p) < n)
			return;
		on_msg(p, n);
		buf_drop(in, (p - in->d) + n);
	}
}

int main(int argc, char **argv)
{
	const char *link = "/tmp/fakeflipper";
	struct buf in = { 0 };
	char line[256];
	size_t ll = 0;
	struct termios t;
	struct pollfd pfd;
	uint8_t tmp[4096];
	ssize_t r, i;
	int c, sfd;

	while ((c = getopt(argc, argv, "l:")) != -1) {
		if (c == 'l')
			link = optarg;
		else
			return 2;
	}
	setvbuf(stdout, NULL, _IOLBF, 0);
	fs_init();
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
	printf("ready %s\n", ptsname(mfd));
	pfd.fd = mfd;
	pfd.events = POLLIN;
	for (;;) {
		if (poll(&pfd, 1, -1) < 0) {
			if (errno == EINTR)
				continue;
			return 1;
		}
		r = read(mfd, tmp, sizeof(tmp));
		if (r < 0 && (errno == EINTR || errno == EAGAIN))
			continue;
		if (r <= 0)
			return 1;
		for (i = 0; i < r && !rpc; i++) {
			/* The CLI: echo, and run the line on Enter */
			if (tmp[i] == '\r') {
				out("\r\n", 2);
				line[ll] = 0;
				printf("cli %s\n", line);
				ll = 0;
				if (!strcmp(line, "start_rpc_session"))
					rpc = true;
				else
					out(">: ", 3);
			} else if (tmp[i] != '\n') {
				out(&tmp[i], 1);
				if (ll < sizeof(line) - 1)
					line[ll++] = tmp[i];
			}
		}
		if (rpc && i < r) {
			buf_add(&in, tmp + i, r - i);
			on_rpc(&in);
		}
	}
}
