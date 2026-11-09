import { Link } from "@tanstack/react-router";
import { ArrowLeft, Bot, Clock } from "lucide-react";
import type { ReactNode } from "react";
import { senderName } from "#/components/mail/message-view";
import { sentLabel } from "#/components/mail/sent-status";
import { PauseButton, PausedNote } from "#/components/settings/agents-settings";
import { useWorkspace } from "#/components/workspace/context";
import { addressPolicySummary } from "#/lib/agent-addresses";
import { policySummary } from "#/lib/agent-policy";
import { AGENT_PAGE_LISTED, type AgentActivity, type AgentMessage } from "#/lib/agents";
import { formatDateTime, formatRelative, formatShortDate } from "#/lib/dates";

/** How many addresses a line names before saying how many more. */
const NAMED_RECIPIENTS = 2;

/**
 * One agent, for an owner or admin: what it may do and holds, what it wrote, what of that waits
 * for a person, and what came to its addresses. Each message opens its thread.
 */
export function AgentPage({ activity }: { activity: AgentActivity }) {
	const { slug } = useWorkspace();
	const { agent, mailboxes, addresses, held, wrote, received } = activity;
	const lastUsed = Math.max(0, ...agent.keys.map((key) => key.lastUsedAt ?? 0));
	return (
		<div className="space-y-8">
			<div className="space-y-3">
				<Link
					to="/$workspace/settings/agents"
					params={{ workspace: slug }}
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft className="size-4" aria-hidden />
					Agents
				</Link>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<Bot
						aria-hidden
						className="size-8 shrink-0 rounded-full border p-1.5 text-muted-foreground"
					/>
					<div className="min-w-0 flex-1 basis-48">
						<h2 className="truncate text-base font-medium">{agent.name}</h2>
						<p className="text-xs text-muted-foreground">
							Created {formatShortDate(agent.createdAt)}.{" "}
							{agent.keys.length === 0
								? "No keys."
								: lastUsed === 0
									? "Its keys were never used."
									: `A key of it was last used ${formatRelative(lastUsed)}.`}
						</p>
					</div>
					<PauseButton agent={agent} />
				</div>
				{agent.paused && <PausedNote paused={agent.paused} />}
				<p className="text-sm text-muted-foreground">
					{policySummary(agent.policy)} {addressPolicySummary(agent.addressPolicy)}
				</p>
			</div>

			<Section title="Mailboxes" id="agent-mailboxes">
				{mailboxes.length === 0 ? (
					<Empty>
						It was given no mailbox, so it reads nothing. A mailbox's “Choose who” gives it one.
					</Empty>
				) : (
					<ul className="divide-y rounded-lg border text-sm">
						{mailboxes.map((box) => (
							<li key={box.id} className="flex items-baseline gap-3 px-4 py-2">
								<Link
									to="/$workspace/mailboxes/$mailbox"
									params={{ workspace: slug, mailbox: box.id }}
									className="min-w-0 flex-1 truncate hover:underline hover:underline-offset-4"
								>
									{box.name}
								</Link>
								<span className="shrink-0 text-xs text-muted-foreground">
									{box.send ? "Reads and sends" : "Reads"}
								</span>
							</li>
						))}
					</ul>
				)}
			</Section>

			{agent.liveAddresses > 0 && (
				<Section title="Addresses it holds" id="agent-addresses">
					<ul className="divide-y rounded-lg border text-sm">
						{addresses.map((address) => (
							<li
								key={address.address}
								className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2"
							>
								<span className="min-w-0 flex-1 truncate font-mono text-xs">{address.address}</span>
								<span className="shrink-0 text-xs text-muted-foreground">
									{address.mailbox.name}
									{address.expiresAt !== null && (
										<>
											{" · "}
											<span title={formatDateTime(address.expiresAt)}>
												ends {formatRelative(address.expiresAt)}
											</span>
										</>
									)}
								</span>
							</li>
						))}
					</ul>
					{agent.liveAddresses > addresses.length && (
						<p className="text-xs text-muted-foreground">
							It holds {agent.liveAddresses}; these are the {addresses.length} that end soonest.
						</p>
					)}
				</Section>
			)}

			{held.length > 0 && (
				<Section
					title={
						<span className="flex items-center gap-2">
							<Clock className="size-4 shrink-0" aria-hidden />
							Waiting for approval
						</span>
					}
					id="agent-held"
				>
					<p className="text-sm text-muted-foreground">
						It wrote {held.length === 1 ? "this" : "these"} to someone it may not mail on its own.
						Open one to approve or reject it.
					</p>
					<Messages messages={held} kind="wrote" />
				</Section>
			)}

			<Section title="What it wrote" id="agent-wrote">
				{wrote.length === 0 ? (
					<Empty>Nothing yet.</Empty>
				) : (
					<Messages messages={wrote} kind="wrote" />
				)}
			</Section>

			<Section title="What came to its addresses" id="agent-received">
				{received.length === 0 ? (
					<Empty>
						Nothing yet. Mail to a mailbox's own addresses isn't counted here, only to those it
						made.
					</Empty>
				) : (
					<Messages messages={received} kind="received" />
				)}
			</Section>
		</div>
	);
}

