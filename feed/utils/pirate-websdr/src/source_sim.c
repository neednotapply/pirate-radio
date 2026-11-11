/*
 * A simulated radio (--sim): noise and a few steady signals, in real time,
 * with no SoapySDR device touched. It stands in for both radios, each with
 * its own rates and gain elements, for tests and for trying the page (and
 * the network) without a radio.
 *
 * In every megahertz of the dial there is, at fixed absolute frequencies:
 *   +100 kHz  a bare carrier
 *   +400 kHz  wide FM: a 1 kHz tone, 75 kHz deviation
 *   +700 kHz  AM: a 400 Hz tone, 80 %
 *   +850 kHz  narrow FM: a 1 kHz tone, 2.4 kHz deviation
 * so tuning moves them across the band, and turning a gain up makes them
 * stronger (the noise stays).
 *
 * It must be cheap enough to run on the router itself, which has no FPU: the
 * signals are worked out once per tuning, with whole-number phase
 * accumulators and a sine table, into a pattern 5 ms long (every frequency
 * in it is a multiple of 200 Hz, so it repeats seamlessly); a read then only
 * copies the pattern and adds noise.
 *
 * Two environment variables bend it, for the tests:
 *   PIRATE_WEBSDR_SIM_ABSENT=rtlsdr   that radio does not open
 *   PIRATE_WEBSDR_SIM_STALL=1.5       the stream goes quiet after 1.5 s
 *
 * This is free software, licensed under the MIT license.
 */
#define _POSIX_C_SOURCE 200809L

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "clock.h"
#include "source.h"

#define PAT_HZ 200		/* a pattern is 1/200 s */
#define PAT_MAX 48000		/* samples: 9.6 Msps / 200 */
#define MAX_EMIT 4		/* signals worked out at a time: the nearest the centre */
#define TAB_BITS 10
#define TAB_SIZE (1 << TAB_BITS)
#define TWO_PI 6.283185307179586

enum { SIG_CARRIER, SIG_WFM, SIG_AM, SIG_NFM };

static const struct {
	long off;		/* Hz above each whole MHz */
	int kind;
	int amp;		/* peak, of 127, at the gains' defaults */
} GRID[] = {
	{ 100000, SIG_CARRIER, 28 },
	{ 400000, SIG_WFM, 24 },
	{ 700000, SIG_AM, 16 },
	{ 850000, SIG_NFM, 20 },
};
#define GRID_N ((int)(sizeof(GRID) / sizeof(GRID[0])))

struct sim_radio {
	int open;
	int running;
	char radio[8];
	struct src_info info;
	double gain_ref;		/* the gains' sum at which the signals have their amp */
	int8_t *pat;			/* I, Q, I, Q... */
	int pat_len;			/* samples in it */
	int pat_pos;			/* the next one to hand out */
	long long t0;			/* ns: when the stream started (or changed rate) */
	unsigned long long handed;	/* samples handed out since */
	long long stall_after;		/* ns of stream before it goes quiet; 0: never */
	uint32_t rng;
};

static struct sim_radio sim;
static int16_t sintab[TAB_SIZE];
static int tab_ready;

static void make_table(void)
{
	int i;

	for (i = 0; i < TAB_SIZE; i++)
		sintab[i] = (int16_t)floor(32767.0 * sin(TWO_PI * i / TAB_SIZE) + 0.5);
	tab_ready = 1;
}

static void add_sat(int8_t *p, long v)
{
	long s = (long)*p + v;

	if (s > 127)
		s = 127;
	else if (s < -127)
		s = -127;
	*p = (int8_t)s;
}

/* cycles in one pattern -> the phase step per sample (2^32 is a turn) */
static uint32_t phase_step(long long cycles, int len)
{
	return (uint32_t)((cycles * 4294967296LL) / len);
}

