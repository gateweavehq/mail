import { and, eq, isNotNull } from "drizzle-orm";
import type { ProviderUnlisting } from "../../lib/suppressions";
import type { Database } from "../db";
import { schema } from "../db";
import { clearEmailSendingSuppressions, type EmailSendingApi } from "../providers/email-sending";
import { openProviderKey } from "../providers/keys";
import { removeResendSuppression } from "../providers/resend";

/** What Mail may reach of the providers' own lists. */
export interface ProviderLists {
	secretsKey: string | undefined;
	resendApi: string;
	/** Null when the deployment gave Mail no token for Email Service's list. */
	emailSending: EmailSendingApi | null;
}

/** Which providers' lists can stop the workspace's mail, from how its proved domains send. */
export interface ListsToClear {
	resend: boolean;
	/** The proved domains, when one sends with Email Service; null when none does. */
	emailService: ReadonlySet<string> | null;
}

/**
 * Reads which providers' lists can stop the workspace's mail. Read before the entry comes off, so
 * that a failure here leaves the list as it was.
 */
export async function listsToClear(db: Database, workspaceId: string): Promise<ListsToClear> {
	const { mailDomain } = schema;
	const domains = await db
		.select({ name: mailDomain.name, sendsWith: mailDomain.sendsWith })
		.from(mailDomain)
		.where(and(eq(mailDomain.organizationId, workspaceId), isNotNull(mailDomain.verifiedAt)))
		.all();
	return {
		resend: domains.some((domain) => domain.sendsWith === "resend"),
		emailService: domains.some((domain) => domain.sendsWith === "cloudflare")
			? new Set(domains.map((domain) => domain.name))
			: null,
	};
}

/**
 * Takes an address an owner or admin removed from the workspace's list off the providers' own
 * lists too, which would still stop the mail: Resend's, with the workspace's key, as that list
 * holds for the key's whole account; and Email Service's, for the workspace's own proved domains,
 * with the deployment's token. Both at once. What each did, for the page to say. Never throws, as
 * the entry is off already. The log names what failed, never the address.
 */
export async function unlistAtProviders(
	db: Database,
	workspaceId: string,
	address: string,
	clear: ListsToClear,
	lists: ProviderLists,
): Promise<ProviderUnlisting[]> {
	const resend = async (): Promise<ProviderUnlisting[]> => {
		if (!clear.resend) return [];
		try {
			const opened = await openProviderKey(db, lists.secretsKey, workspaceId, "resend");
			// Without a key nothing goes through Resend, and its list can't be reached.
			if (!opened.ok) return [];
			const outcome = await removeResendSuppression(lists.resendApi, opened.key, address);
			if (outcome === "failed") console.error("suppressions: Resend's list not changed");
			return [{ provider: "resend", outcome }];
		} catch {
			console.error("suppressions: Resend's list not changed", { failure: "key" });
			return [{ provider: "resend", outcome: "failed" }];
		}
	};
	const emailService = async (): Promise<ProviderUnlisting[]> => {
		if (!clear.emailService) return [];
		if (!lists.emailSending) return [{ provider: "cloudflare", outcome: "notSetUp" }];
		const cleared = await clearEmailSendingSuppressions(
			lists.emailSending,
			address,
			clear.emailService,
		);
		if (cleared.outcome === "failed") {
			console.error("suppressions: Email Service's list not changed", {
				failure: cleared.failure,
			});
			return [{ provider: "cloudflare", outcome: "failed" }];
		}
		return [{ provider: "cloudflare", ...cleared }];
	};
	return (await Promise.all([resend(), emailService()])).flat();
}
