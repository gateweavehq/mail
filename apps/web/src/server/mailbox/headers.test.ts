import { describe, expect, it } from "vitest";
import {
	cloudflareVerdict,
	deliveryKey,
	firstHeader,
	HEADER_BLOCK_LIMIT,
	parseHeaders,
	readHeaderBlock,
	resendVerifiedDomain,
	verifiedDomain,
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
			{ name: "subject", value: "A long subject", strict: true },
			{ name: "received", value: "one", strict: true },
			{ name: "received", value: "two", strict: true },
		]);
		expect(firstHeader(headers, "received")).toBe("one");
		expect(firstHeader(headers, "date")).toBeNull();
	});

	// Programs differ on what such a name means, so it must not be read as an ordinary one.
	it("marks a name written with spaces or other odd characters", () => {
		expect(parseHeaders("From : a@example.org\r\n\u000bFrom: b@example.org\r\n")).toEqual([
			{ name: "from", value: "a@example.org", strict: false },
			{ name: "from", value: "b@example.org", strict: false },
		]);
	});
});

const own = (dmarc: string, domain = "example.org") =>
	`Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${domain}; dmarc=${dmarc} header.from=${domain} policy.dmarc=none; spf=pass (mx.cloudflare.net: domain of a@${domain} designates 192.0.2.1 as permitted sender) smtp.mailfrom=a@${domain}`;

