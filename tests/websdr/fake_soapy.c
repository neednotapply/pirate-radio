/*
 * A stand-in for libSoapySDR, for the tests: the calls source_soapy.c makes
 * of its C API, with a HackRF and an RTL-SDR behind them that are not there.
 * It is compiled against SoapySDR's own headers, so what it defines is what
 * they declare.
 *
 * It cannot say that a real driver is used rightly. It says what the bridge
 * asks of a driver, and what comes of that with a driver as unforgiving as
 * the HackRF's:
 *
 *  - a device opens once: a second make finds it busy;
 *  - it has one stream at a time: a second setupStream is refused;
 *  - samples come a buffer at a time (the HackRF's are 262144 bytes; the
 *    RTL-SDR's are the "bufflen" it is given, which it wants in multiples
 *    of 512), each when the radio has made it, by this machine's clock;
 *  - a stream that is stopped and then started again is spoiled: its reads
 *    never wait for the radio again, and hand out samples it gave before,
 *    as fast as they are asked for. (SoapyHackRF's does, when it was stopped
 *    with a buffer half read: one stop in four or so. Here it is every one.)
 *
 * Every sample tells which it is: I and Q count up from the moment the
 * device opened (fake_fill), so that whoever listens can tell samples that
 * are missing, or that come twice, from the stream itself.
 *
 * What a driver should not be asked is said on stderr, in lines that begin
 * "fake radio:": the tests look for them in the bridge's log.
 *
 * FAKE_SOAPY_FAIL makes one call fail: "make" (the radio is not there),
 * "setup" (it gives no stream) or "activate" (its stream does not start).
 *
 * This is free software, licensed under the MIT license.
 */
#define _POSIX_C_SOURCE 200809L

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <SoapySDR/Device.h>
#include <SoapySDR/Errors.h>
#include <SoapySDR/Formats.h>

#include "clock.h"

#define RING 15			/* buffers a driver holds before it runs over */
#define MAX_GAINS 3

struct SoapySDRStream {
	int open, active, starts, spoiled;
	long buf;		/* samples in one of its buffers */
	long long t0;		/* when it started, ns */
	long long taken;	/* samples handed out since */
	long long first;	/* which sample its first was */
};

struct SoapySDRDevice {
	int made, rtl;
	double rate, freq;
	double gain[MAX_GAINS];
	long long next;		/* the sample handed out next */
	struct SoapySDRStream stream;
};

struct gain_def {
	const char *name;
	double min, max, step;
};

static const struct gain_def HACKRF_GAINS[] = { { "LNA", 0, 40, 8 }, { "AMP", 0, 14, 14 }, { "VGA", 0, 62, 2 } };
static const struct gain_def RTL_GAINS[] = { { "TUNER", 0, 49.6, 0 } };

static struct SoapySDRDevice fake;	/* one radio is plugged in */
static char last_error[160];

static void set_error(const char *text)
{
	snprintf(last_error, sizeof(last_error), "%s", text);
}

static void complain(const char *text)
{
	fprintf(stderr, "fake radio: %s\n", text);
	fflush(stderr);
}

static int fails(const char *call)
{
	const char *v = getenv("FAKE_SOAPY_FAIL");

	return v && strcmp(v, call) == 0;
}

static const struct gain_def *gains_of(const SoapySDRDevice *d, size_t *n)
{
	*n = d->rtl ? sizeof(RTL_GAINS) / sizeof(RTL_GAINS[0]) : sizeof(HACKRF_GAINS) / sizeof(HACKRF_GAINS[0]);
	return d->rtl ? RTL_GAINS : HACKRF_GAINS;
}

static int gain_index(const SoapySDRDevice *d, const char *name)
{
	size_t n, i;
	const struct gain_def *g = gains_of(d, &n);

	for (i = 0; i < n; i++)
		if (strcmp(g[i].name, name) == 0)
			return (int)i;
	return -1;
}

