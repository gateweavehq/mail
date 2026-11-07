import type { Account, GenericEndpointContext, Session } from "better-auth";
import { createAuthEndpoint, NO_STORE_HEADERS } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { and, eq } from "drizzle-orm";
import { decodeJwt, errors, jwtVerify } from "jose";
import { z } from "zod";
import type { Database } from "../db";
import { schema } from "../db";

/**
 * This provider's id in Mail. Every account made through it stores it, and it is in the two URLs
 * the provider is told about, so it can never change.
 */
export const OIDC_PROVIDER = "oidc";

/** An OpenID Connect provider people may sign in through, instead of or as well as a password. */
export interface OidcProvider {
	issuer: string;
	clientId: string;
	clientSecret: string;
}

/**
 * Sign-in through any OpenID Connect provider. It is never added to `trustedProviders`, so an
 * existing account links only when the provider says the address is verified and Mail's own
 * account has verified it too, which is what Better Auth does otherwise.
 */
export function oidcSignIn(db: Database, { issuer, clientId, clientSecret }: OidcProvider) {
	const config = {
		providerId: OIDC_PROVIDER,
		discoveryUrl: `${issuer.endsWith("/") ? issuer.slice(0, -1) : issuer}/.well-known/openid-configuration`,
		clientId,
		clientSecret,
		scopes: ["openid", "profile", "email"],
		requireIdTokenVerification: true,
		// The method every provider has to take, which the plugin's default is not.
		authentication: "basic" as const,
		// Signing out of Mail leaves someone signed in to their provider, as other apps they use it
		// for would expect. Signing out there reaches Mail through the endpoint below.
		disableProviderLogout: true,
		mapProfileToUser: (profile: { email?: unknown; email_verified?: unknown; name?: unknown }) => ({
			// Linking an account rests on this. Some providers send the text "false", which is truthy.
			emailVerified: profile.email_verified === true,
			// Mail shows a name beside everything someone does, and the claim is optional.
			name:
				typeof profile.name === "string" && profile.name
					? profile.name
					: typeof profile.email === "string"
						? profile.email
						: "",
		}),
	};
	const plugin = genericOAuth({ config: [config] });
	return [
		{
			...plugin,
			// The plugin's own `init` waits for the provider's discovery document, with no time limit,
			// and every request in a new isolate waits for `init`. A slow provider would stop password
			// sign-in and every session check with it. So each isolate starts as the plugin does after a
			// failed discovery, which it retries, within 10 seconds, when someone asks for the provider.
			// This reads a field of the plugin's that is not public: the sign-in tests fail if it moves.
			init: async () => {
				const context = {
					genericOAuthPendingDiscovery: new Map([[OIDC_PROVIDER, { config }]]),
				};
				return { context };
			},
		},
		backchannelLogout(db),
	];
}

/**
 * The URL to give the provider as the app's `backchannel_logout_uri`: `generic-oauth` has no such
 * endpoint. The provider calls it directly, with a signed token that says who has signed out, and
 * Mail ends their sessions.
 *
 * The `:id` is there for the plugin: it retries discovery for a request that names its provider, and
 * an isolate that has never seen a sign-in needs the provider's keys to read the token.
 */
function backchannelLogout(db: Database) {
	return {
		id: "oidc-backchannel-logout",
		endpoints: {
			oidcBackchannelLogout: createAuthEndpoint(
				"/backchannel-logout/:id",
				{
					method: "POST",
					body: z.object({ logout_token: z.string().max(MAX_LOGOUT_TOKEN_LENGTH).optional() }),
					metadata: { allowedMediaTypes: ["application/x-www-form-urlencoded"] },
				},
				async (ctx) => {
					for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
						ctx.setHeader(name, value);
					}
					const answer = (status: 200 | 400 | 404 | 503) => {
						ctx.setStatus(status);
						if (status === 200) return {};
						return { error: status === 503 ? "temporarily_unavailable" : "invalid_request" };
					};
					if (ctx.params.id !== OIDC_PROVIDER) return answer(404);

					const token = ctx.body.logout_token;
					if (!token) return answer(400);

					// Discovery has not worked yet, which says nothing about the token. A provider tries a
					// 503 again and takes a 400 as final, and someone stays signed in if it gives up.
					const provider = ctx.context.socialProviders.find(({ id }) => id === OIDC_PROVIDER);
					const keys = provider?.idToken;
					if (!keys || !("jwks" in keys)) return answer(503);

					let claims: LogoutClaims;
					try {
						const { payload, protectedHeader } = await jwtVerify(token, keys.jwks, {
							issuer: keys.issuer,
							audience: keys.audience,
							...(keys.algorithms && { algorithms: keys.algorithms }),
							requiredClaims: ["iat", "exp"],
							maxTokenAge: LOGOUT_TOKEN_MAX_AGE,
							clockTolerance: LOGOUT_TOKEN_CLOCK_TOLERANCE,
						});
						if (!isLogoutType(protectedHeader.typ)) return answer(400);
						claims = logoutClaims.parse(payload);
					} catch (error) {
						// The reason only, never the token.
						if (keysOutOfReach(error)) {
							console.warn("auth: could not check a logout token:", errorName(error));
							return answer(503);
						}
						console.warn("auth: refused a logout token:", errorName(error));
						return answer(400);
					}

					// The token's `sub` is how this provider knows them, which is not Mail's user id.
					const owner = claims.sub
						? await ctx.context.internalAdapter.findAccountByKey({
								providerId: OIDC_PROVIDER,
								accountId: claims.sub,
							})
						: null;
					// Nobody here, which is no failure: they may have deleted their account.
					if (claims.sub && !owner) return answer(200);

					if (claims.sid) {
						const sessions = await db
							.select({ token: schema.session.token })
							.from(schema.session)
							.where(
								and(
									eq(schema.session.oidcSid, claims.sid),
									owner ? eq(schema.session.userId, owner.userId) : undefined,
								),
							)
							.all();
						if (sessions.length > 0) {
							await ctx.context.internalAdapter.deleteSessions(sessions.map((row) => row.token));
						}
					} else if (owner) {
						// The provider means everything of theirs, and a session it cannot name, such as one
						// from a password, is on the safe side of that.
						await ctx.context.internalAdapter.deleteUserSessions(owner.userId);
					}
					return answer(200);
				},
			),
		},
	};
}

