import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "./accounts";
import { agentWorld } from "./agent-world";

// Templates through the built Worker in workerd: an owner or admin writes them in the workspace's
// Audience object, a member reads them, a member of another workspace sees nothing, and an agent
// lists and sends them over the agent API, through the same send as send_email.

const origin = "https://mail.test";

const world = agentWorld(origin, "tpl");
const { workspace, agentOf, auth, arrive } = world;

beforeAll(() => world.start());
afterAll(() => world.dispose());

interface Saved {
	ok: boolean;
	error?: string;
	template: {
		id: string;
		name: string;
		number: number;
		subject: string;
		body: string;
		variables: string[];
		madeBy: string | null;
	};
}

interface Space {
	slug: string;
	workspaceId: string;
}

const WELCOME = {
	name: "Welcome",
	subject: "Welcome to {{product}}, {{first_name}}",
	body: "Hi **{{first_name}}**,\n\n- your code is {{code}}\n- see [the docs](https://example.com/docs)",
	variables: ["product", "first_name", "code"],
};

type Headers = Record<string, string>;

/** Posts a change to a workspace's templates, as whoever these headers are. */
function change(
	space: Space,
	action: unknown,
	{ headers = world.owner.headers, from = origin }: { headers?: Headers; from?: string } = {},
) {
	return world.mail.fetch(`${origin}/api/templates/${space.slug}`, {
		method: "POST",
		headers: { ...headers, origin: from, "content-type": "application/json" },
		body: JSON.stringify(action),
	});
}

/** Saves a template, which must be accepted: a new one, or a new version of the one with `id`. */
async function save(
	space: Space,
	input: Record<string, unknown>,
	id: string | null = null,
	headers?: Headers,
): Promise<Saved["template"]> {
	const response = await change(space, { action: "save", id, input }, headers ? { headers } : {});
	const body = (await response.json()) as Saved;
	expect(body.error).toBeUndefined();
	expect(response.status).toBe(200);
	return body.template;
}

/** A refused change: its status and words. */
async function refusal(space: Space, action: unknown, options?: Parameters<typeof change>[2]) {
	const response = await change(space, action, options);
	const body = (await response.json()) as { ok: boolean; error: string };
	expect(body.ok).toBe(false);
	return { status: response.status, error: body.error };
}

const versionsOf = (space: Space, id: string, headers: Headers = world.owner.headers) =>
	world.mail.fetch(`${origin}/api/templates/${space.slug}?template=${id}`, { headers });

/** Someone new in the workspace, with this role. */
async function join(space: Space, role: string, name: string) {
	const person = await signUp(world.mail, origin, name);
	await world.mail.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(crypto.randomUUID(), space.workspaceId, person.userId, role, Date.now())
		.run();
	return person;
}