static char *copy_of(const char *s)
{
	char *c = malloc(strlen(s) + 1);

	if (c)
		strcpy(c, s);
	return c;
}

/* Samples k, k+1, ... (I, Q, I, Q): I counts 0..250 and starts again, Q
   counts how often it has, to 250 as well; both less 125. So a sample says
   which it is, to within 251 * 251 of them. */
static void fake_fill(int8_t *out, long long k, long n)
{
	int a = (int)(k % 251), b = (int)((k / 251) % 251);
	long i;

	for (i = 0; i < n; i++) {
		out[2 * i] = (int8_t)(a - 125);
		out[2 * i + 1] = (int8_t)(b - 125);
		if (++a == 251) {
			a = 0;
			if (++b == 251)
				b = 0;
		}
	}
}

/* ---------- what is not a device's ---------- */

const char *SoapySDRDevice_lastError(void)
{
	return last_error;
}

const char *SoapySDR_errToStr(const int errorCode)
{
	switch (errorCode) {
	case SOAPY_SDR_TIMEOUT: return "TIMEOUT";
	case SOAPY_SDR_STREAM_ERROR: return "STREAM_ERROR";
	case SOAPY_SDR_CORRUPTION: return "CORRUPTION";
	case SOAPY_SDR_OVERFLOW: return "OVERFLOW";
	case SOAPY_SDR_NOT_SUPPORTED: return "NOT_SUPPORTED";
	default: return "UNKNOWN";
	}
}

void SoapySDR_free(void *ptr)
{
	free(ptr);
}

void SoapySDRStrings_clear(char ***elems, const size_t length)
{
	size_t i;

	for (i = 0; i < length; i++)
		free((*elems)[i]);
	free(*elems);
	*elems = NULL;
}

int SoapySDRKwargs_set(SoapySDRKwargs *args, const char *key, const char *val)
{
	char **keys = realloc(args->keys, (args->size + 1) * sizeof(char *));
	char **vals;

	if (!keys)
		return -1;
	args->keys = keys;
	vals = realloc(args->vals, (args->size + 1) * sizeof(char *));
	if (!vals)
		return -1;
	args->vals = vals;
	keys[args->size] = copy_of(key);
	vals[args->size] = copy_of(val);
	args->size++;
	return 0;
}

void SoapySDRKwargs_clear(SoapySDRKwargs *args)
{
	size_t i;

	for (i = 0; i < args->size; i++) {
		free(args->keys[i]);
		free(args->vals[i]);
	}
	free(args->keys);
	free(args->vals);
	args->keys = NULL;
	args->vals = NULL;
	args->size = 0;
}

static const char *kwarg(const SoapySDRKwargs *args, const char *key)
{
	size_t i;

	for (i = 0; args && i < args->size; i++)
		if (strcmp(args->keys[i], key) == 0)
			return args->vals[i];
	return NULL;
}

/* ---------- the device ---------- */

SoapySDRDevice *SoapySDRDevice_makeStrArgs(const char *args)
{
	int rtl;

	if (strcmp(args, "driver=hackrf") == 0) {
		rtl = 0;
	} else if (strcmp(args, "driver=rtlsdr") == 0) {
		rtl = 1;
	} else {
		set_error("no such driver");
		return NULL;
	}
	if (fails("make")) {
		set_error("no device found");
		return NULL;
	}
	if (fake.made) {
		set_error("the device is busy");
		return NULL;
	}
	memset(&fake, 0, sizeof(fake));
	fake.made = 1;
	fake.rtl = rtl;
	fake.rate = 2000000;
	fake.freq = 100000000;
	return &fake;
}

int SoapySDRDevice_unmake(SoapySDRDevice *device)
{
	if (device->stream.open)
		complain("the device is let go of with its stream still open");
	device->made = 0;
	return 0;
}

char *SoapySDRDevice_getHardwareKey(const SoapySDRDevice *device)
{
	return copy_of(device->rtl ? "R820T" : "HackRF One");
}

