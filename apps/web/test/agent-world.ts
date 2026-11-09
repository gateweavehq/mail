import { expect } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startMail } from "./mail-worker";

/** Cloudflare's own headers, as Email Routing puts them above a message, with its DMARC verdict. */
const fromCloudflare = (domain: string, dmarc: string) => [
	`Received: from mail.${domain} (mail.${domain} [192.0.2.1]) by cloudflare-email.net (unknown) id ABC for <x@example.com>; Sun, 08 Nov 2026 09:00:00 +0000`,
	"ARC-Seal: i=1; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=none; b=abc",
	`ARC-Authentication-Results: i=1; mx.cloudflare.net; dmarc=${dmarc}`,
	`Received-SPF: pass (mx.cloudflare.net: domain of noreply@${domain} designates 192.0.2.1 as permitted sender)`,
	`Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${domain}; dmarc=${dmarc} header.from=${domain}; spf=pass`,
	"X-CF-SpamH-Score: 1",
];

/**
 * The built Worker with an owner, and what tests of an agent's access need around it: workspaces
 * of their own with a proved domain and two mailboxes, agents given one of them, and mail that
 * arrives. `prefix` names the workspaces and domains, so each file's are its own.
 */
export function agentWorld(origin: string, prefix: string) {
	const proofs = new Map<string, string>();
	let mail: Awaited<ReturnType<typeof startMail>> | undefined;
	let owner: Awaited<ReturnType<typeof signUp>> | undefined;
	let counter = 0;

	const started = () => {
		if (!mail || !owner) throw new Error("start() the world first");
		return { mail, owner };
	};

	function dns(request: Request): Response {
		const url = new URL(request.url);
		const value = proofs.get(url.searchParams.get("name") ?? "");
		if (!value || url.searchParams.get("type") !== "TXT") return Response.json({ Status: 3 });
		return Response.json({
			Status: 0,
			Answer: [{ name: url.searchParams.get("name"), type: 16, data: `"${value}"` }],
		});
	}

	async function directory(slug: string, action?: unknown) {
		const { mail, owner } = started();
		const response = await mail.fetch(`${origin}/api/directory/${slug}`, {
			method: action ? "POST" : "GET",
			headers: { ...owner.headers, origin, "content-type": "application/json" },
			...(action ? { body: JSON.stringify(action) } : {}),
		});
		expect(response.status).toBe(200);
		return (await response.json()) as {
			ok?: boolean;
			proved?: boolean;
			domains: { id: string; name: string; proof: { value: string } | null }[];
			mailboxes: { id: string; name: string }[];
		};
	}

	/** A workspace of its own, with a proved domain and two mailboxes with an address each. */
	async function workspace() {
		const { mail, owner } = started();
		const n = ++counter;
		const slug = `${prefix}-${n}`;
		const domain = `${prefix}${n}.example.com`;
		const workspaceId = await createWorkspace(
			mail,
			origin,
			{ ...owner.headers, "cf-connecting-ip": `198.51.100.${n}` },
			slug,
		);
		await directory(slug, { action: "add-domain", name: domain });
		const [added] = (await directory(slug)).domains;
		if (!added?.proof) throw new Error("expected a proof");
		proofs.set(`_gateweave-mail.${domain}`, added.proof.value);
		expect((await directory(slug, { action: "check-domain", id: added.id })).proved).toBe(true);
		const mailbox = async (name: string, localPart: string) => {
			await directory(slug, { action: "add-mailbox", name });
			const made = (await directory(slug)).mailboxes.find((box) => box.name === name);
			if (!made) throw new Error("expected a mailbox");
			await directory(slug, {
				action: "add-address",
				domainId: added.id,
				mailboxId: made.id,
				localPart,
				expiresInDays: null,
			});
			return { id: made.id, name, address: `${localPart}@${domain}` };
		};
		return {
			slug,
			workspaceId,
			domain,
			signUps: await mailbox(`Sign-ups ${n}`, "signups"),
			billing: await mailbox(`Billing ${n}`, "billing"),
		};
	}

	type Workspace = Awaited<ReturnType<typeof workspace>>;

	/** Asks Better Auth's agents plugin, as the owner. */
	function auth(path: string, body: unknown) {
		const { mail, owner } = started();
		return mail.fetch(`${origin}/api/auth${path}`, {
			method: "POST",
			headers: { ...owner.headers, origin, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	/**
	 * An agent of the workspace, given its sign-ups mailbox and let send from it and make addresses
	 * on its domain, with its key.
	 */
	async function agentOf(space: Workspace) {
		const { mail, owner } = started();
		const response = await mail.fetch(`${origin}/api/auth/agents/create`, {
			method: "POST",
			headers: {
				...owner.headers,
				origin,
				"content-type": "application/json",
				// From an address of its own each time, as making agents is limited to a few a minute.
				"cf-connecting-ip": `192.0.2.${++counter % 250}`,
			},
			body: JSON.stringify({ organizationId: space.workspaceId, name: `Signer ${counter}` }),
		});
		expect(response.status).toBe(200);
		const { agent, key } = (await response.json()) as {
			agent: { id: string; memberId: string };
			key: string;
		};
		const access = await directory(space.slug, {
			action: "set-mailbox-access",
			mailboxId: space.signUps.id,
			everyone: false,
			memberIds: [agent.memberId],
			senderIds: [agent.memberId],
		});
		expect(access.ok).toBe(true);
		const limits = await auth("/agents/set-address-policy", {
			agentId: agent.id,
			maxLive: 3,
			maxDays: 7,
			domains: [space.domain],
		});
		expect(limits.status).toBe(200);
		return { ...agent, key };
	}

	/** Revokes an agent's key, as the owner. */
	async function revokeKey(space: Workspace, agentId: string) {
		const { mail, owner } = started();
		const agents = (await (
			await mail.fetch(`${origin}/api/auth/agents/list?organizationId=${space.workspaceId}`, {
				headers: owner.headers,
			})
		).json()) as { id: string; keys: { id: string }[] }[];
		const keyId = agents.find((one) => one.id === agentId)?.keys[0]?.id;
		expect((await auth("/agents/revoke-key", { keyId })).status).toBe(200);
	}

	/** Mail that arrives, as Email Routing hands it to the Worker. */
	async function arrive(
		to: string,
		{
			from = "noreply@shop.example",
			subject = "Hello",
			body = "Hello there.",
			dmarc = "pass",
			messageId = `${crypto.randomUUID()}@${from.slice(from.indexOf("@") + 1)}`,
		}: { from?: string; subject?: string; body?: string; dmarc?: string; messageId?: string } = {},
	) {
		const { mail } = started();
		const domain = from.slice(from.indexOf("@") + 1);
		const raw = [
			...fromCloudflare(domain, dmarc),
			`From: Shop <${from}>`,
			`To: ${to}`,
			`Subject: ${subject}`,
			"Date: Mon, 09 Nov 2026 09:00:00 +0000",
			`Message-ID: <${messageId}>`,
			"",
			body,
			"",
		].join("\r\n");
		const answer = await mail.deliver(from, to, raw);
		expect(answer.status).toBe(200);
	}

	return {
		/** Starts the Worker, with handlers for more hosts it may reach, such as a webhook's. */
		async start(hosts: Record<string, (request: Request) => Response | Promise<Response>> = {}) {
			mail = await startMail(origin, { hosts: { ...hosts, "cloudflare-dns.com": dns } });
			owner = await signUp(mail, origin, "Owner");
		},
		async dispose() {
			await mail?.dispose();
		},
		get mail() {
			return started().mail;
		},
		get owner() {
			return started().owner;
		},
		directory,
		workspace,
		auth,
		agentOf,
		revokeKey,
		arrive,
	};
}
