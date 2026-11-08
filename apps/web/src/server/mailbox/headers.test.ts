import { describe, expect, it } from "vitest";
import {
	cloudflareDmarc,
	deliveryKey,
	firstHeader,
	HEADER_BLOCK_LIMIT,
	parseHeaders,
	readHeaderBlock,
} from "./headers";

/** A stream that gives these pieces one at a time, as a socket would. */
function streamOf(...pieces: string[]) {
	const encoder = new TextEncoder();
	let read = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			const piece = pieces[read++];
			if (piece === undefined) controller.close();
			else controller.enqueue(encoder.encode(piece));
		},
	});
	return { stream, read: () => read };
}

const CLOUDFLARE = [
	"Received: from mail.example.org (mail.example.org [192.0.2.1]) by cloudflare-email.net (unknown) id A for <a@example.com>",
	"ARC-Seal: i=1; cv=none",
	"ARC-Message-Signature: i=1; a=rsa-sha256",
	"ARC-Authentication-Results: i=1; mx.cloudflare.net; dmarc=pass",
	"Received-SPF: pass",
];

describe("readHeaderBlock", () => {
	it("stops at the empty line, without reading the body", async () => {
		const { stream, read } = streamOf(
			"Subject: Hi\r\n",
			"From: a@example.org\r\n\r\nBody",
			...Array.from({ length: 10 }, () => "more"),
		);
		expect(await readHeaderBlock(stream)).toBe("Subject: Hi\r\nFrom: a@example.org\r\n");
		// A stream may read one piece ahead of what was asked for.
		expect(read()).toBeLessThanOrEqual(3);
	});

	it("finds an empty line split between two pieces", async () => {
		const { stream } = streamOf("Subject: Hi\r\n\r", "\nBody");
		expect(await readHeaderBlock(stream)).toBe("Subject: Hi\r\n");
	});

	it("takes bare line feeds, as some senders write them", async () => {
		const { stream } = streamOf("Subject: Hi\n\nBody");
		expect(await readHeaderBlock(stream)).toBe("Subject: Hi\n");
	});

	it("reads no further than its limit when there is no empty line", async () => {
		const line = `X-Filler: ${"a".repeat(1000)}\r\n`;
		const { stream, read } = streamOf(...Array.from({ length: 1000 }, () => line));
		const block = await readHeaderBlock(stream);
		expect(block.length).toBeLessThanOrEqual(HEADER_BLOCK_LIMIT);
		expect(read()).toBeLessThan(1000);
	});
});

describe("parseHeaders", () => {
	it("joins folded lines and keeps the order and every copy", async () => {
		const headers = parseHeaders(
			"Subject: A long\r\n subject\r\nReceived: one\r\nreceived: two\r\nBroken line\r\n",
		);
		expect(headers).toEqual([
			{ name: "subject", value: "A long subject" },
			{ name: "received", value: "one" },
			{ name: "received", value: "two" },
		]);
		expect(firstHeader(headers, "received")).toBe("one");
		expect(firstHeader(headers, "date")).toBeNull();
	});
});

describe("cloudflareDmarc", () => {
	const verdictOf = (lines: string[]) => cloudflareDmarc(parseHeaders(lines.join("\r\n")));
	const own = (dmarc: string) =>
		`Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.org; dmarc=${dmarc} header.from=example.org`;

	it("reads Cloudflare's own verdict", () => {
		expect(
			verdictOf([...CLOUDFLARE, own("pass"), "X-CF-SpamH-Score: 1", "From: a@example.org"]),
		).toBe("pass");
		expect(verdictOf([...CLOUDFLARE, own("FAIL")])).toBe("fail");
	});

	it("trusts nothing when the message doesn't start with Cloudflare's Received", () => {
		expect(verdictOf([own("pass")])).toBeNull();
		expect(verdictOf(["Received: from x by mail.example.org", own("pass")])).toBeNull();
	});

	it("trusts no verdict below the sender's own headers", () => {
		expect(verdictOf([...CLOUDFLARE, "From: a@example.org", own("pass")])).toBeNull();
		expect(verdictOf([...CLOUDFLARE, own("none"), "From: a@example.org", own("pass")])).toBe(
			"none",
		);
	});

	it("trusts no verdict that doesn't say it is Cloudflare's", () => {
		expect(
			verdictOf([...CLOUDFLARE, "Authentication-Results: mx.example.org; dmarc=pass"]),
		).toBeNull();
	});

	it("reads no verdict out of another method's name", () => {
		expect(
			verdictOf([...CLOUDFLARE, "Authentication-Results: mx.cloudflare.net; arc=pass"]),
		).toBeNull();
	});
});

describe("deliveryKey", () => {
	const headersOf = (lines: string[]) => parseHeaders(lines.join("\r\n"));
	const sender = [
		"From: a@example.org",
		"Date: Sun, 8 Nov 2026",
		"Subject: Hi",
		"Message-ID: <1@x>",
	];

	it("is the same for every delivery of one message, whatever Cloudflare added", async () => {
		const first = await deliveryKey("box", headersOf([...CLOUDFLARE, ...sender]));
		const again = await deliveryKey(
			"box",
			headersOf(["Received: by cloudflare-email.net id B", ...sender]),
		);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(again).toBe(first);
	});

	it("differs for another mailbox, or another message", async () => {
		const key = await deliveryKey("box", headersOf(sender));
		expect(await deliveryKey("other", headersOf(sender))).not.toBe(key);
		expect(
			await deliveryKey(
				"box",
				headersOf([...sender.slice(0, 2), "Subject: Other", sender[3] ?? ""]),
			),
		).not.toBe(key);
	});

	it("is null without a Message-ID, so such a message is always kept", async () => {
		expect(await deliveryKey("box", headersOf(sender.slice(0, 3)))).toBeNull();
	});
});
