/**
 * The address another zone sees for every Worker there is, anyone's: Cloudflare says so at
 * https://developers.cloudflare.com/fundamentals/reference/http-headers/, and on 2026-11-05 Gateweave
 * ID saw it for Track's Worker and for one on another zone alike. So a limit counted by it is one
 * limit for all of them, and any Worker could use up what a provider needs to deliver a logout, or
 * what Track needs to deliver an event to a trigger.
 */
const WORKERS_ADDRESS = "2a06:98c0:3600::103";

/** Nothing on the internet comes from here, so nobody's address is ever one of these. */
const MADE_UP = "fd";

/**
 * Who a limit should count a request against. A Worker is the zone it runs on, which Cloudflare sets
 * and a Worker cannot change, and on `workers.dev` that is its account's own subdomain. Anyone else
 * is their address: that header means nothing without the address, and anyone can send it.
 */
export function whoSentIt(request: Request): string {
	const address = request.headers.get("cf-connecting-ip") ?? "unknown";
	const zone = request.headers.get("cf-worker");
	return address === WORKERS_ADDRESS && zone ? `worker:${zone.toLowerCase()}` : address;
}

/** The same for Better Auth, which takes who a request is from as an address, and only that. */
export async function countedByWhoSentIt(request: Request): Promise<Request> {
	if (request.headers.get("cf-connecting-ip") !== WORKERS_ADDRESS) return request;
	const zone = request.headers.get("cf-worker");
	if (!zone) return request;
	const headers = new Headers(request.headers);
	headers.set("cf-connecting-ip", await addressOfZone(zone));
	return new Request(request, { headers });
}

/** Better Auth counts an IPv6 address by its first 64 bits, so those are what tell zones apart. */
async function addressOfZone(zone: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(zone.toLowerCase()),
	);
	const hex = Array.from(new Uint8Array(digest).subarray(0, 7), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${MADE_UP}${hex.slice(0, 2)}:${hex.slice(2, 6)}:${hex.slice(6, 10)}:${hex.slice(10)}::1`;
}
