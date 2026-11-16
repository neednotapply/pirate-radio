/*
 * Pirate Radio's firmware for an ESP32 board on the router's USB port: the
 * chip's Bluetooth Low Energy radio, for pirate-bluetooth, and nothing that
 * sends.
 *
 * The chip's Bluetooth controller runs on its own (no Bluetooth host on the
 * board), and the router speaks HCI to it as to a USB dongle, a line of
 * text each way, so that whatever the chip prints as it starts is told
 * apart from what it says:
 *
 *   router -> board   hello        the board says what it is
 *                     C <hex>      an HCI command: its opcode (low byte
 *                                  first), its length and its parameters
 *   board -> router   PIRATE-ESP <protocol> <chip> <address> <firmware> <radio>
 *                                  what it is: the protocol (1), the chip
 *                                  (esp32c3...), its Bluetooth address, this
 *                                  firmware's version, and "ready" or what
 *                                  went wrong with the radio
 *                     E <hex>      an HCI event: its code, its length and
 *                                  its parameters
 *
 * Only commands that ask the controller what it is, set up a passive scan
 * and turn a scan on or off are let through. Anything else (advertising, a
 * connection, an active scan, which sends scan requests, a test that
 * transmits) is answered with Command Disallowed (0x0c) and never reaches
 * the radio. So the board only listens, whatever the router sends it.
 *
 * As it starts, the board resets the controller and tells it which events
 * to send: of the Low Energy ones, the advertising reports (as they are,
 * directed, and extended, where the chip has those).
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "esp_bt.h"
#include "esp_mac.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#if CONFIG_PIRATE_LINK_USB_SERIAL_JTAG
#include "driver/usb_serial_jtag.h"
#else
#include "driver/uart.h"
#include "soc/uart_pins.h"
#endif

#define FIRMWARE "0.1.0"
#define PROTOCOL 1

#define H4_CMD 0x01
#define H4_EVT 0x04

#define EVT_CMD_COMPLETE 0x0e
#define EVT_CMD_STATUS   0x0f

#define OP_SET_EVENT_MASK    0x0c01
#define OP_RESET             0x0c03
#define OP_LE_SET_EVENT_MASK 0x2001

#define DISALLOWED 0x0c   /* HCI status: Command Disallowed */

#define LINE 600          /* a line from the router, at most (a command is 4 + 255 bytes) */

/* An HCI event, as the controller hands it over: its H4 type, its code, its
 * length and its parameters */
struct pkt {
	uint16_t n;
	uint8_t d[3 + 255];
};

static QueueHandle_t events;          /* events for the router, in order */
static SemaphoreHandle_t to_radio;    /* one sender to the controller at a time */
static SemaphoreHandle_t to_router;   /* one writer of lines at a time */
static SemaphoreHandle_t own_done;    /* the answer to the board's own command came */
static volatile uint16_t own_op;      /* the board's own command that is out, or 0 */
static volatile uint8_t own_status;
static char radio[48] = "starting";
static char address[18] = "00:00:00:00:00:00";

/* ---------- the link to the router ---------- */

