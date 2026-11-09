import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startMail } from "./mail-worker";

// Addresses an agent makes for itself with its key, within the limits an owner or admin sets,
// reached as an agent reaches them, through the built Worker in workerd.

const origin = "https://mail.test";
const DAY_MS = 24 * 60 * 60 * 1000;

const proofs = new Map<string, string>();

function dns(request: Request): Response {
	const url = new URL(request.url);
	const value = proofs.get(url.searchParams.get("name") ?? "");
	if (!value || url.searchParams.get("type") !== "TXT") return Response.json({ Status: 3 });
	return Response.json({
		Status: 0,
		Answer: [{ name: url.searchParams.get("name"), type: 16, data: `"${value}"` }],
	});
}

let mail: Awaited<ReturnType<typeof startMail>>;
let owner: Awaited<ReturnType<typeof signUp>>;
let counter = 0;

type Asker = { headers: Record<string, string> };

interface Listed {
	domains: { id: string; name: string; proof: { value: string } | null }[];
	mailboxes: {
		id: string;
		name: string;
		addresses: { id: string; address: string; expiresAt: number | null; madeBy: string | null }[];
	}[];
}

async function directory(slug: string, person: Asker, action?: unknown) {
	const response = await mail.fetch(`${origin}/api/directory/${slug}`, {
		method: action ? "POST" : "GET",
		headers: { ...person.headers, origin, "content-type": "application/json" },
		...(action ? { body: JSON.stringify(action) } : {}),
	});
	return { status: response.status, body: (await response.json()) as Listed & { ok?: boolean } };
}

/** Adds a domain to the workspace and proves it, as its owner does. */
async function proveDomain(slug: string, domain: string) {
	await directory(slug, owner, { action: "add-domain", name: domain });
	const added = (await directory(slug, owner)).body.domains.find((one) => one.name === domain);
	if (!added?.proof) throw new Error("expected a proof");
	proofs.set(`_gateweave-mail.${domain}`, added.proof.value);
	const checked = await directory(slug, owner, { action: "check-domain", id: added.id });
	expect(checked.status).toBe(200);
	return added.id;
}

/** A workspace of its own, with two proved domains and a mailbox. */
async function workspace() {
	const n = ++counter;
	const slug = `agent-addresses-${n}`;
	const workspaceId = await createWorkspace(
		mail,
		origin,
		{ ...owner.headers, "cf-connecting-ip": `198.51.100.${n}` },
		slug,
	);
	const domain = `agents${n}.example.com`;
	const other = `people${n}.example.com`;
	const domainId = await proveDomain(slug, domain);
	const otherId = await proveDomain(slug, other);
	const name = `Sign-ups ${n}`;
	await directory(slug, owner, { action: "add-mailbox", name });
	const box = (await directory(slug, owner)).body.mailboxes.find((one) => one.name === name);
	if (!box) throw new Error("expected a mailbox");
	return { slug, workspaceId, domain, domainId, other, otherId, mailboxId: box.id };
}

type Workspace = Awaited<ReturnType<typeof workspace>>;

