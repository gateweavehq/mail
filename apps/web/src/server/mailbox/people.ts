import { type Address, addressParser, decodeWords } from "postal-mime";
import type { Person } from "../../lib/mailbox";

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
