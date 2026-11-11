/* One flat JSON object: {"key": "text" | number | true | false | null, ...}.
   That is all a command is (DESIGN.md, Part 1): nesting and arrays are
   refused. */
#ifndef PIRATE_WEBSDR_JSON_H
#define PIRATE_WEBSDR_JSON_H

#include <stddef.h>

#define JSON_MAX_FIELDS 8	/* more are checked, then left out */
#define JSON_KEY_MAX 16		/* longer keys and texts are cut short */
#define JSON_STR_MAX 64

enum { JSON_STRING, JSON_NUMBER, JSON_BOOL, JSON_NULL };

struct json_field {
	char key[JSON_KEY_MAX];
	int type;
	char str[JSON_STR_MAX];	/* JSON_STRING */
	double num;		/* JSON_NUMBER; 1 or 0 for JSON_BOOL */
};

struct json_obj {
	int n;
	struct json_field field[JSON_MAX_FIELDS];
};

/* 0 when s[0..len) is one flat JSON object and nothing else, -1 if not. */
int json_parse_flat(const char *s, size_t len, struct json_obj *o);

/* The field with that key (the first, if it is there twice), or NULL. */
const struct json_field *json_get(const struct json_obj *o, const char *key);

#endif
