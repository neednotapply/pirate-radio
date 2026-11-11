/* The monotonic clock, and sleeping. */
#ifndef PIRATE_WEBSDR_CLOCK_H
#define PIRATE_WEBSDR_CLOCK_H

#include <time.h>

static inline long long mono_ns(void)
{
	struct timespec ts;

	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (long long)ts.tv_sec * 1000000000LL + (long long)ts.tv_nsec;
}

static inline long long mono_ms(void)
{
	return mono_ns() / 1000000LL;
}

/* Returns early when a signal arrives. */
static inline void sleep_ns(long long ns)
{
	struct timespec ts;

	if (ns <= 0)
		return;
	ts.tv_sec = (time_t)(ns / 1000000000LL);
	ts.tv_nsec = (long)(ns % 1000000000LL);
	nanosleep(&ts, NULL);
}

#endif
