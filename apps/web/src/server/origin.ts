import { env } from "cloudflare:workers";
import { getRequestUrl } from "@tanstack/react-start/server";

/** The app's origin as people reach it: `BETTER_AUTH_URL`'s when it is set, else the request's. */
export function appOrigin(): string {
	return env.BETTER_AUTH_URL ? new URL(env.BETTER_AUTH_URL).origin : getRequestUrl().origin;
}
