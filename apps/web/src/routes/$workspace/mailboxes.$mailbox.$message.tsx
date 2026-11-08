import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { MessageView } from "#/components/mail/message-view";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { getMessage } from "#/lib/mailbox";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/mailboxes/$mailbox/$message")({
	loader: ({ params }) =>
		getMessage({
			data: { workspace: params.workspace, mailbox: params.mailbox, message: params.message },
		}),
	component: MessagePage,
});

function MessagePage() {
	const { slug } = useWorkspace();
	const { mailbox } = Route.useParams();
	const message = Route.useLoaderData();
	const navigate = useNavigate();
	useDocumentTitle(message?.subject || "Message");

	if (!message) {
		return (
			<Notice
				title="Message not found"
				action={
					<Button asChild variant="outline">
						<Link to="/$workspace" params={{ workspace: slug }}>
							All mailboxes
						</Link>
					</Button>
				}
			>
				It doesn't exist, or it isn't in a workspace you belong to.
			</Notice>
		);
	}

	return (
		<article className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
			<header className="space-y-3">
				<div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
					<Link
						to="/$workspace/mailboxes/$mailbox"
						params={{ workspace: slug, mailbox }}
						className="underline-offset-4 hover:underline"
					>
						Back to the mailbox
					</Link>
					<Link
						to="/$workspace/mailboxes/$mailbox/threads/$thread"
						params={{ workspace: slug, mailbox, thread: message.threadId }}
						className="underline-offset-4 hover:underline"
					>
						Its thread
					</Link>
				</div>
				<h1 className="min-w-0 break-words text-xl font-semibold tracking-tight">
					{message.subject || "(no subject)"}
				</h1>
			</header>
			<MessageView
				workspace={slug}
				mailbox={mailbox}
				message={message}
				onDeleted={() =>
					navigate({ to: "/$workspace/mailboxes/$mailbox", params: { workspace: slug, mailbox } })
				}
			/>
		</article>
	);
}
