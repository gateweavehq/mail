import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startMail } from "./mail-worker";

// The directory, reached the way a browser and Email Routing reach it: through the built Worker's
// entry, in workerd, with a stand-in for the DNS resolver.

const origin = "https://mail.test";
const CLOUDFLARE_MX = "route1.mx.cloudflare.net";

/** What DNS says, by name and type. A name it doesn't have answers as a real resolver would. */
const records = new Map<string, string[]>();
let resolverDown = false;

function dns(request: Request): Response {
	if (resolverDown) return new Response("down", { status: 503 });
	const url = new URL(request.url);
	const name = url.searchParams.get("name") ?? "";
	const type = url.searchParams.get("type") ?? "";
	const found = records.get(`${name}|${type}`);
	if (!found) return Response.json({ Status: 3 });
	return Response.json({
		Status: 0,
		Answer: found.map((data) => ({ name, type: type === "TXT" ? 16 : 15, data })),
	});
}

const setProof = (domain: string, ...values: string[]) =>
	records.set(
		`_gateweave-mail.${domain}|TXT`,
		values.map((value) => `"${value}"`),
	);
const setMail = (domain: string, ...hosts: string[]) =>
	records.set(
		`${domain}|MX`,
		hosts.map((host) => `10 ${host}.`),
	);

let mail: Awaited<ReturnType<typeof startMail>>;

interface Listed {
	domains: {
		id: string;
		name: string;
		verifiedAt: number | null;
		proof: { name: string; value: string } | null;
	}[];
	mailboxes: {
		id: string;
		name: string;
		addresses: {
			id: string;
			address: string;
			expiresAt: number | null;
			domainProved: boolean;
		}[];
	}[];
}

function read(slug: string, headers?: HeadersInit) {
	return mail.fetch(`${origin}/api/directory/${slug}`, { headers });
}

async function list(slug: string, headers: HeadersInit): Promise<Listed> {
	const response = await read(slug, headers);
	expect(response.status).toBe(200);
	return (await response.json()) as Listed;
}

function change(slug: string, headers: HeadersInit, action: unknown, from: string | null = origin) {
	const sent = new Headers(headers);
	sent.delete("origin");
	if (from) sent.set("origin", from);
	sent.set("content-type", "application/json");
	return mail.fetch(`${origin}/api/directory/${slug}`, {
		method: "POST",
		headers: Object.fromEntries(sent),
		body: JSON.stringify(action),
	});
}

async function changed(slug: string, headers: HeadersInit, action: unknown) {
	const response = await change(slug, headers, action);
	const body = (await response.json()) as {
		ok: boolean;
		error?: string;
		proved?: boolean;
		mail?: string;
	};
	return { status: response.status, ...body };
}

const sent = (to: string) =>
	[
		"From: Sender <sender@example.org>",
		`To: ${to}`,
		"Subject: Hello",
		"Message-ID: <one@example.org>",
		"",
		"Hello",
		"",
	].join("\r\n");

const deliver = (to: string) => mail.deliver("sender@example.org", to, sent(to));

const refused = async (to: string) => {
	const answer = await deliver(to);
	expect(answer.status).toBe(400);
	expect(answer.text).toContain("No such address");
};

/** What a sender's server is told to try again from: anything but acceptance or the refusal. */
const toldToRetry = async (to: string) => {
	const answer = await deliver(to);
	expect(answer.status).toBeGreaterThanOrEqual(500);
	expect(answer.text).not.toContain("No such address");
};

let owner: Awaited<ReturnType<typeof signUp>>;
let counter = 0;

let workspaces = 0;

/** Each from a client address of its own, so the limit on that route stays out of the way. */
function newWorkspace(person: typeof owner, slug: string) {
	const client = `198.51.100.${++workspaces}`;
	return createWorkspace(mail, origin, { ...person.headers, "cf-connecting-ip": client }, slug);
}

