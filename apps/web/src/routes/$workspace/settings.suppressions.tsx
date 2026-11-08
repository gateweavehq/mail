import { createFileRoute } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdminRole, useMyRole, useWorkspace } from "#/components/workspace/context";
import { formatDateTime } from "#/lib/dates";
import {
	type Suppression,
	type SuppressionsPage,
	suppressionLabel,
	suppressionMeaning,
	suppressionsUrl,
} from "#/lib/suppressions";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/suppressions")({
	component: SuppressionsSettings,
});

function SuppressionsSettings() {
	const admin = isAdminRole(useMyRole());
	useDocumentTitle("Suppressions");
	return (
		<section aria-labelledby="suppressions-heading" className="space-y-4">
			<div className="space-y-1">
				<h2 id="suppressions-heading" className="text-sm font-semibold">
					Suppressions
				</h2>
				<p className="text-sm text-muted-foreground">
					No mailbox of this workspace sends to these addresses: mail to them bounced for good,
					their person marked it as spam, or the provider's own list has them. A complaint stays
					until it is removed here. A bounce or a refusal ends by itself after a week, except a
					bounce for a mailbox or domain that doesn't exist.
				</p>
			</div>
			{admin ? (
				<SuppressionList />
			) : (
				<p className="text-sm text-muted-foreground">
					Only an owner or admin can see suppressions.
				</p>
			)}
		</section>
	);
}

type Loaded = { ok: true; page: SuppressionsPage } | { ok: false; error: string };

async function load(workspace: string, query: string, before: string | null): Promise<Loaded> {
	const params = new URLSearchParams();
	if (query) params.set("q", query);
	if (before) params.set("before", before);
	try {
		const response = await fetch(`${suppressionsUrl(workspace)}?${params}`);
		const body = (await response.json()) as SuppressionsPage | { ok: false; error: string };
		return "suppressions" in body ? { ok: true, page: body } : body;
	} catch {
		return { ok: false, error: "The list didn't load. Try again." };
	}
}

function SuppressionList() {
	const { slug } = useWorkspace();
	const [query, setQuery] = useState("");
	const [shown, setShown] = useState<{
		query: string;
		entries: Suppression[];
		next: string | null;
	}>({ query: "", entries: [], next: null });
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const search = useCallback(
		async (text: string, before: string | null = null) => {
			setLoading(true);
			setError(null);
			const result = await load(slug, text, before);
			if (result.ok) {
				setShown((now) => ({
					query: text,
					entries: before
						? [...now.entries, ...result.page.suppressions]
						: result.page.suppressions,
					next: result.page.next,
				}));
			} else {
				setError(result.error);
			}
			setLoading(false);
		},
		[slug],
	);

	useEffect(() => {
		void search("");
	}, [search]);

	function submit(event: FormEvent) {
		event.preventDefault();
		void search(query.trim());
	}

	return (
		<div className="space-y-4">
			<form
				aria-label="Search suppressions"
				onSubmit={submit}
				className="flex flex-wrap items-end gap-2"
			>
				<div className="min-w-0 flex-1 space-y-1.5">
					<Label htmlFor="suppression-search">Address</Label>
					<Input
						id="suppression-search"
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Part of an address"
						maxLength={254}
						autoComplete="off"
					/>
				</div>
				<Button type="submit" variant="outline" disabled={loading}>
					Search
				</Button>
			</form>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{shown.entries.length > 0 ? (
				<ul aria-label="Suppressions" className="space-y-3">
					{shown.entries.map((entry) => (
						<SuppressionRow
							key={entry.id}
							entry={entry}
							onRemoved={() =>
								setShown((now) => ({
									...now,
									entries: now.entries.filter((one) => one.id !== entry.id),
								}))
							}
						/>
					))}
				</ul>
			) : (
				!loading &&
				!error && (
					<p className="text-sm text-muted-foreground">
						{shown.query ? "No suppressed address matches." : "No address is suppressed."}
					</p>
				)
			)}
			{loading && <p className="text-sm text-muted-foreground">Loading…</p>}
			{shown.next && !loading && (
				<Button variant="outline" size="sm" onClick={() => void search(shown.query, shown.next)}>
					Show more
				</Button>
			)}
		</div>
	);
}

function SuppressionRow({ entry, onRemoved }: { entry: Suppression; onRemoved: () => void }) {
	const { slug } = useWorkspace();
	const [asking, setAsking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function remove() {
		setError(null);
		try {
			const response = await fetch(suppressionsUrl(slug), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "remove", id: entry.id }),
			});
			const body = (await response.json()) as { ok: true } | { ok: false; error: string };
			setAsking(false);
			// Gone either way: removed now, or by someone else before.
			if (body.ok || response.status === 404) onRemoved();
			else setError(body.error);
		} catch {
			setAsking(false);
			setError("That didn't reach the server. Try again.");
		}
	}

	const provider = entry.provider === "resend" ? "Resend" : "Email Service";
	return (
		<li className="space-y-2 rounded-lg border p-4">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0 space-y-1">
					<p className="flex items-start gap-2 text-sm">
						<CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
						<span className="min-w-0 break-all font-medium">{entry.address}</span>
					</p>
					<p className="text-sm">
						{suppressionLabel(entry.reason)}{" "}
						<span className="text-muted-foreground">· {suppressionMeaning(entry.reason)}</span>
					</p>
				</div>
				<Button size="sm" variant="ghost" onClick={() => setAsking(true)}>
					Remove
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				Since {formatDateTime(entry.firstAt)}, said by {provider}
				{entry.lastAt > entry.firstAt ? `, again ${formatDateTime(entry.lastAt)}` : ""}.{" "}
				{entry.expiresAt === null
					? "Until it is removed."
					: `Until ${formatDateTime(entry.expiresAt)}.`}
			</p>
			{entry.detail && (
				<p className="break-all font-mono text-xs text-muted-foreground">{entry.detail}</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{asking && (
				<ConfirmDialog
					title={`Remove ${entry.address}?`}
					confirmLabel="Remove"
					onConfirm={remove}
					onClose={() => setAsking(false)}
				>
					Mailboxes of this workspace can send to it again. {provider} keeps a list of its own, and
					may still refuse it: an entry there ends by itself, or comes off where the provider's own
					suppressions are listed.
				</ConfirmDialog>
			)}
		</li>
	);
}
