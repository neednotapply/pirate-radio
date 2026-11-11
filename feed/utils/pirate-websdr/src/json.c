/*
 * One flat JSON object: what a command is. Small and strict: anything that
 * is not exactly that is refused, and nothing a client sends can run past a
 * buffer (keys and texts longer than theirs are cut short, which no key or
 * text of the protocol is).
 *
 * This is free software, licensed under the MIT license.
 */
#define _POSIX_C_SOURCE 200809L

#include <stdlib.h>
#include <string.h>

#include "json.h"

struct cursor {
	const char *s;
	size_t len, pos;
};

static void skip_blanks(struct cursor *c)
{
	while (c->pos < c->len) {
		char ch = c->s[c->pos];

		if (ch != ' ' && ch != '\t' && ch != '\n' && ch != '\r')
			break;
		c->pos++;
	}
}

static int is_digit(char ch)
{
	return ch >= '0' && ch <= '9';
}

static int hex_value(char ch)
{
	if (ch >= '0' && ch <= '9')
		return ch - '0';
	if (ch >= 'a' && ch <= 'f')
		return ch - 'a' + 10;
	if (ch >= 'A' && ch <= 'F')
		return ch - 'A' + 10;
	return -1;
}

/* At a quote: the text into out (cut to outsz - 1), the cursor past it. */
static int parse_string(struct cursor *c, char *out, size_t outsz)
{
	size_t n = 0;

	if (c->pos >= c->len || c->s[c->pos] != '"')
		return -1;
	c->pos++;
	for (;;) {
		unsigned char ch;

		if (c->pos >= c->len)
			return -1;			/* no closing quote */
		ch = (unsigned char)c->s[c->pos++];
		if (ch == '"')
			break;
		if (ch < 0x20)
			return -1;			/* a bare control character */
		if (ch == '\\') {
			if (c->pos >= c->len)
				return -1;
			ch = (unsigned char)c->s[c->pos++];
			switch (ch) {
			case '"': case '\\': case '/':
				break;
			case 'b': ch = '\b'; break;
			case 'f': ch = '\f'; break;
			case 'n': ch = '\n'; break;
			case 'r': ch = '\r'; break;
			case 't': ch = '\t'; break;
			case 'u': {
				unsigned v = 0;
				int i, h;

				if (c->len - c->pos < 4)
					return -1;
				for (i = 0; i < 4; i++) {
					h = hex_value(c->s[c->pos++]);
					if (h < 0)
						return -1;
					v = (v << 4) | (unsigned)h;
				}
				/* nothing the protocol names is outside ASCII */
				ch = (v >= 0x20 && v < 0x7f) ? (unsigned char)v : '?';
				break;
			}
			default:
				return -1;
			}
		}
		if (n + 1 < outsz)
			out[n++] = (char)ch;
	}
	out[n] = '\0';
	return 0;
}

/* At a '-' or a digit: a number as JSON writes them. */
static int parse_number(struct cursor *c, double *out)
{
	char tmp[48];
	const char *s = c->s;
	size_t len = c->len, i = c->pos, n;

	if (i < len && s[i] == '-')
		i++;
	if (i >= len)
		return -1;
	if (s[i] == '0') {
		i++;
	} else if (s[i] >= '1' && s[i] <= '9') {
		while (i < len && is_digit(s[i]))
			i++;
	} else {
		return -1;
	}
	if (i < len && s[i] == '.') {
		i++;
		if (i >= len || !is_digit(s[i]))
			return -1;
		while (i < len && is_digit(s[i]))
			i++;
	}
	if (i < len && (s[i] == 'e' || s[i] == 'E')) {
		i++;
		if (i < len && (s[i] == '+' || s[i] == '-'))
			i++;
		if (i >= len || !is_digit(s[i]))
			return -1;
		while (i < len && is_digit(s[i]))
			i++;
	}
	n = i - c->pos;
	if (n >= sizeof(tmp))
		return -1;
	memcpy(tmp, s + c->pos, n);
	tmp[n] = '\0';
	*out = strtod(tmp, NULL);
	if (!(*out == *out) || *out > 1e300 || *out < -1e300)
		return -1;				/* not a number anything here could use */
	c->pos = i;
	return 0;
}

static int at_word(const struct cursor *c, const char *word)
{
	size_t wlen = strlen(word);

	return c->len - c->pos >= wlen && memcmp(c->s + c->pos, word, wlen) == 0;
}

int json_parse_flat(const char *s, size_t len, struct json_obj *o)
{
	struct cursor c;

	c.s = s;
	c.len = len;
	c.pos = 0;
	o->n = 0;

	skip_blanks(&c);
	if (c.pos >= c.len || c.s[c.pos] != '{')
		return -1;
	c.pos++;
	skip_blanks(&c);
	if (c.pos < c.len && c.s[c.pos] == '}') {
		c.pos++;
	} else {
		for (;;) {
			struct json_field f;
			char ch;

			memset(&f, 0, sizeof(f));
			skip_blanks(&c);
			if (parse_string(&c, f.key, sizeof(f.key)) != 0)
				return -1;
			skip_blanks(&c);
			if (c.pos >= c.len || c.s[c.pos] != ':')
				return -1;
			c.pos++;
			skip_blanks(&c);
			if (c.pos >= c.len)
				return -1;
			ch = c.s[c.pos];
			if (ch == '"') {
				f.type = JSON_STRING;
				if (parse_string(&c, f.str, sizeof(f.str)) != 0)
					return -1;
			} else if (ch == '-' || is_digit(ch)) {
				f.type = JSON_NUMBER;
				if (parse_number(&c, &f.num) != 0)
					return -1;
			} else if (at_word(&c, "true")) {
				f.type = JSON_BOOL;
				f.num = 1;
				c.pos += 4;
			} else if (at_word(&c, "false")) {
				f.type = JSON_BOOL;
				f.num = 0;
				c.pos += 5;
			} else if (at_word(&c, "null")) {
				f.type = JSON_NULL;
				c.pos += 4;
			} else {
				return -1;		/* an object or an array, too: commands are flat */
			}
			if (o->n < JSON_MAX_FIELDS)
				o->field[o->n++] = f;
			skip_blanks(&c);
			if (c.pos >= c.len)
				return -1;
			if (c.s[c.pos] == ',') {
				c.pos++;
				continue;
			}
			if (c.s[c.pos] == '}') {
				c.pos++;
				break;
			}
			return -1;
		}
	}
	skip_blanks(&c);
	return c.pos == c.len ? 0 : -1;
}

const struct json_field *json_get(const struct json_obj *o, const char *key)
{
	int i;

	for (i = 0; i < o->n; i++)
		if (strcmp(o->field[i].key, key) == 0)
			return &o->field[i];
	return NULL;
}