/** A workspace with a proved domain and one mailbox, ready for addresses. */
async function provedWorkspace(person = owner) {
	const n = ++counter;
	const slug = `ws-${n}`;
	const domain = `d${n}.example.com`;
	await newWorkspace(person, slug);
	expect((await changed(slug, person.headers, { action: "add-domain", name: domain })).ok).toBe(
		true,
	);
	const before = await list(slug, person.headers);
	const added = before.domains[0];
	if (!added?.proof) throw new Error("expected a proof for a new domain");
	setProof(domain, added.proof.value);
	const checked = await changed(slug, person.headers, { action: "check-domain", id: added.id });
	expect(checked.proved).toBe(true);
	await changed(slug, person.headers, { action: "add-mailbox", name: "Support" });
	const after = await list(slug, person.headers);
	const box = after.mailboxes[0];
	if (!box) throw new Error("expected a mailbox");
	return { slug, domain, domainId: added.id, mailboxId: box.id };
}

beforeAll(async () => {
	mail = await startMail(origin, { hosts: { "cloudflare-dns.com": dns } });
	owner = await signUp(mail, origin, "Owner");
});

afterAll(async () => {
	await mail?.dispose();
});

describe("who can reach the directory", () => {
	it("answers a non-member and a stranger the same as a workspace that doesn't exist", async () => {
		await newWorkspace(owner, "private-one");
		const stranger = await signUp(mail, origin, "Stranger");

		const missing = await read("no-such-workspace", stranger.headers);
		const notTheirs = await read("private-one", stranger.headers);
		const signedOut = await read("private-one");

		expect(notTheirs.status).toBe(404);
		expect(signedOut.status).toBe(404);
		expect(missing.status).toBe(404);
		const body = await missing.text();
		expect(await notTheirs.text()).toBe(body);
		expect(await signedOut.text()).toBe(body);
		expect(missing.headers.get("cache-control")).toContain("no-store");

		const write = await change("private-one", stranger.headers, {
			action: "add-mailbox",
			name: "x",
		});
		expect(write.status).toBe(404);
		expect(await write.text()).toBe(body);
	});

	it("takes a change only from this site, whoever's cookie comes with it", async () => {
		await newWorkspace(owner, "origin-check");
		const action = { action: "add-mailbox", name: "Sneaked in" };

		expect(
			(await change("origin-check", owner.headers, action, "https://evil.example")).status,
		).toBe(403);
		expect((await change("origin-check", owner.headers, action, null)).status).toBe(403);
		expect((await list("origin-check", owner.headers)).mailboxes).toEqual([]);
	});

	it("shows a member what exists, without the proof, and takes no change from them", async () => {
		const { slug, domain } = await provedWorkspace();
		await changed(slug, owner.headers, { action: "add-domain", name: `waiting.${domain}` });
		const member = await signUp(mail, origin, "Member");
		const workspace = await mail.db
			.prepare("SELECT id FROM organization WHERE slug = ?")
			.bind(slug)
			.first<{ id: string }>();
		await mail.db
			.prepare(
				"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
			)
			.bind(crypto.randomUUID(), workspace?.id, member.userId, Date.now())
			.run();

		const seen = await list(slug, member.headers);
		expect(seen.domains.map((d) => d.name).sort()).toEqual([domain, `waiting.${domain}`].sort());
		expect(seen.domains.every((d) => d.proof === null)).toBe(true);

		const admins = await list(slug, owner.headers);
		expect(admins.domains.find((d) => d.name === `waiting.${domain}`)?.proof).not.toBeNull();

		const write = await change(slug, member.headers, { action: "add-mailbox", name: "Mine" });
		expect(write.status).toBe(403);
		expect((await list(slug, owner.headers)).mailboxes.map((m) => m.name)).toEqual(["Support"]);
	});

	it("refuses a change it doesn't know", async () => {
		await newWorkspace(owner, "bad-change");
		const unknown = await change("bad-change", owner.headers, { action: "drop-everything" });
		expect(unknown.status).toBe(400);
		const notJson = await mail.fetch(`${origin}/api/directory/bad-change`, {
			method: "POST",
			headers: { ...Object.fromEntries(new Headers(owner.headers)), origin },
			body: "{",
		});
		expect(notJson.status).toBe(400);
	});
});

