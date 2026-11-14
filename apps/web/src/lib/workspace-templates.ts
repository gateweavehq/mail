import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isAdminRole, isPersonRole } from "./roles";
import type { Template, TemplateInput } from "./templates";

/** What the templates page shows: the live templates, and the names of those who saved them. */
export interface WorkspaceTemplates {
	templates: Template[];
	/** Members by id, for naming who saved a version. A member who left isn't here. */
	people: Record<string, string>;
}

/** A change, as the page sends it to `/api/templates/<workspace>`. */
export type TemplateAction =
	| { action: "save"; id: string | null; input: TemplateInput }
	| { action: "remove"; id: string };

export type TemplateAnswer<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export const templatesUrl = (slug: string) => `/api/templates/${encodeURIComponent(slug)}`;

/**
 * The workspace's templates, for any member that is a person: owners and admins write them, the
 * rest read. `admin` says which. Null if the caller is not a member.
 */
export const getWorkspaceTemplates = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }): Promise<({ admin: boolean } & WorkspaceTemplates) | null> => {
		const { currentMember } = await import("#/server/access");
		const member = await currentMember(slug);
		if (!member || !isPersonRole(member.membership.role)) return null;
		const { readTemplates } = await import("#/server/audience/gateway");
		return {
			admin: isAdminRole(member.membership.role),
			...(await readTemplates(member.membership.workspaceId)),
		};
	});
