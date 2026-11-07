import type { Email } from "./mailer";

/** An email before it is addressed. */
export type Message = Omit<Email, "to">;

const PRODUCT = "Gateweave Mail";
const DAY = 24 * 60 * 60 * 1000;

export function passwordResetEmail({ url }: { url: string }): Message {
	return compose({
		subject: `Reset your ${PRODUCT} password`,
		heading: "Reset your password",
		body: [
			`Someone asked to reset the password of your ${PRODUCT} account. If it was you, choose a new password below. The link works for one hour, once.`,
			"Resetting it signs you out on every device.",
		],
		action: { label: "Choose a new password", url },
		footer: "If you did not ask for this, ignore this email. Your password stays as it is.",
	});
}

export function verificationEmail({ url }: { url: string }): Message {
	return compose({
		subject: `Verify your email for ${PRODUCT}`,
		heading: "Verify your email",
		body: [
			`Confirm that this address is yours to finish setting up your ${PRODUCT} account. Workspaces you are invited to need it before you can join. The link works for 24 hours.`,
		],
		action: { label: "Verify email", url },
		footer: `If you did not create a ${PRODUCT} account, ignore this email.`,
	});
}

export function invitationEmail({
	inviter,
	workspace,
	url,
	expiresAt,
	now = Date.now(),
}: {
	inviter: { name: string; email: string };
	workspace: string;
	url: string;
	expiresAt: number;
	now?: number;
}): Message {
	// Names are typed by whoever sends the invitation, so they are kept short and on one line.
	const name = clip(inviter.name, 60);
	const space = clip(workspace, 60);
	const days = Math.max(1, Math.round((expiresAt - now) / DAY));
	return compose({
		subject: `${name} invited you to ${space} on ${PRODUCT}`,
		heading: `Join ${space}`,
		body: [`${name} (${inviter.email}) invited you to the ${space} workspace on ${PRODUCT}.`],
		action: { label: `Join ${space}`, url },
		footer: `The invitation works only for this email address and expires in ${days} ${days === 1 ? "day" : "days"}. If you were not expecting it, ignore this email.`,
	});
}

/** To whoever changed their password, so that someone who did not hears of it. */
export function passwordChangedEmail({ email }: { email: string }): Message {
	return compose({
		subject: `Your ${PRODUCT} password was changed`,
		heading: "Your password was changed",
		body: [
			`The password of the ${PRODUCT} account for ${email} was changed, from a session signed in to it. Every other session of this account is signed out.`,
		],
		footer:
			"If this was not you, reset your password from the sign-in page, which signs everyone else out, and tell whoever runs this server.",
	});
}

/** To someone whose tries at their password ran out, which may not have been them. */
export function passwordTriesSpentEmail({ email }: { email: string }): Message {
	return compose({
		subject: `Too many tries at your ${PRODUCT} password`,
		heading: "Too many tries at your password",
		body: [
			`Someone signed in to the ${PRODUCT} account for ${email} has tried a password too many times lately. For now a password offered from a signed-in session is refused, even if it is the right one, so it can't be changed in account settings. Signing in still works, and this comes back by itself, a little at a time.`,
		],
		footer:
			'If this was not you, someone may have a copy of a session. Choose "Sign out everywhere" in your account settings, which asks for no password. If you have a password, reset it from the sign-in page. Then tell whoever runs this server.',
	});
}

/** To whoever deleted their account, so that someone who did not hears of it. */
export function accountDeletedEmail({ email }: { email: string }): Message {
	return compose({
		subject: `Your ${PRODUCT} account was deleted`,
		heading: "Your account was deleted",
		body: [
			`The ${PRODUCT} account for ${email} has been deleted, from a session signed in to it. It cannot be brought back.`,
			"Workspaces you belonged to stay with the people still in them.",
		],
		footer:
			"If this was not you, someone else had your password or a recent session. Tell whoever runs this server.",
	});
}

function compose({
	subject,
	heading,
	body,
	action,
	footer,
}: {
	subject: string;
	heading: string;
	body: string[];
	/** The button, for a message that asks for something. */
	action?: { label: string; url: string };
	footer: string;
}): Message {
	const link = action ? [`${action.label}: ${action.url}`] : [];
	const text = [...body, ...link, footer, `— ${PRODUCT}`].join("\n\n");
	const button = action
		? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:10px 16px;background:#171717;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">${escapeHtml(action.label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;color:#525252">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(action.url)}</span></p>`
		: "";
	const paragraphs = body
		.map((line) => `<p style="margin:0 0 16px">${escapeHtml(line)}</p>`)
		.join("");
	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f5f5f5;color:#171717;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<div style="max-width:480px;margin:0 auto;padding:32px;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px">
<p style="margin:0 0 24px;font-size:13px;font-weight:600;color:#525252">${PRODUCT}</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(heading)}</h1>
${paragraphs}
${button}
<p style="margin:24px 0 0;font-size:13px;color:#737373">${escapeHtml(footer)}</p>
</div>
</body>
</html>`;
	return { subject: oneLine(subject), text, html };
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, max: number): string {
	const line = oneLine(value);
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