describe("proving a domain", () => {
	it("normalises the name, and refuses what isn't one or is there already", async () => {
		await newWorkspace(owner, "names");
		const added = await changed("names", owner.headers, {
			action: "add-domain",
			name: "  Mail.Example.COM. ",
		});
		expect(added.ok).toBe(true);
		const { domains } = await list("names", owner.headers);
		expect(domains.map((d) => d.name)).toEqual(["mail.example.com"]);
		expect(domains[0]?.verifiedAt).toBeNull();
		expect(domains[0]?.proof?.name).toBe("_gateweave-mail.mail.example.com");

		expect(
			(await changed("names", owner.headers, { action: "add-domain", name: "nope" })).status,
		).toBe(400);
		const twice = await changed("names", owner.headers, {
			action: "add-domain",
			name: "mail.example.com",
		});
		expect(twice.status).toBe(409);
	});

	it("stays unproved until DNS holds this very record, and says where its mail goes", async () => {
		await newWorkspace(owner, "proof");
		const domain = "proof.example.com";
		await changed("proof", owner.headers, { action: "add-domain", name: domain });
		const [row] = (await list("proof", owner.headers)).domains;
		if (!row?.proof) throw new Error("expected a proof");
		const check = () => changed("proof", owner.headers, { action: "check-domain", id: row.id });

		expect(await check()).toMatchObject({ ok: true, proved: false, mail: "none" });

		// Someone else's token proves nothing.
		setProof(domain, "gateweave-mail-verification=not-the-right-one");
		expect(await check()).toMatchObject({ proved: false });
		expect((await list("proof", owner.headers)).domains[0]?.verifiedAt).toBeNull();

		setProof(domain, row.proof.value);
		setMail(domain, "aspmx.l.google.com");
		expect(await check()).toMatchObject({ proved: true, mail: "elsewhere" });
		const proved = (await list("proof", owner.headers)).domains[0];
		expect(proved?.verifiedAt).toEqual(expect.any(Number));
		expect(proved?.proof).toBeNull();

		// One host elsewhere means some of its mail doesn't come here.
		setMail(domain, CLOUDFLARE_MX, "aspmx.l.google.com");
		expect(await check()).toMatchObject({ mail: "elsewhere" });
		setMail(domain, CLOUDFLARE_MX, "route2.mx.cloudflare.net");
		expect(await check()).toMatchObject({ mail: "cloudflare" });

		// The record has served its purpose, and people remove such records.
		records.delete(`_gateweave-mail.${domain}|TXT`);
		expect(await check()).toMatchObject({ proved: true });
	});

	it("changes nothing when the resolver fails", async () => {
		await newWorkspace(owner, "resolver-down");
		await changed("resolver-down", owner.headers, {
			action: "add-domain",
			name: "down.example.com",
		});
		const [row] = (await list("resolver-down", owner.headers)).domains;
		resolverDown = true;
		try {
			const checked = await changed("resolver-down", owner.headers, {
				action: "check-domain",
				id: row?.id,
			});
			expect(checked.status).toBe(502);
			expect(checked.ok).toBe(false);
		} finally {
			resolverDown = false;
		}
		expect((await list("resolver-down", owner.headers)).domains[0]?.verifiedAt).toBeNull();
	});

	it("gives a domain to whoever proves it, and an unproved claim blocks nobody", async () => {
		const domain = "contested.example.com";
		const squatter = await signUp(mail, origin, "Squatter");
		await newWorkspace(squatter, "squatter");
		await newWorkspace(owner, "real-owner");

		expect(
			(await changed("squatter", squatter.headers, { action: "add-domain", name: domain })).ok,
		).toBe(true);
		expect(
			(await changed("real-owner", owner.headers, { action: "add-domain", name: domain })).ok,
		).toBe(true);

		const [theirs] = (await list("squatter", squatter.headers)).domains;
		const [ours] = (await list("real-owner", owner.headers)).domains;
		expect(theirs?.proof?.value).not.toBe(ours?.proof?.value);
		if (!ours?.proof || !theirs) throw new Error("expected both claims");

		setProof(domain, ours.proof.value);
		expect(
			await changed("real-owner", owner.headers, { action: "check-domain", id: ours.id }),
		).toMatchObject({
			proved: true,
		});

		// Their claim stays what it was, and a claim can still be made: it proves nothing.
		expect(
			await changed("squatter", squatter.headers, { action: "check-domain", id: theirs.id }),
		).toMatchObject({ proved: false });
		const late = await signUp(mail, origin, "Late");
		await newWorkspace(late, "late");
		expect((await changed("late", late.headers, { action: "add-domain", name: domain })).ok).toBe(
			true,
		);
	});

	/** A workspace of its own that holds this domain, with an address on it. */
	async function holder(name: string, domain: string, localPart: string) {
		const person = await signUp(mail, origin, name);
		const slug = name.toLowerCase();
		await newWorkspace(person, slug);
		await changed(slug, person.headers, { action: "add-domain", name: domain });
		const [row] = (await list(slug, person.headers)).domains;
		if (!row?.proof) throw new Error("expected a proof");
		setProof(domain, row.proof.value);
		const proved = await changed(slug, person.headers, { action: "check-domain", id: row.id });
		expect(proved.proved).toBe(true);
		await changed(slug, person.headers, { action: "add-mailbox", name: "Box" });
		const [box] = (await list(slug, person.headers)).mailboxes;
		const made = await changed(slug, person.headers, {
			action: "add-address",
			domainId: row.id,
			mailboxId: box?.id,
			localPart,
			expiresInDays: null,
		});
		expect(made.ok).toBe(true);
		return { slug, person, id: row.id, value: row.proof.value };
	}

	/** Another workspace's claim on a domain someone holds, not yet checked. */
	async function claim(name: string, domain: string) {
		const person = await signUp(mail, origin, name);
		const slug = name.toLowerCase();
		await newWorkspace(person, slug);
		const added = await changed(slug, person.headers, { action: "add-domain", name: domain });
		expect(added.ok).toBe(true);
		const [row] = (await list(slug, person.headers)).domains;
		if (!row?.proof) throw new Error("expected a proof");
		return {
			slug,
			person,
			id: row.id,
			value: row.proof.value,
			check: () => changed(slug, person.headers, { action: "check-domain", id: row.id }),
		};
	}

	// Someone with DNS access for a while proves a company's domain and takes the record away. The
	// company runs its DNS now, so it must be able to get the domain, and them to lose it.
	it("moves a domain to whoever proves it next, once the holder's record has gone", async () => {
		const domain = "moved.example.com";
		const old = await holder("Contractor", domain, "help");
		await toldToRetry(`help@${domain}`);

		records.delete(`_gateweave-mail.${domain}|TXT`);
		expect(
			await changed(old.slug, old.person.headers, { action: "check-domain", id: old.id }),
		).toMatchObject({ proved: true });
		await toldToRetry(`help@${domain}`);

		const company = await claim("Company", domain);
		expect(await company.check()).toMatchObject({ proved: false });
		setProof(domain, company.value);
		expect(await company.check()).toMatchObject({ proved: true });

		const left = await list(old.slug, old.person.headers);
		expect(left.domains[0]?.verifiedAt).toBeNull();
		expect(left.domains[0]?.proof?.value).toBe(old.value);
		expect(left.mailboxes[0]?.addresses[0]?.domainProved).toBe(false);
		await refused(`help@${domain}`);

		// The company's own address is what mail finds now.
		const now = await list(company.slug, company.person.headers);
		expect(now.domains[0]?.verifiedAt).toEqual(expect.any(Number));
		await changed(company.slug, company.person.headers, { action: "add-mailbox", name: "Own" });
		const [box] = (await list(company.slug, company.person.headers)).mailboxes;
		await changed(company.slug, company.person.headers, {
			action: "add-address",
			domainId: company.id,
			mailboxId: box?.id,
			localPart: "help",
			expiresInDays: null,
		});
		const [address] =
			(await list(company.slug, company.person.headers)).mailboxes[0]?.addresses ?? [];
		expect(address?.domainProved).toBe(true);
		await toldToRetry(`help@${domain}`);
	});

	it("moves nothing while the holder's record is there too, since it isn't clear who is meant", async () => {
		const domain = "both.example.com";
		const old = await holder("Stays", domain, "help");
		const other = await claim("Waits", domain);

		setProof(domain, old.value, other.value);
		const tried = await other.check();
		expect(tried.status).toBe(409);
		expect(tried.error).toContain("record is on this domain too");
		expect((await list(old.slug, old.person.headers)).domains[0]?.verifiedAt).toEqual(
			expect.any(Number),
		);
		expect((await list(other.slug, other.person.headers)).domains[0]?.verifiedAt).toBeNull();
		await toldToRetry(`help@${domain}`);

		setProof(domain, other.value);
		expect(await other.check()).toMatchObject({ proved: true });
	});

	it("lets the database hold one proved row per name, whatever the code above does", async () => {
		const first = await newWorkspace(owner, "one-proved-a");
		const second = await newWorkspace(owner, "one-proved-b");
		const insert = (id: string, workspaceId: string) =>
			mail.db
				.prepare(
					"INSERT INTO mail_domain (id, organization_id, name, verification_token, verified_at) VALUES (?, ?, 'one.example.com', ?, 1)",
				)
				.bind(id, workspaceId, id)
				.run();
		await insert("one-a", first);
		await expect(insert("one-b", second)).rejects.toThrow(/UNIQUE/);
	});

	it("proves each domain on its own, so a subdomain needs its own record", async () => {
		const { slug, domain, domainId, mailboxId } = await provedWorkspace();
		await changed(slug, owner.headers, {
			action: "add-address",
			domainId,
			mailboxId,
			localPart: "help",
			expiresInDays: null,
		});
		await toldToRetry(`help@${domain}`);
		await refused(`help@sub.${domain}`);
	});
});