int SoapySDRDevice_setSampleRate(SoapySDRDevice *device, const int direction, const size_t channel, const double rate)
{
	(void)direction;
	(void)channel;
	if (device->stream.active)
		complain("the sample rate is changed under a running stream");
	if (rate < 1000 || rate > 20000000) {
		set_error("no such sample rate");
		return -1;
	}
	device->rate = rate;
	return 0;
}

int SoapySDRDevice_setFrequency(SoapySDRDevice *device, const int direction, const size_t channel,
	const double frequency, const SoapySDRKwargs *args)
{
	(void)direction;
	(void)channel;
	(void)args;
	device->freq = frequency;
	return 0;
}

SoapySDRRange *SoapySDRDevice_getFrequencyRange(const SoapySDRDevice *device, const int direction,
	const size_t channel, size_t *length)
{
	SoapySDRRange *r = malloc(sizeof(*r));

	(void)direction;
	(void)channel;
	*length = 0;
	if (!r)
		return NULL;
	r->minimum = device->rtl ? 24000000.0 : 0.0;
	r->maximum = device->rtl ? 1766000000.0 : 7250000000.0;
	r->step = 0;
	*length = 1;
	return r;
}

bool SoapySDRDevice_hasGainMode(const SoapySDRDevice *device, const int direction, const size_t channel)
{
	(void)direction;
	(void)channel;
	return device->rtl != 0;
}

int SoapySDRDevice_setGainMode(SoapySDRDevice *device, const int direction, const size_t channel, const bool automatic)
{
	(void)device;
	(void)direction;
	(void)channel;
	(void)automatic;
	return 0;
}

char **SoapySDRDevice_listGains(const SoapySDRDevice *device, const int direction, const size_t channel, size_t *length)
{
	size_t n, i;
	const struct gain_def *g = gains_of(device, &n);
	char **names = malloc(n * sizeof(char *));

	(void)direction;
	(void)channel;
	*length = 0;
	if (!names)
		return NULL;
	for (i = 0; i < n; i++)
		names[i] = copy_of(g[i].name);
	*length = n;
	return names;
}

SoapySDRRange SoapySDRDevice_getGainElementRange(const SoapySDRDevice *device, const int direction,
	const size_t channel, const char *name)
{
	SoapySDRRange r = { 0, 0, 0 };
	size_t n;
	const struct gain_def *g = gains_of(device, &n);
	int i = gain_index(device, name);

	(void)direction;
	(void)channel;
	if (i >= 0) {
		r.minimum = g[i].min;
		r.maximum = g[i].max;
		r.step = g[i].step;
	}
	return r;
}

int SoapySDRDevice_setGainElement(SoapySDRDevice *device, const int direction, const size_t channel,
	const char *name, const double value)
{
	int i = gain_index(device, name);

	(void)direction;
	(void)channel;
	if (i < 0) {
		set_error("no such gain element");
		return -1;
	}
	device->gain[i] = value;
	return 0;
}

double SoapySDRDevice_getGainElement(const SoapySDRDevice *device, const int direction, const size_t channel,
	const char *name)
{
	int i = gain_index(device, name);

	(void)direction;
	(void)channel;
	return i < 0 ? 0 : device->gain[i];
}

/* ---------- its stream ---------- */

SoapySDRStream *SoapySDRDevice_setupStream(SoapySDRDevice *device, const int direction, const char *format,
	const size_t *channels, const size_t numChans, const SoapySDRKwargs *args)
{
	struct SoapySDRStream *st = &device->stream;
	long bytes = 262144;

	(void)channels;
	(void)numChans;
	if (direction != SOAPY_SDR_RX || strcmp(format, SOAPY_SDR_CS8) != 0) {
		set_error("setupStream invalid format or direction");
		return NULL;
	}
	if (fails("setup")) {
		set_error("no memory for its buffers");
		return NULL;
	}
	if (st->open) {
		set_error("RX stream already opened");
		return NULL;
	}
	if (device->rtl && kwarg(args, "bufflen")) {
		bytes = atol(kwarg(args, "bufflen"));
		if (bytes < 512 || bytes % 512 != 0) {
			complain("an RTL-SDR's bufflen is a multiple of 512");
			bytes = 262144;
		}
	}
	memset(st, 0, sizeof(*st));
	st->open = 1;
	st->buf = bytes / 2;
	return st;
}

