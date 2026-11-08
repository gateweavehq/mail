import { describe, expect, it } from "vitest";
import { parseHeaders } from "./headers";
import { MAX_REFERENCES, messageIds, ownId, referencedIds, subjectKey } from "./thread";

describe("messageIds", () => {
	it("takes the ids out of their brackets, in order and each once", () => {
		expect(messageIds("<a@x> <b@y>\t<a@x>")).toEqual(["a@x", "b@y"]);
	});

	it("leaves out what isn't in brackets", () => {
		expect(messageIds("<a@x> (sent by a list) b@y")).toEqual(["a@x"]);
		expect(messageIds("no ids here")).toEqual([]);
		expect(messageIds(null)).toEqual([]);
	});

	it("leaves out an id too long for a line of mail", () => {
		expect(messageIds(`<${"a".repeat(999)}@x>`)).toEqual([]);
	});
});

describe("the ids a message names", () => {
	const headers = (block: string) => parseHeaders(block);

	it("takes its own id from Message-ID", () => {
		expect(ownId(headers("Message-ID: <me@x>\r\nSubject: hi"))).toBe("me@x");
		expect(ownId(headers("Subject: hi"))).toBeNull();
	});

	it("takes References, then In-Reply-To, each once", () => {
		const block =
			"References: <one@x>\r\n <two@x>\r\nIn-Reply-To: <two@x> <three@x>\r\nSubject: Re: hi";
		expect(referencedIds(headers(block))).toEqual(["one@x", "two@x", "three@x"]);
	});

	it("keeps the newest of a long chain", () => {
		const ids = Array.from({ length: MAX_REFERENCES + 10 }, (_, i) => `<m${i}@x>`).join(" ");
		const kept = referencedIds(headers(`References: ${ids}`));
		expect(kept).toHaveLength(MAX_REFERENCES);
		expect(kept.at(-1)).toBe(`m${MAX_REFERENCES + 9}@x`);
		expect(kept[0]).toBe("m10@x");
	});
});

describe("subjectKey", () => {
	it("takes off what replies and forwards add, in several languages", () => {
		for (const subject of [
			"Invoice 42",
			"Re: Invoice 42",
			"RE: re: Invoice 42",
			"Fwd: Re: Invoice 42",
			"AW: WG: Invoice 42",
			"Re[2]: Invoice 42",
			"YNT: Invoice 42",
			"[team] Re: Invoice 42",
			"回复：Invoice 42",
			"  re :  Invoice   42 ",
		]) {
			expect(subjectKey(subject), subject).toBe("invoice 42");
		}
	});

	it("decodes encoded words", () => {
		expect(subjectKey("=?UTF-8?B?UmU6IMOcYmVyZ2FiZQ==?=")).toBe("übergabe");
	});

	it("keeps words that only start like a prefix", () => {
		expect(subjectKey("Reply needed")).toBe("reply needed");
		expect(subjectKey("Fwdx: a")).toBe("fwdx: a");
	});

	it("is empty for no subject", () => {
		expect(subjectKey(null)).toBe("");
		expect(subjectKey("Re:")).toBe("");
	});
});