describe("what one workspace can use up", () => {
	it("can't have this server ask DNS without end", async () => {
		await newWorkspace(owner, "many-checks");
		await changed("many-checks", owner.headers, { action: "add-domain", name: "many.example.com" });
		const [row] = (await list("many-checks", owner.headers)).domains;
		const statuses: number[] = [];
		for (let i = 0; i < 11; i++) {
			const checked = await changed("many-checks", owner.headers, {
				action: "check-domain",
				id: row?.id,
			});
			statuses.push(checked.status);
		}
		expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
		expect(statuses[10]).toBe(429);
	});

	it("stops at its share of domains, mailboxes and addresses", async () => {
		const workspaceId = await newWorkspace(owner, "full-up");
		const fill = (table: string, columns: string, select: string, count: number) =>
			mail.db
				.prepare(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
					INSERT INTO ${table} (${columns}) SELECT ${select} FROM n`,
				)
				.bind(workspaceId)
				.run();

		await fill(
			"mail_domain",
			"id, organization_id, name, verification_token, verified_at",
			"'full-d' || i, ?1, 'd' || i || '.full.example.com', 't' || i, 1",
			20,
		);
		const domains = await changed("full-up", owner.headers, {
			action: "add-domain",
			name: "one-more.example.com",
		});
		expect(domains.status).toBe(409);
		expect(domains.error).toContain("20 domains");

		await fill("mailbox", "id, organization_id, name", "'full-b' || i, ?1, 'box'", 500);
		const boxes = await changed("full-up", owner.headers, { action: "add-mailbox", name: "more" });
		expect(boxes.status).toBe(409);
		expect(boxes.error).toContain("500 mailboxes");

		await mail.db
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
				INSERT INTO mail_address (id, domain_id, local_part, mailbox_id)
				SELECT 'full-a' || i, 'full-d1', 'a' || i, 'full-b1' FROM n`,
			)
			.run();
		const addresses = await changed("full-up", owner.headers, {
			action: "add-address",
			domainId: "full-d1",
			mailboxId: "full-b1",
			localPart: "one-more",
			expiresInDays: null,
		});
		expect(addresses.status).toBe(409);
		expect(addresses.error).toContain("5000 addresses");
	});
});

