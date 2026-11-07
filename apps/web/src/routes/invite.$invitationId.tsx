import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { LegalLinks } from "#/components/legal-links";
import { Button } from "#/components/ui/button";
import { VerifyEmailButton } from "#/components/verify-email";
import { authClient } from "#/lib/auth-client";
import { formatRelative } from "#/lib/dates";
import { previewInvitation } from "#/lib/members";
import { getLegalLinks } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";
import type { InvitationPreview } from "#/server/workspaces";

export const Route = createFileRoute("/invite/$invitationId")({
	// A verification link that failed sends the browser back here with an error code.
	validateSearch: z.object({ error: z.string().optional().catch(undefined) }),
	loader: async ({ params }) => {
		const [preview, legal] = await Promise.all([
			previewInvitation({ data: params.invitationId }),
			getLegalLinks(),
		]);
		return { ...preview, legal };
	},
	component: InvitePage,
});

function InvitePage() {
	const { invitation, viewer, verificationRequired } = Route.useLoaderData();
	const { invitationId } = Route.useParams();
	useDocumentTitle(invitation ? `Join ${invitation.workspaceName}` : "Invitation");

	if (!invitation) {
		return (
			<Card title="This invitation is no longer valid">
				<p className="text-sm text-muted-foreground">
					It may have expired, been revoked or already been used. Ask whoever invited you for a new
					link.
				</p>
				<Button asChild variant="outline" className="w-full">
					<Link to="/">Go to Gateweave Mail</Link>
				</Button>
			</Card>
		);
	}
	return (
		<ValidInvitation
			invitationId={invitationId}
			invitation={invitation}
			viewer={viewer}
			verificationRequired={verificationRequired}
		/>
	);
}

function ValidInvitation({
	invitationId,
	invitation,
	viewer,
	verificationRequired,
}: {
	invitationId: string;
	invitation: InvitationPreview;
	viewer: { email: string; emailVerified: boolean } | null;
	verificationRequired: boolean;
}) {
	const { error: linkError } = Route.useSearch();
	const router = useRouter();
	const [pending, setPending] = useState(false);
	const here = `/invite/${invitationId}`;
	const title = `Join ${invitation.workspaceName}`;
	const role = invitation.role === "admin" ? "an admin" : `a ${invitation.role}`;
	const intro = (
		<p className="text-sm text-muted-foreground">
			{invitation.inviterName} invited <span className="text-foreground">{invitation.email}</span>{" "}
			to join as {role}. The invitation expires {formatRelative(invitation.expiresAt)}.
		</p>
	);

	async function switchAccount() {
		setPending(true);
		await authClient.signOut();
		await router.invalidate();
		await router.navigate({ to: "/login", search: { redirect: here, email: invitation.email } });
	}

	async function accept() {
		setPending(true);
		const result = await authClient.organization.acceptInvitation({ invitationId });
		if (result.error) {
			setPending(false);
			toast.error("Could not join", { description: result.error.message });
			return;
		}
		await router.navigate({ to: "/$workspace", params: { workspace: invitation.workspaceSlug } });
	}

	async function decline() {
		setPending(true);
		const result = await authClient.organization.rejectInvitation({ invitationId });
		setPending(false);
		if (result.error) {
			toast.error("Could not decline", { description: result.error.message });
			return;
		}
		toast.success("Invitation declined");
		await router.navigate({ to: "/" });
	}

	if (!viewer) {
		return (
			<Card title={title}>
				{intro}
				<div className="space-y-2">
					<Button asChild className="w-full">
						<Link to="/login" search={{ redirect: here, email: invitation.email, mode: "sign-up" }}>
							Create an account
						</Link>
					</Button>
					<Button asChild variant="outline" className="w-full">
						<Link to="/login" search={{ redirect: here, email: invitation.email }}>
							Sign in
						</Link>
					</Button>
				</div>
			</Card>
		);
	}

	if (viewer.email.toLowerCase() !== invitation.email.toLowerCase()) {
		return (
			<Card title={title}>
				{intro}
				<p className="text-sm">
					You are signed in as <span className="font-medium">{viewer.email}</span>. Sign in with{" "}
					{invitation.email} to accept.
				</p>
				<Button className="w-full" onClick={switchAccount} disabled={pending}>
					Switch account
				</Button>
			</Card>
		);
	}

	if (verificationRequired && !viewer.emailVerified) {
		return (
			<Card title={title}>
				{intro}
				<p className="text-sm">
					{linkError ? "That link has expired or was already used. " : ""}
					To join, confirm that {invitation.email} is yours. We email it a link that brings you back
					here.
				</p>
				<VerifyEmailButton email={viewer.email} callbackURL={here} className="w-full" />
			</Card>
		);
	}

	return (
		<Card title={title}>
			{intro}
			<div className="space-y-2">
				<Button className="w-full" onClick={accept} disabled={pending}>
					Join {invitation.workspaceName}
				</Button>
				<Button variant="ghost" className="w-full" onClick={decline} disabled={pending}>
					Decline
				</Button>
			</div>
		</Card>
	);
}

function Card({ title, children }: { title: string; children: ReactNode }) {
	const { legal } = Route.useLoaderData();
	return (
		<main className="flex min-h-svh items-center justify-center p-6">
			<div className="w-full max-w-sm space-y-6">
				<h1 className="text-xl font-semibold tracking-tight">{title}</h1>
				{children}
				<LegalLinks links={legal} />
			</div>
		</main>
	);
}