const MAX_LOGOUT_TOKEN_LENGTH = 8192;

/** A provider delivers a logout token as soon as it makes it. */
const LOGOUT_TOKEN_MAX_AGE = "5 minutes";
const LOGOUT_TOKEN_CLOCK_TOLERANCE = "30 seconds";

const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

const logoutClaims = z
	.object({
		sub: z.string().min(1).optional(),
		sid: z.string().min(1).optional(),
		events: z.object({ [LOGOUT_EVENT]: z.looseObject({}) }),
		// Which, with `events`, keeps an ID token from passing as a logout token.
		nonce: z.never().optional(),
	})
	.refine((claims) => claims.sub || claims.sid);

type LogoutClaims = z.infer<typeof logoutClaims>;

/** The specification only recommends the type, so a token may leave it out but not contradict it. */
function isLogoutType(typ: string | undefined) {
	if (!typ) return true;
	const type = typ.toLowerCase();
	return type === "logout+jwt" || type === "application/logout+jwt";
}

/**
 * Whether a token could not be checked for want of the provider's keys, which says nothing about the
 * token. A failed fetch throws its own error through `jose`, and an answer it cannot use a plain
 * `JOSEError`. Every other `JOSEError` is about the token.
 */
function keysOutOfReach(error: unknown) {
	if (error instanceof errors.JOSEError) {
		return (
			error.code === errors.JOSEError.code ||
			error instanceof errors.JWKSTimeout ||
			error instanceof errors.JWKSInvalid
		);
	}
	return !(error instanceof z.ZodError);
}

function errorName(error: unknown) {
	if (!(error instanceof Error)) return "unknown";
	return "code" in error && typeof error.code === "string" ? error.code : error.name;
}

/** What is cleared from an account: Mail signs people in, and never acts for them at a provider. */
const NO_TOKENS = {
	accessToken: null,
	refreshToken: null,
	idToken: null,
	accessTokenExpiresAt: null,
	refreshTokenExpiresAt: null,
};

/**
 * The database hooks sign-in through a provider needs. The account hook keeps none of any provider's
 * tokens, GitHub's included. It is also the only place that sees the ID token, which by then has been
 * checked against the provider's keys and this request's nonce, so it takes the provider's session id
 * from it, for the session row made next in the same request. That row's `oidcSid` is what a logout
 * token names.
 */
export function oidcDatabaseHooks() {
	// By the request's context, which each endpoint call gets a copy of, so that sign-ins running at
	// once in an isolate cannot take each other's session id.
	const sessionIds = new WeakMap<object, string>();

	const fromProvider = async (
		account: Partial<Account>,
		context: GenericEndpointContext | null,
	) => {
		if (account.providerId === OIDC_PROVIDER) {
			const sessionId = account.idToken ? sessionIdIn(account.idToken) : undefined;
			if (sessionId && context) sessionIds.set(context.context, sessionId);
		}
		return { data: NO_TOKENS };
	};

	return {
		account: {
			create: { before: fromProvider },
			update: { before: fromProvider },
		},
		session: {
			create: {
				before: async (_session: Session, context: GenericEndpointContext | null) => {
					const oidcSid = context && sessionIds.get(context.context);
					return oidcSid ? { data: { oidcSid } } : undefined;
				},
			},
			delete: {
				// Changing a password ends every session and makes a new one for the browser that asked.
				// That one came from the same sign-in at the provider, so a logout token must still name it.
				before: async (
					session: Session & { oidcSid?: string | null },
					context: GenericEndpointContext | null,
				) => {
					if (!context || !session.oidcSid) return;
					if (session.id === context.context.session?.session.id) {
						sessionIds.set(context.context, session.oidcSid);
					}
				},
			},
		},
	};
}

function sessionIdIn(idToken: string) {
	const { sid } = decodeJwt(idToken);
	return typeof sid === "string" ? sid : undefined;
}
