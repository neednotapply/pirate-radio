/*
 * fakemodem: a USB voice modem with a Dreamcast on the line, as dreampi sees
 * them, on a pseudo-terminal: for testing dreampi without either. It answers
 * AT commands, takes the dial tone in voice mode (at 8000 bytes/s, like a
 * modem), "dials" by reporting DTMF digits, and CONNECTs on ATA. During a
 * call it can run a PPP client (pppd) as the Dreamcast would.
 *
 *   fakemodem [-l link] [-n number[,number...]] [-c calls] [-p pppd-args]
 *             [-s seconds]
 *
 *   -l  a symlink to the modem's tty (default /tmp/fakemodem)
 *   -n  the numbers to dial, one after another, each 2 s into a dial tone
 *       (default 5551234)
 *   -c  ATA answers this many calls (default 1)
 *   -p  during a call, run "pppd <tty> <args>" on the line
 *   -s  ...and stop it after this many seconds (default 10)
 *
 * Prints an event a line to stdout: "cmd <AT command>", "tone <bytes> dle
 * <stray DLEs>", "dial <number>", "connect", "ppp <exit status>", "escape".
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define DLE 0x10
#define ETX 0x03

enum { CMD, VOICE, DATA };

static const char *link_path = "/tmp/fakemodem";
static char *numbers = "5551234";
static int calls = 1;
static const char *pppd_args;
static double ppp_secs = 10;

static int mfd, state = CMD;
static pid_t ppp_pid;
static int ppp_fd = -1;

static double now(void)
{
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec + t.tv_nsec / 1e9;
}

static void event(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void event(const char *fmt, ...)
{
	va_list ap;
	va_start(ap, fmt);
	vprintf(fmt, ap);
	va_end(ap);
	putchar('\n');
	fflush(stdout);
}

static void reply(const char *s)
{
	char buf[64];
	snprintf(buf, sizeof(buf), "\r\n%s\r\n", s);
	if (write(mfd, buf, strlen(buf)) < 0)
		perror("write");
}

static int open_pty(char *name, size_t size)
{
	int fd = posix_openpt(O_RDWR | O_NOCTTY);
	struct termios t;

	if (fd < 0 || grantpt(fd) || unlockpt(fd) || ptsname_r(fd, name, size)) {
		perror("pty");
		exit(1);
	}
	if (tcgetattr(fd, &t) == 0) {
		cfmakeraw(&t);
		tcsetattr(fd, TCSANOW, &t);
	}
	fcntl(fd, F_SETFL, O_NONBLOCK);
	return fd;
}

static void start_ppp(void)
{
	char tty[64], cmd[512];

	if (!pppd_args)
		return;
	ppp_fd = open_pty(tty, sizeof(tty));
	snprintf(cmd, sizeof(cmd), "exec pppd %s 57600 %s", tty, pppd_args);
	ppp_pid = fork();
	if (ppp_pid == 0) {
		execl("/bin/sh", "sh", "-c", cmd, (char *)NULL);
		_exit(127);
	}
}

/* The PPP client ended (or, with wait, is made to now) */
static void reap_ppp(int wait)
{
	int st;

	if (ppp_pid <= 0)
		return;
	if (wait)
		kill(ppp_pid, SIGKILL);
	if (waitpid(ppp_pid, &st, wait ? 0 : WNOHANG) != ppp_pid)
		return;
	event("ppp %d", WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st));
	ppp_pid = 0;
	close(ppp_fd);
	ppp_fd = -1;
}

