/*
 * dreampi: answers a Sega Dreamcast's modem with a USB voice modem, then hands
 * each call to a script (pppd for DreamPi's servers, or the DCNet client).
 *
 * The modem side of DreamPi (https://github.com/Kazade/dreampi; MIT license,
 * Copyright (c) 2015 Luke Benstead), rewritten in C for OpenWrt. There is no
 * phone line: the modem goes off-hook in voice mode and plays a dial tone into
 * the cable, the Dreamcast dials, the modem reports the DTMF digits, and once
 * the dialling stops the modem answers in data mode.
 *
 *   dreampi [-t tty] [-b baud] [-s ppp|dcnet] [-c script] [-S statefile]
 *           [-w seconds] [-n] [-v]
 *
 * After CONNECT, <script> runs as "<script> <service> <number>" with the modem
 * in $DREAMPI_TTY and its speed in $DREAMPI_BAUD; the call lasts as long as
 * the script does. Dialling *69 first picks DCNet for the next call, as in
 * DreamPi 2.1. The current state goes to <statefile> (shell variables) while
 * this runs.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define DLE 0x10
#define ETX 0x03

static const char *tty = "/dev/ttyACM0";
static int baud = 57600;
static const char *service = "ppp";
static const char *script = "/usr/libexec/dreampi/call";
static const char *statefile = "/var/run/dreampi/state";
static double answer_delay = 8;	/* from the last digit to ATA, for PPP calls */
static int dial_tone = 1;
static int verbose;

static volatile sig_atomic_t stopping;
static int fd = -1;

/* 350 + 440 Hz (a North American dial tone), 8-bit unsigned PCM at 8 kHz.
   Both repeat every 1/10 s, so 800 samples loop seamlessly. The level is
   that of DreamPi's dial-tone.wav, and no sample is DLE, which the modem
   would take for the start of a command. */
static unsigned char tone[800];

static double now(void)
{
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec + t.tv_nsec / 1e9;
}

static void pause_for(double s)
{
	struct timespec t = { (time_t)s, (long)((s - (time_t)s) * 1e9) };
	if (s <= 0)
		return;
	while (!stopping && nanosleep(&t, &t) < 0 && errno == EINTR)
		;
}

static void say(const char *fmt, ...)
{
	va_list ap;
	va_start(ap, fmt);
	vfprintf(stderr, fmt, ap);
	va_end(ap);
	fputc('\n', stderr);
}

static void set_state(const char *state, const char *svc, const char *number)
{
	char tmp[512];
	FILE *f;

	snprintf(tmp, sizeof(tmp), "%s.tmp", statefile);
	if (!(f = fopen(tmp, "w")))
		return;
	/* number is digits, * and # only */
	fprintf(f, "state=%s\nservice=%s\nnumber='%s'\nsince=%ld\n",
		state, svc ? svc : "", number ? number : "", (long)time(NULL));
	fclose(f);
	rename(tmp, statefile);
}

static speed_t speed(int b)
{
	switch (b) {
	case 9600: return B9600;
	case 19200: return B19200;
	case 38400: return B38400;
	case 57600: return B57600;
	case 115200: return B115200;
	case 230400: return B230400;
	}
	return 0;
}

