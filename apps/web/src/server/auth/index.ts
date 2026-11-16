import { env, waitUntil } from "cloudflare:workers";
import { namesNobody, parseAllowList } from "../../lib/sign-up-allow";
import { removeAudience } from "../audience";
import { createDb } from "../db";
import { mailer } from "../email";
import { removeMailboxes } from "../mailbox";
import { allowPasswordTry, allowSpentTriesEmail, authRateLimits } from "../rate-limit";
import { removeWebhooks } from "../webhooks";
import { countedByWhoSentIt } from "../workers-address";
import { createAuth } from "./config";

export const db = createDb(env.DB);

const baseURL = env.BETTER_AUTH_URL || undefined;

const oidc =
	env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET
		? {
				issuer: env.OIDC_ISSUER,
				clientId: env.OIDC_CLIENT_ID,
				clientSecret: env.OIDC_CLIENT_SECRET,
			}
		: undefined;

const signUpAllow = parseAllowList(env.SIGN_UP_ALLOW);

/**
 * Whether new accounts are only for listed and invited addresses a provider proved
 * (`SIGN_UP_ALLOW`). A setting that is there but empty closes sign-up too.
 */
export const signUpClosed = signUpAllow !== null;

let instance: ReturnType<typeof buildAuth> | undefined;

/**
 * The isolate's one Better Auth instance, built on first use. Better Auth starts resolving its
 * context as soon as it is created, and workerd forbids I/O in global scope, so a plugin that
 * touches the database while doing so would log an error on every cold start.
 */
export function getAuth() {
	instance ??= buildAuth();
	return instance;
}

/**
 * Everything from outside reaches Better Auth through here, because its handler counts a request
 * first of all, before anything in it can step in.
 */
export async function handleAuthRequest(request: Request): Promise<Response> {
	return getAuth().handler(await countedByWhoSentIt(request));
}

const PROVIDER_LOGOUT = "/api/auth/backchannel-logout/";

/**
 * Takes a POST for Better Auth. A provider waits only so long for the answer to a logout token, and
 * its giving up would cancel the request, leaving someone signed in to Mail after signing out there.
 * So a logout is seen through once it has arrived, and read first, while the sender is still there.
 */
export async function postToAuth(request: Request): Promise<Response> {
	if (!new URL(request.url).pathname.startsWith(PROVIDER_LOGOUT)) {
		return handleAuthRequest(request);
	}
	const arrived = new Request(request.url, {
		method: "POST",
		headers: request.headers,
		body: await request.arrayBuffer(),
	});
	const answer = handleAuthRequest(arrived);
	waitUntil(answer);
	return answer;
}

function buildAuth() {
	if (signUpAllow && signUpAllow.ignored > 0) {
		// Said once an isolate, and as a count: whoever wrote an entry that is neither an address
		// nor an `@domain` would otherwise believe its people can sign up. The entries may be
		// people's addresses, which the log does not keep.
		console.warn(
			`auth: SIGN_UP_ALLOW: ignored ${signUpAllow.ignored} of its entries, which let nobody in. Each must be an address or an @domain.`,
		);
	}
	if (signUpAllow && namesNobody(signUpAllow)) {
		// Also once an isolate: an emptied setting closes the server rather than opening it, which
		// whoever emptied it to open sign-up has to be told. To open it, remove the setting.
		console.warn(
			"auth: SIGN_UP_ALLOW is set and names nobody, so only invited addresses can make an account. Remove the setting to open sign-up.",
		);
	}
	return createAuth({
		signUpAllow,
		db,
		secret: env.BETTER_AUTH_SECRET,
		baseURL,
		// A deployed Worker answers over HTTPS. Local dev has no certificate.
		secureCookies: !baseURL && !import.meta.env.DEV,
		github:
			env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
				? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
				: undefined,
		oidc,
		mailer,
		runInBackground: waitUntil,
		rateLimitStorage: authRateLimits,
		allowPasswordTry,
		allowSpentTriesEmail,
		removeMailboxes,
		removeWebhooks,
		removeAudience,
		providers: {
			secrets: env,
			resendApi: env.RESEND_API_URL,
			afterKeySet: async (workspaceId) => {
				const [{ webhookForNewKey }, { appOrigin }] = await Promise.all([
					import("../resend-inbound"),
					import("../origin"),
				]);
				return webhookForNewKey(db, workspaceId, appOrigin());
			},
		},
	});
}

export const githubEnabled = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

export const emailEnabled = Boolean(mailer);

/** What the sign-in page calls the OpenID Connect provider, if there is one. */
export const oidcProviderName = oidc ? env.OIDC_PROVIDER_NAME || "single sign-on" : null;
