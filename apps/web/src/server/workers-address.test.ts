import { describe, expect, it } from "vitest";
import { countedByWhoSentIt, whoSentIt } from "./workers-address";

const WORKERS = "2a06:98c0:3600::103";

const asked = (headers: Record<string, string>) =>
	new Request("https://mail.test/api/auth/backchannel-logout/oidc", { headers });

async function countedAs(headers: Record<string, string>) {
	return (await countedByWhoSentIt(asked(headers))).headers.get("cf-connecting-ip");
}

describe("countedByWhoSentIt", () => {
	it("counts Workers on different zones apart", async () => {
		const one = await countedAs({ "cf-connecting-ip": WORKERS, "cf-worker": "gateweave.com" });
		const other = await countedAs({ "cf-connecting-ip": WORKERS, "cf-worker": "example.com" });
		expect(one).not.toBe(other);
		expect(one).not.toBe(WORKERS);
	});

	it("counts Workers on one zone together, however its name is written", async () => {
		const one = await countedAs({ "cf-connecting-ip": WORKERS, "cf-worker": "gateweave.com" });
		const again = await countedAs({ "cf-connecting-ip": WORKERS, "cf-worker": "GateWeave.com" });
		expect(one).toBe(again);
	});

	it("makes an address Better Auth takes, which differs within its first 64 bits", async () => {
		const made = await countedAs({ "cf-connecting-ip": WORKERS, "cf-worker": "gateweave.com" });
		expect(made).toMatch(/^fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}:[0-9a-f]{4}::1$/);
	});

	it("leaves everyone else as they are, whatever they claim", async () => {
		const someone = { "cf-connecting-ip": "203.0.113.7", "cf-worker": "gateweave.com" };
		expect(await countedAs(someone)).toBe("203.0.113.7");
	});

	it("gives the request itself back for anyone else, body and all", async () => {
		const request = new Request("https://mail.test/", { method: "POST", body: "a" });
		expect(await countedByWhoSentIt(request)).toBe(request);
	});

	it("counts by the address when there is no zone to count by", async () => {
		expect(await countedAs({ "cf-connecting-ip": WORKERS })).toBe(WORKERS);
	});

	it("keeps a Worker's request's method and body", async () => {
		const request = new Request("https://mail.test/", {
			method: "POST",
			headers: { "cf-connecting-ip": WORKERS, "cf-worker": "gateweave.com" },
			body: "logout_token=a",
		});
		const counted = await countedByWhoSentIt(request);
		expect(counted.method).toBe("POST");
		expect(await counted.text()).toBe("logout_token=a");
	});
});

describe("whoSentIt", () => {
	it("tells Workers on different zones apart, and one zone however it is written", () => {
		const one = whoSentIt(asked({ "cf-connecting-ip": WORKERS, "cf-worker": "gateweave.com" }));
		const other = whoSentIt(asked({ "cf-connecting-ip": WORKERS, "cf-worker": "example.com" }));
		const again = whoSentIt(asked({ "cf-connecting-ip": WORKERS, "cf-worker": "GateWeave.com" }));
		expect(one).not.toBe(other);
		expect(one).toBe(again);
	});

	it("goes by the address for anyone else, whatever they claim", () => {
		const someone = { "cf-connecting-ip": "203.0.113.7", "cf-worker": "gateweave.com" };
		expect(whoSentIt(asked(someone))).toBe("203.0.113.7");
	});

	it("goes by the address when there is no zone, and has an answer with neither", () => {
		expect(whoSentIt(asked({ "cf-connecting-ip": WORKERS }))).toBe(WORKERS);
		expect(whoSentIt(asked({}))).toBe("unknown");
	});
});