static int modem_open(void)
{
	struct termios t;

	fd = open(tty, O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
	if (fd < 0) {
		say("can't open %s: %s", tty, strerror(errno));
		return -1;
	}
	ioctl(fd, TIOCEXCL);
	if (tcgetattr(fd, &t) == 0) {
		cfmakeraw(&t);
		/* Ignore carrier detect while listening; and closing the port
		   must not hang up: the call script opens it next. */
		t.c_cflag |= CLOCAL | CREAD;
		t.c_cflag &= ~(CRTSCTS | HUPCL);
		t.c_cc[VMIN] = 0;
		t.c_cc[VTIME] = 0;
		cfsetispeed(&t, speed(baud));
		cfsetospeed(&t, speed(baud));
		tcsetattr(fd, TCSANOW, &t);
	}
	tcflush(fd, TCIOFLUSH);
	return 0;
}

static void modem_close(void)
{
	if (fd >= 0) {
		/* The exclusive flag can outlive the close (on a pty, say), and
		   would keep the next open (pppd, ours) out without CAP_SYS_ADMIN */
		ioctl(fd, TIOCNXCL);
		close(fd);
	}
	fd = -1;
}

/* The modem is gone (unplugged) when the port hangs up or reads fail. */
static void gone(void)
{
	say("lost the modem on %s", tty);
	set_state("no-modem", NULL, NULL);
	exit(2);
}

static int send_raw(const void *buf, size_t len)
{
	const unsigned char *p = buf;
	double give_up = now() + 5;

	while (len) {
		ssize_t n = write(fd, p, len);
		if (n < 0) {
			struct pollfd pf = { fd, POLLOUT, 0 };
			if (errno != EAGAIN && errno != EINTR)
				gone();
			if (now() > give_up)
				return -1;
			poll(&pf, 1, 200);
			continue;
		}
		p += n;
		len -= (size_t)n;
	}
	return 0;
}

/* Reads what the modem sent. Lines go to line_cb; <DLE><x> events to the
   caller through *event (one per call). Returns -1 on timeout. */
static char line[256];
static size_t linelen;
static int dle_pending;

static int pump(int timeout_ms, int want_write, void (*line_cb)(const char *), int *event)
{
	struct pollfd pf = { fd, POLLIN | (want_write ? POLLOUT : 0), 0 };
	unsigned char buf[256];
	ssize_t n, i;
	int r = poll(&pf, 1, timeout_ms);

	if (r < 0)
		return errno == EINTR ? 0 : -1;
	if (r == 0)
		return 0;
	if (pf.revents & (POLLHUP | POLLERR | POLLNVAL))
		gone();
	if (!(pf.revents & POLLIN))
		return 1;
	n = read(fd, buf, sizeof(buf));
	if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR))
		gone();
	for (i = 0; i < n; i++) {
		unsigned char c = buf[i];
		if (dle_pending) {
			dle_pending = 0;
			if (event && c != DLE)
				*event = c;
			continue;
		}
		if (c == DLE) {
			dle_pending = 1;
		} else if (c == '\r' || c == '\n') {
			line[linelen] = 0;
			if (linelen && line_cb)
				line_cb(line);
			linelen = 0;
		} else if (linelen < sizeof(line) - 1) {
			line[linelen++] = (char)c;
		}
	}
	return 1;
}

/* send_command: <cmd> and the modem's final result code */
static const char *result;
static char result_line[sizeof(line)];

static void on_line(const char *l)
{
	static const char *const finals[] = { "OK", "ERROR", "CONNECT", "VCON", "NO CARRIER",
		"BUSY", "NO DIALTONE", "NO DIAL TONE", "NO ANSWER" };
	size_t i;

	if (verbose)
		say("< %s", l);
	if (result)
		return;
	for (i = 0; i < sizeof(finals) / sizeof(*finals); i++)
		if (!strncmp(l, finals[i], strlen(finals[i]))) {
			result = finals[i];
			snprintf(result_line, sizeof(result_line), "%s", l);
			return;
		}
}

static void drain(void)
{
	while (pump(0, 0, verbose ? on_line : NULL, NULL) > 0)
		;
	result = NULL;
	linelen = 0;
	dle_pending = 0;
}

/* 0 on OK, CONNECT or VCON (or CONNECT alone with only_connect); -1 on
   another result or no answer within <timeout> s */
static int at(const char *cmd, double timeout, int only_connect)
{
	char buf[64];
	double end = now() + timeout;

	drain();
	if (verbose)
		say("> %s", cmd);
	snprintf(buf, sizeof(buf), "%s\r\n", cmd);
	if (send_raw(buf, strlen(buf)))
		return -1;
	while (!stopping && now() < end) {
		pump(100, 0, on_line, NULL);
		if (!result)
			continue;
		if (!strcmp(result, "CONNECT"))
			return 0;
		if (only_connect && !strcmp(result, "OK")) {
			result = NULL;
			continue;
		}
		if (!strcmp(result, "OK") || !strcmp(result, "VCON"))
			return 0;
		return -1;
	}
	return -1;
}

