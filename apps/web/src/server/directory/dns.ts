export const DEFAULT_DNS_RESOLVER = "https://cloudflare-dns.com/dns-query";

const TIMEOUT_MS = 5_000;
const TXT = 16;
const MX = 15;

export interface DomainRecords {
	/** The TXT records at the name that holds a domain's proof. */
	proof: string[];
	/** The hosts its mail goes to, lower case with no trailing dot. */
	mailHosts: string[];
}

export type LookUpDomain = (domain: string) => Promise<DomainRecords>;

/** Where a domain keeps the proof that whoever added it here runs it. */
export function proofName(domain: string): string {
	return `_gateweave-mail.${domain}`;
}

interface DnsJson {
	Status: number;
	Answer?: { type: number; data: string }[];
}

/** A TXT record comes quoted and may be in several parts, which DNS means to be read as one. */
function textOf(data: string): string {
	const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? "");
	return parts.length ? parts.join("") : data;
}

/** `10 route1.mx.cloudflare.net.` becomes `route1.mx.cloudflare.net`. */
function hostOf(data: string): string {
	return (data.trim().split(/\s+/).at(-1) ?? "").toLowerCase().replace(/\.$/, "");
}

/**
 * Asks a DNS-over-HTTPS resolver about a domain. Throws when it can't say, which is different from
 * saying a name has no records: a domain's proof must not look absent because a resolver was down.
 */
export function dnsLookup(
	resolver: string,
	send: typeof fetch = (input, init) => fetch(input, init),
): LookUpDomain {
	async function ask(name: string, type: number): Promise<string[]> {
		const url = new URL(resolver);
		url.searchParams.set("name", name);
		url.searchParams.set("type", type === TXT ? "TXT" : "MX");
		const response = await send(url, {
			headers: { accept: "application/dns-json" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`The DNS resolver answered ${response.status}`);
		const answer = (await response.json()) as DnsJson;
		// 3 is "no such name", which is an answer. Anything else but 0 means the resolver can't tell.
		if (answer.Status === 3) return [];
		if (answer.Status !== 0) throw new Error(`The DNS resolver answered status ${answer.Status}`);
		return (answer.Answer ?? []).filter((record) => record.type === type).map((r) => r.data);
	}

	return async (domain) => {
		const [proof, mail] = await Promise.all([ask(proofName(domain), TXT), ask(domain, MX)]);
		// `0 .` leaves no host: it is how a domain says it takes no mail at all (RFC 7505).
		return { proof: proof.map(textOf), mailHosts: mail.map(hostOf).filter(Boolean) };
	};
}
