import { describe, expect, it } from "vitest";
import { afterHeaders } from "./body";

async function bodyOf(...pieces: string[]) {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const piece of pieces) controller.enqueue(encoder.encode(piece));
			controller.close();
		},
	});
	return new Response(stream.pipeThrough(afterHeaders())).text();
}

describe("afterHeaders", () => {
	it("passes on only what follows the header block", async () => {
		expect(await bodyOf("Subject: Hi\r\nFrom: a@example.org\r\n\r\nThe body.\r\n")).toBe(
			"The body.\r\n",
		);
	});

	// Cloudflare signs each delivery anew, so only the body can tell two copies are the same.
	it("gives the same body whatever headers came above it", async () => {
		const one = await bodyOf("Received: by cloudflare-email.net id A\r\nSubject: Hi\r\n\r\nSame.");
		const two = await bodyOf("Received: by cloudflare-email.net id B\r\nSubject: Hi\r\n\r\nSame.");
		expect(one).toBe("Same.");
		expect(two).toBe(one);
	});

	it("finds the empty line wherever the pieces split it", async () => {
		const raw = "Subject: Hi\r\n\r\nBody";
		for (let at = 1; at < raw.length; at++) {
			expect(await bodyOf(raw.slice(0, at), raw.slice(at))).toBe("Body");
		}
	});

	it("takes bare line feeds", async () => {
		expect(await bodyOf("Subject: Hi\n\nBody")).toBe("Body");
	});

	it("gives nothing for a message with no body", async () => {
		expect(await bodyOf("Subject: Hi\r\n")).toBe("");
	});
});
