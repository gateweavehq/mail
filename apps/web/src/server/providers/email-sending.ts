import { z } from "zod";

/**
 * Email Service's own suppression list, through Cloudflare's API with a token the deployment may
 * have (`EMAIL_SENDING_API_TOKEN`, with Email Sending: Edit, for `EMAIL_SENDING_ACCOUNT_ID`).
 *
 * The list is the deployment's account's, which every workspace's domains share. So Mail only takes
 * off what one workspace may decide: an entry Cloudflare made after a bounce or a complaint, for one
 * of that workspace's own proved domains. An entry for the whole account, one someone added by hand,
 * Cloudflare's own (`policy`) and any it marks `read_only` stay, as do other domains' entries,
 * which Mail doesn't mention.
 */

const API = "https://api.cloudflare.com/client/v4";

/** How long one call to Cloudflare's API may take. */
const TIMEOUT_MS = 10_000;

/** The reasons Cloudflare gives the entries it makes itself, from delivery. */
const CLEARABLE = new Set(["complaint", "hard_bounce", "soft_bounce"]);

export interface EmailSendingApi {
	accountId: string;
	token: string;
}

/** The deployment's access to its Email Sending list, or null when it hasn't given Mail any. */
export function emailSendingApi(env: {
	EMAIL_SENDING_ACCOUNT_ID?: string | undefined;
	EMAIL_SENDING_API_TOKEN?: string | undefined;
}): EmailSendingApi | null {
	const accountId = env.EMAIL_SENDING_ACCOUNT_ID?.trim().toLowerCase();
	const token = env.EMAIL_SENDING_API_TOKEN?.trim();
	if (!accountId || !token || !/^[a-f0-9]{32}$/.test(accountId)) return null;
	return { accountId, token };
}

const Entry = z.object({
	id: z.string().min(1).max(100),
	email: z.string().max(1_000),
	reason: z.string().max(100),
	read_only: z.boolean(),
	scope: z
		.object({ type: z.string().max(100), value: z.string().max(1_024).optional() })
		.optional(),
});

const Listed = z.object({
	success: z.literal(true),
	result: z.array(z.unknown()).max(1_000),
	result_info: z
		.object({ next_cursor: z.string().min(1).max(2_048).nullable().optional() })
		.optional(),
});

/**
 * The most pages read for one address. It has at most an entry for the account and one for each
 * sending domain, but a large account's scan may answer with short pages before the last.
 */
const MAX_PAGES = 5;

/** What Email Service's list did with an address. */
export type EmailSendingUnlisting =
	| {
			outcome: "done";
			/** How many of the workspace's entries came off. */
			removed: number;
			/** How many still stop its mail, which only whoever runs the deployment can change. */
			kept: number;
	  }
	| { outcome: "failed"; failure: string };

async function request(api: EmailSendingApi, method: string, path: string): Promise<Response> {
	return fetch(`${API}/accounts/${api.accountId}/email/sending/suppressions${path}`, {
		method,
		headers: { authorization: `Bearer ${api.token}` },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
}

/**
 * Takes the address off Email Service's list for the workspace's own domains, where Cloudflare put
 * it, and counts what stays that still stops the workspace's mail. `domains` are the workspace's
 * proved domains, in lower case. Never throws; a failure names an HTTP status or what went wrong,
 * never the address.
 */
export async function clearEmailSendingSuppressions(
	api: EmailSendingApi,
	address: string,
	domains: ReadonlySet<string>,
): Promise<EmailSendingUnlisting> {
	// By id, as a page may repeat one of the page before.
	const entries = new Map<string, z.infer<typeof Entry>>();
	let cursor: string | null = null;
	try {
		for (let page = 0; ; page++) {
			if (page === MAX_PAGES) return { outcome: "failed", failure: "list: too long" };
			const query = new URLSearchParams({ email: address, per_page: "100" });
			if (cursor) query.set("cursor", cursor);
			const response = await request(api, "GET", `?${query}`);
			if (!response.ok) {
				await response.body?.cancel();
				return { outcome: "failed", failure: `list: ${response.status}` };
			}
			const listed = Listed.safeParse(await response.json());
			if (!listed.success) return { outcome: "failed", failure: "list: unreadable" };
			for (const one of listed.data.result) {
				const entry = Entry.safeParse(one);
				if (entry.success && entry.data.email.trim().toLowerCase() === address) {
					entries.set(entry.data.id, entry.data);
				}
			}
			cursor = listed.data.result_info?.next_cursor ?? null;
			if (!cursor) break;
		}
	} catch {
		return { outcome: "failed", failure: "list: unreachable" };
	}

	const ours = (entry: z.infer<typeof Entry>) =>
		entry.scope?.type === "sending_domain" &&
		domains.has((entry.scope.value ?? "").toLowerCase().replace(/\.$/, ""));
	// What stops this workspace's mail: entries for the whole account, or for one of its domains.
	const stopping = [...entries.values()].filter(
		(entry) => entry.scope?.type === "account" || ours(entry),
	);
	let removed = 0;
	let kept = 0;
	for (const entry of stopping) {
		if (!ours(entry) || entry.read_only || !CLEARABLE.has(entry.reason)) {
			kept++;
			continue;
		}
		try {
			const response = await request(api, "DELETE", `/${encodeURIComponent(entry.id)}`);
			await response.body?.cancel();
			// 404: gone meanwhile, as it ended or someone else removed it.
			if (response.ok || response.status === 404) removed++;
			else if (response.status === 409 || response.status === 403) {
				// 403 is a read-only entry, or a token that may only read the list.
				console.warn("email-sending: an entry stayed", { status: response.status });
				kept++;
			} else return { outcome: "failed", failure: `delete: ${response.status}` };
		} catch {
			return { outcome: "failed", failure: "delete: unreachable" };
		}
	}
	return { outcome: "done", removed, kept };
}
