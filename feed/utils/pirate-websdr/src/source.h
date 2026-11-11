/* The radio, behind one small interface: a real one through SoapySDR
   (source_soapy.c) or a simulated one (source_sim.c). One at a time. */
#ifndef PIRATE_WEBSDR_SOURCE_H
#define PIRATE_WEBSDR_SOURCE_H

#include <stdint.h>
#include <string.h>

#define SRC_MAX_GAINS 6
#define SRC_MAX_RATES 6
#define SRC_ERR_LEN 160		/* every err argument has room for this */

struct src_gain {
	char name[16];
	double min, max, step;	/* dB; step 0: continuous */
	double value;
};

struct src_info {
	char label[48];
	double freq;		/* centre, Hz */
	double rate;		/* samples a second */
	double range_lo, range_hi;
	int nrates;
	double rates[SRC_MAX_RATES];
	int ngains;
	struct src_gain gains[SRC_MAX_GAINS];
};

struct source_ops {
	/* Opens the radio ("hackrf" or "rtlsdr") at that centre and rate, the
	   gains at their defaults, not yet streaming: a handle for the calls
	   below. NULL, and why in err, when it does not open. */
	void *(*open)(const char *radio, double freq, double rate, char *err);
	/* Stops the stream if it runs, then lets go of the radio. */
	void (*close)(void *h);
	/* The stream on and off: the radio stays open. 0, or -1 and err. */
	int (*start)(void *h, char *err);
	void (*stop)(void *h);
	/* 0, or -1 and err. After any of them, info() tells what holds now. */
	int (*set_freq)(void *h, double hz, char *err);
	int (*set_rate)(void *h, double hz, char *err);
	int (*set_gain)(void *h, const char *name, double db, char *err);
	const struct src_info *(*info)(void *h);
	/* Up to max samples (I, Q, I, Q... as int8) into iq, waiting at most
	   timeout_ms for them: how many came (0: none in time), or -1 and err
	   when the radio failed. *overflow is set when samples were lost
	   before these. */
	int (*read)(void *h, int8_t *iq, int max, int timeout_ms, int *overflow, char *err);
};

extern const struct source_ops source_sim;
#ifdef WITH_SOAPY
extern const struct source_ops source_soapy;
#endif

/* The sample rates offered for a radio: all multiples of 48000, so that the
   browser gets to 48 kHz audio by dividing by a whole number. */
static inline int src_rates_for(const char *radio, double *rates)
{
	static const double hackrf[] = { 2400000, 4800000, 9600000 };
	static const double rtlsdr[] = { 240000, 960000, 1200000, 1920000, 2400000 };
	int i, n;

	if (strcmp(radio, "hackrf") == 0) {
		n = (int)(sizeof(hackrf) / sizeof(hackrf[0]));
		for (i = 0; i < n; i++)
			rates[i] = hackrf[i];
	} else {
		n = (int)(sizeof(rtlsdr) / sizeof(rtlsdr[0]));
		for (i = 0; i < n; i++)
			rates[i] = rtlsdr[i];
	}
	return n;
}

/* A gain brought into its element's range and onto its steps. */
static inline double src_snap_gain(const struct src_gain *g, double db)
{
	if (db < g->min)
		db = g->min;
	if (db > g->max)
		db = g->max;
	if (g->step > 0) {
		db = g->min + (double)(long)((db - g->min) / g->step + 0.5) * g->step;
		if (db > g->max)
			db = g->max;
	}
	return db;
}

/* A gain element's value when the radio opens: the HackRF's as hackrf_transfer
   and the other jobs here have them, anything else at 60 % of its range. */
static inline double src_default_gain(const char *radio, const struct src_gain *g)
{
	double db = g->min + 0.6 * (g->max - g->min);

	if (strcmp(radio, "hackrf") == 0) {
		if (strcmp(g->name, "LNA") == 0)
			db = 24;
		else if (strcmp(g->name, "VGA") == 0)
			db = 20;
		else if (strcmp(g->name, "AMP") == 0)
			db = 0;
	}
	return src_snap_gain(g, db);
}

#endif
