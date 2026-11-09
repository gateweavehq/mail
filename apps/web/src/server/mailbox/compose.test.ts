import PostalMime, { decodeWords } from "postal-mime";
import { describe, expect, it } from "vitest";
import {
	addressHeader,
	headerText,
	inCopyOrder,
	MAX_HEADER_VALUE,
	newOwnId,
	type Outgoing,
	rawCopy,
	referencesValue,
	replySubject,
	sendRequest,
} from "./compose";
import { parseHeaders } from "./headers";
import { ownId, referencedIds } from "./thread";

const reply: Outgoing = {
	from: { name: "Support", email: "support@acme.test" },
	to: ["ada@example.com"],
	cc: ["grace@example.com", "alan@example.com"],
	subject: "Re: Invoice 42",
	text: "Thanks, it's paid.\n\nOn Monday, Ada wrote:\n> Is it paid?",
	html: null,
	files: [],
	inReplyTo: "b@example.com",
	references: ["a@example.com", "b@example.com"],
	ownId: "mine@acme.test",
};

describe("rawCopy", () => {
	it("is mail that reads back as what was written", async () => {
		const email = await PostalMime.parse(rawCopy(reply, new Date(Date.UTC(2026, 10, 8, 9, 30))));
		expect(email.from).toEqual({ name: "Support", address: "support@acme.test" });
		expect(email.to).toEqual([{ name: "", address: "ada@example.com" }]);
		expect(email.cc?.map((person) => person.address)).toEqual([
			"grace@example.com",
			"alan@example.com",
		]);
		expect(email.subject).toBe("Re: Invoice 42");
		expect(email.text?.replace(/\r\n/g, "\n").trimEnd()).toBe(reply.text);
		expect(email.date).toBe("2026-11-08T09:30:00.000Z");
		expect(email.messageId).toBe("<mine@acme.test>");
		expect(email.inReplyTo).toBe("<b@example.com>");
	});

	it("threads as the message it names, following what it answers", () => {
		const raw = rawCopy(reply, new Date());
		const headers = parseHeaders(raw.slice(0, raw.indexOf("\r\n\r\n")));
		expect(ownId(headers)).toBe("mine@acme.test");
		// Its own id is in its References too, so a reply that carries them on finds it.
		expect(referencedIds(headers)).toEqual(["a@example.com", "b@example.com", "mine@acme.test"]);
	});

	it("writes any language, and keeps every line short", async () => {
		const written: Outgoing = {
			...reply,
			from: { name: "Destek Ekibi — İstanbul", email: "destek@acme.test" },
			subject: "Faturanız hazır 🧾 ".repeat(8).trim(),
			text: "Merhaba Ayşe,\nödemeniz alındı. ".repeat(40),
			cc: [],
			inReplyTo: null,
			references: [],
		};
		const raw = rawCopy(written, new Date());
		for (const line of raw.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
		const email = await PostalMime.parse(raw);
		expect(email.from?.name).toBe("Destek Ekibi — İstanbul");
		expect(email.subject).toBe(written.subject);
		expect(email.text?.replace(/\r\n/g, "\n")).toBe(written.text);
		expect(email.cc).toBeUndefined();
		expect(email.inReplyTo).toBeUndefined();
	});

	it("keeps every line short however long an ASCII subject or name", async () => {
		const written: Outgoing = {
			...reply,
			from: { name: "The Customer Support Team of Acme, Inc., Worldwide", email: "s@acme.test" },
			subject: `Invoice${" and another word".repeat(60)}`,
		};
		const raw = rawCopy(written, new Date());
		for (const line of raw.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
		const email = await PostalMime.parse(raw);
		expect(email.from).toEqual({ name: written.from.name, address: "s@acme.test" });
		expect(email.subject).toBe(written.subject);
	});
});

/** Bytes in Base64, as a file comes in a request. */
const base64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

describe("rawCopy with HTML and files", () => {
	const pdf = base64(Array.from({ length: 3000 }, (_, i) => i % 256));
	const logo = base64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const long = `Fatura — Ekim 2026 (müşteri kopyası) ${"ve ekleri ".repeat(8)}.pdf`;
	const written: Outgoing = {
		...reply,
		text: "Your invoice is attached.",
		html: '<p>Your <b>invoice</b> is attached.</p><img src="cid:logo@acme.test">',
		files: [
			{
				filename: "invoice 42.pdf",
				type: "application/pdf",
				content: pdf,
				contentId: null,
				bytes: 3000,
			},
			{
				filename: "logo.png",
				type: "image/png",
				content: logo,
				contentId: "logo@acme.test",
				bytes: 11,
			},
			{ filename: long, type: "application/pdf", content: pdf, contentId: null, bytes: 3000 },
			{
				filename: 'odd "name".txt',
				type: "text/plain",
				content: base64([104, 105]),
				contentId: null,
				bytes: 2,
			},
		],
	};

	it("reads back whole: its text, its HTML, and each file as it was given", async () => {
		const raw = rawCopy(written, new Date());
		const email = await PostalMime.parse(raw, { attachmentEncoding: "base64" });
		expect(email.text?.trimEnd()).toBe(written.text);
		expect(email.html?.trimEnd()).toBe(written.html);
		const read = email.attachments.map((file) => ({
			filename: file.filename,
			type: file.mimeType,
			disposition: file.disposition,
			contentId: file.contentId ?? null,
			content: file.content,
		}));
		expect(read).toEqual([
			{
				filename: "logo.png",
				type: "image/png",
				disposition: "inline",
				contentId: "<logo@acme.test>",
				content: logo,
			},
			{
				filename: "invoice 42.pdf",
				type: "application/pdf",
				disposition: "attachment",
				contentId: null,
				content: pdf,
			},
			{
				filename: long,
				type: "application/pdf",
				disposition: "attachment",
				contentId: null,
				content: pdf,
			},
			{
				filename: 'odd "name".txt',
				type: "text/plain",
				disposition: "attachment",
				contentId: null,
				content: base64([104, 105]),
			},
		]);
		// A long or non-ASCII name goes over short lines, as RFC 2231 continues it.
		for (const line of raw.split("\r\n")) {
			expect(line.length).toBeLessThanOrEqual(998);
			if (/name/.test(line)) expect(line.length).toBeLessThanOrEqual(78);
		}
	});

	it("holds the files in the order a try finds them, and names the root of its related part", () => {
		expect(inCopyOrder(written.files).map((file) => file.filename)).toEqual([
			"logo.png",
			"invoice 42.pdf",
			long,
			'odd "name".txt',
		]);
		const raw = rawCopy(written, new Date());
		expect(raw).toMatch(
			/Content-Type: multipart\/related;\r\n type="multipart\/alternative";\r\n boundary=/,
		);
	});

	it("keeps a calendar as bytes, which reading it as text would change", async () => {
		// CRLF and a Latin-1 byte, as a calendar may hold them.
		const invite = base64([
			...new TextEncoder().encode("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nSUMMARY:Caf"),
			0xe9,
			...new TextEncoder().encode("\r\nEND:VCALENDAR\r\n"),
		]);
		const raw = rawCopy(
			{
				...reply,
				files: [
					{
						filename: "invite.ics",
						type: "text/calendar",
						content: invite,
						contentId: null,
						bytes: 59,
					},
				],
			},
			new Date(),
		);
		expect(raw).toContain("Content-Type: application/octet-stream;");
		const [file, ...more] = (await PostalMime.parse(raw, { attachmentEncoding: "base64" }))
			.attachments;
		expect(more).toEqual([]);
		expect(file?.content).toBe(invite);
	});

	it("is one text part when there is no HTML or file", () => {
		const raw = rawCopy(reply, new Date());
		expect(raw).toContain("\r\nContent-Type: text/plain; charset=utf-8\r\n");
		expect(raw).not.toContain("multipart");
		const html = rawCopy({ ...reply, html: "<p>Hi</p>" }, new Date());
		expect(html).toContain("Content-Type: multipart/alternative;");
		expect(html).not.toContain("multipart/mixed");
	});

	it("asks Email Service for the HTML too, but leaves the files to each try", () => {
		const request = sendRequest(written);
		expect(request.html).toBe(written.html);
		expect(request.text).toBe(written.text);
		expect(request).not.toHaveProperty("attachments");
		expect(sendRequest(reply)).not.toHaveProperty("html");
	});
});

describe("headerText", () => {
	it("leaves ASCII alone and puts the rest in words that decode back", () => {
		expect(headerText("Invoice 42")).toBe("Invoice 42");
		const encoded = headerText("Sipariş 🎉 hazır");
		expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
		expect(decodeWords(encoded.replace(/\r\n /g, " "))).toBe("Sipariş 🎉 hazır");
	});

	it("never splits a character between words, nor lets a line break into the header", () => {
		const encoded = headerText("🎉".repeat(30));
		for (const word of encoded.split("\r\n ")) {
			expect(word.length).toBeLessThanOrEqual(75);
			expect(decodeWords(word)).toMatch(/^(🎉)+$/u);
		}
		expect(headerText("one\r\nBcc: someone@example.com")).toBe("one Bcc: someone@example.com");
	});
});

describe("addressHeader", () => {
	it("quotes a name that would read as more than one address", () => {
		expect(addressHeader({ name: "Support", email: "s@acme.test" })).toBe("Support <s@acme.test>");
		expect(addressHeader({ name: 'Acme, "Inc."', email: "s@acme.test" })).toBe(
			'"Acme, \\"Inc.\\"" <s@acme.test>',
		);
		expect(addressHeader({ name: "", email: "s@acme.test" })).toBe("s@acme.test");
	});

	it("makes control characters spaces", () => {
		expect(addressHeader({ name: "Sup\tport\u0000\r\nBcc: x", email: "s@acme.test" })).toBe(
			'"Sup port Bcc: x" <s@acme.test>',
		);
	});
});

describe("referencesValue", () => {
	it("names every id it follows, then its own", () => {
		expect(referencesValue(["a@x", "b@x"], "me@x")).toBe("<a@x> <b@x> <me@x>");
		expect(referencesValue([], "me@x")).toBe("<me@x>");
	});

	it("keeps the first, the newest and its own when they don't all fit", () => {
		const ids = Array.from({ length: 200 }, (_, i) => `${"x".repeat(20)}-${i}@example.com`);
		const value = referencesValue(ids, "me@acme.test");
		expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(MAX_HEADER_VALUE);
		const kept = value.split(" ");
		expect(kept[0]).toBe(`<${ids[0]}>`);
		expect(kept.at(-1)).toBe("<me@acme.test>");
		expect(kept.at(-2)).toBe(`<${ids.at(-1)}>`);
		// What stays of the middle is the newest, in order.
		const middle = kept.slice(1, -1).map((id) => id.slice(1, -1));
		expect(middle).toEqual(ids.slice(ids.length - middle.length));
	});
});

describe("sendRequest", () => {
	it("asks Email Service for the message with the headers that thread it", () => {
		expect(sendRequest(reply)).toEqual({
			from: { name: "Support", email: "support@acme.test" },
			to: ["ada@example.com"],
			cc: ["grace@example.com", "alan@example.com"],
			subject: "Re: Invoice 42",
			text: reply.text,
			headers: {
				References: "<a@example.com> <b@example.com> <mine@acme.test>",
				"In-Reply-To": "<b@example.com>",
			},
		});
		// The mailbox's name goes as a name, whatever an admin typed.
		expect(
			sendRequest({ ...reply, from: { name: "Support\r\nBcc: x", email: "s@acme.test" } }).from,
		).toEqual({
			name: "Support Bcc: x",
			email: "s@acme.test",
		});
		const fresh = sendRequest({ ...reply, cc: [], inReplyTo: null, references: [] });
		expect(fresh).not.toHaveProperty("cc");
		expect(fresh.headers).toEqual({ References: "<mine@acme.test>" });
	});
});

it("gives a new message an id of its own on the domain it is sent from", () => {
	expect(newOwnId("support@acme.test")).toMatch(/^[0-9a-f-]{36}@acme\.test$/);
	expect(newOwnId("support@acme.test")).not.toBe(newOwnId("support@acme.test"));
});

it("puts Re: before a subject once", () => {
	expect(replySubject("Invoice 42")).toBe("Re: Invoice 42");
	expect(replySubject("RE: Invoice 42")).toBe("RE: Invoice 42");
});
