import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { DirectoryAction } from "#/server/directory/gateway";

/** Where a domain's MX records send its mail. */
export type MailRoute = "cloudflare" | "elsewhere" | "none";

export interface DirectoryDomain {
	id: string;
	name: string;
	verifiedAt: number | null;
	/** The TXT record that would prove it. Only for those who can act on it, and until it's proved. */
	proof: { name: string; value: string } | null;
}

export interface DirectoryAddress {
	id: string;
	address: string;
	expiresAt: number | null;
	/** False when someone else has since proved its domain, so mail to it is refused. */
	domainProved: boolean;
}

export interface DirectoryMailbox {
	id: string;
	name: string;
	addresses: DirectoryAddress[];
}

export interface Directory {
	domains: DirectoryDomain[];
	mailboxes: DirectoryMailbox[];
}

/** The workspace's domains and mailboxes, or null if the caller isn't in it. */
export const getDirectory = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }) => {
		const { currentMember } = await import("#/server/access");
		const member = await currentMember(slug);
		if (!member) return null;
		const { db } = await import("#/server/auth");
		const { listDirectory } = await import("#/server/directory");
		const { isAdminRole } = await import("#/lib/roles");
		const { workspaceId, role } = member.membership;
		return listDirectory(db, workspaceId, { admin: isAdminRole(role) });
	});

export type DirectoryAnswer<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Sends a change to the directory. What goes wrong comes back in words to show. */
export async function changeDirectory<T = object>(
	slug: string,
	action: DirectoryAction,
): Promise<DirectoryAnswer<T>> {
	try {
		const response = await fetch(`/api/directory/${encodeURIComponent(slug)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(action),
		});
		return (await response.json()) as DirectoryAnswer<T>;
	} catch {
		return { ok: false, error: "That didn't reach the server. Try again." };
	}
}
