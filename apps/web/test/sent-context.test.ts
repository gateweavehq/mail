import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWorld } from "./agent-world";

// What a message was written for, as its writer says, through the built Worker in workerd: given
// with send_email or reply over the agent API, kept with the message, shown on the message, the
// agent's page and its log as the writer's words, and never put in the mail.

const origin = "https://mail.test";

const world = agentWorld(origin, "context");
const { workspace, agentOf, auth, arrive } = world;

beforeAll(() => world.start());
afterAll(() => world.dispose());

interface Context {
	url: string;
	label: string | null;
}

/** Asks the agent API with a key, a GET's input in its query. */
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
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Asks the app's own API as the owner, signed in. */
async function asOwner(path: string) {
	const response = await world.mail.fetch(`${origin}${path}`, { headers: world.owner.headers });
	expect(response.status, path).toBe(200);
	return response;
}

describe("what a message was written for", () => {
	it("is kept and shown as its writer's words, and never goes into the mail", {
		timeout: 60_000,
	}, async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const domain = `${space.slug}.example.org`;
		expect(
			(
				await auth("/agents/set-policy", {
					agentId: agent.id,
					// As many as it sends below, so a refusal that counted would leave one unsent.
					sendPerDay: 3,
					allowed: [`@${domain}`],
				})
			).status,
		).toBe(200);
		const box = `/mailboxes/${space.signUps.id}`;
		const context = { url: "https://ci.example.org/acme/app/runs/7?attempt=2", label: "CI run 7" };

		// Refused unless it is an https link, before anything is sent or counted.
		for (const url of [
			"http://ci.example.org/runs/7",
			"javascript:alert(1)",
			"https://a:b@ci.example.org/",
		]) {
			const refused = await rest(agent.key, "POST", `${box}/messages`, {
				to: [`ada@${domain}`],
				subject: "Refused",
				text: "Hello.",
				context: { url },
			});
			expect(refused.status, url).toBe(400);
			expect(String(refused.body.error), url).toMatch(/^The context's url /);
		}

		const sent = await rest(agent.key, "POST", `${box}/messages`, {
			to: [`ada@${domain}`],
			subject: "The build is green",
			text: "Hello.",
			context,
		});
		expect(sent.body).toMatchObject({ state: "sent" });
		const id = String(sent.body.id);
		const threadId = String(sent.body.threadId);

		// A reply may say what it is for too, with a link alone, and a label of null as webhooks give.
		await arrive(space.signUps.address, { subject: "Your code", body: "Code: 482913" });
		const code = await rest(agent.key, "GET", "/verification-code", {
			to: space.signUps.address,
			from: "shop.example",
			timeoutSeconds: 0,
		});
		const answered = String(code.body.messageId);
		const reply = await rest(agent.key, "POST", `${box}/messages/${answered}/reply`, {
			text: "Thanks.",
			context: { url: "https://track.example.org/acme/issue/ENG-42", label: null },
		});
		expect(reply.status).toBe(200);

		// The message, as people open it.
		const opened = (await (
			await asOwner(`/api/mail/${space.slug}/${space.signUps.id}/${id}`)
		).json()) as { sent: { context: Context | null } };
		expect(opened.sent.context).toEqual(context);
		const repliedWith = (await (
			await asOwner(`/api/mail/${space.slug}/${space.signUps.id}/${String(reply.body.id)}`)
		).json()) as { sent: { context: Context | null } };
		expect(repliedWith.sent.context).toEqual({
			url: "https://track.example.org/acme/issue/ENG-42",
			label: null,
		});

		// Its thread's page says whose words they are, with the link's host beside its label.
		// Without the markers React leaves between pieces of text.
		const html = (
			await (
				await asOwner(`/${space.slug}/mailboxes/${space.signUps.id}/threads/${threadId}`)
			).text()
		).replaceAll("<!-- -->", "");
		const line = html.match(/Its writer said it is for <a [^>]*>.*?<\/a>[^<]*/s)?.[0] ?? "";
		expect(line).toContain('href="https://ci.example.org/acme/app/runs/7?attempt=2"');
		expect(line).toContain('target="_blank" rel="noopener noreferrer nofollow"');
		expect(line).toContain(">CI run 7<");
		expect(line).toMatch(/<\/a> \(ci\.example\.org\)\.$/);

		// Never in the mail itself.
		const raw = await (
			await asOwner(`/api/mail/${space.slug}/${space.signUps.id}/${id}/original`)
		).text();
		expect(raw).toContain("The build is green");
		expect(raw).not.toContain("ci.example.org");
		expect(raw).not.toContain("CI run 7");

		// The agent's page and its log.
		const activity = (await (await asOwner(`/api/agents/${space.slug}/${agent.id}`)).json()) as {
			wrote: { id: string; sent: { context: Context | null } }[];
		};
		expect(activity.wrote.find((one) => one.id === id)?.sent.context).toEqual(context);
		const log = (await (
			await asOwner(`/api/agents/${space.slug}/${agent.id}/log?kind=mail`)
		).json()) as { entries: { action: string; target: string | null; context: Context | null }[] };
		expect(log.entries.find((entry) => entry.target === id)).toMatchObject({
			action: "message.sent",
			context,
		});
		// Mail written without one says nothing of it.
		const plain = await rest(agent.key, "POST", `${box}/messages`, {
			to: [`bo@${domain}`],
			subject: "No context",
			text: "Hello.",
		});
		expect(plain.body).toMatchObject({ state: "sent" });
		const plainOpened = (await (
			await asOwner(`/api/mail/${space.slug}/${space.signUps.id}/${String(plain.body.id)}`)
		).json()) as { sent: { context: Context | null } };
		expect(plainOpened.sent.context).toBeNull();

		// Nor in anything given to Email Service.
		const handed = JSON.stringify(await world.mail.emails());
		expect(handed).toContain("The build is green");
		expect(handed).toContain("No context");
		for (const said of ["ci.example.org", "CI run 7", "track.example.org"]) {
			expect(handed).not.toContain(said);
		}
	});
});
