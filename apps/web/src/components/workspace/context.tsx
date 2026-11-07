import { createContext, type ReactNode, useContext } from "react";
import type { MemberRole } from "#/lib/roles";
import type { Workspace } from "#/lib/workspace";

const WorkspaceContext = createContext<Workspace | null>(null);

export function WorkspaceProvider({
	workspace,
	children,
}: {
	workspace: Workspace;
	children: ReactNode;
}) {
	return <WorkspaceContext value={workspace}>{children}</WorkspaceContext>;
}

export function useWorkspace(): Workspace {
	const workspace = useContext(WorkspaceContext);
	if (!workspace) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
	return workspace;
}

/**
 * The signed-in user's role, as of the last page load. The server checks every action again;
 * this only decides what to offer.
 */
export function useMyRole(): MemberRole {
	return useWorkspace().role;
}

export { isAdminRole } from "#/lib/roles";
