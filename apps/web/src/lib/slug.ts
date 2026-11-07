/** Top-level paths that a workspace slug would shadow. */
const RESERVED = new Set([
	"admin",
	"api",
	"assets",
	"forgot-password",
	"invite",
	"login",
	"logout",
	"new",
	"reset-password",
	"settings",
	"signup",
	"static",
]);

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** Returns why a workspace slug is unusable, or null if it is fine. */
export function slugProblem(slug: string): string | null {
	if (!SLUG.test(slug)) {
		return "Use 1-48 lowercase letters, digits or dashes, not starting or ending with a dash";
	}
	if (RESERVED.has(slug)) return `"${slug}" is reserved`;
	return null;
}

export function slugify(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/, "");
}
