/*
 * fakeportapack: a HackRF/PortaPack on Mayhem firmware, in its device mode, as
 * pirate-portapack sees one, on a pseudo-terminal, for testing pirate-portapack
 * without one. It speaks Mayhem's serial command shell: a "ch> " prompt, a line
 * a command, the answer then the prompt again. It keeps a small file system in
 * memory and draws a screen that changes as buttons move the selection.
 *
 *   fakeportapack [-l link]
 *
 *   -l  a symlink to its tty (default /tmp/fakeportapack)
 *
 * Prints an event a line to stdout: "info", "getres", "getdevtype",
 * "button <n>", "touch <x> <y>", "keyboard <hex>", "write <path> <bytes>",
 * "delete <path>", "mkdir <path>", "flash <path>", "reboot", "dfu", "hackrf".
 * A reboot / dfu / hackrf / flash ends it, as the device leaves the USB bus.
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

#define SCR_W 60
#define SCR_H 80
#define MAXENT 64
#define LINEMAX 512

static int mfd = -1;
static int sel = 0;

/* ---------- a tiny in-memory file system ---------- */

struct ent {
	char path[128];
	int dir;
	unsigned char *data;
	size_t len, cap;
};
static struct ent fs[MAXENT];
static int nfs;

static struct ent *fs_find(const char *path)
{
	int i;

	for (i = 0; i < nfs; i++)
		if (!strcmp(fs[i].path, path))
			return &fs[i];
	return NULL;
}

static struct ent *fs_add(const char *path, int dir)
{
	struct ent *e;

	if (nfs >= MAXENT)
		return NULL;
	e = &fs[nfs++];
	memset(e, 0, sizeof(*e));
	snprintf(e->path, sizeof(e->path), "%s", path);
	e->dir = dir;
	return e;
}

static void fs_set(struct ent *e, const char *s)
{
	e->len = strlen(s);
	e->cap = e->len + 1;
	e->data = malloc(e->cap);
	memcpy(e->data, s, e->len);
}

static void fs_init(void)
{
	fs_add("/FIRMWARE", 1);
	fs_add("/APPS", 1);
	fs_set(fs_add("/APPS/analogtv.ppma", 0), "APPMA-demo-binary-content");
	fs_add("/SETTINGS", 1);
	fs_set(fs_add("/SETTINGS/receiver.ini", 0), "freq=433920000\n");
	fs_set(fs_add("/notes.txt", 0), "pirate radio\n");
}

/* parent("/APPS/x")="/APPS"; parent("/x")="/" */
static void parent_of(const char *path, char *out, size_t n)
{
	const char *slash = strrchr(path, '/');

	if (!slash) {
		out[0] = 0;
		return;
	}
	if (slash == path)
		snprintf(out, n, "/");
	else
		snprintf(out, n, "%.*s", (int)(slash - path), path);
}

/* ---------- the serial port ---------- */

static void out(const void *p, size_t n)
{
	const char *b = p;
	size_t w = 0;
	ssize_t r;

	while (w < n) {
		r = write(mfd, b + w, n - w);
		if (r > 0)
			w += r;
		else if (r < 0 && (errno == EINTR || errno == EAGAIN))
			continue;
		else
			return;
	}
}

static void outs(const char *s)
{
	out(s, strlen(s));
}

static void prompt(void)
{
	outs("ch> ");
}

/* the open file (one at a time, as the shell keeps) */
static struct ent *open_file;
static size_t open_pos;
static int open_written;

/* fwb: consuming raw bytes into the open file */
static long expect_bytes;

/* ---------- commands ---------- */

static void cmd_info(void)
{
	outs("Kernel:           2.6.x\r\n");
	outs("Mayhem Version:   v2.4.0\r\n");
	outs("HackRF Board Rev: HackRF R9\r\n");
	outs("Device:           HackRF One\r\n");
	outs("Flash Allowed:    1MB\r\n");
	outs("Reference Source: internal\r\n");
	printf("info\n");
}