describe("addresses", () => {
	it("needs a proved domain and a mailbox of this workspace", async () => {
		const here = await provedWorkspace();
		const other = await provedWorkspace();
		await changed(here.slug, owner.headers, {
			action: "add-domain",
			name: `unproved.${here.domain}`,
		});
		const unproved = (await list(here.slug, owner.headers)).domains.find(
			(d) => d.verifiedAt === null,
		);

		const add = (domainId: string | undefined, mailboxId: string) =>
			changed(here.slug, owner.headers, {
				action: "add-address",
				domainId,
				mailboxId,
				localPart: "help",
				expiresInDays: null,
			});

		expect((await add(unproved?.id, here.mailboxId)).status).toBe(409);
		expect((await add(other.domainId, here.mailboxId)).status).toBe(404);
		expect((await add(here.domainId, other.mailboxId)).status).toBe(404);
		expect((await list(here.slug, owner.headers)).mailboxes[0]?.addresses).toEqual([]);
	});

	it("refuses a mailbox in another workspace at the database, whatever the code above does", async () => {
		const here = await provedWorkspace();
		const other = await provedWorkspace();
		const insert = (id: string, mailboxId: string) =>
			mail.db
				.prepare(
					"INSERT INTO mail_address (id, domain_id, local_part, mailbox_id) VALUES (?, ?, ?, ?)",
				)
				.bind(id, here.domainId, id, mailboxId)
				.run();

		await expect(insert("crossed", other.mailboxId)).rejects.toThrow(/one workspace/);
		await insert("straight", here.mailboxId);
		await expect(
			mail.db
				.prepare("UPDATE mail_address SET mailbox_id = ? WHERE id = 'straight'")
				.bind(other.mailboxId)
				.run(),
		).rejects.toThrow(/one workspace/);
	});

	it("lowers the name, refuses a bad one, and keeps one name to one address", async () => {
		const { slug, domain, domainId, mailboxId } = await provedWorkspace();
		const add = (localPart: string) =>
			changed(slug, owner.headers, {
				action: "add-address",
				domainId,
				mailboxId,
				localPart,
				expiresInDays: null,
			});

		expect((await add("Help.Desk")).ok).toBe(true);
		const [box] = (await list(slug, owner.headers)).mailboxes;
		expect(box?.addresses.map((a) => a.address)).toEqual([`help.desk@${domain}`]);

		expect((await add("no spaces")).status).toBe(400);
		expect((await add("two@ats")).status).toBe(400);
		expect((await add("help.desk")).status).toBe(409);
	});

	it("takes a set number of days and no silly ones", async () => {
		const { slug, domainId, mailboxId } = await provedWorkspace();
		const add = (localPart: string, expiresInDays: unknown) =>
			change(slug, owner.headers, {
				action: "add-address",
				domainId,
				mailboxId,
				localPart,
				expiresInDays,
			});

		const before = Date.now();
		expect((await add("week", 7)).status).toBe(200);
		const [address] = (await list(slug, owner.headers)).mailboxes[0]?.addresses ?? [];
		expect(address?.expiresAt).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
		expect(address?.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);

		for (const days of [0, -1, 366, 1.5, "7"]) {
			expect((await add("silly", days)).status).toBe(400);
		}
	});

	it("can be checked or taken away only by its own workspace", async () => {
		const here = await provedWorkspace();
		const other = await provedWorkspace();
		await changed(here.slug, owner.headers, {
			action: "add-address",
			domainId: here.domainId,
			mailboxId: here.mailboxId,
			localPart: "keep",
			expiresInDays: null,
		});
		const [address] = (await list(here.slug, owner.headers)).mailboxes[0]?.addresses ?? [];

		const elsewhere = await changed(other.slug, owner.headers, {
			action: "remove-address",
			id: address?.id,
		});
		expect(elsewhere.status).toBe(404);
		const checked = await changed(other.slug, owner.headers, {
			action: "check-domain",
			id: here.domainId,
		});
		expect(checked.status).toBe(404);
		expect(
			(await changed(other.slug, owner.headers, { action: "remove-mailbox", id: here.mailboxId }))
				.status,
		).toBe(404);
		expect(
			(await changed(other.slug, owner.headers, { action: "remove-domain", id: here.domainId }))
				.status,
		).toBe(404);
		expect((await list(here.slug, owner.headers)).mailboxes[0]?.addresses).toHaveLength(1);

		expect(
			(await changed(here.slug, owner.headers, { action: "remove-address", id: address?.id })).ok,
		).toBe(true);
		expect((await list(here.slug, owner.headers)).mailboxes[0]?.addresses).toEqual([]);

		// A person chose to give the name up, so it's free at once.
		const again = await changed(here.slug, owner.headers, {
			action: "add-address",
			domainId: here.domainId,
			mailboxId: here.mailboxId,
			localPart: "keep",
			expiresInDays: null,
		});
		expect(again.ok).toBe(true);
	});
});

