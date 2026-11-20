import { describe, expect, it } from "vitest";
import {
	AgentPolicyInput,
	AllowedEntry,
	DEFAULT_AGENT_POLICY,
	goesWithoutApproval,
	isAllowedRecipient,
	MAX_ALLOWED_ENTRIES,
	NEW_AGENT_POLICY,
	policySummary,
	readAllowed,
	readPolicy,
	WebhookHost,
	waitsForApproval,
} from "./agent-policy";

import { MAX_AGENT_WEBHOOKS, MAX_WEBHOOKS } from "./webhooks";

it("has room to seed every webhook and takes only exact hosts", () => {
	expect(MAX_WEBHOOKS).toBeLessThanOrEqual(MAX_ALLOWED_ENTRIES);
	expect(MAX_AGENT_WEBHOOKS).toBeLessThanOrEqual(MAX_ALLOWED_ENTRIES);
	expect(WebhookHost.parse("B\u00dcCHER.example.")).toBe("xn--bcher-kva.example");
	for (const entry of ["@example.org", "*.example.org", "example.org/path", "example.org:443"]) {
		expect(WebhookHost.safeParse(entry).success).toBe(false);
	}
	expect(
		AgentPolicyInput.safeParse({
			sendPerDay: 1,
			allowed: [],
			webhookHosts: Array(101).fill("example.org"),
		}).success,
	).toBe(false);
});

describe("isAllowedRecipient", () => {
	const allowed = ["ops@example.org", "@acme.test"];

	it("takes an allowed address, in any case", () => {
		expect(isAllowedRecipient("ops@example.org", allowed)).toBe(true);
		expect(isAllowedRecipient("Ops@Example.ORG", allowed)).toBe(true);
	});

	it("takes any address on an allowed domain", () => {
		expect(isAllowedRecipient("anyone@acme.test", allowed)).toBe(true);
	});

	it("doesn't take another address on an allowed address's domain", () => {
		expect(isAllowedRecipient("ceo@example.org", allowed)).toBe(false);
	});

	it("doesn't take a subdomain, or a domain that only ends the same", () => {
		expect(isAllowedRecipient("a@mail.acme.test", allowed)).toBe(false);
		expect(isAllowedRecipient("a@notacme.test", allowed)).toBe(false);
	});

	it("takes nothing when nothing is allowed", () => {
		expect(isAllowedRecipient("ops@example.org", [])).toBe(false);
	});
});

describe("goesWithoutApproval", () => {
	it("needs every recipient allowed", () => {
		expect(goesWithoutApproval(["a@acme.test", "b@acme.test"], ["@acme.test"])).toBe(true);
		expect(goesWithoutApproval(["a@acme.test", "b@other.test"], ["@acme.test"])).toBe(false);
	});

	it("doesn't take an empty list", () => {
		expect(goesWithoutApproval([], ["@acme.test"])).toBe(false);
	});
});

describe("AllowedEntry", () => {
	it("reads addresses and domains in lower case", () => {
		expect(AllowedEntry.parse(" Ops@Example.org ")).toBe("ops@example.org");
		expect(AllowedEntry.parse("@Acme.Test")).toBe("@acme.test");
		expect(AllowedEntry.parse("@local")).toBe("@local");
		expect(AllowedEntry.parse("@[::1]")).toBe("@[::1]");
	});

	it("normalises international domains and refuses URL syntax in a mail domain", () => {
		expect(AllowedEntry.parse("Ops@B\u00dcCHER.example.")).toBe("ops@xn--bcher-kva.example");
		expect(isAllowedRecipient("Ops@B\u00dcCHER.example.", ["@xn--bcher-kva.example"])).toBe(true);
		for (const domain of [
			"example.org/path",
			"example.org:443",
			"example.org%2f",
			"evil@example.org",
		]) {
			expect(AllowedEntry.safeParse(`ops@${domain}`).success).toBe(false);
		}
	});

	it("refuses what is neither", () => {
		for (const entry of ["acme.test", "@", "a@acme.test,b@acme.test", "@*.acme.test", "a@b"]) {
			expect(AllowedEntry.safeParse(entry).success).toBe(false);
		}
	});
});

describe("AgentPolicyInput", () => {
	it("keeps the day's count whole and within bounds", () => {
		expect(AgentPolicyInput.safeParse({ sendPerDay: -1, allowed: [] }).success).toBe(false);
		expect(AgentPolicyInput.safeParse({ sendPerDay: 1.5, allowed: [] }).success).toBe(false);
		expect(AgentPolicyInput.safeParse({ sendPerDay: 1001, allowed: [] }).success).toBe(false);
		expect(AgentPolicyInput.safeParse({ sendPerDay: 0, allowed: [] }).success).toBe(true);
	});
});