static void cmd_screenframeshort(void)
{
	char row[SCR_W + 3];
	int x, y;

	for (y = 0; y < SCR_H; y++) {
		/* Every 16th row all-black (0x20): a daemon that trims trailing
		 * blanks like a text line would drop these and squash the picture. */
		for (x = 0; x < SCR_W; x++)
			row[x] = (y % 16 == 0) ? 0x20 : (char)(0x20 + ((x + y + sel * 7) & 0x3f));
		row[SCR_W] = '\r';
		row[SCR_W + 1] = '\n';
		out(row, SCR_W + 2);
	}
	outs("\r\nok\r\n");
}

static void hexout(const unsigned char *p, size_t n)
{
	static const char h[] = "0123456789ABCDEF";
	char line[62 * 2 + 3];
	size_t i, w = 0;

	for (i = 0; i < n; i++) {
		line[w++] = h[p[i] >> 4];
		line[w++] = h[p[i] & 15];
		if ((i % 62) == 61) {
			line[w++] = '\r';
			line[w++] = '\n';
			out(line, w);
			w = 0;
		}
	}
	if (w) {
		line[w++] = '\r';
		line[w++] = '\n';
		out(line, w);
	}
}

/* run one command line; returns 1 to keep going, 0 to exit the device */
static int run(const char *line)
{
	char cmd[LINEMAX], *arg;

	snprintf(cmd, sizeof(cmd), "%s", line);
	arg = strchr(cmd, ' ');
	if (arg)
		*arg++ = 0;

	if (!*cmd)
		return 1;
	if (!strcmp(cmd, "info")) {
		cmd_info();
	} else if (!strcmp(cmd, "getres")) {
		char b[32];

		snprintf(b, sizeof(b), "%dx%d\r\nok\r\n", SCR_W, SCR_H);
		outs(b);
		printf("getres\n");
	} else if (!strcmp(cmd, "getdevtype")) {
		outs("PORTAPACK\r\nok\r\n");
		printf("getdevtype\n");
	} else if (!strcmp(cmd, "screenframeshort")) {
		cmd_screenframeshort();
	} else if (!strcmp(cmd, "button")) {
		int n = arg ? atoi(arg) : 0;

		if (n == 3)
			sel = (sel + 1) & 7;
		else if (n == 4)
			sel = (sel + 7) & 7;
		outs("ok\r\n");
		printf("button %d\n", n);
	} else if (!strcmp(cmd, "touch")) {
		outs("ok\r\n");
		printf("touch %s\n", arg ? arg : "");
	} else if (!strcmp(cmd, "keyboard")) {
		outs("ok\r\n");
		printf("keyboard %s\n", arg ? arg : "");
	} else if (!strcmp(cmd, "ls")) {
		char par[128];
		int i;

		for (i = 0; i < nfs; i++) {
			parent_of(fs[i].path, par, sizeof(par));
			if (arg && !strcmp(par, arg)) {
				const char *name = strrchr(fs[i].path, '/') + 1;
				char b[160];

				snprintf(b, sizeof(b), "%s%s\r\n", name, fs[i].dir ? "/" : "");
				outs(b);
			}
		}
	} else if (!strcmp(cmd, "filesize")) {
		struct ent *e = arg ? fs_find(arg) : NULL;

		if (e && !e->dir) {
			char b[48];

			snprintf(b, sizeof(b), "%zu\r\nok\r\n", e->len);
			outs(b);
		} else {
			outs("Error: no such file\r\n");
		}
	} else if (!strcmp(cmd, "fopen")) {
		struct ent *e = arg ? fs_find(arg) : NULL;

		if (!e && arg)
			e = fs_add(arg, 0);
		open_file = e;
		open_pos = 0;
		open_written = 0;
		outs("ok\r\n");
	} else if (!strcmp(cmd, "fseek")) {
		open_pos = arg ? (size_t)strtoul(arg, NULL, 10) : 0;
		outs("ok\r\n");
	} else if (!strcmp(cmd, "fread")) {
		size_t want = arg ? strtoul(arg, NULL, 10) : 0;

		if (open_file && open_pos < open_file->len) {
			size_t avail = open_file->len - open_pos;

			if (want > avail)
				want = avail;
			hexout(open_file->data + open_pos, want);
			open_pos += want;
		}
		outs("ok\r\n");
	} else if (!strcmp(cmd, "fwb")) {
		long n = arg ? atol(arg) : 0;
		char b[48];

		snprintf(b, sizeof(b), "send %ld bytes\r\n", n);
		outs(b);
		expect_bytes = n;
		if (expect_bytes == 0) {
			outs("ok\r\n");
			return 1;
		}
		return 1;   /* the prompt comes once the bytes are in */
	} else if (!strcmp(cmd, "ftruncate")) {
		if (open_file && open_pos < open_file->len)
			open_file->len = open_pos;
		outs("ok\r\n");
	} else if (!strcmp(cmd, "fsync")) {
		outs("ok\r\n");
	} else if (!strcmp(cmd, "fclose")) {
		if (open_file && open_written)
			printf("write %s %zu\n", open_file->path, open_file->len);
		open_file = NULL;
		open_written = 0;
		outs("ok\r\n");
	} else if (!strcmp(cmd, "mkdir")) {
		if (arg && fs_find(arg)) {
			outs("directory already exists.\r\n");
		} else if (arg) {
			fs_add(arg, 1);
			outs("ok\r\n");
			printf("mkdir %s\n", arg);
		}
	} else if (!strcmp(cmd, "unlink")) {
		struct ent *e = arg ? fs_find(arg) : NULL;

		if (!e) {
			outs("no such file\r\n");
		} else {
			int i = e - fs;

			free(e->data);
			fs[i] = fs[--nfs];
			outs("ok\r\n");
			printf("delete %s\n", arg);
		}
	} else if (!strcmp(cmd, "reboot")) {
		printf("reboot\n");
		return 0;
	} else if (!strcmp(cmd, "dfu")) {
		printf("dfu\n");
		return 0;
	} else if (!strcmp(cmd, "hackrf")) {
		printf("hackrf\n");
		return 0;
	} else if (!strcmp(cmd, "flash")) {
		outs("Flashing started\r\n");
		printf("flash %s\n", arg ? arg : "");
		return 0;
	} else {
		char b[LINEMAX + 4];

		snprintf(b, sizeof(b), "%s ?\r\n", cmd);
		outs(b);
	}
	return 1;
}