function Section({ title, id, children }: { title: ReactNode; id: string; children: ReactNode }) {
	return (
		<section aria-labelledby={id} className="space-y-3">
			<h3 id={id} className="text-sm font-medium">
				{title}
			</h3>
			{children}
		</section>
	);
}

function Empty({ children }: { children: ReactNode }) {
	return <p className="text-sm text-muted-foreground">{children}</p>;
}

/** Addresses, the first few named and the rest counted. */
function named(addresses: string[]): string {
	const shown = addresses.slice(0, NAMED_RECIPIENTS).join(", ");
	const more = addresses.length - NAMED_RECIPIENTS;
	return more > 0 ? `${shown} +${more}` : shown;
}

function Messages({ messages, kind }: { messages: AgentMessage[]; kind: "wrote" | "received" }) {
	const { slug } = useWorkspace();
	return (
		<>
			<ul className="divide-y rounded-lg border">
				{messages.map((message) => {
					const status =
						kind === "wrote" && message.sent
							? sentLabel(message.sent.status, message.sent.deliveries, message.sent.recipients)
							: null;
					const who =
						kind === "wrote"
							? message.to.length > 0
								? `To ${named(message.to)}`
								: null
							: `From ${senderName(message.from)}${message.to.length > 0 ? ` to ${named(message.to)}` : ""}`;
					return (
						<li key={`${message.mailbox.id}/${message.id}`}>
							<Link
								to="/$workspace/mailboxes/$mailbox/threads/$thread"
								params={{ workspace: slug, mailbox: message.mailbox.id, thread: message.threadId }}
								className="flex flex-col gap-0.5 px-4 py-2.5 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
							>
								<span className="flex min-w-0 items-baseline gap-3">
									<span className="min-w-0 flex-1 truncate text-sm">
										{message.subject || <span className="text-muted-foreground">(no subject)</span>}
									</span>
									<time
										className="shrink-0 text-xs text-muted-foreground"
										dateTime={new Date(message.arrivedAt).toISOString()}
										title={formatDateTime(message.arrivedAt)}
									>
										{formatShortDate(message.arrivedAt)}
									</time>
								</span>
								<span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
									{who && <span className="min-w-0 truncate">{who}</span>}
									<span className="shrink-0">in {message.mailbox.name}</span>
									{status && <span className="shrink-0 font-medium text-foreground">{status}</span>}
								</span>
							</Link>
						</li>
					);
				})}
			</ul>
			{messages.length === AGENT_PAGE_LISTED && (
				<p className="text-xs text-muted-foreground">The newest {AGENT_PAGE_LISTED}.</p>
			)}
		</>
	);
}
