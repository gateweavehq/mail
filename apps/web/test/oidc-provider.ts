import { createHash } from "node:crypto";
import { type CryptoKey, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";

export const OIDC = {
	issuer: "https://id.test",
	clientId: "mail-client",
	clientSecret: "mail-client-secret",
};

/** The settings that point the Worker at the stand-in. */
export const OIDC_VARS = {
	OIDC_ISSUER: OIDC.issuer,
	OIDC_CLIENT_ID: OIDC.clientId,
	OIDC_CLIENT_SECRET: OIDC.clientSecret,
	OIDC_PROVIDER_NAME: "Gateweave",
};

export const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

interface SignOptions {
	/** Another key than the one the provider publishes. */
	key?: CryptoKey;
	typ?: string;
}

interface Grant {
	/** The ID token's claims. */
	claims: JWTPayload;
	challenge: string | null;
	redirectUri: string | null;
	sign: SignOptions;
	/** Claims `/userinfo` answers with, for a token that does not carry them. */
	userInfo?: JWTPayload;
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * Stands in for an OpenID Connect provider, in the test's process. Its token endpoint is as strict
 * as a real one about what Mail sends: PKCE, the redirect URI and the client's credentials.
 */
export async function standInProvider() {
	const keys = await generateKeyPair("ES256");
	const publicKey = {
		...(await exportJWK(keys.publicKey)),
		kid: "key-1",
		alg: "ES256",
		use: "sig",
	};
	const grants = new Map<string, Grant>();
	let granted = 0;
	let mode: "up" | "down" | "hanging" | "no-keys" = "up";
	/** The paths the Worker has asked for, oldest first. */
	const requests: string[] = [];

	function sign(claims: JWTPayload, { key = keys.privateKey, typ = "JWT" }: SignOptions = {}) {
		return new SignJWT(claims)
			.setProtectedHeader({ alg: "ES256", kid: "key-1", ...(typ && { typ }) })
			.sign(key);
	}

	return {
		requests,
		/** How the provider answers from now on. */
		go(next: typeof mode) {
			mode = next;
		},
		/**
		 * What the provider does once someone has signed in: makes a code for the request Mail sent
		 * them with, for an ID token with these claims on top of the ones it would have anyway.
		 */
		grant(
			authorize: URL,
			claims: JWTPayload & { email?: unknown; email_verified?: unknown; name?: unknown },
			options: SignOptions & { userInfo?: JWTPayload } = {},
		) {
			const { userInfo, ...sign } = options;
			const code = `code-${++granted}`;
			grants.set(code, {
				claims: {
					iss: OIDC.issuer,
					aud: OIDC.clientId,
					iat: now(),
					exp: now() + 300,
					nonce: authorize.searchParams.get("nonce") ?? undefined,
					...claims,
				},
				challenge: authorize.searchParams.get("code_challenge"),
				redirectUri: authorize.searchParams.get("redirect_uri"),
				sign,
				...(userInfo && { userInfo }),
			});
			return code;
		},
		/** A logout token, as the provider would send it, with these claims on top. */
		logoutToken(claims: JWTPayload, options: SignOptions = {}) {
			return sign(
				{
					iss: OIDC.issuer,
					aud: OIDC.clientId,
					iat: now(),
					exp: now() + 120,
					jti: crypto.randomUUID(),
					events: { [LOGOUT_EVENT]: {} },
					...claims,
				},
				{ typ: "logout+jwt", ...options },
			);
		},
		/** Signs anything with the provider's own key, for a token it would not make. */
		sign,
		/** A key the provider does not publish. */
		strangerKey: async () => (await generateKeyPair("ES256")).privateKey,
		async outbound(request: Request, url: URL): Promise<Response | undefined> {
			if (url.origin !== OIDC.issuer) return undefined;
			requests.push(url.pathname);
			if (mode === "down") return new Response("Down", { status: 503 });
			if (mode === "hanging") return new Promise<Response>(() => {});
			if (url.pathname === "/.well-known/openid-configuration") {
				return Response.json({
					issuer: OIDC.issuer,
					authorization_endpoint: `${OIDC.issuer}/authorize`,
					token_endpoint: `${OIDC.issuer}/token`,
					userinfo_endpoint: `${OIDC.issuer}/userinfo`,
					...(mode !== "no-keys" && { jwks_uri: `${OIDC.issuer}/jwks` }),
					end_session_endpoint: `${OIDC.issuer}/end-session`,
					id_token_signing_alg_values_supported: ["ES256"],
				});
			}
			if (url.pathname === "/jwks") return Response.json({ keys: [publicKey] });
			if (url.pathname === "/userinfo") {
				const code = request.headers.get("authorization")?.replace("Bearer access-for-", "");
				const grant = code ? grants.get(code) : undefined;
				return grant?.userInfo
					? Response.json(grant.userInfo)
					: new Response(null, { status: 401 });
			}
			if (url.pathname === "/token") {
				const form = new URLSearchParams(await request.text());
				const code = form.get("code");
				const grant = code ? grants.get(code) : undefined;
				const credentials = btoa(`${OIDC.clientId}:${OIDC.clientSecret}`);
				const verifier = form.get("code_verifier") ?? "";
				const challenge = createHash("sha256").update(verifier).digest("base64url");
				if (
					!code ||
					!grant ||
					// The method every provider must take, which some have instead of the one in the body.
					request.headers.get("authorization") !== `Basic ${credentials}` ||
					form.get("grant_type") !== "authorization_code" ||
					form.get("redirect_uri") !== grant.redirectUri ||
					grant.challenge !== challenge
				) {
					return Response.json({ error: "invalid_grant" }, { status: 400 });
				}
				grants.delete(code);
				if (grant.userInfo) grants.set(code, grant);
				return Response.json({
					access_token: `access-for-${code}`,
					refresh_token: `refresh-for-${code}`,
					token_type: "Bearer",
					expires_in: 3600,
					scope: "openid profile email",
					id_token: await sign(grant.claims, grant.sign),
				});
			}
			return new Response("Not found", { status: 404 });
		},
	};
}