/* append a raw byte to the open file at open_pos (for fwb) */
static void file_put(unsigned char c)
{
	struct ent *e = open_file;

	if (!e)
		return;
	if (open_pos + 1 > e->cap) {
		size_t nc = e->cap ? e->cap * 2 : 64;

		while (nc < open_pos + 1)
			nc *= 2;
		e->data = realloc(e->data, nc);
		e->cap = nc;
	}
	e->data[open_pos++] = c;
	if (open_pos > e->len)
		e->len = open_pos;
	open_written = 1;
}

int main(int argc, char **argv)
{
	const char *link = "/tmp/fakeportapack";
	char line[LINEMAX];
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
	outs("\r\nch> ");          /* the prompt waits for the daemon */
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
		for (i = 0; i < r; i++) {
			if (expect_bytes > 0) {
				file_put(tmp[i]);
				if (--expect_bytes == 0) {
					outs("ok\r\n");
					prompt();
				}
				continue;
			}
			if (tmp[i] == '\r') {
				line[ll] = 0;
				outs(line);
				outs("\r\n");       /* echo the command */
				ll = 0;
				if (!run(line))
					return 0;       /* the device leaves the bus */
				if (expect_bytes == 0)
					prompt();
			} else if (tmp[i] != '\n') {
				if (ll < sizeof(line) - 1)
					line[ll++] = tmp[i];
			}
		}
	}
}