static void link_init(void)
{
#if CONFIG_PIRATE_LINK_USB_SERIAL_JTAG
	usb_serial_jtag_driver_config_t c = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();

	c.rx_buffer_size = 1024;
	c.tx_buffer_size = 8192;
	usb_serial_jtag_driver_install(&c);
#else
	uart_config_t c = {
		.baud_rate = CONFIG_PIRATE_UART_BAUD,
		.data_bits = UART_DATA_8_BITS,
		.parity = UART_PARITY_DISABLE,
		.stop_bits = UART_STOP_BITS_1,
		.flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
		.source_clk = UART_SCLK_DEFAULT,
	};

	uart_driver_install(UART_NUM_0, 1024, 8192, 0, NULL, 0);
	uart_param_config(UART_NUM_0, &c);
	/* (its pins said: with no console, nothing at start-up puts them on
	 * the UART, and the board says nothing) */
	uart_set_pin(UART_NUM_0, U0TXD_GPIO_NUM, U0RXD_GPIO_NUM, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
#endif
}

/* A whole line to the router; with nobody reading, it is let go of after a
 * moment rather than holding up the radio */
static void link_write(const char *s, size_t n)
{
	xSemaphoreTake(to_router, portMAX_DELAY);
#if CONFIG_PIRATE_LINK_USB_SERIAL_JTAG
	usb_serial_jtag_write_bytes(s, n, pdMS_TO_TICKS(20));
#else
	uart_write_bytes(UART_NUM_0, s, n);
#endif
	xSemaphoreGive(to_router);
}

/* What has come, as soon as something has */
static int link_read(uint8_t *b, size_t n)
{
#if CONFIG_PIRATE_LINK_USB_SERIAL_JTAG
	return usb_serial_jtag_read_bytes(b, n, portMAX_DELAY);
#else
	/* (uart_read_bytes waits for all it is asked for: one byte, then
	 * what else is there already) */
	size_t more = 0;
	int r = uart_read_bytes(UART_NUM_0, b, 1, portMAX_DELAY);

	if (r == 1 && uart_get_buffered_data_len(UART_NUM_0, &more) == ESP_OK && more) {
		int r2 = uart_read_bytes(UART_NUM_0, b + 1, more < n - 1 ? more : n - 1, 0);

		if (r2 > 0)
			r += r2;
	}
	return r;
#endif
}

static void say_hello(void)
{
	char s[160];
	int n = snprintf(s, sizeof(s), "PIRATE-ESP %d %s %s %s %s\n", PROTOCOL, CONFIG_IDF_TARGET, address, FIRMWARE,
			 radio);

	link_write(s, n);
}

/* ---------- the radio (the Bluetooth controller, over VHCI) ---------- */

static void radio_ready(void)
{
}

/* What the controller sends (the controller's own task: nothing that waits
 * long). An event goes to the router, but for the answer to a command the
 * board sent itself */
static int radio_said(uint8_t *d, uint16_t n)
{
	static struct pkt p;
	uint16_t op = 0;
	uint8_t st = 0;

	if (n < 3 || d[0] != H4_EVT || n != 3u + d[2])
		return 0;
	if (d[1] == EVT_CMD_COMPLETE && n >= 7) {
		op = d[4] | d[5] << 8;
		st = d[6];
	} else if (d[1] == EVT_CMD_STATUS && n >= 7) {
		op = d[5] | d[6] << 8;
		st = d[3];
	}
	if (op && op == own_op) {
		own_status = st;
		own_op = 0;
		xSemaphoreGive(own_done);
		return 0;
	}
	p.n = n;
	memcpy(p.d, d, n);
	/* (with the queue full, the router is not reading: let go) */
	xQueueSend(events, &p, 0);
	return 0;
}

static const esp_vhci_host_callback_t radio_cb = {
	.notify_host_send_available = radio_ready,
	.notify_host_recv = radio_said,
};

static bool radio_send(uint8_t *pkt, uint16_t n)
{
	bool ok;
	int i;

	/* (a second at most, a tick at a time) */
	xSemaphoreTake(to_radio, portMAX_DELAY);
	for (i = 0; i < 1 + configTICK_RATE_HZ && !esp_vhci_host_check_send_available(); i++)
		vTaskDelay(1);
	ok = esp_vhci_host_check_send_available();
	if (ok)
		esp_vhci_host_send_packet(pkt, n);
	xSemaphoreGive(to_radio);
	return ok;
}

/* A command of the board's own, and its answer (true: done) */
static bool own_cmd(uint16_t op, const uint8_t *p, uint8_t n)
{
	uint8_t pkt[4 + 16];

	pkt[0] = H4_CMD;
	pkt[1] = op & 0xff;
	pkt[2] = op >> 8;
	pkt[3] = n;
	memcpy(pkt + 4, p, n);
	xSemaphoreTake(own_done, 0);
	own_op = op;
	if (!radio_send(pkt, 4 + n) || xSemaphoreTake(own_done, pdMS_TO_TICKS(2000)) != pdTRUE) {
		own_op = 0;
		return false;
	}
	return own_status == 0;
}

/* What the controller is let do for the router: be asked what it is, scan
 * passively, and stop */
static bool allowed(uint16_t op, const uint8_t *p, uint8_t n)
{
	switch (op) {
	case 0x1001:   /* Read Local Version Information */
	case 0x1002:   /* Read Local Supported Commands */
	case 0x1003:   /* Read Local Supported Features */
	case 0x1009:   /* Read BD_ADDR */
	case 0x2002:   /* LE Read Buffer Size */
	case 0x2003:   /* LE Read Local Supported Features */
		return true;
	case 0x200c:   /* LE Set Scan Enable */
	case 0x2042:   /* LE Set Extended Scan Enable */
		return true;
	case 0x200b:   /* LE Set Scan Parameters: passive (scan type 0) only */
		return n == 7 && p[0] == 0;
	case 0x2041:   /* LE Set Extended Scan Parameters: one PHY, passive */
		return n == 8 && p[3] == 0 && (p[2] == 0x01 || p[2] == 0x04);
	default:
		return false;
	}
}

/* The answer to a command that is not let through, in its turn */
static void refuse(uint16_t op)
{
	struct pkt p = { .n = 7, .d = { H4_EVT, EVT_CMD_COMPLETE, 4, 1, op & 0xff, op >> 8, DISALLOWED } };

	xQueueSend(events, &p, portMAX_DELAY);
}

static void radio_start(void)
{
	esp_bt_controller_config_t cfg = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
	/* LE Meta (bit 61) on top of the events a controller sends anyway */
	static const uint8_t mask[8] = { 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0x00, 0x20 };
	/* Of the Low Energy events: advertising reports (bit 1), directed ones
	 * (bit 10) and extended ones (bit 12); without the extended ones on a
	 * chip from before Bluetooth 5, and without the directed ones before 4.2 */
	static const uint8_t le_masks[3][8] = {
		{ 0x02, 0x14, 0, 0, 0, 0, 0, 0 },
		{ 0x02, 0x04, 0, 0, 0, 0, 0, 0 },
		{ 0x02, 0x00, 0, 0, 0, 0, 0, 0 },
	};
	uint8_t mac[6];
	esp_err_t e;
	int i;

	if (esp_read_mac(mac, ESP_MAC_BT) == ESP_OK)
		snprintf(address, sizeof(address), "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3],
			 mac[4], mac[5]);
	esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT);
	if ((e = esp_bt_controller_init(&cfg)) != ESP_OK) {
		snprintf(radio, sizeof(radio), "failed:init:0x%x", e);
		return;
	}
	if ((e = esp_bt_controller_enable(ESP_BT_MODE_BLE)) != ESP_OK) {
		snprintf(radio, sizeof(radio), "failed:enable:0x%x", e);
		return;
	}
	if ((e = esp_vhci_host_register_callback(&radio_cb)) != ESP_OK) {
		snprintf(radio, sizeof(radio), "failed:vhci:0x%x", e);
		return;
	}
	if (!own_cmd(OP_RESET, NULL, 0)) {
		snprintf(radio, sizeof(radio), "failed:reset");
		return;
	}
	if (!own_cmd(OP_SET_EVENT_MASK, mask, sizeof(mask))) {
		snprintf(radio, sizeof(radio), "failed:event-mask");
		return;
	}
	for (i = 0; i < 3 && !own_cmd(OP_LE_SET_EVENT_MASK, le_masks[i], 8); i++)
		;
	if (i == 3) {
		snprintf(radio, sizeof(radio), "failed:le-event-mask");
		return;
	}
	snprintf(radio, sizeof(radio), "ready");
}

