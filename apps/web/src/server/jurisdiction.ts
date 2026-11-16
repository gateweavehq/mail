import { env } from "cloudflare:workers";

// "Keeping data in one jurisdiction" in docs/self-hosting.md.

/** The jurisdictions Cloudflare can keep a Durable Object in. */
const JURISDICTIONS: readonly DurableObjectJurisdiction[] = ["eu", "us", "fedramp", "fedramp-high"];

function isJurisdiction(value: string): value is DurableObjectJurisdiction {
	return (JURISDICTIONS as readonly string[]).includes(value);
}

/**
 * The jurisdiction this deployment keeps its Durable Objects in, from
 * `DURABLE_OBJECT_JURISDICTION`, or null for none. A value Cloudflare doesn't know is an error,
 * not none: whoever set it asked for their data to stay somewhere.
 */
export function configuredJurisdiction(): DurableObjectJurisdiction | null {
	const value = env.DURABLE_OBJECT_JURISDICTION?.trim().toLowerCase();
	if (!value) return null;
	if (!isJurisdiction(value)) {
		throw new Error(
			`DURABLE_OBJECT_JURISDICTION is "${value}", which is none of ${JURISDICTIONS.join(", ")}`,
		);
	}
	return value;
}

/**
 * A namespace's objects in a jurisdiction, or outside any for null. The same name is another
 * object in each.
 */
export function objectsIn<T extends Rpc.DurableObjectBranded | undefined>(
	namespace: DurableObjectNamespace<T>,
	jurisdiction: string | null,
): DurableObjectNamespace<T> {
	if (!jurisdiction) return namespace;
	if (!isJurisdiction(jurisdiction)) throw new Error(`No jurisdiction "${jurisdiction}"`);
	return namespace.jurisdiction(jurisdiction);
}

/**
 * A namespace's objects where this deployment keeps them. Every id of a mailbox, a workspace's
 * webhooks or audience, or a rate limit is made from what this returns, never from the binding
 * itself: an id made from the binding names an object outside the jurisdiction, which would hold
 * mail there and be another, empty object than the one the rest of the Worker reaches.
 */
export function ownObjects<T extends Rpc.DurableObjectBranded | undefined>(
	namespace: DurableObjectNamespace<T>,
): DurableObjectNamespace<T> {
	return objectsIn(namespace, configuredJurisdiction());
}