/* "+++" a character at a time, in case the modem is stuck in data mode */
static void shake(void)
{
	int i;
	for (i = 0; i < 3; i++) {
		send_raw("+", 1);
		pause_for(0.2);
	}
	pause_for(4);
	at("ATH0", 3, 0);
}

static int reset(void)
{
	int tries;

	for (tries = 0; tries < 3 && !stopping; tries++) {
		if (!at("ATZ0", 3, 0)) {
			pause_for(1);
			if (!at("AT&F0", 10, 0) && !at("ATE0W2", 10, 0))
				return 0;
		}
		say("the modem doesn't answer; trying a harder reset");
		shake();
	}
	return -1;
}

/* Off-hook in voice mode, sending 8-bit PCM at 8 kHz */
static int start_tone(void)
{
	int tries;

	for (tries = 0; tries < 3 && !stopping; tries++) {
		if (!reset() && !at("AT+FCLASS=8", 10, 0) && !at("AT+VLS=1", 10, 0) &&
		    !at("AT+VSM=1,8000", 10, 0) && !at("AT+VTX", 10, 0))
			return 0;
		pause_for(0.5);
	}
	return -1;
}

static void stop_tone(void)
{
	send_raw("\0\x10\x03\r\n", 5);	/* <DLE><ETX>: end of voice data */
	pause_for(1);
	send_raw("+++", 3);
	pause_for(1);
	at("ATH0", 10, 0);
	reset();
}

/* The numbers DreamPi hands to its Netlink module (peer-to-peer games, XBAND,
   Capcom's server): not supported here. */
static int unsupported(const char *n)
{
	static const char *const numbers[] = { "0", "00", "18002071194", "19209492263",
		"0120717360", "0355703001", "0642542154" };
	size_t i, len = strlen(n);

	if (len > 1 && n[0] == '#' && n[len - 1] == '#')
		return 1;
	for (i = 0; i < sizeof(numbers) / sizeof(*numbers); i++)
		if (!strcmp(n, numbers[i]))
			return 1;
	return 0;
}

/* Waits for the Dreamcast to dial a number to answer. 0: a call, with its
   service and number; -1: stopping or the modem failed. */
static int listen_for_call(const char **svc, char *number, size_t size, double *heard)
{
	size_t len = 0;
	double last = 0, dcnet_until = 0;
	size_t pos = 0;
	int sending = 1;

	if (start_tone()) {
		say("the modem won't go into voice mode");
		return -1;
	}
	say("listening on %s", tty);
	set_state("listening", NULL, NULL);
	while (!stopping) {
		int event = 0, r;

		r = pump(100, sending, verbose ? on_line : NULL, &event);
		if (r < 0)
			return -1;
		if (sending) {
			ssize_t n = write(fd, tone + pos, sizeof(tone) - pos);
			if (n > 0)
				pos = (pos + (size_t)n) % sizeof(tone);
		}
		if (event && strchr("0123456789*#", event)) {
			if (len < size - 1)
				number[len++] = (char)event;
			number[len] = 0;
			last = now();
			sending = 0;	/* a real dial tone stops at the first digit */
			continue;
		}
		if (event && verbose)
			say("modem event <DLE>%c", event);
		if (!len || now() - last < 2)
			continue;

		/* Two seconds without a digit: that's the number. */
		*heard = now();
		len = 0;
		sending = 1;
		if (!strcmp(number, "*69")) {
			say("heard *69: DCNet for the next call");
			dcnet_until = now() + 10;
		} else if (!strcmp(number, "*70")) {
			say("heard *70 (call waiting off)");
		} else if (unsupported(number)) {
			say("heard %s: Netlink, XBAND and Capcom numbers aren't supported", number);
		} else {
			*svc = now() < dcnet_until ? "dcnet" : service;
			say("heard %s", number);
			return 0;
		}
	}
	return -1;
}

