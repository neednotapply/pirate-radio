/*
 * The real radio, through SoapySDR's C API (0.8 and later): the HackRF
 * (driver=hackrf) or the RTL-SDR (driver=rtlsdr), read as CS8: interleaved
 * signed 8-bit I and Q, which is what both give natively, so nothing is
 * converted on the way.
 *
 * A stream is started once. It is made when the samples are to start and
 * closed when they stop; the radio itself stays open in between. A driver's
 * stream that is stopped and started again can come back wrong: the
 * HackRF's keeps the buffer it had only half handed out, and from the next
 * start counts its buffers one too few (below nought, when none has come
 * yet). Its reads then never wait for the radio again: they hand out old
 * samples, over and over, as fast as they are asked for. A stream made anew
 * starts clean, whatever the driver.
 *
 * Every way out lets go of the radio in order: deactivateStream,
 * closeStream, unmake.
 *
 * This is free software, licensed under the MIT license.
 */
#define _POSIX_C_SOURCE 200809L

#include <stdio.h>
#include <string.h>

#include <SoapySDR/Device.h>
#include <SoapySDR/Errors.h>
#include <SoapySDR/Formats.h>

#include "source.h"

struct soapy_radio {
	SoapySDRDevice *dev;
	SoapySDRStream *stream;
	int active;
	char radio[8];
	struct src_info info;
};

static struct soapy_radio soapy;	/* one radio at a time */

/* "<what>: <SoapySDR's reason>" into err */
static void fail(char *err, const char *what)
{
	const char *why = SoapySDRDevice_lastError();

	snprintf(err, SRC_ERR_LEN, "%s: %s", what, (why && *why) ? why : "no reason given");
}

/* The stream, at the rate of now. The RTL-SDR's driver hands samples over
   in buffers of 262144 bytes unless told otherwise: at 240000 samples a
   second that is more than half a second at a time, far too lumpy to listen
   to. So its buffers are made to hold about 20 ms (a multiple of 512 bytes,
   as its USB side wants), and enough of them for most of a second. The
   HackRF's are what its library makes them (262144 bytes: 55 ms at 2.4 Msps). */
static int make_stream(struct soapy_radio *s, char *err)
{
	SoapySDRKwargs args;
	char num[16];
	long len;

	memset(&args, 0, sizeof(args));
	if (strcmp(s->radio, "rtlsdr") == 0) {
		len = (long)(s->info.rate * 2 / 50);
		len = (len + 511) / 512 * 512;
		if (len < 4096)
			len = 4096;
		if (len > 262144)
			len = 262144;
		snprintf(num, sizeof(num), "%ld", len);
		SoapySDRKwargs_set(&args, "bufflen", num);
		SoapySDRKwargs_set(&args, "buffers", "40");
	}
	s->stream = SoapySDRDevice_setupStream(s->dev, SOAPY_SDR_RX, SOAPY_SDR_CS8, NULL, 0, &args);
	SoapySDRKwargs_clear(&args);
	if (!s->stream) {
		fail(err, "it gave no stream");
		return -1;
	}
	return 0;
}

/* The stream stopped, if it runs, and closed: it is not used again. */
static void drop_stream(struct soapy_radio *s)
{
	if (!s->stream)
		return;
	if (s->active)
		SoapySDRDevice_deactivateStream(s->dev, s->stream, 0, 0);
	SoapySDRDevice_closeStream(s->dev, s->stream);
	s->stream = NULL;
	s->active = 0;
}

static void let_go(struct soapy_radio *s)
{
	drop_stream(s);
	if (s->dev)
		SoapySDRDevice_unmake(s->dev);
	s->dev = NULL;
}

static void *soapy_open(const char *radio, double freq, double rate, char *err)
{
	struct soapy_radio *s = &soapy;
	int hackrf = strcmp(radio, "hackrf") == 0;
	char args[32];
	char **names;
	char *key;
	SoapySDRRange *fr;
	size_t n, i;

	if (s->dev) {
		snprintf(err, SRC_ERR_LEN, "a radio is open already");
		return NULL;
	}
	memset(s, 0, sizeof(*s));
	snprintf(s->radio, sizeof(s->radio), "%s", radio);
	snprintf(args, sizeof(args), "driver=%s", radio);

	s->dev = SoapySDRDevice_makeStrArgs(args);
	if (!s->dev) {
		fail(err, "it did not open");
		return NULL;
	}

	if (SoapySDRDevice_setSampleRate(s->dev, SOAPY_SDR_RX, 0, rate) != 0) {
		fail(err, "it would not take the sample rate");
		let_go(s);
		return NULL;
	}
	if (SoapySDRDevice_setFrequency(s->dev, SOAPY_SDR_RX, 0, freq, NULL) != 0) {
		fail(err, "it would not tune");
		let_go(s);
		return NULL;
	}
	s->info.rate = rate;
	s->info.freq = freq;
	s->info.nrates = src_rates_for(radio, s->info.rates);

	/* the gains by hand, each element at its default */
	if (SoapySDRDevice_hasGainMode(s->dev, SOAPY_SDR_RX, 0))
		SoapySDRDevice_setGainMode(s->dev, SOAPY_SDR_RX, 0, false);
	n = 0;
	names = SoapySDRDevice_listGains(s->dev, SOAPY_SDR_RX, 0, &n);
	for (i = 0; names && i < n && s->info.ngains < SRC_MAX_GAINS; i++) {
		struct src_gain *g = &s->info.gains[s->info.ngains];
		SoapySDRRange r;

		if (!names[i] || strlen(names[i]) >= sizeof(g->name))
			continue;
		r = SoapySDRDevice_getGainElementRange(s->dev, SOAPY_SDR_RX, 0, names[i]);
		strcpy(g->name, names[i]);
		g->min = r.minimum;
		g->max = r.maximum;
		g->step = r.step > 0 ? r.step : 0;
		SoapySDRDevice_setGainElement(s->dev, SOAPY_SDR_RX, 0, g->name, src_default_gain(radio, g));
		g->value = SoapySDRDevice_getGainElement(s->dev, SOAPY_SDR_RX, 0, g->name);
		s->info.ngains++;
	}
	if (names)
		SoapySDRStrings_clear(&names, n);

	/* what it calls itself */
	key = SoapySDRDevice_getHardwareKey(s->dev);
	if (hackrf)
		snprintf(s->info.label, sizeof(s->info.label), "%s", (key && *key) ? key : "HackRF");
	else if (key && *key)
		snprintf(s->info.label, sizeof(s->info.label), "RTL-SDR (%s)", key);
	else
		snprintf(s->info.label, sizeof(s->info.label), "RTL-SDR");
	if (key)
		SoapySDR_free(key);

	/* what it tunes: from the lowest of its ranges to the highest */
	s->info.range_lo = hackrf ? 1e6 : 24e6;
	s->info.range_hi = hackrf ? 6e9 : 1766e6;
	n = 0;
	fr = SoapySDRDevice_getFrequencyRange(s->dev, SOAPY_SDR_RX, 0, &n);
	if (fr && n > 0) {
		double lo = fr[0].minimum, hi = fr[0].maximum;

		for (i = 1; i < n; i++) {
			if (fr[i].minimum < lo)
				lo = fr[i].minimum;
			if (fr[i].maximum > hi)
				hi = fr[i].maximum;
		}
		if (lo < 1e6)
			lo = 1e6;		/* a driver may say 0: nothing here hears down there */
		if (hi > lo) {
			s->info.range_lo = lo;
			s->info.range_hi = hi;
		}
	}
	if (fr)
		SoapySDR_free(fr);

	return s;			/* (its stream is made when it is started) */
}

