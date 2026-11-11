import { Link } from "@tanstack/react-router";
import { Bot } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "#/components/workspace/context";
import { agentLogVerb } from "#/lib/agent-log";
import { type AgentGlance, GLANCE_HOURS, getAgentsAtAGlance } from "#/lib/agents";
import { formatDateTime, formatRelative } from "#/lib/dates";

/** How often the home looks at the agents again while it is in sight, as an agent's page does. */
const REFRESH_MS = 15_000;

// A key used this much after the last thing logged was used for something the log doesn't note.
const UNLOGGED_USE_MS = 60_000;

const many = (count: number, one: string, more = `${one}s`) =>
	`${count} ${count === 1 ? one : more}`;

/** What an agent did of late, in a few words. */
export function recentSummary({ sent, held, reads }: AgentGlance["recent"]): string {
	const parts = [
		sent > 0 && `${sent} sent`,
		held > 0 && `${held} held for approval`,
		reads > 0 && many(reads, "read"),
	].filter((part) => part !== false);
	const since = GLANCE_HOURS === 24 ? "the last day" : `the last ${GLANCE_HOURS} hours`;
	return parts.length > 0 ? `In ${since}: ${parts.join(", ")}` : `Nothing in ${since}`;
}

/**
 * The workspace's agents, for an owner or admin: each one's name, whether it is paused, the
 * addresses it holds and what it did of late, with a link to its page. It looks again every so
 * often while in sight, asking for the agents only, so the rest of the home stays as it is. Keyed
 * by the workspace where it is used, so another's home starts from its own.
 */
export function AgentsAtAGlance({ initial }: { initial: AgentGlance[] }) {
	const { slug } = useWorkspace();
	const [agents, setAgents] = useState<AgentGlance[] | null>(initial);
	// Each answer counts only if nothing newer came since it was asked for: a look that set out
	// before the page's own reload, or before a later look, is left.
	const latest = useRef(0);
	// The page's own reload, as after a change to a mailbox, brings them too.
	useEffect(() => {
		latest.current += 1;
		setAgents(initial);
	}, [initial]);
	useEffect(() => {
		let gone = false;
		const look = async () => {
			if (document.visibilityState !== "visible") return;
			const asked = ++latest.current;
			try {
				const fresh = await getAgentsAtAGlance({ data: slug });
				if (!gone && asked === latest.current) setAgents(fresh);
			} catch {
				// Offline or a deploy: the next look tries again, and what is shown stays.
			}
		};
		const timer = setInterval(look, REFRESH_MS);
		document.addEventListener("visibilitychange", look);
		return () => {
			gone = true;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", look);
		};
	}, [slug]);

	// No longer an owner or admin: nothing to show.
	if (!agents) return null;

	return (
		<section aria-labelledby="agents-heading" className="space-y-3">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h2 id="agents-heading" className="text-sm font-medium">
					Agents
				</h2>
				<Link
					to="/$workspace/settings/agents"
					params={{ workspace: slug }}
					className="text-sm text-muted-foreground underline-offset-4 hover:underline"
				>
					{agents.length > 0 ? "Manage agents" : "Make an agent"}
				</Link>
			</div>
			{agents.length > 0 ? (
				<ul aria-label="Agents" className="divide-y rounded-lg border">
					{agents.map((agent) => (
						<AgentGlanceRow key={agent.id} agent={agent} />
					))}
				</ul>
			) : (
				<p className="text-sm text-muted-foreground">
					An agent is an AI with its own key: it can read and send the mail of the mailboxes it is
					given, and make addresses of its own. What each one does shows here.
				</p>
			)}
		</section>
	);
}

/** The last thing an agent did, and when, then its key's use since, which the log doesn't note. */
function lastSummary({ last, keyUsedAt }: AgentGlance) {
	const lines = [];
	if (last) {
		const verb = agentLogVerb({ action: last.action, detail: null });
		lines.push(
			<p key="last" title={formatDateTime(last.at)}>
				{`Last ${verb}, ${formatRelative(last.at)}`}
			</p>,
		);
	}
	if (keyUsedAt !== null && keyUsedAt > (last?.at ?? 0) + UNLOGGED_USE_MS) {
		lines.push(
			<p key="key" title={formatDateTime(keyUsedAt)}>
				{`Used its key ${formatRelative(keyUsedAt)}`}
			</p>,
		);
	}
	return lines.length > 0 ? lines : <p>Hasn't used its key yet</p>;
}

function AgentGlanceRow({ agent }: { agent: AgentGlance }) {
	const { slug } = useWorkspace();
	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
			<Bot
				aria-hidden
				className="size-8 shrink-0 rounded-full border p-1.5 text-muted-foreground"
			/>
			<div className="min-w-0 flex-1 basis-48">
				<p className="flex min-w-0 items-center gap-2 text-sm font-medium">
					<Link
						to="/$workspace/settings/agents/$agent"
						params={{ workspace: slug, agent: agent.id }}
						className="truncate underline-offset-4 hover:underline"
					>
						{agent.name}
					</Link>
					{agent.paused && (
						<span
							className="shrink-0 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground"
							title={`Paused ${agent.paused.by ? `by ${agent.paused.by} ` : ""}${formatRelative(agent.paused.at)}`}
						>
							Paused
						</span>
					)}
				</p>
				<p className="text-xs text-muted-foreground">{recentSummary(agent.recent)}</p>
			</div>
			<div className="min-w-0 pl-11 text-xs text-muted-foreground sm:pl-0 sm:text-right">
				<p>
					{agent.liveAddresses > 0
						? `Holds ${many(agent.liveAddresses, "address", "addresses")}`
						: "No addresses of its own"}
				</p>
				{lastSummary(agent)}
			</div>
		</li>
	);
}