describe("who may write templates and who may read them", () => {
	it("are an owner's or admin's to write, and any member's to read", async () => {
		const space = await workspace();
		const made = await save(space, WELCOME);
		const member = await join(space, "member", "Reader");
		const admin = await join(space, "admin", "Writer");

		const input = { action: "save", id: null, input: { ...WELCOME, name: "By a member" } };
		expect(await refusal(space, input, { headers: member.headers })).toEqual({
			status: 403,
			error: "Only an owner or admin can change templates.",
		});
		expect(
			await refusal(space, { action: "remove", id: made.id }, { headers: member.headers }),
		).toEqual({ status: 403, error: "Only an owner or admin can change templates." });
		// Nothing changed.
		expect((await (await versionsOf(space, made.id)).json()) as { versions: unknown[] }).toEqual(
			expect.objectContaining({ versions: [expect.objectContaining({ number: 1 })] }),
		);

		// An admin writes, and the version says who.
		const second = await save(
			space,
			{ ...WELCOME, subject: "Hello {{first_name}} {{product}} {{code}}" },
			made.id,
			admin.headers,
		);
		expect(second.number).toBe(2);
		expect(second.madeBy).not.toBeNull();
		await save(space, { ...WELCOME, name: "By an admin" }, null, admin.headers);

		// A member reads what is there, on the page and as versions, which name who saved them.
		const page = await world.mail.fetch(`${origin}/${space.slug}/settings/templates`, {
			headers: member.headers,
		});
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("By an admin");
		expect(html).toContain(">Welcome<");
		// Without the buttons that write.
		expect(html).not.toContain("Add template");
		const read = (await (await versionsOf(space, made.id, member.headers)).json()) as {
			versions: { number: number; madeBy: string }[];
			people: Record<string, string>;
		};
		expect(read.versions.map((one) => one.number)).toEqual([2, 1]);
		expect(Object.values(read.people).sort()).toEqual(["Owner", "Writer"]);
		// The owner's page has them.
		const owners = await world.mail.fetch(`${origin}/${space.slug}/settings/templates`, {
			headers: world.owner.headers,
		});
		expect(await owners.text()).toContain("Add template");
	});

	it("show nothing to a member of another workspace, as for one that isn't there", async () => {
		const space = await workspace();
		const other = await workspace();
		const made = await save(space, WELCOME);
		const stranger = await signUp(world.mail, origin, "Stranger");
		const input = { action: "save", id: null, input: WELCOME };

		expect((await refusal(space, input, { headers: stranger.headers })).status).toBe(404);
		expect(
			(await refusal(space, { action: "remove", id: made.id }, { headers: stranger.headers }))
				.status,
		).toBe(404);
		expect((await versionsOf(space, made.id, stranger.headers)).status).toBe(404);
		// The same as a workspace that doesn't exist, and a template of another workspace.
		const nowhere = await world.mail.fetch(`${origin}/api/templates/no-such-workspace?template=x`, {
			headers: stranger.headers,
		});
		expect(nowhere.status).toBe(404);
		expect(await nowhere.json()).toEqual({ ok: false, error: "Not found" });
		expect((await versionsOf(other, made.id)).status).toBe(404);
		expect((await refusal(other, { action: "remove", id: made.id })).status).toBe(404);
		// Still there in its own workspace, and not in the other.
		expect((await versionsOf(space, made.id)).status).toBe(200);
		// A change from another site is refused whoever it is signed in as.
		expect((await refusal(space, input, { from: "https://elsewhere.example" })).status).toBe(403);
	});
});