static void soapy_close(void *h)
{
	let_go(h);
}

static int soapy_start(void *h, char *err)
{
	struct soapy_radio *s = h;

	if (s->active)
		return 0;
	if (make_stream(s, err) != 0)
		return -1;
	if (SoapySDRDevice_activateStream(s->dev, s->stream, 0, 0, 0) != 0) {
		fail(err, "the stream did not start");
		drop_stream(s);
		return -1;
	}
	s->active = 1;
	return 0;
}

static void soapy_stop(void *h)
{
	drop_stream(h);
}

static int soapy_set_freq(void *h, double hz, char *err)
{
	struct soapy_radio *s = h;

	if (SoapySDRDevice_setFrequency(s->dev, SOAPY_SDR_RX, 0, hz, NULL) != 0) {
		fail(err, "it would not tune");
		return -1;
	}
	s->info.freq = hz;
	return 0;
}

/* The stream stops for a change of rate, so that no buffer mixes the two,
   and a new one starts after it (the RTL-SDR's with its buffers sized for
   the new rate); the radio itself stays open. */
static int soapy_set_rate(void *h, double hz, char *err)
{
	struct soapy_radio *s = h;
	char again[SRC_ERR_LEN];
	int was = s->active, rc = 0;

	drop_stream(s);
	if (SoapySDRDevice_setSampleRate(s->dev, SOAPY_SDR_RX, 0, hz) != 0) {
		fail(err, "it would not take the sample rate");
		rc = -1;
	} else {
		s->info.rate = hz;
	}
	/* (at the rate it has: the new one, or the old one still. Should it
	   not start, there is no stream: reads fail, and the radio is closed) */
	if (was && soapy_start(s, rc == 0 ? err : again) != 0)
		rc = -1;
	return rc;
}

static int soapy_set_gain(void *h, const char *name, double db, char *err)
{
	struct soapy_radio *s = h;
	int i;

	for (i = 0; i < s->info.ngains; i++) {
		struct src_gain *g = &s->info.gains[i];

		if (strcmp(g->name, name) != 0)
			continue;
		if (SoapySDRDevice_setGainElement(s->dev, SOAPY_SDR_RX, 0, g->name, src_snap_gain(g, db)) != 0) {
			fail(err, "it would not take the gain");
			return -1;
		}
		g->value = SoapySDRDevice_getGainElement(s->dev, SOAPY_SDR_RX, 0, g->name);
		return 0;
	}
	snprintf(err, SRC_ERR_LEN, "no gain element %s", name);
	return -1;
}

static const struct src_info *soapy_info(void *h)
{
	struct soapy_radio *s = h;

	return &s->info;
}

static int soapy_read(void *h, int8_t *iq, int max, int timeout_ms, int *overflow, char *err)
{
	struct soapy_radio *s = h;
	void *buffs[1];
	int flags = 0, n;
	long long when = 0;

	if (max <= 0)
		return 0;
	if (!s->stream) {
		snprintf(err, SRC_ERR_LEN, "it has no stream");
		return -1;
	}
	buffs[0] = iq;
	n = SoapySDRDevice_readStream(s->dev, s->stream, buffs, (size_t)max, &flags, &when, (long)timeout_ms * 1000L);
	if (n >= 0)
		return n;
	if (n == SOAPY_SDR_TIMEOUT)
		return 0;
	if (n == SOAPY_SDR_OVERFLOW) {
		*overflow = 1;		/* its own buffer ran over: samples are gone, it goes on */
		return 0;
	}
	snprintf(err, SRC_ERR_LEN, "%s", SoapySDR_errToStr(n));
	return -1;
}

const struct source_ops source_soapy = {
	soapy_open, soapy_close, soapy_start, soapy_stop,
	soapy_set_freq, soapy_set_rate, soapy_set_gain, soapy_info, soapy_read
};
