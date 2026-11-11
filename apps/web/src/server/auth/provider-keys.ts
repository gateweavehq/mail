import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	freshSessionMiddleware,
	sessionMiddleware,
} from "better-auth/api";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { KEYED_PROVIDERS } from "../../lib/providers";
import { isAdminRole } from "../../lib/roles";
import type { Database } from "../db";
import { schema } from "../db";
import {
	openProviderKey,
	providerKeyInfo,
	removeProviderKey,
	saveProviderKey,
} from "../providers/keys";
import { checkResendKey, RESEND_API } from "../providers/resend";
import { isSealer, sealerFor } from "../secrets";
import type { SecretsKeySettings } from "../secrets-key";
import { toRole } from "../workspaces";

/**
 * A workspace's keys for mail providers, which owners and admins keep: for now one Resend key, for
 * domains that send through Resend. A key is checked with Resend before it is kept, kept sealed
 * (`providers/keys.ts`), and never sent back: pages see its last four characters.
 */

export interface ProviderSettings {
	/**
	 * The deployment's `SECRETS_KEY`, which seals the keys, and `SECRETS_KEY_PREVIOUS`. Without the
	 * first none can be added.
	 */
	secrets?: SecretsKeySettings | undefined;
	/** Resend's API, when it isn't Resend's own. */
	resendApi?: string | undefined;
	/**
	 * Sees to what the workspace's domains need of the new key, as the webhook in its Resend
	 * account. What the key can't do, if anything.
	 */
	afterKeySet?: ((workspaceId: string) => Promise<string | null>) | undefined;
}

const id = z.string().min(1).max(64);
const provider = z.enum(KEYED_PROVIDERS);
/** A Resend key as Resend gives one out. */
const resendKey = z
	.string()
	.trim()
	.regex(
		/^re_[A-Za-z0-9_-]{8,200}$/,
		"That doesn't look like a Resend key, which starts with re_.",
	);

export const SET_PROVIDER_KEY = "/providers/set-key";
export const CHECK_PROVIDER_KEY = "/providers/check-key";

export function providerKeys({ db, settings }: { db: Database; settings: ProviderSettings }) {
	const { member } = schema;
	const api = settings.resendApi || RESEND_API;

	async function requireAdmin(organizationId: string, userId: string) {
		const row = await db
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
			.get();
		if (!row || !isAdminRole(toRole(row.role))) {
			throw new APIError("FORBIDDEN", {
				message: "Only the workspace's owners and admins can manage its keys",
			});
		}
	}

	return {
		id: "provider-keys",
		endpoints: {
			getProviderKey: createAuthEndpoint(
				"/providers/key",
				{
					method: "GET",
					query: z.object({ organizationId: id, provider }),
					use: [sessionMiddleware],
				},
				async (ctx) => {
					const { organizationId } = ctx.query;
					await requireAdmin(organizationId, ctx.context.session.user.id);
					const sealer = await sealerFor(settings.secrets ?? {}, organizationId);
					return ctx.json({
						unavailable: isSealer(sealer) ? null : sealer.unavailable,
						key: await providerKeyInfo(db, organizationId, ctx.query.provider),
					});
				},
			),

			setProviderKey: createAuthEndpoint(
				SET_PROVIDER_KEY,
				{
					method: "POST",
					body: z.object({ organizationId: id, provider, key: resendKey }),
					// The key sends mail as the workspace's domains, so putting one in, which could be the
					// taker's own account, takes a recent sign-in: a stolen cookie can't.
					use: [freshSessionMiddleware],
				},
				async (ctx) => {
					const { organizationId, key } = ctx.body;
					const userId = ctx.context.session.user.id;
					await requireAdmin(organizationId, userId);
					const sealer = await sealerFor(settings.secrets ?? {}, organizationId);
					if (!isSealer(sealer)) throw new APIError("BAD_REQUEST", { message: sealer.unavailable });
					const check = await checkResendKey(api, key);
					if (!check.ok) throw new APIError("BAD_REQUEST", { message: check.error });
					const saved = await saveProviderKey(db, settings.secrets ?? {}, {
						workspaceId: organizationId,
						provider: ctx.body.provider,
						key,
						addedBy: userId,
					});
					if (!saved.ok) throw new APIError("BAD_REQUEST", { message: saved.error });
					const note = (await settings.afterKeySet?.(organizationId)) ?? null;
					return ctx.json({ key: saved.info, access: check.access, note });
				},
			),

			checkProviderKey: createAuthEndpoint(
				CHECK_PROVIDER_KEY,
				{
					method: "POST",
					body: z.object({ organizationId: id, provider }),
					use: [sessionMiddleware],
				},
				async (ctx) => {
					const { organizationId } = ctx.body;
					await requireAdmin(organizationId, ctx.context.session.user.id);
					const opened = await openProviderKey(
						db,
						settings.secrets ?? {},
						organizationId,
						ctx.body.provider,
					);
					if (!opened.ok) {
						throw new APIError("BAD_REQUEST", {
							message:
								opened.code === "no_key"
									? "This workspace has no Resend key."
									: "The key can't be read on this server any more, as when its SECRETS_KEY changes. Add it again.",
						});
					}
					const check = await checkResendKey(api, opened.key);
					if (!check.ok) throw new APIError("BAD_REQUEST", { message: check.error });
					return ctx.json({ access: check.access });
				},
			),

			removeProviderKey: createAuthEndpoint(
				"/providers/remove-key",
				{
					method: "POST",
					body: z.object({ organizationId: id, provider }),
					// Taking a key away stops mail rather than sending it anywhere, as revoking an agent's
					// key does, so a session is enough.
					use: [sessionMiddleware],
				},
				async (ctx) => {
					const { organizationId } = ctx.body;
					await requireAdmin(organizationId, ctx.context.session.user.id);
					const removed = await removeProviderKey(db, organizationId, ctx.body.provider);
					return ctx.json({ removed });
				},
			),
		},
		// Each of these asks Resend, so they get fewer tries than other paths.
		rateLimit: [
			{ pathMatcher: (path) => path === SET_PROVIDER_KEY, window: 60, max: 10 },
			{ pathMatcher: (path) => path === CHECK_PROVIDER_KEY, window: 60, max: 10 },
		],
	} satisfies BetterAuthPlugin;
}