static int answer(const char *svc, const char *number, double heard)
{
	int ppp = strcmp(svc, "dcnet") != 0;

	set_state("answering", svc, number);
	stop_tone();
	if (ppp) {
		/* DreamPi waits 8 s, and resets the modem again, before ATA */
		pause_for(heard + answer_delay - now());
		reset();
	}
	say("answering (%s)", svc);
	if (stopping || at("ATA", 60, 1)) {
		say("couldn't answer the call");
		return -1;
	}
	say("%s", result_line);
	pause_for(ppp ? 5 : 3);
	return stopping ? -1 : 0;
}

static void run_call(const char *svc, const char *number)
{
	char b[16];
	pid_t pid;
	int st;

	set_state("connected", svc, number);
	modem_close();
	pid = fork();
	if (pid == 0) {
		snprintf(b, sizeof(b), "%d", baud);
		setenv("DREAMPI_TTY", tty, 1);
		setenv("DREAMPI_BAUD", b, 1);
		signal(SIGTERM, SIG_DFL);
		signal(SIGINT, SIG_DFL);
		execl(script, script, svc, number, (char *)NULL);
		say("can't run %s: %s", script, strerror(errno));
		_exit(127);
	}
	if (pid < 0) {
		say("fork: %s", strerror(errno));
		return;
	}
	while (waitpid(pid, &st, 0) < 0) {
		if (errno != EINTR)
			break;
		if (stopping)
			kill(pid, SIGTERM);
	}
	say("call ended");
}

/* After the call: back to command mode, and on-hook */
static int hang_up(void)
{
	int i;

	set_state("hanging-up", NULL, NULL);
	if (modem_open())
		return -1;
	pause_for(1.5);
	for (i = 0; i < 3; i++) {
		send_raw("+", 1);
		pause_for(0.2);
	}
	pause_for(1.5);
	if (at("ATH0", 3, 0))
		say("no reply to ATH0 after the call; carrying on");
	pause_for(1);
	return 0;
}

static void on_signal(int sig)
{
	(void)sig;
	stopping = 1;
}

static void usage(void)
{
	fprintf(stderr, "usage: dreampi [-t tty] [-b baud] [-s ppp|dcnet] [-c script] "
		"[-S statefile] [-w seconds] [-n] [-v]\n");
	exit(1);
}

int main(int argc, char **argv)
{
	struct sigaction sa;
	char number[64];
	const char *svc;
	double heard;
	size_t i;
	int opt;

	while ((opt = getopt(argc, argv, "t:b:s:c:S:w:nvh")) != -1) {
		switch (opt) {
		case 't': tty = optarg; break;
		case 'b': baud = atoi(optarg); break;
		case 's': service = optarg; break;
		case 'c': script = optarg; break;
		case 'S': statefile = optarg; break;
		case 'w': answer_delay = atof(optarg); break;
		case 'n': dial_tone = 0; break;
		case 'v': verbose = 1; break;
		default: usage();
		}
	}
	if (optind != argc || !speed(baud) ||
	    (strcmp(service, "ppp") && strcmp(service, "dcnet")))
		usage();

	for (i = 0; i < sizeof(tone); i++) {
		double t = (double)i / 8000;
		tone[i] = (unsigned char)lround(128 + 38 * sin(2 * M_PI * 350 * t) +
			38 * sin(2 * M_PI * 440 * t));
		if (!dial_tone)
			tone[i] = 0x80;	/* silence, for a Dreamcast set to blind dial */
	}

	memset(&sa, 0, sizeof(sa));
	sa.sa_handler = on_signal;
	sigaction(SIGTERM, &sa, NULL);
	sigaction(SIGINT, &sa, NULL);
	signal(SIGPIPE, SIG_IGN);

	if (modem_open()) {
		set_state("no-modem", NULL, NULL);
		return 1;
	}
	while (!stopping) {
		if (listen_for_call(&svc, number, sizeof(number), &heard))
			break;
		if (!answer(svc, number, heard))
			run_call(svc, number);
		if (stopping || hang_up())
			break;
	}
	if (fd >= 0) {
		/* Leave the modem on-hook. It plays out the dial tone it has
		   buffered after <DLE><ETX>, and takes no command until then. */
		stopping = 0;
		send_raw("\0\x10\x03\r\n", 5);
		pause_for(1);
		at("ATH0", 3, 0);
		modem_close();
	}
	unlink(statefile);
	return 0;
}