int main(int argc, char **argv)
{
	char tty[64], line[128], *next_number = NULL, *dialling = NULL;
	size_t linelen = 0;
	long tone = 0, stray = 0;
	int opt, dle = 0, pluses = 0;
	double voice_at = 0, digit_at = 0, ppp_until = 0, quiet_since = 0;

	while ((opt = getopt(argc, argv, "l:n:c:p:s:")) != -1) {
		switch (opt) {
		case 'l': link_path = optarg; break;
		case 'n': numbers = optarg; break;
		case 'c': calls = atoi(optarg); break;
		case 'p': pppd_args = optarg; break;
		case 's': ppp_secs = atof(optarg); break;
		default:
			fprintf(stderr, "usage: fakemodem [-l link] [-n numbers] [-c calls] [-p pppd-args] [-s seconds]\n");
			return 1;
		}
	}
	signal(SIGPIPE, SIG_IGN);
	next_number = numbers;
	mfd = open_pty(tty, sizeof(tty));
	unlink(link_path);
	if (symlink(tty, link_path)) {
		perror("symlink");
		return 1;
	}
	event("ready %s", tty);

	for (;;) {
		struct pollfd pf[2] = { { mfd, POLLIN, 0 }, { ppp_fd, POLLIN, 0 } };
		unsigned char buf[800];
		ssize_t n, i;

		poll(pf, ppp_fd >= 0 ? 2 : 1, 100);

		/* A call's PPP client: its end of the line, and its time is up */
		if (ppp_fd >= 0 && (pf[1].revents & POLLIN)) {
			n = read(ppp_fd, buf, sizeof(buf));
			if (n > 0 && write(mfd, buf, (size_t)n) < 0)
				perror("write");
		}
		/* Time's up: the client says goodbye (LCP Terminate) over the line */
		if (ppp_pid > 0 && ppp_until && now() > ppp_until) {
			kill(ppp_pid, SIGTERM);
			ppp_until = 0;
		}
		reap_ppp(0);

		/* The Dreamcast dials, 2 s into the dial tone */
		if (state == VOICE && !dialling && next_number && *next_number && now() > voice_at + 2) {
			dialling = next_number;
			digit_at = now();
		}
		if (state == VOICE && dialling && now() >= digit_at) {
			if (*dialling && *dialling != ',') {
				char d[2] = { DLE, *dialling++ };
				if (write(mfd, d, 2) < 0)
					perror("write");
				digit_at = now() + 0.15;
			} else {
				size_t len = (size_t)(dialling - next_number);
				event("dial %.*s", (int)len, next_number);
				next_number = *dialling ? dialling + 1 : dialling;
				dialling = NULL;
				voice_at = now() + 1;	/* the next number 3 s on */
			}
		}

		/* What dreampi sent; voice data no faster than a modem plays it */
		if (!(pf[0].revents & (POLLIN | POLLHUP)))
			continue;
		n = read(mfd, buf, state == VOICE ? 80 : sizeof(buf));
		if (n <= 0) {
			usleep(50000);	/* EIO: no one has the tty open right now */
			continue;
		}
		if (state == VOICE)
			usleep(10000);
		if (state == DATA) {
			for (i = 0; i < n && buf[i] == '+'; i++)
				;
			if (i == n && now() - quiet_since > 0.9) {
				pluses += (int)n;
				if (pluses >= 3) {
					event("escape");
					reap_ppp(1);
					state = CMD;
					pluses = 0;
					reply("OK");
				}
				continue;
			}
			pluses = 0;
			quiet_since = now();
			if (ppp_fd >= 0 && write(ppp_fd, buf, (size_t)n) < 0)
				perror("write");
			continue;
		}
		for (i = 0; i < n; i++) {
			unsigned char c = buf[i];

			if (state == VOICE) {
				if (dle) {
					dle = 0;
					if (c == ETX) {
						event("tone %ld dle %ld", tone, stray);
						state = CMD;
						reply("OK");
					} else {
						stray++;
					}
				} else if (c == DLE) {
					dle = 1;
				} else {
					tone++;
				}
				continue;
			}
			if (c != '\r') {
				if (c != '\n' && linelen < sizeof(line) - 1)
					line[linelen++] = (char)c;
				continue;
			}
			line[linelen] = 0;
			linelen = 0;
			{
				char *at = strcasestr(line, "AT");
				if (!at)
					continue;
				event("cmd %s", at);
				if (!strcasecmp(at, "AT+VTX")) {
					reply("CONNECT");
					state = VOICE;
					voice_at = now();
					tone = stray = 0;
				} else if (!strcasecmp(at, "ATA")) {
					if (calls-- > 0) {
						sleep(1);
						reply("CONNECT 33600");
						event("connect");
						state = DATA;
						quiet_since = now();
						start_ppp();
						ppp_until = now() + ppp_secs;
					} else {
						reply("NO CARRIER");
					}
				} else {
					reply("OK");
				}
			}
		}
	}
}
