import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "./accounts";
import { agentWorld } from "./agent-world";

// The workspace's agents at a glance, on its home and at `/api/agents/<workspace>`, through the
// built Worker in workerd: each one with what it holds and what it did in the last day, counted
// from its log, for the workspace's owners and admins only.

const origin = "https://mail.test";
const HOUR = 60 * 60 * 1000;

const world = agentWorld(origin, "glance");
const { workspace, agentOf, auth } = world;

beforeAll(() => world.start());
afterAll(() => world.dispose());

type Space = Awaited<ReturnType<typeof workspace>>;

interface Glance {
	id: string;
	name: string;
	paused: { at: number; by: string | null } | null;
	liveAddresses: number;
	recent: { sent: number; held: number; reads: number };
	last: { at: number; action: string } | null;
	keyUsedAt: number | null;
}

const glanceUrl = (space: Space) => `${origin}/api/agents/${space.slug}`;

async function glance(space: Space): Promise<Glance[]> {
	const response = await world.mail.fetch(glanceUrl(space), { headers: world.owner.headers });
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	return ((await response.json()) as { agents: Glance[] }).agents;
}

/**
 * Entries written straight to an agent's log, each `[action, hours ago, by the agent]`, as of a
 * workspace's, which may be another than the agent's.
 */
async function logged(
	space: { workspaceId: string },
	agent: { memberId: string },
	entries: [action: string, hoursAgo: number, byAgent?: boolean][],
) {
	const now = Date.now();
	await world.mail.db.batch(
		entries.map(([action, hoursAgo, byAgent = true], n) =>
			world.mail.db
				.prepare(
					"INSERT INTO agent_log (id, organization_id, agent_member_id, by_agent, action, at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.bind(
					`glance-${crypto.randomUUID()}-${n}`,
					space.workspaceId,
					agent.memberId,
					byAgent ? 1 : 0,
					action,
					now - hoursAgo * HOUR,
				),
		),
	);
}

describe("the agents at a glance", () => {
	it("counts what each agent did in the last day, and says the last thing it did", async () => {
		const space = await workspace();
		// The last one made is the one given the mailbox.
		const idle = await agentOf(space);
		const trying = await agentOf(space);
		const busy = await agentOf(space);
		const elsewhere = await workspace();
		const theirs = await agentOf(elsewhere);

		await logged(space, busy, [
			["message.sent", 1],
			["message.sent", 23],
			["message.held", 2],
			["message.read", 3],
			["code.read", 3],
			["attachment.read", 4],
			["mail.searched", 5],
			// Too long ago to count.
			["message.sent", 25],
			["message.read", 30],
			// What people did isn't the agent's, however recent, whatever it says.
			["message.approved", 0.5, false],
			["policy.changed", 0.1, false],
			["message.sent", 0.2, false],
		]);
		// Entries of another workspace are its own, whoever's they say they are.
		await logged(elsewhere, busy, [
			["message.sent", 1],
			["message.read", 0.05],
		]);
		await logged(elsewhere, theirs, [
			["message.sent", 1],
			["message.held", 2],
		]);
		// And the agent does something with its key, which is now the last thing it did.
		const made = await world.mail.fetch(
			`${origin}/api/v1/mailboxes/${space.signUps.id}/addresses`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${busy.key}`, "content-type": "application/json" },
				body: JSON.stringify({ domain: space.domain, localPart: "glanced", days: 2 }),
			},
		);
		expect(made.status).toBe(200);
		expect((await auth("/agents/pause", { agentId: idle.id })).status).toBe(200);
		// A paused agent that keeps trying uses its key, which its log doesn't note.
		expect((await auth("/agents/pause", { agentId: trying.id })).status).toBe(200);
		const refused = await world.mail.fetch(`${origin}/api/v1/mailboxes`, {
			headers: { authorization: `Bearer ${trying.key}` },
		});
		expect(refused.status).toBe(403);

		const agents = await glance(space);
		expect(agents.map((agent) => agent.id).sort()).toEqual([busy.id, idle.id, trying.id].sort());
		const shown = agents.find((agent) => agent.id === busy.id);
		expect(shown).toMatchObject({
			paused: null,
			liveAddresses: 1,
			recent: { sent: 2, held: 1, reads: 4 },
			last: { action: "address.made" },
		});
		expect(Date.now() - (shown?.last?.at ?? 0)).toBeLessThan(60_000);
		const resting = agents.find((agent) => agent.id === idle.id);
		expect(resting).toMatchObject({
			paused: { by: "Owner" },
			liveAddresses: 0,
			recent: { sent: 0, held: 0, reads: 0 },
			// Pausing it was a person's doing.
			last: null,
			keyUsedAt: null,
		});
		const still = agents.find((agent) => agent.id === trying.id);
		expect(still).toMatchObject({ recent: { sent: 0, held: 0, reads: 0 }, last: null });
		expect(Date.now() - (still?.keyUsedAt ?? 0)).toBeLessThan(60_000);
		expect((await glance(elsewhere)).find((agent) => agent.id === theirs.id)).toMatchObject({
			recent: { sent: 1, held: 1, reads: 0 },
			last: { action: "message.sent" },
		});

		// The home shows them, from the server, before any script runs.
		const home = await world.mail.fetch(`${origin}/${space.slug}`, {
			headers: world.owner.headers,
		});
		expect(home.status).toBe(200);
		const html = (await home.text()).match(
			/<section aria-labelledby="agents-heading".*?<\/section>/s,
		);
		expect(html).not.toBeNull();
		expect(html?.[0]).toContain(`/${space.slug}/settings/agents/${busy.id}`);
		expect(html?.[0]).toContain("In the last day: 2 sent, 1 held for approval, 4 reads");
		expect(html?.[0]).toContain("Last made an address, just now");
		expect(html?.[0]).toContain("Hasn&#x27;t used its key yet");
		expect(html?.[0]).toContain("Used its key just now");
		// Its key was used as it made the address, which the log noted.
		expect(html?.[0]?.match(/Used its key/g)).toHaveLength(1);
		expect(html?.[0]?.match(/>Paused</g)).toHaveLength(2);
	});

	it("is shown to nobody but the workspace's owners and admins", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
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
			[
				"an owner's cookies with a key",
				{ ...world.owner.headers, authorization: `Bearer ${agent.key}` },
			],
			["nobody signed in", {}],
		] as const) {
			const response = await world.mail.fetch(glanceUrl(space), { headers });
			expect(response.status, who).toBe(404);
		}

		// A member's home has no agents on it.
		const home = await world.mail.fetch(`${origin}/${space.slug}`, { headers: member.headers });
		expect(home.status).toBe(200);
		const html = await home.text();
		expect(html).not.toContain('aria-label="Agents"');
		expect(html).not.toContain(agent.id);
	});
});
