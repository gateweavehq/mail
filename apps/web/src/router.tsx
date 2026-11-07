import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { createIsomorphicFn, getGlobalStartContext } from "@tanstack/react-start";
import { RouteError } from "./components/route-error";
import "./lib/zod-config";
import { routeTree } from "./routeTree.gen";

/**
 * The nonce `server.ts` made for this response. In the browser the router reads it back from the
 * page by itself. A router built outside a request, only to follow a redirect, renders nothing.
 */
const requestNonce = createIsomorphicFn()
	.server(() => {
		try {
			return getGlobalStartContext()?.nonce;
		} catch {
			return undefined;
		}
	})
	.client(() => undefined);

export function getRouter() {
	const router = createTanStackRouter({
		routeTree,
		scrollRestoration: true,
		defaultPreload: "intent",
		defaultPreloadStaleTime: 0,
		// Unknown URLs get the full-page "not found". The default renders it inside the deepest
		// layout that matched, which would run the workspace shell without its data.
		notFoundMode: "root",
		defaultErrorComponent: RouteError,
		ssr: { nonce: requestNonce() },
	});

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}

declare module "@tanstack/react-start" {
	interface Register {
		server: { requestContext: { nonce: string } };
	}
}