describe("mail when the lookup fails", () => {
	// A failed query's message quotes its parameters, and Workers Logs keeps what `email()` throws.
	it("tells the sender to try again, and logs no address", async () => {
		const broken = await startMail(origin);
		try {
			await broken.db.prepare("DROP TABLE mail_address").run();
			const to = "private-name@example.com";
			const answer = await broken.deliver("sender@example.org", to, sent(to));
			expect(answer.status).toBeGreaterThanOrEqual(500);
			expect(answer.text).not.toContain("No such address");
			expect(answer.text).not.toContain("private-name");
			expect(JSON.stringify(broken.logs)).toContain("the directory lookup failed");
			expect(JSON.stringify(broken.logs)).not.toContain("private-name");
		} finally {
			await broken.dispose();
		}
	});
});

describe("mail to the directory's addresses", () => {
	async function withAddress(localPart = "help") {
		const made = await provedWorkspace();
		const result = await changed(made.slug, owner.headers, {
			action: "add-address",
			domainId: made.domainId,
			mailboxId: made.mailboxId,
			localPart,
			expiresInDays: null,
		});
		expect(result.ok).toBe(true);
		return { ...made, address: `${localPart}@${made.domain}` };
	}

	it("tells the sender to try again for an address that exists, in any case", async () => {
		const { address } = await withAddress();
		await toldToRetry(address);
		await toldToRetry(address.toUpperCase());
	});

	it("refuses for good an address that doesn't exist on a proved domain", async () => {
		const { domain } = await withAddress();
		await refused(`nobody@${domain}`);
	});

	it("refuses an address on a domain nobody has proved, even with the row there", async () => {
		await newWorkspace(owner, "unproved-mail");
		await changed("unproved-mail", owner.headers, {
			action: "add-domain",
			name: "unproved-mail.example.com",
		});
		await changed("unproved-mail", owner.headers, { action: "add-mailbox", name: "Box" });
		const { domains, mailboxes } = await list("unproved-mail", owner.headers);
		await mail.db
			.prepare(
				"INSERT INTO mail_address (id, domain_id, local_part, mailbox_id) VALUES ('sneak', ?, 'sneak', ?)",
			)
			.bind(domains[0]?.id, mailboxes[0]?.id)
			.run();
		await refused("sneak@unproved-mail.example.com");
	});

	it("refuses an address past its time", async () => {
		const { address, slug } = await withAddress("short");
		await toldToRetry(address);
		const [listed] = (await list(slug, owner.headers)).mailboxes[0]?.addresses ?? [];
		await mail.db
			.prepare("UPDATE mail_address SET expires_at = ? WHERE id = ?")
			.bind(Date.now() - 1000, listed?.id)
			.run();
		await refused(address);
	});

	it("refuses it once the address, the mailbox or the domain is gone", async () => {
		const byAddress = await withAddress("gone");
		const [one] = (await list(byAddress.slug, owner.headers)).mailboxes[0]?.addresses ?? [];
		await changed(byAddress.slug, owner.headers, { action: "remove-address", id: one?.id });
		await refused(byAddress.address);

		const byMailbox = await withAddress("gone");
		await changed(byMailbox.slug, owner.headers, {
			action: "remove-mailbox",
			id: byMailbox.mailboxId,
		});
		await refused(byMailbox.address);

		const byDomain = await withAddress("gone");
		await changed(byDomain.slug, owner.headers, { action: "remove-domain", id: byDomain.domainId });
		await refused(byDomain.address);
		expect((await list(byDomain.slug, owner.headers)).mailboxes[0]?.addresses).toEqual([]);
	});

	it("lets a removed domain be proved by someone else, and the old addresses stay gone", async () => {
		const { domain, domainId, slug, address } = await withAddress("moved");
		await changed(slug, owner.headers, { action: "remove-domain", id: domainId });

		const next = await signUp(mail, origin, "Next");
		await newWorkspace(next, "next-owner");
		expect(
			(await changed("next-owner", next.headers, { action: "add-domain", name: domain })).ok,
		).toBe(true);
		const [row] = (await list("next-owner", next.headers)).domains;
		if (!row?.proof) throw new Error("expected a proof");
		setProof(domain, row.proof.value);
		expect(
			await changed("next-owner", next.headers, { action: "check-domain", id: row.id }),
		).toMatchObject({
			proved: true,
		});
		await refused(address);
	});
});

