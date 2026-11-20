import { type Address, addressParser, decodeWords } from "postal-mime";
import { normalTarget } from "../../lib/agent-policy";
import type { Person } from "../../lib/mailbox";
import { MAX_KEPT_HEADER } from "./headers";

/** A header as people read it. A word that won't decode is left as sent. */
export function decoded(value: string | null): string {
	if (!value) return "";
	try {
		return decodeWords(value);
	} catch {
		return value;
	}
}

export function people(addresses: Address[] | undefined): Person[] {
	const found: Person[] = [];
	for (const address of addresses ?? []) {
		if (address.group) found.push(...address.group);
		else found.push({ name: address.name, address: address.address });
	}
	return found;
}

/** The first person a From header names. */
export function sender(value: string | null): Person | null {
	if (!value) return null;
	try {
		return people(addressParser(value))[0] ?? null;
	} catch {
		return { name: decoded(value), address: "" };
	}
}

/** A shortened From can end in a different, still valid address. */
export const receivedFromKeptHeader = (value: string | null) =>
	value !== null && value.length < MAX_KEPT_HEADER ? receivedFrom(value) : null;

/** Only an actual sender address can become a destination for the agent. */
export function receivedFrom(value: string | null): string | null {
	if (!value) return null;
	try {
		const parsed = addressParser(value);
		const [only] = parsed;
		return parsed.length === 1 && only?.address && !only.group ? normalTarget(only.address) : null;
	} catch {
		return null;
	}
}