/* ---------- what goes between them ---------- */

static const char hexd[] = "0123456789abcdef";

static int unhex1(char c)
{
	if (c >= '0' && c <= '9')
		return c - '0';
	if (c >= 'a' && c <= 'f')
		return c - 'a' + 10;
	if (c >= 'A' && c <= 'F')
		return c - 'A' + 10;
	return -1;
}

/* Hex digits (spaces between bytes allowed) into bytes; -1 if not that */
static int unhex(const char *s, uint8_t *b, size_t max)
{
	size_t n = 0;

	for (;;) {
		int hi, lo;

		while (*s == ' ')
			s++;
		if (!*s)
			return n;
		hi = unhex1(s[0]);
		lo = hi < 0 ? -1 : unhex1(s[1]);
		if (lo < 0 || n == max)
			return -1;
		b[n++] = hi << 4 | lo;
		s += 2;
	}
}

/* The controller's events to the router, each a line */
static void to_router_task(void *arg)
{
	static struct pkt p;
	static char s[2 + 2 * sizeof(p.d) + 1];
	size_t i, o;

	(void)arg;
	for (;;) {
		xQueueReceive(events, &p, portMAX_DELAY);
		s[0] = 'E';
		s[1] = ' ';
		o = 2;
		for (i = 1; i < p.n; i++) {
			s[o++] = hexd[p.d[i] >> 4];
			s[o++] = hexd[p.d[i] & 15];
		}
		s[o++] = '\n';
		link_write(s, o);
	}
}

static void on_line(char *s)
{
	uint8_t pkt[1 + 3 + 255];
	uint16_t op;
	int n;

	if (!strcmp(s, "hello")) {
		say_hello();
		return;
	}
	if (s[0] != 'C' || s[1] != ' ')
		return;
	/* A whole command, or nothing */
	n = unhex(s + 2, pkt + 1, sizeof(pkt) - 1);
	if (n < 3 || n != 3 + pkt[3])
		return;
	op = pkt[1] | pkt[2] << 8;
	if (strcmp(radio, "ready") || !allowed(op, pkt + 4, pkt[3])) {
		refuse(op);
		return;
	}
	pkt[0] = H4_CMD;
	if (!radio_send(pkt, 1 + n))
		refuse(op);
}

void app_main(void)
{
	static char line[LINE + 1];
	size_t len = 0;
	bool junk = false;
	esp_err_t e;

	/* (the radio keeps its calibration in NVS; what another firmware left
	 * there, or nothing it can read, is wiped) */
	e = nvs_flash_init();
	if (e != ESP_OK) {
		nvs_flash_erase();
		nvs_flash_init();
	}
	events = xQueueCreate(48, sizeof(struct pkt));
	to_radio = xSemaphoreCreateMutex();
	to_router = xSemaphoreCreateMutex();
	own_done = xSemaphoreCreateBinary();
	link_init();
	xTaskCreate(to_router_task, "to-router", 3072, NULL, 5, NULL);
	radio_start();
	say_hello();

	/* What the router sends, a line at a time (one too long is let go of
	 * whole) */
	for (;;) {
		uint8_t b[64];
		int i, r = link_read(b, sizeof(b));

		for (i = 0; i < r; i++) {
			char c = b[i];

			if (c == '\n' || c == '\r') {
				line[len] = 0;
				if (len && !junk)
					on_line(line);
				len = 0;
				junk = false;
			} else if (len < LINE) {
				line[len++] = c;
			} else {
				junk = true;
			}
		}
	}
}
