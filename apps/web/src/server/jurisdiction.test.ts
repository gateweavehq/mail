import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { audienceStub } from "./audience";
import { configuredJurisdiction, objectsIn, ownObjects } from "./jurisdiction";
import { mailboxStub } from "./mailbox/store";
import { allowPasswordTry } from "./rate-limit";
import { webhooksStub } from "./webhooks";

// Where a deployment keeps its Durable Objects (DURABLE_OBJECT_JURISDICTION). Local workerd has
// no jurisdictions, so the namespaces here are stand-ins whose objects say which one they are in.

/** A stand-in's object: where it is and what it was named. */
interface Placed {
	where: string;
	name: string;
}

const { env, counted } = vi.hoisted(() => {
	const counted: { where: string; name: string }[] = [];
	function namespace(where = "none") {
		const object = (name: string) => ({
			where,
			name,
			consume: async () => {
				counted.push({ where, name });
				return { allowed: true, retryAfter: null };
			},
		});
		return {
			where,
			jurisdiction: (jurisdiction: string) => namespace(jurisdiction),
			getByName: object,
			idFromName: (name: string) => ({ name }),
			get: ({ name }: { name: string }) => object(name),
		};
	}
	const env = {
		DURABLE_OBJECT_JURISDICTION: undefined as string | undefined,
		MAILBOX: namespace(),
		WEBHOOKS: namespace(),
		AUDIENCE: namespace(),
		RATE_LIMITER: namespace(),
	};
	return { env, counted };
});

vi.mock("cloudflare:workers", () => ({
	env,
	DurableObject: class {},
	WorkerEntrypoint: class {},
	waitUntil: () => {},
}));

const placed = (stub: unknown) => stub as Placed;

/** Every object the Worker reaches by a name, as the places that make their ids reach them. */
async function everyObject() {
	counted.length = 0;
	await allowPasswordTry("someone");
	return {
		mailbox: placed(mailboxStub("a-mailbox")),
		webhooks: placed(webhooksStub("a-workspace")),
		audience: placed(audienceStub("a-workspace")),
		rateLimit: counted[0],
	};
}

beforeEach(() => {
	env.DURABLE_OBJECT_JURISDICTION = undefined;
});

describe("the deployment's jurisdiction", () => {
	it("is none when unset or blank", () => {
		expect(configuredJurisdiction()).toBeNull();
		env.DURABLE_OBJECT_JURISDICTION = " ";
		expect(configuredJurisdiction()).toBeNull();
	});

	it("is one of Cloudflare's, however it is written", () => {
		env.DURABLE_OBJECT_JURISDICTION = " EU ";
		expect(configuredJurisdiction()).toBe("eu");
	});

	it("refuses one Cloudflare doesn't have, rather than keeping data anywhere", () => {
		env.DURABLE_OBJECT_JURISDICTION = "de";
		expect(() => configuredJurisdiction()).toThrow('DURABLE_OBJECT_JURISDICTION is "de"');
		expect(() => ownObjects(env.MAILBOX as never)).toThrow('DURABLE_OBJECT_JURISDICTION is "de"');
	});
});

describe("a namespace's objects", () => {
	it("are the namespace's own outside any jurisdiction", () => {
		const objects = { jurisdiction: vi.fn() } as unknown as DurableObjectNamespace;
		expect(objectsIn(objects, null)).toBe(objects);
		expect(ownObjects(objects)).toBe(objects);
		expect(objects.jurisdiction).not.toHaveBeenCalled();
	});

	it("are the jurisdiction's in one", () => {
		const objects = env.MAILBOX as unknown as DurableObjectNamespace;
		expect(objectsIn(objects, "eu")).toMatchObject({ where: "eu" });
		expect(() => objectsIn(objects, "mars")).toThrow('No jurisdiction "mars"');
	});
});

describe("the objects the Worker reaches", () => {
	it("are the bindings' own without the setting, as they always were", async () => {
		expect(await everyObject()).toEqual({
			mailbox: expect.objectContaining({ where: "none", name: "a-mailbox" }),
			webhooks: expect.objectContaining({ where: "none", name: "a-workspace" }),
			audience: expect.objectContaining({ where: "none", name: "a-workspace" }),
			rateLimit: { where: "none", name: expect.stringMatching(/^[0-9a-f]{64}$/) },
		});
	});

	it("are all in the jurisdiction with it, under the same names", async () => {
		const outside = await everyObject();
		env.DURABLE_OBJECT_JURISDICTION = "eu";
		const inside = await everyObject();
		expect(inside).toEqual({
			mailbox: expect.objectContaining({ where: "eu", name: "a-mailbox" }),
			webhooks: expect.objectContaining({ where: "eu", name: "a-workspace" }),
			audience: expect.objectContaining({ where: "eu", name: "a-workspace" }),
			rateLimit: { where: "eu", name: outside.rateLimit?.name },
		});
	});
});

describe("every place that makes a Durable Object's id", () => {
	const server = import.meta.dirname;
	const BINDING = /\benv\.(MAILBOX|WEBHOOKS|AUDIENCE|RATE_LIMITER)\b/g;

	function sources(directory: string): string[] {
		return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return sources(path);
			return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
		});
	}

	it("takes its namespace through ownObjects, never from the binding itself", () => {
		// One id made from the binding would put that object outside the jurisdiction, and be
		// another, empty object than the one everything else reaches. A mailbox reaches its
		// workspace's webhooks from inside a Durable Object, which no test here can run.
		const uses: string[] = [];
		const bare: string[] = [];
		for (const path of sources(server)) {
			const text = readFileSync(path, "utf8");
			for (const match of text.matchAll(BINDING)) {
				const before = text.slice(0, match.index);
				const use = `${path.slice(server.length + 1).replaceAll("\\", "/")}: ${match[0]}`;
				uses.push(use);
				if (!/ownObjects\((this\.)?$/.test(before)) bare.push(use);
			}
		}
		expect(bare).toEqual([]);
		// The five there are. One more is fine, once it is here too.
		expect(uses.sort()).toEqual([
			"audience/index.ts: env.AUDIENCE",
			"mailbox/durable-object.ts: env.WEBHOOKS",
			"mailbox/store.ts: env.MAILBOX",
			"rate-limit/index.ts: env.RATE_LIMITER",
			"webhooks/index.ts: env.WEBHOOKS",
		]);
	});
});
