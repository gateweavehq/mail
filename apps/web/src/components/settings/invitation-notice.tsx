/**
 * What the members page can say about an invitation. Its mail goes in the background, so the page
 * knows it was asked for, not that it went or arrived, and the link is there for when it doesn't.
 */
export function InvitationNotice({ byEmail, email }: { byEmail: boolean; email: string }) {
	if (!byEmail) {
		return (
			<>
				Send this link to <span className="font-medium">{email}</span>:
			</>
		);
	}
	return (
		<>
			We are emailing an invitation to <span className="font-medium">{email}</span>. If it does not
			arrive, send them this link:
		</>
	);
}

/** The same, for asking again from a pending invitation. */
export function resentNotice(email: string): { title: string; description: string } {
	return {
		title: `Emailing the invitation to ${email} again`,
		description: "If it does not arrive, copy the link and send it to them.",
	};
}
