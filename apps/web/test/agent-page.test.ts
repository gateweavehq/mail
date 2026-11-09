import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "./accounts";
import { agentWorld } from "./agent-world";

// An agent's page, through the built Worker in workerd: what it wrote, what of that waits for a
// person, and what came to the addresses it made, for the workspace's owners and admins only.

const origin = "https://mail.test";

const world = agentWorld(origin, "page");
const { workspace, agentOf, auth, arrive } = world;

beforeAll(() => world.start());
afterAll(() => world.dispose());

type Space = Awaited<ReturnType<typeof workspace>>;

interface Listed {
	subject: string;
	mailbox: { id: string; name: string };
	to: string[];
	sent: { status: { state: string } | null } | null;
}

interface Activity {
	agent: { id: string; name: string };
	mailboxes: { id: string; name: string; send: boolean }[];
	addresses: { address: string; mailbox: { id: string }; expiresAt: number | null }[];
	held: Listed[];
	wrote: Listed[];
	received: Listed[];
}

const page = (space: Space, agentId: string, headers: Record<string, string>) =>
	world.mail.fetch(`${origin}/api/agents/${space.slug}/${agentId}`, { headers });

/** Asks the agent API with its key. */
async function rest(key: string, path: string, data: Record<string, unknown>) {
	const response = await world.mail.fetch(`${origin}/api/v1${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify(data),
	});
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("an agent's page", () => {
	it("shows an owner what it wrote, what waits, and what came to the addresses it made", {
		timeout: 60_000,
	}, async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const domain = `${space.slug}.example.org`;
		const policy = await auth("/agents/set-policy", {
			agentId: agent.id,
			sendPerDay: 20,
			allowed: [`@${domain}`],
		});
		expect(policy.status).toBe(200);
		const box = `/mailboxes/${space.signUps.id}`;
		const sent = await rest(agent.key, `${box}/messages`, {
			to: [`ada@${domain}`],
			cc: [`bo@${domain}`],
			subject: "Its own",
			text: "Hello.",
		});
		expect(sent.body).toMatchObject({ state: "sent" });
		const held = await rest(agent.key, `${box}/messages`, {
			to: [`cy@elsewhere-${space.slug}.example.org`],
			subject: "Waits for a person",
			text: "Hello.",
		});
		expect(held.body).toMatchObject({ state: "held" });
		const made = await rest(agent.key, `${box}/addresses`, {
			domain: space.domain,
			localPart: "page-agent",
			days: 2,
		});
		expect(made.status).toBe(200);

		// Mail to its address is its; mail to the mailbox's own address, and what a person sent, aren't.
		await arrive(`page-agent@${space.domain}`, { subject: "For the agent" });
		await arrive(space.signUps.address, { subject: "For the mailbox" });
		const byOwner = await world.mail.fetch(
			`${origin}/api/mail/${space.slug}/${space.signUps.id}/outbox`,
			{
				method: "POST",
				headers: { ...world.owner.headers, origin, "content-type": "application/json" },
				body: JSON.stringify({
					action: "send",
					draft: crypto.randomUUID(),
					to: [`dee@${domain}`],
					subject: "From a person",
					text: "Hello.",
				}),
			},
		);
		expect(byOwner.status).toBe(200);

		const response = await page(space, agent.id, world.owner.headers);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const activity = (await response.json()) as Activity;
		expect(activity.agent.id).toBe(agent.id);
		expect(activity.mailboxes).toEqual([
			{ id: space.signUps.id, name: space.signUps.name, send: true },
		]);
		expect(activity.addresses).toEqual([
			{
				address: `page-agent@${space.domain}`,
				mailbox: { id: space.signUps.id, name: space.signUps.name },
				expiresAt: expect.any(Number),
			},
		]);
		expect(activity.wrote.map((one) => one.subject).sort()).toEqual([
			"Its own",
			"Waits for a person",
		]);
		expect(activity.wrote.find((one) => one.subject === "Its own")).toMatchObject({
			mailbox: { id: space.signUps.id },
			to: [`ada@${domain}`, `bo@${domain}`],
			sent: { status: { state: "sent" } },
		});
		expect(activity.held.map((one) => one.subject)).toEqual(["Waits for a person"]);
		expect(activity.received.map((one) => one.subject)).toEqual(["For the agent"]);
		expect(activity.received[0]?.to).toEqual([`page-agent@${space.domain}`]);

		// Once a person approves it, it no longer waits, and stays among what it wrote.
		const approved = await world.mail.fetch(
			`${origin}/api/mail/${space.slug}/${space.signUps.id}/outbox`,
			{
				method: "POST",
				headers: { ...world.owner.headers, origin, "content-type": "application/json" },
				body: JSON.stringify({ action: "approve", message: held.body.id }),
			},
		);
		expect(await approved.json()).toMatchObject({ ok: true });
		const after = (await (await page(space, agent.id, world.owner.headers)).json()) as Activity;
		expect(after.held).toEqual([]);
		expect(after.wrote).toHaveLength(2);

		// Once its grant goes, what it wrote there stays on its page, though it reads the mailbox no more.
		const taken = await world.directory(space.slug, {
			action: "set-mailbox-access",
			mailboxId: space.signUps.id,
			everyone: false,
			memberIds: [],
			senderIds: [],
		});
		expect(taken.ok).toBe(true);
		const ungranted = (await (await page(space, agent.id, world.owner.headers)).json()) as Activity;
		expect(ungranted.mailboxes).toEqual([]);
		expect(ungranted.wrote).toHaveLength(2);
		expect(ungranted.received.map((one) => one.subject)).toEqual(["For the agent"]);
	});

	it("counts mail to the mailbox's address and its own at once as its, whichever copy comes first", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const made = await rest(agent.key, `/mailboxes/${space.signUps.id}/addresses`, {
			domain: space.domain,
			localPart: "both-at-once",
			days: 2,
		});
		expect(made.status).toBe(200);
		// Email Routing hands each recipient its own copy of the same mail.
		const theirs = `both-at-once@${space.domain}`;
		const messageId = `${crypto.randomUUID()}@shop.example`;
		await arrive(space.signUps.address, { subject: "To both", messageId });
		await arrive(theirs, { subject: "To both", messageId });

		const activity = (await (await page(space, agent.id, world.owner.headers)).json()) as Activity;
		expect(activity.received).toHaveLength(1);
		expect(activity.received[0]).toMatchObject({ subject: "To both" });
		expect(activity.received[0]?.to.sort()).toEqual([space.signUps.address, theirs].sort());

		// The mailbox keeps the one copy, which says it came to both.
		const threads = await world.mail.fetch(`${origin}/api/mail/${space.slug}/${space.signUps.id}`, {
			headers: world.owner.headers,
		});
		const listed = (await threads.json()) as { messages: { subject: string; cameTo: string[] }[] };
		const copies = listed.messages.filter((one) => one.subject === "To both");
		expect(copies).toHaveLength(1);
		expect(copies[0]?.cameTo.sort()).toEqual([space.signUps.address, theirs].sort());
	});

	it("is shown to nobody but the workspace's owners and admins", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const other = await workspace();
		const theirs = await agentOf(other);

		const member = await signUp(world.mail, origin, "Member");
		await world.mail.db
			.prepare(
				"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(crypto.randomUUID(), space.workspaceId, member.userId, "member", Date.now())
			.run();
		const stranger = await signUp(world.mail, origin, "Stranger");

		for (const [who, headers] of [
			["a member", member.headers],
			["someone outside", stranger.headers],
			["the agent itself", { authorization: `Bearer ${agent.key}` }],
			// A key makes the request the key's, whatever cookies come with it.
			[
				"an owner's cookies with a key",
				{
					...world.owner.headers,
					authorization: `Bearer ${agent.key}`,
				},
			],
			["nobody signed in", {}],
		] as const) {
			const response = await page(space, agent.id, headers);
			expect(response.status, who).toBe(404);
		}
		// An agent of another workspace is as missing as one that never was.
		expect((await page(space, theirs.id, world.owner.headers)).status).toBe(404);
		expect((await page(space, "no-such-agent", world.owner.headers)).status).toBe(404);
		expect((await page(space, agent.id, world.owner.headers)).status).toBe(200);
	});
});