describe("cloudflareVerdict", () => {
	const verdictOf = (lines: string[]) => cloudflareVerdict(parseHeaders(lines.join("\r\n")));

	it("reads Cloudflare's own verdict, and the domain it checked", () => {
		expect(
			verdictOf([...CLOUDFLARE, own("pass"), "X-CF-SpamH-Score: 1", "From: a@example.org"]),
		).toEqual({ dmarc: "pass", fromDomain: "example.org" });
		expect(verdictOf([...CLOUDFLARE, own("FAIL", "Example.ORG.")])).toEqual({
			dmarc: "fail",
			fromDomain: "example.org",
		});
	});

	it("trusts nothing when the message doesn't start with Cloudflare's Received", () => {
		expect(verdictOf([own("pass")])).toBeNull();
		expect(verdictOf(["Received: from x by mail.example.org", own("pass")])).toBeNull();
	});

	it("trusts no verdict below the sender's own headers", () => {
		expect(verdictOf([...CLOUDFLARE, "From: a@example.org", own("pass")])).toBeNull();
		expect(verdictOf([...CLOUDFLARE, own("none"), "From: a@example.org", own("pass")])).toEqual({
			dmarc: "none",
			fromDomain: "example.org",
		});
	});

	// Were Cloudflare's own verdict ever missing, the sender's headers would follow its others.
	it("stops where Cloudflare's headers stop, when its verdict isn't among them", () => {
		expect(verdictOf([...CLOUDFLARE, "Received-SPF: pass", own("pass")])).toBeNull();
		expect(verdictOf([...CLOUDFLARE, "ARC-Seal: i=2; cv=pass", own("pass")])).toBeNull();
		expect(verdictOf([...CLOUDFLARE, "X-CF-SpamH-Score: 1", own("pass")])).toBeNull();
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

	// Cloudflare's comments quote the envelope sender, which the sender chooses.
	it("reads nothing out of a comment", () => {
		expect(
			verdictOf([
				...CLOUDFLARE,
				'Authentication-Results: mx.cloudflare.net; spf=pass (mx.cloudflare.net: domain of "x; dmarc=pass header.from=bank.example"@evil.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=x@evil.example; dmarc=fail header.from=evil.example',
			]),
		).toEqual({ dmarc: "fail", fromDomain: "evil.example" });
	});

	it("trusts no verdict when it names DMARC twice", () => {
		expect(
			verdictOf([
				...CLOUDFLARE,
				'Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=evil.example; spf=pass (domain of "x) ; dmarc=pass header.from=bank.example (y"@evil.example) smtp.mailfrom=x@evil.example',
			]),
		).toBeNull();
	});
});

describe("verifiedDomain", () => {
	const domainOf = (lines: string[]) => {
		const headers = parseHeaders(lines.join("\r\n"));
		return verifiedDomain(headers, cloudflareVerdict(headers));
	};
	const passed = (from: string[], domain = "example.org") => [
		...CLOUDFLARE,
		own("pass", domain),
		...from,
	];

	it("is the From's domain when Cloudflare checked that one and it passed", () => {
		expect(domainOf(passed(["From: A Person <a@example.org>"]))).toBe("example.org");
		expect(domainOf(passed(["From: a@Example.org"]))).toBe("example.org");
	});

	it("is the address's domain, whatever the name in front of it says", () => {
		expect(domainOf(passed(['From: "ceo@bank.example" <a@example.org>']))).toBe("example.org");
	});

	it("is nothing when DMARC didn't pass", () => {
		expect(domainOf([...CLOUDFLARE, own("none"), "From: a@example.org"])).toBeNull();
	});

	it("is nothing when Cloudflare checked another domain than the From shows", () => {
		expect(domainOf(passed(["From: ceo@bank.example"], "evil.example"))).toBeNull();
		expect(domainOf(passed(["From: a@mail.example.org"]))).toBeNull();
	});

	// Which of two a program shows, or which Cloudflare checked, can't be told from here.
	it("is nothing when the message has more than one From", () => {
		expect(domainOf(passed(["From: a@example.org", "From: ceo@bank.example"]))).toBeNull();
		expect(domainOf(passed(["From : ceo@bank.example", "From: a@example.org"]))).toBeNull();
		expect(domainOf(passed(["\u000bFrom: ceo@bank.example", "From: a@example.org"]))).toBeNull();
		expect(domainOf(passed(["From : a@example.org"]))).toBeNull();
	});

	it("is nothing when the From names more than one sender", () => {
		expect(domainOf(passed(["From: a@example.org, ceo@bank.example"]))).toBeNull();
		expect(domainOf(passed(["From: Team: a@example.org, b@example.org;"]))).toBeNull();
		expect(domainOf(passed(["From: Nobody"]))).toBeNull();
	});
});

const CRLF = "\r\n";

describe("resendVerifiedDomain", () => {
	const domainOf = (lines: string[], dmarc: string | null, from: string | null = "a@example.org") =>
		resendVerifiedDomain(parseHeaders(lines.join(CRLF)), dmarc, from);

	it("is the From's domain when Resend's DMARC check passed", () => {
		expect(domainOf(["From: A Person <a@Example.ORG>", "Subject: hi"], "pass")).toBe("example.org");
		expect(domainOf(["From: a@example.org"], "pass", "Someone <b@EXAMPLE.org.>")).toBe(
			"example.org",
		);
	});

	// Resend's check was of the From it read, which must be the one the mail shows.
	it("is nothing when Resend read another From than the mail's", () => {
		expect(domainOf(["From: a@example.org"], "pass", "x@bank.example")).toBeNull();
		expect(domainOf(["From: a@example.org"], "pass", "a@mail.example.org")).toBeNull();
		expect(domainOf(["From: a@example.org"], "pass", null)).toBeNull();
		expect(domainOf(["From: a@example.org"], "pass", "no address")).toBeNull();
	});

	it("is nothing when the check didn't pass, or Resend didn't say", () => {
		for (const dmarc of ["fail", "gray", "processing_failed", "unknown", null]) {
			expect(domainOf(["From: a@example.org"], dmarc)).toBeNull();
		}
	});

	it("is nothing when the From isn't one address", () => {
		expect(domainOf(["From: a@example.org, b@example.net"], "pass")).toBeNull();
		expect(domainOf(["From: a@example.org", "From: b@example.net"], "pass")).toBeNull();
		expect(domainOf(["From: a@example.org", "From : b@example.net"], "pass")).toBeNull();
		expect(domainOf(["Subject: no sender"], "pass")).toBeNull();
	});

	it("takes nothing from headers that look like Cloudflare's", () => {
		const forged = [...CLOUDFLARE, own("pass", "bank.example"), "From: x@bank.example"];
		expect(domainOf(forged, "fail")).toBeNull();
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

	// Delivery is at least once whether or not the sender wrote a Message-ID.
	it("is made from the other headers when there is no Message-ID", async () => {
		const key = await deliveryKey("box", headersOf(sender.slice(0, 3)));
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(await deliveryKey("box", headersOf(sender.slice(0, 3)))).toBe(key);
		expect(await deliveryKey("box", headersOf([...sender.slice(0, 2), "Subject: Other"]))).not.toBe(
			key,
		);
	});
});