/** Asks Better Auth's agents plugin, as the owner unless someone else asks. */
function auth(path: string, body: unknown, person: Asker = owner) {
	return mail.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: { ...person.headers, origin, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** An agent of the workspace, with its key, as its owner makes it in settings. */
async function makeAgent(space: Workspace, name = `Sorter ${++counter}`) {
	// From an address of its own each time, as making agents is limited to a few a minute.
	const response = await auth(
		"/agents/create",
		{ organizationId: space.workspaceId, name },
		{ headers: { ...owner.headers, "cf-connecting-ip": `192.0.2.${counter % 250}` } },
	);
	expect(response.status).toBe(200);
	const { agent, key } = (await response.json()) as {
		agent: { id: string; memberId: string };
		key: string;
	};
	return { ...agent, name, headers: { authorization: `Bearer ${key}` } };
}

type Agent = Awaited<ReturnType<typeof makeAgent>>;

/** Gives the mailbox to these agents, letting those named send from it. */
async function give(
	space: Workspace,
	memberIds: string[],
	senderIds: string[],
	mailboxId = space.mailboxId,
) {
	const response = await directory(space.slug, owner, {
		action: "set-mailbox-access",
		mailboxId,
		everyone: false,
		memberIds,
		senderIds,
	});
	expect(response.status).toBe(200);
}

/** Sets what addresses the agent may make, as its owner does on Settings → Agents. */
function limit(
	agent: Agent,
	policy: { maxLive: number; maxDays: number; domains: string[] },
	person: Asker = owner,
) {
	return auth("/agents/set-address-policy", { agentId: agent.id, ...policy }, person);
}

/** An agent ready to make addresses on the workspace's first domain, in its mailbox. */
async function readyAgent(
	space: Workspace,
	policy: Partial<{ maxLive: number; maxDays: number; domains: string[] }> = {},
) {
	const agent = await makeAgent(space);
	await give(space, [agent.memberId], [agent.memberId]);
	const set = await limit(agent, { maxLive: 3, maxDays: 7, domains: [space.domain], ...policy });
	expect(set.status).toBe(200);
	return agent;
}

interface Made {
	ok: boolean;
	error?: string;
	address?: { id: string; address: string; expiresAt: number };
}

/** The agent's call to its addresses route, with its key and from no page. */
async function addresses(
	space: Workspace,
	agent: Asker,
	body?: unknown,
	mailboxId = space.mailboxId,
	slug = space.slug,
) {
	const response = await mail.fetch(`${origin}/api/mail/${slug}/${mailboxId}/addresses`, {
		method: body ? "POST" : "GET",
		headers: { ...agent.headers, "content-type": "application/json" },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	return {
		status: response.status,
		body: (await response.json()) as Made & Record<string, unknown>,
	};
}

const make = (space: Workspace, agent: Asker, request: Record<string, unknown> = {}) =>
	addresses(space, agent, { action: "make", domain: space.domain, ...request });

/** Whether mail to this address is taken, as Email Routing hands it to the Worker. */
async function takes(address: string) {
	const raw = [
		"From: Ada Lovelace <ada@example.org>",
		`To: ${address}`,
		"Subject: Welcome",
		`Message-ID: <${crypto.randomUUID()}@example.org>`,
		"Date: Mon, 09 Nov 2026 09:00:00 +0000",
		"",
		"Confirm your sign-up.",
		"",
	].join("\r\n");
	return (await mail.deliver("ada@example.org", address, raw)).status === 200;
}

/** The address as the workspace's page lists it to the owner. */
async function listed(space: Workspace, address: string, person: Asker = owner) {
	const { body } = await directory(space.slug, person);
	return body.mailboxes.flatMap((box) => box.addresses).find((one) => one.address === address);
}

beforeAll(async () => {
	mail = await startMail(origin, { hosts: { "cloudflare-dns.com": dns } });
	owner = await signUp(mail, origin, "Owner");
});

afterAll(async () => {
	await mail?.dispose();
});

describe("an agent's own addresses", () => {
	it("are none until an owner or admin lets it make them", async () => {
		const space = await workspace();
		const agent = await makeAgent(space);
		await give(space, [agent.memberId], [agent.memberId]);
		const shown = await addresses(space, agent);
		expect(shown.status).toBe(200);
		expect(shown.body.policy).toEqual({ maxLive: 0, maxDays: 7, domains: [] });
		const refused = await make(space, agent);
		expect(refused.status).toBe(403);
		expect(refused.body.error).toContain("An owner or admin can let it");
		// A domain but none at once is none at all.
		const set = await limit(agent, { maxLive: 0, maxDays: 7, domains: [space.domain] });
		expect(set.status).toBe(200);
		const stopped = await make(space, agent);
		expect(stopped.status).toBe(403);
		expect(stopped.body.error).toContain("An owner or admin can let it");
	});

	it("are made on a domain it was given, take mail for the mailbox, and stop when ended", async () => {
		const space = await workspace();
		const agent = await readyAgent(space, { maxDays: 3 });
		const before = Date.now();
		const made = await make(space, agent);
		expect(made.status).toBe(200);
		const address = made.body.address;
		if (!address) throw new Error("expected an address");
		expect(address.address).toMatch(
			new RegExp(`^[a-z0-9]{12}@${space.domain.replaceAll(".", "\\.")}$`),
		);
		// It lasts the agent's longest when it asks for nothing else.
		expect(address.expiresAt).toBeGreaterThanOrEqual(before + 3 * DAY_MS);
		expect(address.expiresAt).toBeLessThanOrEqual(Date.now() + 3 * DAY_MS);
		expect(await takes(address.address)).toBe(true);

		const shown = await addresses(space, agent);
		expect(shown.body.live).toBe(1);
		expect(shown.body.addresses).toEqual([address]);
		// Owners and admins see who made it; nobody else is told.
		expect((await listed(space, address.address))?.madeBy).toBe(agent.name);

		const ended = await addresses(space, agent, { action: "end", id: address.id });
		expect(ended.status).toBe(200);
		expect(await takes(address.address)).toBe(false);
		expect((await addresses(space, agent)).body.addresses).toEqual([]);
		// Its name is kept a while, as any address that ends is.
		const again = await make(space, agent, { localPart: address.address.split("@")[0] });
		expect(again.status).toBe(409);
	});

	it("can have a name it chooses, but not one that proves who runs the domain", async () => {
		const space = await workspace();
		const agent = await readyAgent(space);
		const chosen = await make(space, agent, { localPart: "Invoice-42" });
		expect(chosen.status).toBe(200);
		expect(chosen.body.address?.address).toBe(`invoice-42@${space.domain}`);
		for (const reserved of ["admin", "Postmaster", " webmaster ", "abuse", "mailer-daemon"]) {
			const refused = await make(space, agent, { localPart: reserved });
			expect(refused.status, reserved).toBe(400);
		}
		expect((await make(space, agent, { localPart: "no..dots" })).status).toBe(400);
		expect((await make(space, agent, { localPart: "invoice-42" })).status).toBe(409);
	});

	it("last no longer than its limit says", async () => {
		const space = await workspace();
		const agent = await readyAgent(space, { maxDays: 2 });
		const tooLong = await make(space, agent, { days: 3 });
		expect(tooLong.status).toBe(400);
		expect(tooLong.body.error).toContain("at most 2 days");
		const short = await make(space, agent, { days: 1 });
		expect(short.status).toBe(200);
		expect(short.body.address?.expiresAt).toBeLessThanOrEqual(Date.now() + DAY_MS);
		// An agent's address always ends: none lasts for good, whatever it asks.
		const longest = (await make(space, agent, { days: null })).body.address;
		if (!longest) throw new Error("expected an address");
		const stored = (await listed(space, longest.address))?.expiresAt;
		expect(stored).toBeGreaterThan(Date.now() + DAY_MS);
		expect(stored).toBeLessThanOrEqual(Date.now() + 2 * DAY_MS);
		expect((await make(space, agent, { days: 0 })).status).toBe(400);
	});

	it("go only on the domains it was given, while the workspace has them proved", async () => {
		const space = await workspace();
		const agent = await readyAgent(space);
		const other = await make(space, agent, { domain: space.other });
		expect(other.status).toBe(403);
		const elsewhere = await make(space, agent, { domain: "example.org" });
		expect(elsewhere.status).toBe(403);
		// Once another workspace proves the domain, this one still lists it, unproved, and the
		// agent can't use it.
		const theirs = await workspace();
		await proveDomain(theirs.slug, space.domain);
		const released = await make(space, agent);
		expect(released.status).toBe(409);
		expect(released.body.error).toContain("hasn't proved");
		// Nor once the workspace removes it.
		expect(
			(await directory(space.slug, owner, { action: "remove-domain", id: space.domainId })).status,
		).toBe(200);
		const gone = await make(space, agent);
		expect(gone.status).toBe(409);
		expect(gone.body.error).toContain("hasn't proved");
	});

	it("stop at as many as it may hold, and as many as it may make in a day", async () => {
		const space = await workspace();
		const agent = await readyAgent(space, { maxLive: 2 });
		const first = await make(space, agent);
		expect(first.status).toBe(200);
		expect((await make(space, agent)).status).toBe(200);
		const third = await make(space, agent);
		expect(third.status).toBe(409);
		expect(third.body.error).toContain("holds 2 addresses");
		// Ending one leaves room to hold another, but not to make a third today.
		const id = first.body.address?.id;
		expect((await addresses(space, agent, { action: "end", id })).status).toBe(200);
		const churn = await make(space, agent);
		expect(churn.status).toBe(409);
		expect(churn.body.error).toContain("in the last day");
	});

	it("count those made on other days that haven't ended", async () => {
		const space = await workspace();
		const agent = await readyAgent(space, { maxLive: 2, maxDays: 30 });
		// One it made three days ago, which lasts a while yet.
		await mail.db
			.prepare(
				"INSERT INTO mail_address (id, domain_id, local_part, mailbox_id, expires_at, created_at, agent_member_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(
				crypto.randomUUID(),
				space.domainId,
				`older${++counter}`,
				space.mailboxId,
				Date.now() + 10 * DAY_MS,
				Date.now() - 3 * DAY_MS,
				agent.memberId,
			)
			.run();
		expect((await make(space, agent)).status).toBe(200);
		// It has made one today, but holds two, as many as it may.
		const third = await make(space, agent);
		expect(third.status).toBe(409);
		expect(third.body.error).toContain("holds 2 addresses");
		expect((await addresses(space, agent)).body.live).toBe(2);
	});

	it("don't pass the limit when made all at once", async () => {
		const space = await workspace();
		const agent = await readyAgent(space, { maxLive: 3 });
		const results = await Promise.all(Array.from({ length: 8 }, () => make(space, agent)));
		expect(results.filter((result) => result.status === 200)).toHaveLength(3);
		expect(results.filter((result) => result.status === 409)).toHaveLength(5);
		expect((await addresses(space, agent)).body.live).toBe(3);
	});

	it("point only at a mailbox it may send from, in its own workspace", async () => {
		const space = await workspace();
		const agent = await readyAgent(space);
		// Given to read only.
		await give(space, [agent.memberId], []);
		const reads = await make(space, agent);
		expect(reads.status).toBe(403);
		expect(reads.body.error).toContain("not send from it");
		// Not given at all: the same as no such mailbox.
		await give(space, [], []);
		expect((await make(space, agent)).status).toBe(404);
		// Another workspace's mailbox, through either workspace's address.
		const theirs = await workspace();
		expect(
			(await addresses(space, agent, { action: "make", domain: space.domain }, theirs.mailboxId))
				.status,
		).toBe(404);
		expect(
			(
				await addresses(
					theirs,
					agent,
					{ action: "make", domain: theirs.domain },
					theirs.mailboxId,
					theirs.slug,
				)
			).status,
		).toBe(404);
	});

	it("can be ended only by the agent that made them", async () => {
		const space = await workspace();
		const maker = await readyAgent(space);
		const made = await make(space, maker);
		const id = made.body.address?.id;
		const other = await makeAgent(space);
		await give(space, [maker.memberId, other.memberId], [maker.memberId, other.memberId]);
		expect((await addresses(space, other, { action: "end", id })).status).toBe(404);
		// Nor an address a person added.
		await directory(space.slug, owner, {
			action: "add-address",
			domainId: space.domainId,
			mailboxId: space.mailboxId,
			localPart: "help",
			expiresInDays: null,
		});
		const help = await listed(space, `help@${space.domain}`);
		expect((await addresses(space, maker, { action: "end", id: help?.id })).status).toBe(404);
		expect(await takes(`help@${space.domain}`)).toBe(true);
		if (!made.body.address) throw new Error("expected an address");
		expect(await takes(made.body.address.address)).toBe(true);
	});

	it("are ended only through their own mailbox, and only once", async () => {
		const space = await workspace();
		const agent = await readyAgent(space);
		const made = await make(space, agent);
		const id = made.body.address?.id;
		// A second mailbox the agent may send from too.
		const name = `Orders ${++counter}`;
		await directory(space.slug, owner, { action: "add-mailbox", name });
		const orders = (await directory(space.slug, owner)).body.mailboxes.find(
			(one) => one.name === name,
		);
		if (!orders) throw new Error("expected a mailbox");
		await give(space, [agent.memberId], [agent.memberId], orders.id);
		expect((await addresses(space, agent, undefined, orders.id)).body.addresses).toEqual([]);
		expect((await addresses(space, agent, { action: "end", id }, orders.id)).status).toBe(404);
		expect((await addresses(space, agent, { action: "end", id })).status).toBe(200);
		expect((await addresses(space, agent, { action: "end", id })).status).toBe(404);
	});

	it("are named to owners and admins only", async () => {
		const space = await workspace();
		const agent = await readyAgent(space);
		const made = await make(space, agent);
		const address = made.body.address?.address ?? "";
		const reader = await signUp(mail, origin, `Reader${++counter}`);
		const readerId = crypto.randomUUID();
		await mail.db
			.prepare(
				"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(readerId, space.workspaceId, reader.userId, "member", Date.now())
			.run();
		await give(space, [agent.memberId, readerId], [agent.memberId]);
		expect((await listed(space, address))?.madeBy).toBe(agent.name);
		const seen = await listed(space, address, reader);
		expect(seen?.address).toBe(address);
		expect(seen?.madeBy).toBeNull();
	});

	it("stop at the workspace's cap, as anyone's do", async () => {
		const space = await workspace();
		const agent = await readyAgent(space);
		await mail.db
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
				INSERT INTO mail_address (id, domain_id, local_part, mailbox_id)
				SELECT ?1 || i, ?2, 'filler' || i, ?3 FROM n`,
			)
			.bind(`cap-${counter}-`, space.otherId, space.mailboxId)
			.run();
		const refused = await make(space, agent);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toContain("5000 addresses");
	});

	it("leave half of the workspace's cap to people, counting those that ended", async () => {
		const space = await workspace();
		const agent = await readyAgent(space);
		// Addresses the agent made and ended over the last weeks, whose names are still kept.
		await mail.db
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500)
				INSERT INTO mail_address (id, domain_id, local_part, mailbox_id, expires_at, created_at, agent_member_id)
				SELECT ?1 || i, ?2, 'ended' || i, ?3, ?4, ?5, ?6 FROM n`,
			)
			.bind(
				`share-${counter}-`,
				space.domainId,
				space.mailboxId,
				Date.now() - DAY_MS,
				Date.now() - 10 * DAY_MS,
				agent.memberId,
			)
			.run();
		const refused = await make(space, agent);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toContain("agents can have made 2500");
		// People still have room for theirs.
		const added = await directory(space.slug, owner, {
			action: "add-address",
			domainId: space.domainId,
			mailboxId: space.mailboxId,
			localPart: "help",
			expiresInDays: null,
		});
		expect(added.status).toBe(200);
	});

	it("can't take a name a person removed lately, though people can take it again", async () => {
		const space = await workspace();
		const agent = await readyAgent(space);
		const add = (localPart: string, mailboxId = space.mailboxId) =>
			directory(space.slug, owner, {
				action: "add-address",
				domainId: space.domainId,
				mailboxId,
				localPart,
				expiresInDays: null,
			});
		const remove = async (address: string) => {
			const id = (await listed(space, address))?.id;
			expect((await directory(space.slug, owner, { action: "remove-address", id })).status).toBe(
				200,
			);
		};
		// Whatever wrote to jane@ may still: password resets, say.
		const jane = `jane@${space.domain}`;
		expect((await add("jane")).status).toBe(200);
		await remove(jane);
		const taken = await make(space, agent, { localPart: "jane" });
		expect(taken.status).toBe(409);
		expect(taken.body.error).toContain("taken");
		// A person chose to let it go, so people may take it again at once.
		expect((await add("jane")).status).toBe(200);
		await remove(jane);
		// Once it has been kept as long as an ended address is, an agent may have it.
		await mail.db
			.prepare(
				"UPDATE removed_address SET removed_at = ? WHERE domain_id = ? AND local_part = 'jane'",
			)
			.bind(Date.now() - 31 * DAY_MS, space.domainId)
			.run();
		expect((await make(space, agent, { localPart: "jane" })).status).toBe(200);
		// The names a removed mailbox had are kept the same way.
		const name = `Team ${++counter}`;
		await directory(space.slug, owner, { action: "add-mailbox", name });
		const team = (await directory(space.slug, owner)).body.mailboxes.find(
			(one) => one.name === name,
		);
		if (!team) throw new Error("expected a mailbox");
		expect((await add("bob", team.id)).status).toBe(200);
		expect(
			(await directory(space.slug, owner, { action: "remove-mailbox", id: team.id })).status,
		).toBe(200);
		expect((await make(space, agent, { localPart: "bob" })).status).toBe(409);
	});

	it("end once the agent may no longer send from their mailbox", async () => {
		const space = await workspace();
		const agent = await readyAgent(space);
		await directory(space.slug, owner, {
			action: "add-address",
			domainId: space.domainId,
			mailboxId: space.mailboxId,
			localPart: "help",
			expiresInDays: null,
		});
		const first = (await make(space, agent)).body.address;
		if (!first) throw new Error("expected an address");
		// Let it read the mailbox, but no longer send from it.
		await give(space, [agent.memberId], []);
		expect(await takes(first.address)).toBe(false);
		expect((await listed(space, first.address))?.madeBy).toBe(agent.name);
		// Let it send again: the ended one no longer counts. Then take the mailbox away.
		await give(space, [agent.memberId], [agent.memberId]);
		expect((await addresses(space, agent)).body.live).toBe(0);
		const second = (await make(space, agent)).body.address;
		if (!second) throw new Error("expected an address");
		expect(await takes(second.address)).toBe(true);
		await give(space, [], []);
		expect(await takes(second.address)).toBe(false);
		// What people added stays as it was.
		expect(await takes(`help@${space.domain}`)).toBe(true);
	});

	it("end, and no longer name it, once the agent is deleted", async () => {
		const space = await workspace();
		const agent = await readyAgent(space);
		const made = await make(space, agent, { localPart: "order-7" });
		const address = `order-7@${space.domain}`;
		expect(made.status).toBe(200);
		expect(await takes(address)).toBe(true);
		expect((await auth("/agents/delete", { agentId: agent.id })).status).toBe(200);
		expect(await takes(address)).toBe(false);
		const left = await listed(space, address);
		expect(left?.madeBy).toBeNull();
		expect(left?.expiresAt).toBeLessThanOrEqual(Date.now());
		// The name stays kept for a while, so nobody takes it over at once.
		const added = await directory(space.slug, owner, {
			action: "add-address",
			domainId: space.domainId,
			mailboxId: space.mailboxId,
			localPart: "order-7",
			expiresInDays: null,
		});
		expect(added.status).toBe(409);
	});

	it("are an agent's only: a session can't use the route", async () => {
		const space = await workspace();
		const shown = await addresses(space, owner);
		expect(shown.status).toBe(403);
		const made = await addresses(
			space,
			{ headers: { ...owner.headers, origin } },
			{ action: "make", domain: space.domain },
		);
		expect(made.status).toBe(403);
		const unknownKey = await addresses(space, { headers: { authorization: "Bearer gwm_nope" } });
		expect(unknownKey.status).toBe(404);
	});
});

describe("an agent's address limits", () => {
	it("need a recent sign-in, as letting an agent take mail is a grant", async () => {
		const space = await workspace();
		const agent = await makeAgent(space);
		const admin = await signUp(mail, origin, `Admin${++counter}`);
		await mail.db
			.prepare(
				"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(crypto.randomUUID(), space.workspaceId, admin.userId, "admin", Date.now())
			.run();
		const policy = { maxLive: 5, maxDays: 30, domains: [space.domain] };
		expect((await limit(agent, policy, admin)).status).toBe(200);
		await mail.db
			.prepare("UPDATE session SET created_at = ? WHERE user_id = ?")
			.bind(Date.now() - 2 * DAY_MS, admin.userId)
			.run();
		const late = await limit(agent, { ...policy, maxLive: 50 }, admin);
		expect(late.status).toBe(403);
		expect(((await late.json()) as { code?: string }).code).toBe("SESSION_NOT_FRESH");
	});

	it("are set only by owners and admins, and only to domains the workspace has proved", async () => {
		const space = await workspace();
		const agent = await makeAgent(space);
		const member = await signUp(mail, origin, `Member${++counter}`);
		await mail.db
			.prepare(
				"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(crypto.randomUUID(), space.workspaceId, member.userId, "member", Date.now())
			.run();
		const policy = { maxLive: 5, maxDays: 30, domains: [space.domain] };
		expect((await limit(agent, policy, member)).status).toBe(403);
		const unproved = await limit(agent, { ...policy, domains: ["example.org"] });
		expect(unproved.status).toBe(400);
		const theirs = await workspace();
		expect((await limit(agent, { ...policy, domains: [theirs.domain] })).status).toBe(400);
		expect((await limit(agent, { ...policy, maxLive: 501 })).status).toBe(400);
		expect((await limit(agent, { ...policy, maxDays: 0 })).status).toBe(400);

		const set = await limit(agent, {
			...policy,
			domains: [space.domain.toUpperCase(), space.domain],
		});
		expect(set.status).toBe(200);
		const response = await mail.fetch(
			`${origin}/api/auth/agents/list?organizationId=${space.workspaceId}`,
			{ headers: { ...owner.headers, origin } },
		);
		const agents = (await response.json()) as {
			id: string;
			addressPolicy: unknown;
			liveAddresses: number;
		}[];
		const shown = agents.find((one) => one.id === agent.id);
		expect(shown?.addressPolicy).toEqual({ maxLive: 5, maxDays: 30, domains: [space.domain] });
		expect(shown?.liveAddresses).toBe(0);
	});
});

describe("the database", () => {
	it("refuses an agent's address in another workspace's mailbox, or one naming a person", async () => {
		const space = await workspace();
		const agent = await makeAgent(space);
		const theirs = await workspace();
		const insert = (mailboxId: string, domainId: string, memberId: string, id = "") =>
			mail.db
				.prepare(
					"INSERT INTO mail_address (id, domain_id, local_part, mailbox_id, expires_at, created_at, agent_member_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(
					id || crypto.randomUUID(),
					domainId,
					`x${++counter}`,
					mailboxId,
					Date.now() + DAY_MS,
					Date.now(),
					memberId,
				)
				.run();
		await expect(insert(theirs.mailboxId, theirs.domainId, agent.memberId)).rejects.toThrow(
			"agent's workspace",
		);
		const ownerMember = await mail.db
			.prepare("SELECT id FROM member WHERE organization_id = ? AND role = 'owner'")
			.bind(space.workspaceId)
			.first<{ id: string }>();
		await expect(insert(space.mailboxId, space.domainId, ownerMember?.id ?? "")).rejects.toThrow(
			"agent's workspace",
		);
		await expect(insert(space.mailboxId, space.domainId, "no-such-member")).rejects.toThrow(
			"agent's workspace",
		);
		const id = crypto.randomUUID();
		await insert(space.mailboxId, space.domainId, agent.memberId, id);
		// Nor may a change move it there, or make it name a person.
		const update = (column: string, value: string) =>
			mail.db.prepare(`UPDATE mail_address SET ${column} = ? WHERE id = ?`).bind(value, id).run();
		await expect(update("agent_member_id", ownerMember?.id ?? "")).rejects.toThrow(
			"agent's workspace",
		);
		await expect(update("mailbox_id", theirs.mailboxId)).rejects.toThrow();
		await update("agent_member_id", agent.memberId);
	});
});
