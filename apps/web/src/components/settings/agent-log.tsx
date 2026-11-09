import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import {
	AGENT_LOG_DAYS,
	AGENT_LOG_KIND_NAMES,
	AGENT_LOG_KINDS,
	type AgentLogEntry,
	type AgentLogKind,
	type AgentLogPage,
	agentLogVerb,
} from "#/lib/agent-log";
import { getAgentLog } from "#/lib/agents";
import { formatDateTime, formatRelative } from "#/lib/dates";

const KINDS = Object.keys(AGENT_LOG_KINDS) as AgentLogKind[];

/**
 * What an agent did with its key, and what people did to it, newest first, of one kind or all.
 * `newest` is the page's own, which it asks again for every so often; a kind is asked for here.
 */
export function AgentLog({
	agent,
	newest,
}: {
	agent: { id: string; name: string };
	newest: AgentLogPage;
}) {
	const { slug } = useWorkspace();
	const [kind, setKind] = useState<AgentLogKind | null>(null);
	const [ofKind, setOfKind] = useState<AgentLogPage | null>(null);
	// Once older entries are shown, the newest page stays as it was, so none fall between the two.
	const [kept, setKept] = useState<AgentLogPage | null>(null);
	const [older, setOlder] = useState<AgentLogEntry[]>([]);
	const [next, setNext] = useState<AgentLogPage["next"]>(null);
	const [busy, setBusy] = useState(false);
	/** Whether the newest page of the chosen kind couldn't be read. */
	const [unread, setUnread] = useState(false);
	/** Whether the older entries asked for couldn't be read. */
	const [olderFailed, setOlderFailed] = useState(false);
	// Bumped as a kind is chosen, so an answer asked for under another kind is let go.
	const choice = useRef(0);

	// Asked again as the page's own is, while a kind is chosen.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new `newest` is the page refreshing.
	useEffect(() => {
		if (kind === null) return;
		let gone = false;
		getAgentLog({ data: { slug, agentId: agent.id, kind, before: null } })
			.then((page) => {
				if (gone) return;
				// None: the agent was deleted meanwhile, or the caller is no longer an admin.
				if (page) setOfKind(page);
				setUnread(page === null);
			})
			.catch(() => {
				if (!gone) setUnread(true);
			});
		return () => {
			gone = true;
		};
	}, [slug, agent.id, kind, newest]);

	const choose = (chosen: AgentLogKind | null) => {
		if (chosen === kind) return;
		choice.current += 1;
		setKind(chosen);
		setOfKind(null);
		setKept(null);
		setOlder([]);
		setNext(null);
		setBusy(false);
		setUnread(false);
		setOlderFailed(false);
	};

	const first = kept ?? (kind === null ? newest : ofKind);
	const cursor = older.length > 0 ? next : (first?.next ?? null);
	const seen = new Set<string>();
	const entries = [...(first?.entries ?? []), ...older].filter((entry) => {
		if (seen.has(entry.id)) return false;
		seen.add(entry.id);
		return true;
	});

	const showOlder = async () => {
		if (!first || !cursor) return;
		const asked = choice.current;
		setBusy(true);
		setOlderFailed(false);
		try {
			const page = await getAgentLog({ data: { slug, agentId: agent.id, kind, before: cursor } });
			if (asked !== choice.current) return;
			if (!page) throw new Error("The log is gone");
			setKept(first);
			setOlder((shown) => [...shown, ...page.entries]);
			setNext(page.next);
		} catch {
			if (asked === choice.current) setOlderFailed(true);
		} finally {
			if (asked === choice.current) setBusy(false);
		}
	};

	return (
		<div className="space-y-3">
			<fieldset className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0">
				<legend className="sr-only">Show</legend>
				{[null, ...KINDS].map((one) => (
					<Button
						key={one ?? "all"}
						type="button"
						size="sm"
						variant="ghost"
						className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
						aria-pressed={kind === one}
						onClick={() => choose(one)}
					>
						{one === null ? "All" : AGENT_LOG_KIND_NAMES[one]}
					</Button>
				))}
			</fieldset>
			{!first ? (
				unread ? (
					<p role="alert" className="text-sm text-destructive">
						The log couldn't be read just now. Try again in a moment.
					</p>
				) : (
					<p className="text-sm text-muted-foreground">Loading…</p>
				)
			) : entries.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					Nothing {kind === null ? "" : "of this kind "}in the last {AGENT_LOG_DAYS} days.
				</p>
			) : (
				<>
					<ul className="divide-y rounded-lg border">
						{entries.map((entry) => (
							<Entry key={entry.id} entry={entry} agentName={agent.name} />
						))}
					</ul>
					{cursor ? (
						<div className="flex items-center gap-3">
							<Button type="button" size="sm" variant="outline" disabled={busy} onClick={showOlder}>
								{busy ? "Loading…" : "Show older"}
							</Button>
							{olderFailed && (
								<p role="alert" className="text-sm text-destructive">
									The older entries couldn't be read. Try again.
								</p>
							)}
						</div>
					) : (
						<p className="text-xs text-muted-foreground">
							The log keeps the last {AGENT_LOG_DAYS} days.
						</p>
					)}
				</>
			)}
		</div>
	);
}

function Entry({ entry, agentName }: { entry: AgentLogEntry; agentName: string }) {
	const { slug } = useWorkspace();
	const who = entry.by.agent ? agentName : (entry.by.name ?? "Someone no longer here");
	// A message's thread opens while its mailbox lasts.
	const thread =
		entry.mailbox?.name != null && entry.thread
			? { mailbox: entry.mailbox.id, thread: entry.thread }
			: null;
	return (
		<li className="flex flex-col gap-0.5 px-4 py-2.5">
			<span className="flex min-w-0 items-baseline gap-3">
				<span className="min-w-0 flex-1 text-sm">
					<span className={entry.by.agent ? undefined : "font-medium"}>{who}</span>{" "}
					{agentLogVerb(entry)}
				</span>
				<time
					className="shrink-0 text-xs text-muted-foreground"
					dateTime={new Date(entry.at).toISOString()}
					title={formatDateTime(entry.at)}
				>
					{formatRelative(entry.at)}
				</time>
			</span>
			{(entry.subject !== null || entry.detail || entry.mailbox) && (
				<span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
					{entry.subject !== null &&
						(thread ? (
							<Link
								to="/$workspace/mailboxes/$mailbox/threads/$thread"
								params={{ workspace: slug, mailbox: thread.mailbox, thread: thread.thread }}
								className="min-w-0 truncate text-foreground hover:underline hover:underline-offset-4"
							>
								{entry.subject || "(no subject)"}
							</Link>
						) : (
							<span className="min-w-0 truncate">{entry.subject || "(no subject)"}</span>
						))}
					{entry.detail && <span className="min-w-0 break-words">{entry.detail}</span>}
					{entry.mailbox && (
						<span className="shrink-0">in {entry.mailbox.name ?? "a mailbox since removed"}</span>
					)}
				</span>
			)}
		</li>
	);
}