/* The pattern for the tuning, rate and gains of now. */
static void build_pattern(struct sim_radio *s)
{
	struct {
		long d;			/* Hz from the centre */
		int kind, amp;
	} em[MAX_EMIT];
	double centre = s->info.freq < 0 ? 0 : s->info.freq > 1e12 ? 1e12 : s->info.freq;
	long long fc = (long long)(centre + 0.5), mhz;
	long rate = (long)(s->info.rate + 0.5);
	long half = rate / 2 - rate / 100;	/* the band's very edges stay empty */
	long scale;				/* the gains' doing, in 1/256 */
	double sum = 0, g;
	int len = (int)(rate / PAT_HZ);
	int n = 0, i, j, k;

	if (len > PAT_MAX)
		len = PAT_MAX;
	if (len < 1)
		len = 1;
	s->pat_len = len;
	s->pat_pos = 0;
	memset(s->pat, 0, 2 * (size_t)len);

	for (i = 0; i < s->info.ngains; i++)
		sum += s->info.gains[i].value;
	g = pow(10.0, (sum - s->gain_ref) / 20.0);
	if (g < 0.0625)
		g = 0.0625;
	if (g > 4.0)
		g = 4.0;
	scale = (long)(g * 256.0 + 0.5);

	/* the signals in view: the MAX_EMIT nearest the centre, nearest first */
	for (mhz = (fc - half) / 1000000 - 1; mhz <= (fc + half) / 1000000 + 1; mhz++) {
		for (k = 0; k < GRID_N; k++) {
			long long d = mhz * 1000000 + GRID[k].off - fc;
			long ad;
			int pos, last;

			if (d > half || d < -half)
				continue;
			ad = (long)(d < 0 ? -d : d);
			pos = n;
			while (pos > 0 && labs(em[pos - 1].d) > ad)
				pos--;
			if (pos >= MAX_EMIT)
				continue;
			last = (n < MAX_EMIT) ? n : MAX_EMIT - 1;
			for (j = last; j > pos; j--)
				em[j] = em[j - 1];
			em[pos].d = (long)d;
			em[pos].kind = GRID[k].kind;
			em[pos].amp = GRID[k].amp;
			if (n < MAX_EMIT)
				n++;
		}
	}

	for (i = 0; i < n; i++) {
		long d = em[i].d;
		long long cycles = (d >= 0 ? d + PAT_HZ / 2 : d - PAT_HZ / 2) / PAT_HZ;
		uint32_t step = phase_step(cycles, len), ph = 0;
		uint32_t mstep = 0, mph = 0;	/* the tone that modulates it */
		long long dev = 0;		/* FM: the peak deviation, as a phase step */
		long amp = (long)em[i].amp * scale;	/* in 1/256 */

		switch (em[i].kind) {
		case SIG_WFM:
			mstep = phase_step(1000 / PAT_HZ, len);
			dev = ((75000LL / PAT_HZ) * 4294967296LL) / len;
			break;
		case SIG_NFM:
			mstep = phase_step(1000 / PAT_HZ, len);
			dev = ((2400LL / PAT_HZ) * 4294967296LL) / len;
			break;
		case SIG_AM:
			mstep = phase_step(400 / PAT_HZ, len);
			break;
		default:
			break;
		}

		for (j = 0; j < len; j++) {
			long a = amp;
			int idx;

			if (em[i].kind == SIG_AM) {
				a = amp + (amp * 4 / 5) * (long)sintab[mph >> (32 - TAB_BITS)] / 32768;
				mph += mstep;
			} else if (dev != 0) {
				ph += (uint32_t)((dev * (long long)sintab[mph >> (32 - TAB_BITS)]) / 32768);
				mph += mstep;
			}
			idx = (int)(ph >> (32 - TAB_BITS));
			add_sat(&s->pat[2 * j], a * (long)sintab[(idx + TAB_SIZE / 4) & (TAB_SIZE - 1)] / 8388608);
			add_sat(&s->pat[2 * j + 1], a * (long)sintab[idx] / 8388608);
			ph += step;
		}
	}
}

static void add_gain(struct sim_radio *s, const char *name, double min, double max, double step)
{
	struct src_gain *g = &s->info.gains[s->info.ngains++];

	snprintf(g->name, sizeof(g->name), "%s", name);
	g->min = min;
	g->max = max;
	g->step = step;
	g->value = src_default_gain(s->radio, g);
	s->gain_ref += g->value;
}

static void *sim_open(const char *radio, double freq, double rate, char *err)
{
	struct sim_radio *s = &sim;
	const char *absent = getenv("PIRATE_WEBSDR_SIM_ABSENT");
	const char *stall = getenv("PIRATE_WEBSDR_SIM_STALL");
	int hackrf = strcmp(radio, "hackrf") == 0;

	if (s->open) {
		snprintf(err, SRC_ERR_LEN, "the simulated radio is open already");
		return NULL;
	}
	if (absent && strcmp(absent, radio) == 0) {
		snprintf(err, SRC_ERR_LEN, "no %s found (simulated)", radio);
		return NULL;
	}
	if (rate < PAT_HZ || rate / PAT_HZ > PAT_MAX) {
		snprintf(err, SRC_ERR_LEN, "the simulated radio cannot do %.0f samples a second", rate);
		return NULL;
	}
	if (!tab_ready)
		make_table();

	memset(s, 0, sizeof(*s));
	s->pat = malloc(2 * PAT_MAX);
	if (!s->pat) {
		snprintf(err, SRC_ERR_LEN, "out of memory");
		return NULL;
	}
	snprintf(s->radio, sizeof(s->radio), "%s", radio);
	snprintf(s->info.label, sizeof(s->info.label), "Simulated %s", hackrf ? "HackRF" : "RTL-SDR");
	s->info.freq = freq;
	s->info.rate = rate;
	s->info.nrates = src_rates_for(radio, s->info.rates);
	if (hackrf) {
		s->info.range_lo = 1e6;
		s->info.range_hi = 6e9;
		add_gain(s, "LNA", 0, 40, 8);		/* in the real driver's order */
		add_gain(s, "AMP", 0, 14, 14);
		add_gain(s, "VGA", 0, 62, 2);
	} else {
		s->info.range_lo = 24e6;
		s->info.range_hi = 1766e6;
		add_gain(s, "TUNER", 0, 49.6, 0);
	}
	if (stall && atof(stall) > 0)
		s->stall_after = (long long)(atof(stall) * 1e9);
	s->rng = 0x2545f491u;
	s->open = 1;
	build_pattern(s);
	return s;
}

