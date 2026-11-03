/*
 * dcnow-config: DreamPi's Dreamcast Now configuration helper (its
 * config_server.py), for dreamcast.online/now/configure/. That page, open in
 * a browser on this network, asks port 1998 here for this router's Dreamcast
 * Now id, then shows the form that names it; its buttons turn reporting on
 * and off. The answers come from a script, as JSON:
 *
 *   <script> config          {"mac_address": "<id>", "is_enabled": true}
 *   <script> config on|off   the same, after turning reporting on or off
 *
 * A GET asks; a POST turns reporting off if its form says "disable", on
 * otherwise, as DreamPi does. Every reply allows any origin, and the private
 * network preflight browsers send before a public page reaches a local one.
 *
 *   dcnow-config [-p port] [-c script]
 */
#define _GNU_SOURCE
#include <errno.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>

static const char *script = "/usr/libexec/dreampi/dcnow";
static int port = 1998;

static void send_all(int fd, const char *p, size_t len)
{
	while (len) {
		ssize_t n = write(fd, p, len);
		if (n <= 0) {
			if (n < 0 && errno == EINTR)
				continue;
			return;
		}
		p += n;
		len -= (size_t)n;
	}
}

static void reply(int fd, const char *status, const char *body)
{
	char head[512];
	int n = snprintf(head, sizeof(head),
		"HTTP/1.0 %s\r\n"
		"Content-Type: application/json\r\n"
		"Access-Control-Allow-Origin: *\r\n"
		"Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
		"Access-Control-Allow-Headers: Content-Type, X-Requested-With\r\n"
		"Access-Control-Allow-Private-Network: true\r\n"
		"Content-Length: %zu\r\n"
		"Connection: close\r\n\r\n", status, strlen(body));
	send_all(fd, head, (size_t)n);
	send_all(fd, body, strlen(body));
}

/* <script> config [arg]: its output in out; 0 if it succeeded */
static int run(const char *arg, char *out, size_t size)
{
	int p[2], st;
	size_t len = 0;
	ssize_t n;
	pid_t pid;

	out[0] = 0;
	if (pipe(p) < 0)
		return -1;
	pid = fork();
	if (pid == 0) {
		dup2(p[1], 1);
		close(p[0]);
		close(p[1]);
		execl(script, script, "config", arg, (char *)NULL);
		_exit(127);
	}
	close(p[1]);
	while (pid > 0 && len < size - 1 && (n = read(p[0], out + len, size - 1 - len)) != 0) {
		if (n < 0) {
			if (errno == EINTR)
				continue;
			break;
		}
		len += (size_t)n;
	}
	out[len] = 0;
	close(p[0]);
	if (pid < 0 || waitpid(pid, &st, 0) < 0)
		return -1;
	return WIFEXITED(st) && WEXITSTATUS(st) == 0 ? 0 : -1;
}

static void handle(int fd)
{
	char req[8192], out[512], *end, *cl;
	struct timeval tv = { 5, 0 };
	size_t len = 0, want = 0, head;
	ssize_t n;

	/* A slow or silent client doesn't hold the helper up for long */
	setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
	setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

	/* The request line and headers, then as much body as they announce */
	for (;;) {
		n = read(fd, req + len, sizeof(req) - 1 - len);
		if (n <= 0)
			return;
		len += (size_t)n;
		req[len] = 0;
		if ((end = strstr(req, "\r\n\r\n")))
			break;
		if (len == sizeof(req) - 1)
			return;
	}
	head = (size_t)(end - req) + 4;
	for (cl = req; (cl = strchr(cl, '\n')); cl++)
		if (!strncasecmp(cl + 1, "Content-Length:", 15)) {
			want = strtoul(cl + 16, NULL, 10);
			break;
		}
	if (want > sizeof(req) - 1 - head)
		want = sizeof(req) - 1 - head;
	while (len - head < want && (n = read(fd, req + len, sizeof(req) - 1 - len)) > 0)
		len += (size_t)n;
	req[len] = 0;

	if (!strncmp(req, "OPTIONS ", 8)) {
		reply(fd, "204 No Content", "");
	} else if (!strncmp(req, "GET ", 4) || !strncmp(req, "POST ", 5)) {
		const char *arg = NULL;
		if (req[0] == 'P')
			arg = strstr(req + head, "disable") ? "off" : "on";
		if (run(arg, out, sizeof(out)))
			reply(fd, "500 Internal Server Error", "{\"error\": \"no Dreamcast Now id\"}");
		else
			reply(fd, "200 OK", out);
	} else {
		reply(fd, "405 Method Not Allowed", "{}");
	}
}

int main(int argc, char **argv)
{
	struct sockaddr_in a;
	int opt, s, one = 1;

	while ((opt = getopt(argc, argv, "p:c:")) != -1) {
		switch (opt) {
		case 'p': port = atoi(optarg); break;
		case 'c': script = optarg; break;
		default:
			fprintf(stderr, "usage: dcnow-config [-p port] [-c script]\n");
			return 1;
		}
	}
	signal(SIGPIPE, SIG_IGN);

	s = socket(AF_INET, SOCK_STREAM, 0);
	memset(&a, 0, sizeof(a));
	a.sin_family = AF_INET;
	a.sin_port = htons((unsigned short)port);
	a.sin_addr.s_addr = htonl(INADDR_ANY);
	setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
	if (s < 0 || bind(s, (struct sockaddr *)&a, sizeof(a)) || listen(s, 8)) {
		perror("dcnow-config");
		return 1;
	}
	for (;;) {
		int c = accept(s, NULL, NULL);
		if (c < 0) {
			if (errno == EINTR || errno == ECONNABORTED)
				continue;
			perror("accept");
			return 1;
		}
		handle(c);
		close(c);
	}
}