describe("what goes with a workspace, and with time", () => {
	it("takes its domains, mailboxes and addresses with it", async () => {
		const { slug, domain } = await provedWorkspace();
		const workspace = await mail.db
			.prepare("SELECT id FROM organization WHERE slug = ?")
			.bind(slug)
			.first<{ id: string }>();
		await changed(slug, owner.headers, {
			action: "add-address",
			domainId: (await list(slug, owner.headers)).domains[0]?.id,
			mailboxId: (await list(slug, owner.headers)).mailboxes[0]?.id,
			localPart: "leaving",
			expiresInDays: null,
		});

		await mail.db.prepare("DELETE FROM organization WHERE id = ?").bind(workspace?.id).run();

		const left = await mail.db
			.prepare(
				"SELECT (SELECT count(*) FROM mail_domain WHERE organization_id = ?1) + (SELECT count(*) FROM mailbox WHERE organization_id = ?1) AS rows",
			)
			.bind(workspace?.id)
			.first<{ rows: number }>();
		expect(left?.rows).toBe(0);
		await refused(`leaving@${domain}`);
	});

	it("keeps an ended address's name for 30 days, then lets it go", async () => {
		const { slug, domain, domainId, mailboxId } = await provedWorkspace();
		const add = () =>
			changed(slug, owner.headers, {
				action: "add-address",
				domainId,
				mailboxId,
				localPart: "again",
				expiresInDays: 1,
			});
		const day = 86_400_000;
		expect((await add()).ok).toBe(true);
		const end = (at: number) =>
			mail.db
				.prepare(
					"UPDATE mail_address SET expires_at = ? WHERE local_part = 'again' AND domain_id = ?",
				)
				.bind(at, domainId)
				.run();

		// It has ended, and it's still kept: nobody can have the name yet, and mail is refused.
		await end(Date.now() - day);
		await mail.runScheduled();
		await refused(`again@${domain}`);
		expect((await add()).status).toBe(409);

		// Past the 30 days the daily clean-up lets it go.
		await end(Date.now() - 31 * day);
		await mail.runScheduled();
		expect((await add()).ok).toBe(true);
	});

	it("leaves an address with no end alone", async () => {
		const { slug, domainId, mailboxId } = await provedWorkspace();
		await changed(slug, owner.headers, {
			action: "add-address",
			domainId,
			mailboxId,
			localPart: "forever",
			expiresInDays: null,
		});
		await mail.runScheduled();
		expect((await list(slug, owner.headers)).mailboxes[0]?.addresses).toHaveLength(1);
	});
});
