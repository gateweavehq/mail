import { describe, expect, it } from "vitest";
import { parseDomainName, parseLocalPart, splitRecipient } from "./addresses";

describe("parseDomainName", () => {
	it.each([
		["Example.COM", "example.com"],
		["  mail.example.com. ", "mail.example.com"],
		["xn--bcher-kva.example", "xn--bcher-kva.example"],
		["a-b.example.org", "a-b.example.org"],
	])("takes %s", (input, name) => {
		expect(parseDomainName(input)).toBe(name);
	});

	it.each([
		["no dot", "localhost"],
		["an IP address", "192.168.0.1"],
		["a leading hyphen", "-a.example.com"],
		["a trailing hyphen", "a-.example.com"],
		["an empty label", "a..example.com"],
		["an address", "someone@example.com"],
		["a URL", "https://example.com"],
		["a space inside", "exa mple.com"],
		["a label over 63", `${"a".repeat(64)}.example.com`],
		["a name over 253", `${"a.".repeat(127)}example.com`],
		["nothing", ""],
	])("refuses %s", (_, input) => {
		expect(parseDomainName(input)).toBeNull();
	});
});

describe("parseLocalPart", () => {
	it.each([
		["Support", "support"],
		[" first.last ", "first.last"],
		["a", "a"],
		["signup-bot_2", "signup-bot_2"],
	])("takes %s", (input, part) => {
		expect(parseLocalPart(input)).toBe(part);
	});

	it.each([
		["a dot at the start", ".a"],
		["a dot at the end", "a."],
		["two dots", "a..b"],
		["a tag", "a+b"],
		["an @", "a@b"],
		["a space", "a b"],
		["over 64", "a".repeat(65)],
		["nothing", ""],
	])("refuses %s", (_, input) => {
		expect(parseLocalPart(input)).toBeNull();
	});
});

describe("splitRecipient", () => {
	it("lowers the case of both parts, since that's how they are stored", () => {
		expect(splitRecipient("Agent@Example.COM")).toEqual({
			localPart: "agent",
			domain: "example.com",
		});
	});

	it("splits at the last @, as a quoted local part can hold one", () => {
		expect(splitRecipient('"a@b"@example.com')).toEqual({
			localPart: '"a@b"',
			domain: "example.com",
		});
	});

	it.each(["", "nobody", "@example.com", "nobody@"])("finds no address in %j", (input) => {
		expect(splitRecipient(input)).toBeNull();
	});
});
