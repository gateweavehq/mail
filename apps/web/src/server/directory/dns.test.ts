import { describe, expect, it } from "vitest";
import { dnsLookup, proofName } from "./dns";

function resolver(answers: Record<string, unknown>, asked: string[] = []) {
	return dnsLookup("https://dns.test/dns-query", (async (input: URL) => {
		const type = input.searchParams.get("type") ?? "";
		const name = input.searchParams.get("name") ?? "";
		asked.push(`${type} ${name}`);
		const answer = answers[type];
		if (answer instanceof Response) return answer;
		return Response.json(answer);
	}) as typeof fetch);
}

const empty = { Status: 0 };

describe("dnsLookup", () => {
	it("asks for the proof at its own name and for mail at the domain", async () => {
		const asked: string[] = [];
		await resolver({ TXT: empty, MX: empty }, asked)("example.com");
		expect(asked.sort()).toEqual(["MX example.com", "TXT _gateweave-mail.example.com"]);
		expect(proofName("example.com")).toBe("_gateweave-mail.example.com");
	});

	it("reads a TXT record in parts as one, as DNS means it", async () => {
		const records = await resolver({
			TXT: { Status: 0, Answer: [{ type: 16, data: '"gateweave-mail-" "verification=abc"' }] },
			MX: empty,
		})("example.com");
		expect(records.proof).toEqual(["gateweave-mail-verification=abc"]);
	});

	it("reads mail hosts without priority or trailing dot, in lower case", async () => {
		const records = await resolver({
			TXT: empty,
			MX: {
				Status: 0,
				Answer: [
					{ type: 15, data: "24 Route3.MX.Cloudflare.net." },
					{ type: 15, data: "36 route2.mx.cloudflare.net." },
				],
			},
		})("example.com");
		expect(records.mailHosts).toEqual(["route3.mx.cloudflare.net", "route2.mx.cloudflare.net"]);
	});

	it("leaves out what a CNAME brings along", async () => {
		const records = await resolver({
			TXT: {
				Status: 0,
				Answer: [
					{ type: 5, data: "elsewhere.example.net." },
					{ type: 16, data: '"the proof"' },
				],
			},
			MX: empty,
		})("example.com");
		expect(records.proof).toEqual(["the proof"]);
	});

	it("takes no such name as no records", async () => {
		const records = await resolver({ TXT: { Status: 3 }, MX: { Status: 3 } })("example.com");
		expect(records).toEqual({ proof: [], mailHosts: [] });
	});

	it.each([
		["a failed lookup", { TXT: { Status: 2 }, MX: empty }],
		["a resolver that is down", { TXT: new Response("", { status: 502 }), MX: empty }],
	])("throws on %s, rather than say there is no proof", async (_, answers) => {
		await expect(resolver(answers)("example.com")).rejects.toThrow("DNS resolver");
	});
});