describe("what templates keep", () => {
	it("numbers each saving, never changes one, and keeps a name once in any case", async () => {
		const space = await workspace();
		const first = await save(space, WELCOME);
		expect(first).toMatchObject({ number: 1, name: "Welcome", variables: WELCOME.variables });
		const again = await save(
			space,
			{ ...WELCOME, body: "Changed {{first_name}} {{product}} {{code}}" },
			first.id,
		);
		expect(again).toMatchObject({ id: first.id, number: 2 });

		const versions = (await (await versionsOf(space, first.id)).json()) as {
			versions: { number: number; body: string }[];
		};
		expect(versions.versions.map((one) => one.number)).toEqual([2, 1]);
		expect(versions.versions[1]?.body).toBe(WELCOME.body);

		// The name is taken in any case, by another template, and when one is renamed to it.
		for (const name of ["welcome", "WELCOME", "  Welcome "]) {
			expect(
				await refusal(space, { action: "save", id: null, input: { ...WELCOME, name } }),
			).toEqual({
				status: 409,
				error: 'A template called "Welcome" exists.',
			});
		}
		const second = await save(space, { ...WELCOME, name: "Receipt" });
		expect(
			(
				await refusal(space, {
					action: "save",
					id: second.id,
					input: { ...WELCOME, name: "WELCOME" },
				})
			).status,
		).toBe(409);
		// A template's own name, in another case, is a rename.
		expect(await save(space, { ...WELCOME, name: "WELCOME" }, first.id)).toMatchObject({
			name: "WELCOME",
			number: 3,
		});
		// Changing one that isn't there.
		expect(
			(await refusal(space, { action: "save", id: "no-such-id", input: WELCOME })).status,
		).toBe(404);
	});

	it("refuses what can't be a template, saying why", async () => {
		const space = await workspace();
		const save400 = (input: Record<string, unknown>) =>
			refusal(space, { action: "save", id: null, input: { ...WELCOME, ...input } });
		expect(await save400({ variables: ["product", "first_name"] })).toMatchObject({
			status: 400,
			error: expect.stringContaining("{{code}} is used but isn't declared"),
		});
		expect(await save400({ variables: [...WELCOME.variables, "extra"] })).toMatchObject({
			status: 400,
			error: expect.stringContaining("extra is declared but never used"),
		});
		expect(
			await save400({ body: "[{{code}}](https://example.com) {{product}} {{first_name}}" }),
		).toMatchObject({
			status: 400,
			error: expect.stringContaining("can't be in a link"),
		});
		expect(await save400({ subject: "Hi {{code}}\nBcc: a@b.example" })).toMatchObject({
			status: 400,
		});
		expect((await refusal(space, { action: "save", id: null, input: "nope" })).status).toBe(400);
		expect((await refusal(space, { action: "start" })).status).toBe(400);
	});

	it("keeps 200 live templates, and a removed one doesn't count and may be named again", {
		timeout: 120_000,
	}, async () => {
		const space = await workspace();
		const small = (n: number) => ({
			name: `Template ${n}`,
			subject: "Hi",
			body: "Hello",
			variables: [],
		});
		const made: string[] = [];
		for (let at = 0; at < 200; at += 20) {
			const batch = await Promise.all(
				Array.from({ length: 20 }, (_, n) => save(space, small(at + n))),
			);
			made.push(...batch.map((one) => one.id));
		}
		expect(new Set(made).size).toBe(200);
		expect(await refusal(space, { action: "save", id: null, input: small(200) })).toEqual({
			status: 409,
			error: "A workspace can have at most 200 templates.",
		});
		// A new version of one that is there isn't a new template.
		expect(await save(space, small(7), made[7] ?? "")).toMatchObject({ number: 2 });

		// Removing is soft: the template is gone from view and its place and name are free.
		const gone = made[3] ?? "";
		expect(await (await change(space, { action: "remove", id: gone })).json()).toEqual({
			ok: true,
		});
		expect((await versionsOf(space, gone)).status).toBe(404);
		expect(await refusal(space, { action: "remove", id: gone })).toEqual({
			status: 404,
			error: "No such template.",
		});
		expect((await refusal(space, { action: "save", id: gone, input: small(3) })).status).toBe(404);
		const again = await save(space, small(3));
		expect(again).toMatchObject({ name: "Template 3", number: 1 });
		expect(again.id).not.toBe(gone);
		expect(await refusal(space, { action: "save", id: null, input: small(201) })).toMatchObject({
			status: 409,
		});

		// What was removed is still kept, for a backup to see.
		const dump = await world.mail.backup<{ n: number; live: number }[][]>(
			"read",
			`audience.${space.workspaceId}`,
			[
				"SELECT count(*) AS n, count(removed_at) AS removed FROM template",
				"SELECT count(*) AS n FROM template_version",
			],
		);
		expect(dump.result).toEqual([[{ n: 201, removed: 1 }], [{ n: 202 }]]);
	});

	it("is read by Gateweave Backup as an object of its own, as webhooks are", async () => {
		const space = await workspace();
		await save(space, WELCOME);
		const listed = await world.mail.backup<{ names: string[] }>("objects");
		// Paged, so the object may be on a later page than the first.
		let names = listed.result?.names ?? [];
		let cursor = (listed.result as { cursor?: string } | undefined)?.cursor;
		while (!names.includes(`audience.${space.workspaceId}`) && cursor) {
			const next = await world.mail.backup<{ names: string[]; cursor?: string }>("objects", cursor);
			names = names.concat(next.result?.names ?? []);
			cursor = next.result?.cursor;
		}
		expect(names).toContain(`audience.${space.workspaceId}`);
		const dump = await world.mail.backup<{ name: string; number: number }[][]>(
			"read",
			`audience.${space.workspaceId}`,
			[
				"SELECT name FROM template",
				"SELECT number, subject FROM template_version",
				"DELETE FROM template",
			],
		);
		// Only reads get in.
		expect(dump.error).toMatch(/^The object refused the backup's read\. /);
		const reads = await world.mail.backup<unknown[][]>("read", `audience.${space.workspaceId}`, [
			"SELECT name FROM template",
			"SELECT number, subject FROM template_version",
		]);
		expect(reads.result).toEqual([
			[{ name: "Welcome" }],
			[{ number: 1, subject: WELCOME.subject }],
		]);
		// A workspace that isn't there is never woken.
		expect(
			await world.mail.backup("read", "audience.no-such-workspace", ["SELECT 1 AS one"]),
		).toEqual({
			result: null,
		});
	});
});

/** Asks the agent API with a key. */
async function rest(key: string, method: string, path: string, data: object = {}) {
	const url = new URL(`${origin}/api/v1${path}`);
	const json = method === "POST";
	if (!json) {
		for (const [name, value] of Object.entries(data)) url.searchParams.set(name, String(value));
	}
	const response = await world.mail.fetch(url.href, {
		method,
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		...(json ? { body: JSON.stringify(data) } : {}),
	});
	return {
		status: response.status,
		headers: response.headers,
		body: (await response.json()) as Record<string, unknown>,
	};
}

const SAMPLE = { product: "Gateweave", first_name: "Ann", code: "4821" };

describe("sending a template as an agent", () => {
	it("refuses a rendered template to an unknown recipient under never", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		await save(space, WELCOME);
		const answer = await rest(
			agent.key,
			"POST",
			`/mailboxes/${space.signUps.id}/template-messages`,
			{
				template: "Welcome",
				values: SAMPLE,
				to: ["elsewhere@example.net"],
			},
		);
		expect(answer.status).toBe(403);
		expect(answer.body.error).toContain("elsewhere@example.net");
	});

	it("R6: lists templates and sends the rendered message with the agent disclosure", {
		timeout: 60_000,
	}, async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const domain = `${space.slug}.example.org`;
		expect(
			(
				await auth("/agents/set-policy", {
					agentId: agent.id,
					sendPerDay: 20,
					allowed: [`@${domain}`],
				})
			).status,
		).toBe(200);
		const made = await save(space, WELCOME);
		await save(
			space,
			{ ...WELCOME, subject: "Hello {{first_name}} {{product}} {{code}}" },
			made.id,
		);
		await save(space, { name: "Plain", subject: "Note", body: "Just words.", variables: [] });

		const listed = await rest(agent.key, "GET", "/templates");
		expect(listed.status).toBe(200);
		expect(listed.body).toEqual({
			templates: [
				{ name: "Plain", variables: [], version: 1, subject: "Note" },
				{
					name: "Welcome",
					variables: WELCOME.variables,
					version: 2,
					subject: "Hello {{first_name}} {{product}} {{code}}",
				},
			],
		});
		expect(JSON.stringify(listed.body)).not.toContain("your code is");

		const box = `/mailboxes/${space.signUps.id}/template-messages`;
		// The hostile value can't add a tag, a link or a list, in the HTML or in the text.
		const hostile = '<script>alert(1)</script> [pay](https://evil.example) **x** & "q"';
		const sent = await rest(agent.key, "POST", box, {
			template: "welcome",
			version: 1,
			values: { ...SAMPLE, first_name: hostile },
			to: [`ada@${domain}`],
		});
		expect(sent.body.error).toBeUndefined();
		expect(sent.body).toMatchObject({ state: "sent", template: "Welcome", version: 1 });
		const latest = await rest(agent.key, "POST", box, {
			template: "Welcome",
			values: SAMPLE,
			to: [`bo@${domain}`],
		});
		expect(latest.body).toMatchObject({ state: "sent", template: "Welcome", version: 2 });

		const emails = await world.mail.emails();
		const toAda = emails.find((email) => email.to.includes(`ada@${domain}`));
		expect(toAda?.headers?.["X-AI-Disclosure"]).toBe("mode=machine-generated");
		expect(toAda?.text).toMatch(/^This message was written by an AI agent \(Signer \d+\)\.\n\n/);
		expect(toAda?.html).toMatch(
			/^<p [^>]+>This message was written by an AI agent \(Signer \d+\)\.<\/p>/,
		);
		expect(toAda?.subject).toBe(`Welcome to Gateweave, ${hostile}`);
		expect(toAda?.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(toAda?.html).toContain("**x**");
		expect(toAda?.html).not.toContain("<script");
		expect(toAda?.html).not.toMatch(/<a [^>]*evil/);
		expect(toAda?.html).toContain('<a href="https://example.com/docs">the docs</a>');
		expect(toAda?.text).not.toContain("<strong>");
		const toBo = emails.find((email) => email.to.includes(`bo@${domain}`));
		expect(toBo?.subject).toBe("Hello Ann Gateweave 4821");
		expect(toBo?.html).toContain("<p>Hi <strong>Ann</strong>,</p>");
		expect(toBo?.html).toContain("<li>your code is 4821</li>");
		expect(toBo?.text).toContain("Hi Ann");
		expect(toBo?.text).toContain("your code is 4821");

		// What the mailbox keeps is the same message.
		const opened = (await (
			await world.mail.fetch(
				`${origin}/api/mail/${space.slug}/${space.signUps.id}/${String(latest.body.id)}`,
				{
					headers: world.owner.headers,
				},
			)
		).json()) as {
			subject: string;
			text: string;
			hasHtml: boolean;
			sent: { status: { state: string } };
		};
		expect(opened).toMatchObject({ subject: "Hello Ann Gateweave 4821", hasHtml: true });
		expect(opened.text).toContain("your code is 4821");

		// A message with no formatting goes as text alone.
		const plain = await rest(agent.key, "POST", box, {
			template: "Plain",
			values: {},
			to: [`cy@${domain}`],
		});
		expect(plain.body).toMatchObject({ state: "sent", version: 1 });
		const toCy = (await world.mail.emails()).find((email) => email.to.includes(`cy@${domain}`));
		expect(toCy).toMatchObject({
			subject: "Note",
			text: expect.stringMatching(
				/^This message was written by an AI agent \(Signer \d+\)\.\n\nJust words\.$/,
			),
			headers: expect.objectContaining({ "X-AI-Disclosure": "mode=machine-generated" }),
		});
		expect(toCy?.html).toBeUndefined();
	});

	it("refuses what can't be rendered before anything is sent or counted", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const domain = `${space.slug}.example.org`;
		await auth("/agents/set-policy", { agentId: agent.id, sendPerDay: 2, allowed: [`@${domain}`] });
		await save(space, WELCOME);
		const box = `/mailboxes/${space.signUps.id}/template-messages`;
		const ask = (body: object) =>
			rest(agent.key, "POST", box, { template: "Welcome", to: [`ada@${domain}`], ...body });
		const asked = async (body: object) => {
			const answer = await ask(body);
			return { status: answer.status, error: String(answer.body.error ?? "") };
		};
		expect(await asked({ values: { product: "x", first_name: "y" } })).toEqual({
			status: 400,
			error: "No value for code.",
		});
		expect(await asked({ values: { ...SAMPLE, extra: "z" } })).toEqual({
			status: 400,
			error: "extra: this template has no such variable.",
		});
		expect((await asked({ values: { ...SAMPLE, code: "a\nb" } })).status).toBe(400);
		expect((await asked({ values: { ...SAMPLE, first_name: "x".repeat(2001) } })).status).toBe(400);
		expect((await asked({ values: { ...SAMPLE, first_name: 7 } })).status).toBe(400);
		expect(await asked({ template: "Nothing", values: SAMPLE })).toEqual({
			status: 404,
			error: 'No template "Nothing". See list_templates.',
		});
		expect(await asked({ version: 9, values: SAMPLE })).toEqual({
			status: 404,
			error: 'No template "Welcome" at version 9. See list_templates.',
		});
		// None of those used up its two messages a day.
		expect((await ask({ values: SAMPLE })).body).toMatchObject({ state: "sent" });
		expect((await ask({ values: SAMPLE })).body).toMatchObject({ state: "sent" });
		expect((await ask({ values: SAMPLE })).status).toBe(429);
	});

	it("R5/R6: holds an unlisted template send, counts it, and preserves disclosure on approval", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		await auth("/agents/set-policy", {
			agentId: agent.id,
			sendPerDay: 2,
			allowed: [`@${space.slug}.example.org`],
		});
		await save(space, WELCOME);
		const box = `/mailboxes/${space.signUps.id}/template-messages`;
		const stranger = `stranger-${space.slug}@elsewhere.example.net`;
		const held = await rest(agent.key, "POST", box, {
			template: "Welcome",
			values: SAMPLE,
			to: [stranger],
		});
		expect(held.body).toMatchObject({ state: "held", template: "Welcome", version: 1 });
		expect((await world.mail.emails()).some((email) => email.to.includes(stranger))).toBe(false);
		// Held counts against the day, as it does for send_email.
		const second = await rest(agent.key, "POST", box, {
			template: "Welcome",
			values: SAMPLE,
			to: [stranger],
		});
		expect(second.body).toMatchObject({ state: "held" });
		const third = await rest(agent.key, "POST", box, {
			template: "Welcome",
			values: SAMPLE,
			to: [stranger],
		});
		expect(third.status).toBe(429);
		// The owner sees it waiting, with the subject as rendered, and approving sends that.
		const approved = await world.mail.fetch(
			`${origin}/api/mail/${space.slug}/${space.signUps.id}/outbox`,
			{
				method: "POST",
				headers: { ...world.owner.headers, origin, "content-type": "application/json" },
				body: JSON.stringify({ action: "approve", message: String(held.body.id) }),
			},
		);
		expect(approved.status).toBe(200);
		const out = (await world.mail.emails()).find((email) => email.to.includes(stranger));
		expect(out?.subject).toBe("Welcome to Gateweave, Ann");
		expect(out?.headers?.["X-AI-Disclosure"]).toBe("mode=ai-originated");
		expect(out?.text).toMatch(/^This message was written by an AI agent \(Signer \d+\)\.\n\n/);
		expect(out?.html).toMatch(
			/^<p [^>]+>This message was written by an AI agent \(Signer \d+\)\.<\/p>/,
		);
	});

	it("is refused for a recipient on the suppression list, as send_email is", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const domain = `${space.slug}.example.org`;
		await auth("/agents/set-policy", { agentId: agent.id, sendPerDay: 5, allowed: [`@${domain}`] });
		await save(space, WELCOME);
		const blocked = `blocked@${domain}`;
		await world.mail.db
			.prepare(
				"INSERT INTO mail_suppression (id, organization_id, address, reason, provider, first_at, last_at) VALUES (?, ?, ?, 'bounced', 'cloudflare', ?, ?)",
			)
			.bind(crypto.randomUUID(), space.workspaceId, blocked, Date.now(), Date.now())
			.run();
		const refused = await rest(
			agent.key,
			"POST",
			`/mailboxes/${space.signUps.id}/template-messages`,
			{
				template: "Welcome",
				values: SAMPLE,
				to: [blocked],
			},
		);
		expect(refused.status).toBe(409);
		expect(String(refused.body.error)).toContain(blocked);
		expect((await world.mail.emails()).some((email) => email.to.includes(blocked))).toBe(false);
	});

	it("is for a mailbox the agent may send from, and not while it is paused or without a key", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const domain = `${space.slug}.example.org`;
		await auth("/agents/set-policy", { agentId: agent.id, sendPerDay: 5, allowed: [`@${domain}`] });
		await save(space, WELCOME);
		const body = { template: "Welcome", values: SAMPLE, to: [`ada@${domain}`] };
		// The billing mailbox wasn't given to it.
		expect(
			(await rest(agent.key, "POST", `/mailboxes/${space.billing.id}/template-messages`, body))
				.status,
		).toBe(404);
		const noKey = await world.mail.fetch(`${origin}/api/v1/templates`, {
			headers: world.owner.headers,
		});
		expect(noKey.status).toBe(401);
		// Another workspace's agent sees none of this workspace's templates.
		const other = await workspace();
		const stranger = await agentOf(other);
		expect((await rest(stranger.key, "GET", "/templates")).body).toEqual({ templates: [] });
		expect(
			(await rest(stranger.key, "POST", `/mailboxes/${other.signUps.id}/template-messages`, body))
				.status,
		).toBe(404);
		await arrive(space.signUps.address);
	});
});