static void sim_close(void *h)
{
	struct sim_radio *s = h;

	free(s->pat);
	s->pat = NULL;
	s->running = 0;
	s->open = 0;
}

static int sim_start(void *h, char *err)
{
	struct sim_radio *s = h;

	(void)err;
	s->running = 1;
	s->t0 = mono_ns();
	s->handed = 0;
	return 0;
}

static void sim_stop(void *h)
{
	struct sim_radio *s = h;

	s->running = 0;
}

static int sim_set_freq(void *h, double hz, char *err)
{
	struct sim_radio *s = h;

	if (hz < s->info.range_lo || hz > s->info.range_hi) {
		snprintf(err, SRC_ERR_LEN, "%.0f Hz is outside what the radio tunes", hz);
		return -1;
	}
	s->info.freq = hz;
	build_pattern(s);
	return 0;
}

static int sim_set_rate(void *h, double hz, char *err)
{
	struct sim_radio *s = h;

	if (hz < PAT_HZ || hz / PAT_HZ > PAT_MAX) {
		snprintf(err, SRC_ERR_LEN, "the simulated radio cannot do %.0f samples a second", hz);
		return -1;
	}
	s->info.rate = hz;
	build_pattern(s);
	s->t0 = mono_ns();
	s->handed = 0;
	return 0;
}

static int sim_set_gain(void *h, const char *name, double db, char *err)
{
	struct sim_radio *s = h;
	int i;

	for (i = 0; i < s->info.ngains; i++) {
		if (strcmp(s->info.gains[i].name, name) == 0) {
			s->info.gains[i].value = src_snap_gain(&s->info.gains[i], db);
			build_pattern(s);
			return 0;
		}
	}
	snprintf(err, SRC_ERR_LEN, "no gain element %s", name);
	return -1;
}

static const struct src_info *sim_info(void *h)
{
	struct sim_radio *s = h;

	return &s->info;
}

static int sim_read(void *h, int8_t *iq, int max, int timeout_ms, int *overflow, char *err)
{
	struct sim_radio *s = h;
	long long now = mono_ns(), deadline = now + (long long)timeout_ms * 1000000LL;
	unsigned long long rate = (unsigned long long)(s->info.rate + 0.5), due;
	long long avail;
	uint32_t r;
	int n, i, pos, len;

	(void)err;
	if (!s->running || max <= 0) {
		sleep_ns(deadline - now);
		return 0;
	}

	/* wait until the radio would have made max samples, or as long as allowed */
	for (;;) {
		long long el = now - s->t0, wait;

		if (s->stall_after && el > s->stall_after) {
			sleep_ns(deadline - now);
			return 0;
		}
		due = (unsigned long long)(el / 1000000000LL) * rate +
			((unsigned long long)(el % 1000000000LL) * rate) / 1000000000ULL;
		avail = (long long)(due - s->handed);
		if (avail > (long long)(rate / 2)) {
			/* half a second behind: the oldest are lost, as in a radio's own buffer */
			s->handed = due - (unsigned long long)max;
			avail = max;
			*overflow = 1;
		}
		if (avail >= max || now >= deadline)
			break;
		wait = ((long long)(max - avail) * 1000000000LL) / (long long)rate + 1000;
		if (wait > deadline - now)
			wait = deadline - now;
		sleep_ns(wait);
		now = mono_ns();
	}
	n = avail < max ? (int)avail : max;
	if (n <= 0)
		return 0;

	/* the pattern, round and round, and noise: two bits and two bits a side */
	r = s->rng;
	pos = s->pat_pos;
	len = s->pat_len;
	for (i = 0; i < n; i++) {
		int vi, vq;

		r ^= r << 13;
		r ^= r >> 17;
		r ^= r << 5;
		vi = s->pat[2 * pos] + (int)((r & 3) + ((r >> 2) & 3)) - 3;
		vq = s->pat[2 * pos + 1] + (int)(((r >> 4) & 3) + ((r >> 6) & 3)) - 3;
		if (vi > 127)
			vi = 127;
		else if (vi < -127)
			vi = -127;
		if (vq > 127)
			vq = 127;
		else if (vq < -127)
			vq = -127;
		iq[2 * i] = (int8_t)vi;
		iq[2 * i + 1] = (int8_t)vq;
		if (++pos == len)
			pos = 0;
	}
	s->rng = r;
	s->pat_pos = pos;
	s->handed += (unsigned long long)n;
	return n;
}

const struct source_ops source_sim = {
	sim_open, sim_close, sim_start, sim_stop,
	sim_set_freq, sim_set_rate, sim_set_gain, sim_info, sim_read
};