describe("a policy from before there was a choice", () => {
	// MAIL-58, R2: a row as it was stored then has no `approval`, and an agent may have no row.
	it("with an empty list has everything wait, mail inside the workspace too", () => {
		const policy = readPolicy({ sendPerDay: 7, allowed: "[]", approval: null });
		expect(policy).toEqual({
			sendPerDay: 7,
			approval: "always",
			allowed: [],
			webhookHosts: [],
			anyRecipient: false,
			insideWaits: true,
		});
		expect(waitsForApproval(policy, ["a@acme.test"])).toBe(true);
	});

	it("with a list lets its list through and has the rest wait", () => {
		const policy = readPolicy({ sendPerDay: 7, allowed: '["@acme.test"]', approval: null });
		expect(policy).toMatchObject({ approval: "unlisted", insideWaits: true });
		expect(waitsForApproval(policy, ["a@acme.test"])).toBe(false);
		expect(waitsForApproval(policy, ["a@acme.test", "b@other.test"])).toBe(true);
	});

	it("without a row has everything wait, as the default was", () => {
		expect(DEFAULT_AGENT_POLICY).toEqual({
			sendPerDay: 20,
			approval: "always",
			webhookHosts: [],
			anyRecipient: false,
			allowed: [],
			insideWaits: true,
		});
	});
});

describe("a policy that says which mail waits", () => {
	const stored = (approval: string, allowed = "[]") =>
		readPolicy({ sendPerDay: 20, allowed, approval });

	it("lets a new agent send on its own, a few messages a day", () => {
		expect(NEW_AGENT_POLICY).toEqual({
			sendPerDay: 20,
			approval: "never",
			webhookHosts: [],
			anyRecipient: false,
			allowed: [],
			insideWaits: false,
		});
		expect(waitsForApproval(NEW_AGENT_POLICY, ["anyone@anywhere.test"])).toBe(false);
	});

	it("reads each of the three, and no longer as one from before", () => {
		expect(stored("never")).toMatchObject({ approval: "never", insideWaits: false });
		expect(stored("always")).toMatchObject({ approval: "always", insideWaits: false });
		expect(stored("unlisted", '["@acme.test"]')).toMatchObject({
			approval: "unlisted",
			insideWaits: false,
		});
	});

	it("has everything wait under always, whatever list is kept", () => {
		const policy = stored("always", '["@acme.test"]');
		expect(waitsForApproval(policy, ["a@acme.test"])).toBe(true);
	});

	it("has nothing wait under never, whatever list is kept", () => {
		expect(waitsForApproval(stored("never", '["@acme.test"]'), ["b@other.test"])).toBe(false);
	});

	it("takes a list of nobody, or a word it doesn't know, as everything waiting", () => {
		expect(stored("unlisted").approval).toBe("always");
		expect(stored("sometimes").approval).toBe("always");
		expect(stored("sometimes", '["@acme.test"]').approval).toBe("unlisted");
	});

	it("takes the choice, and does without it as a page from before would", () => {
		const input = { sendPerDay: 1, allowed: [] };
		expect(AgentPolicyInput.parse(input).approval).toBeUndefined();
		expect(AgentPolicyInput.parse({ ...input, approval: "never" }).approval).toBe("never");
		expect(AgentPolicyInput.safeParse({ ...input, approval: "sometimes" }).success).toBe(false);
	});

	it("says each in a sentence", () => {
		expect(policySummary(stored("never"))).toBe(
			"Writes up to 20 messages a day, each going on its own.",
		);
		// Saved, a policy lets mail inside the workspace go, so what it says of waiting says so.
		expect(policySummary(stored("always", '["@acme.test"]'))).toBe(
			"Writes up to 20 messages a day, each waiting for approval unless it goes only to this workspace's own addresses.",
		);
		expect(policySummary(stored("unlisted", '["@acme.test"]'))).toBe(
			"Writes up to 20 messages a day. To @acme.test, and to this workspace's own addresses alone, it goes on its own; anything else waits for approval.",
		);
		expect(policySummary({ ...stored("never"), sendPerDay: 0 })).toBe("Can't send mail.");
	});

	it("says of one from before that everything waits, as is true of it", () => {
		const before = (allowed: string) => readPolicy({ sendPerDay: 20, allowed, approval: null });
		expect(policySummary(before("[]"))).toBe(
			"Writes up to 20 messages a day, each waiting for approval.",
		);
		expect(policySummary(before('["@acme.test", "a@b.test", "c@d.test"]'))).toBe(
			"Writes up to 20 messages a day. To @acme.test, a@b.test and 1 more it goes on its own; anything else waits for approval.",
		);
	});
});

describe("readAllowed", () => {
	it("reads a stored list, and anything else as none", () => {
		expect(readAllowed('["@acme.test"]')).toEqual(["@acme.test"]);
		expect(readAllowed('[1, "a@b.test"]')).toEqual(["a@b.test"]);
		expect(readAllowed("{}")).toEqual([]);
		expect(readAllowed("not json")).toEqual([]);
	});
});
