import type { BetterAuthClientPlugin } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import type { agentMembers } from "#/server/auth/agents";
import type { providerKeys } from "#/server/auth/provider-keys";

/** The agent members plugin's endpoints, typed from the server plugin (a type-only import). */
const agentMembersClient = () =>
	({
		id: "agent-members",
		$InferServerPlugin: {} as ReturnType<typeof agentMembers>,
	}) satisfies BetterAuthClientPlugin;

/** The provider keys plugin's endpoints, typed the same way. */
const providerKeysClient = () =>
	({
		id: "provider-keys",
		$InferServerPlugin: {} as ReturnType<typeof providerKeys>,
	}) satisfies BetterAuthClientPlugin;

export const authClient = createAuthClient({
	plugins: [organizationClient(), agentMembersClient(), providerKeysClient()],
});