/** How many live templates, and versions, the workspace's object holds, as a backup reads them. */
async function held(space: Space) {
	const dump = await world.mail.backup<{ live: number; versions: number }[][]>(
		"read",
		`audience.${space.workspaceId}`,
		[
			"SELECT count(*) AS live FROM template WHERE removed_at IS NULL",
			"SELECT count(*) AS versions FROM template_version",
		],
	);
	return { live: dump.result?.[0]?.[0]?.live, versions: dump.result?.[1]?.[0]?.versions };
}

describe("what the review asked to be held", () => {
	it("keeps at most 100 versions of a template, and refuses another without changing anything", {
		timeout: 120_000,
	}, async () => {
		const space = await workspace();
		const made = await save(space, WELCOME);
		for (let n = 2; n <= 100; n++) {
			expect((await save(space, WELCOME, made.id)).number).toBe(n);
		}
		const past = { action: "save", id: made.id, input: { ...WELCOME, name: "Renamed" } };
		expect(await refusal(space, past)).toEqual({
			status: 409,
			error: "A template can have at most 100 versions. Make a new template instead.",
		});
		// Nothing pruned and nothing renamed.
		expect(await held(space)).toEqual({ live: 1, versions: 100 });
		const read = (await (await versionsOf(space, made.id)).json()) as {
			versions: { number: number }[];
		};
		expect(read.versions).toHaveLength(100);
		expect(read.versions[0]?.number).toBe(100);
		expect(await refusal(space, { action: "save", id: null, input: WELCOME })).toMatchObject({
			status: 409,
			error: 'A template called "Welcome" exists.',
		});
	});

	it("ends with exactly 200 when two saves race for the last place", {
		timeout: 120_000,
	}, async () => {
		const space = await workspace();
		const small = (n: number) => ({
			name: `Racer ${n}`,
			subject: "Hi",
			body: "Hello",
			variables: [],
		});
		for (let at = 0; at < 190; at += 19) {
			await Promise.all(Array.from({ length: 19 }, (_, n) => save(space, small(at + n))));
		}
		await Promise.all(Array.from({ length: 9 }, (_, n) => save(space, small(1000 + n))));
		expect((await held(space)).live).toBe(199);
		const raced = await Promise.all(
			[small(2000), small(2001)].map((input) => change(space, { action: "save", id: null, input })),
		);
		expect(raced.map((response) => response.status).sort()).toEqual([200, 409]);
		expect((await held(space)).live).toBe(200);
	});

	it("refuses a change from another site, and a member's, saving nothing", async () => {
		const space = await workspace();
		const member = await join(space, "member", "Plain");
		const input = { action: "save", id: null, input: WELCOME };
		expect(await refusal(space, input, { from: "https://elsewhere.example" })).toEqual({
			status: 403,
			error: "Not allowed from there.",
		});
		// No Origin at all is as foreign as a wrong one.
		const bare = await world.mail.fetch(`${origin}/api/templates/${space.slug}`, {
			method: "POST",
			headers: { ...world.owner.headers, origin: "", "content-type": "application/json" },
			body: JSON.stringify(input),
		});
		expect(bare.status).toBe(403);
		expect(await refusal(space, input, { headers: member.headers })).toMatchObject({
			status: 403,
		});
		expect((await held(space)).live).toBe(0);
	});

	it("gives an agent of another workspace the refusal a missing template gets", async () => {
		const space = await workspace();
		const other = await workspace();
		await save(space, { ...WELCOME, name: "Only here" });
		const stranger = await agentOf(other);
		const domain = `${other.slug}.example.org`;
		await auth("/agents/set-policy", {
			agentId: stranger.id,
			sendPerDay: 5,
			allowed: [`@${domain}`],
		});
		const box = `/mailboxes/${other.signUps.id}/template-messages`;
		const ask = async (template: string) => {
			const answer = await rest(stranger.key, "POST", box, {
				template,
				values: SAMPLE,
				to: [`ada@${domain}`],
			});
			return { status: answer.status, error: String(answer.body.error) };
		};
		const theirs = await ask("Only here");
		expect(theirs.status).toBe(404);
		expect(theirs.error).toBe('No template "Only here". See list_templates.');
		expect({ ...(await ask("No such template")), error: "" }).toEqual({ ...theirs, error: "" });
		expect((await world.mail.emails()).some((email) => email.to.includes(`ada@${domain}`))).toBe(
			false,
		);
	});

	it("empties the object when the workspace is deleted", async () => {
		const space = await workspace();
		await save(space, WELCOME);
		await save(space, { ...WELCOME, name: "Second" });
		expect((await held(space)).live).toBe(2);
		const deleted = await auth("/organization/delete", { organizationId: space.workspaceId });
		expect(deleted.status).toBe(200);
		// A workspace with the same id again, only so that a backup may read the object: it is
		// listed for none that D1 doesn't have.
		await world.mail.db
			.prepare("INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, 0)")
			.bind(space.workspaceId, "again", `${space.slug}-again`)
			.run();
		// Emptied in the background once the deletion answered.
		const deadline = Date.now() + 10_000;
		let now = await held(space);
		while (now.live !== 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			now = await held(space);
		}
		expect(now).toEqual({ live: 0, versions: 0 });
	});

	it("names the template and its version in the agent's log, sent or held", {
		timeout: 60_000,
	}, async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const domain = `${space.slug}.example.org`;
		await auth("/agents/set-policy", {
			agentId: agent.id,
			sendPerDay: 5,
			allowed: [`@${domain}`],
		});
		const made = await save(space, WELCOME);
		await save(space, WELCOME, made.id);
		const box = `/mailboxes/${space.signUps.id}/template-messages`;
		const stranger = `someone-${space.slug}@elsewhere.example.net`;
		const sent = await rest(agent.key, "POST", box, {
			template: "Welcome",
			values: SAMPLE,
			to: [`ada@${domain}`],
		});
		const held = await rest(agent.key, "POST", box, {
			template: "Welcome",
			version: 1,
			values: SAMPLE,
			to: [stranger],
		});
		expect(sent.body.state).toBe("sent");
		expect(held.body.state).toBe("held");
		const log = (await (
			await world.mail.fetch(`${origin}/api/agents/${space.slug}/${agent.id}/log?kind=mail`, {
				headers: world.owner.headers,
			})
		).json()) as { entries: { action: string; target: string | null; detail: string | null }[] };
		const entry = (id: unknown) => log.entries.find((one) => one.target === String(id));
		expect(entry(sent.body.id)).toMatchObject({
			action: "message.sent",
			detail: `template Welcome, version 2: ada@${domain}`,
		});
		expect(entry(held.body.id)).toMatchObject({
			action: "message.held",
			detail: `template Welcome, version 1: ${stranger}`,
		});
	});
});