int SoapySDRDevice_closeStream(SoapySDRDevice *device, SoapySDRStream *stream)
{
	(void)device;
	if (!stream->open)
		complain("a stream is closed that is not open");
	stream->open = 0;
	stream->active = 0;
	return 0;
}

int SoapySDRDevice_activateStream(SoapySDRDevice *device, SoapySDRStream *stream, const int flags,
	const long long timeNs, const size_t numElems)
{
	(void)flags;
	(void)timeNs;
	(void)numElems;
	if (!stream->open) {
		complain("a stream is started that is not open");
		set_error("no such stream");
		return SOAPY_SDR_STREAM_ERROR;
	}
	if (fails("activate")) {
		set_error("the radio would not start receiving");
		return SOAPY_SDR_STREAM_ERROR;
	}
	if (stream->active)
		return 0;
	if (++stream->starts > 1 && !stream->spoiled) {
		stream->spoiled = 1;
		complain("a stream that was stopped is started again: it hands out old samples from here on");
	}
	stream->active = 1;
	stream->t0 = mono_ns();
	stream->taken = 0;
	stream->first = device->next;
	return 0;
}

int SoapySDRDevice_deactivateStream(SoapySDRDevice *device, SoapySDRStream *stream, const int flags,
	const long long timeNs)
{
	(void)device;
	(void)flags;
	(void)timeNs;
	stream->active = 0;
	return 0;
}

int SoapySDRDevice_readStream(SoapySDRDevice *device, SoapySDRStream *stream, void * const *buffs,
	const size_t numElems, int *flags, long long *timeNs, const long timeoutUs)
{
	struct SoapySDRStream *st = stream;
	const long long until = mono_ns() + (long long)timeoutUs * 1000LL;
	long long made, avail, wait, left;
	long n;

	(void)timeNs;
	*flags = 0;
	if (!st->open || !st->active) {
		complain("a stream is read that is not started");
		return SOAPY_SDR_STREAM_ERROR;
	}
	if (st->spoiled) {
		/* no waiting; and the same stretch, a ring of buffers long, again and again */
		n = (long)numElems < st->buf ? (long)numElems : st->buf;
		fake_fill(buffs[0], st->first + st->taken % ((long long)RING * st->buf), n);
		st->taken += n;
		return (int)n;
	}
	for (;;) {
		/* what the radio has made since the start: in whole buffers */
		made = (long long)((double)(mono_ns() - st->t0) * device->rate / 1e9);
		made -= made % st->buf;
		avail = made - st->taken;
		if (avail > 0)
			break;
		left = until - mono_ns();
		if (left <= 0)
			return SOAPY_SDR_TIMEOUT;
		/* until the next buffer is full, or the patience is over */
		wait = (long long)((double)(made + st->buf) / device->rate * 1e9) - (mono_ns() - st->t0);
		if (wait < 100000)
			wait = 100000;
		sleep_ns(wait < left ? wait : left);
	}
	if (avail > (long long)RING * st->buf) {
		/* nobody took them in time: all but the ring's worth are gone */
		long long lost = avail - (long long)RING * st->buf;

		st->taken += lost;
		device->next += lost;
		return SOAPY_SDR_OVERFLOW;
	}
	n = avail < (long long)numElems ? (long)avail : (long)numElems;
	fake_fill(buffs[0], device->next, n);
	device->next += n;
	st->taken += n;
	return (int)n;
}
