import { type FormEvent, useState } from "react";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { useWorkspace } from "#/components/workspace/context";
import { authClient } from "#/lib/auth-client";
import { formatShortDate } from "#/lib/dates";
import type { ProviderKeyInfo, ResendAccess } from "#/lib/providers";

/** What the page knows of the workspace's Resend key: whether one can be kept here, and which. */
export interface ResendKeyState {
	unavailable: string | null;
	key: ProviderKeyInfo | null;
}

function failure(
	error: { code?: string | undefined; message?: string | undefined },
	fallback: string,
) {
	if (error.code === "SESSION_NOT_FRESH") {
		return "This needs a recent sign-in. Sign out and sign in again, then try again.";
	}
	return error.message || fallback;
}

const accessWords = (access: ResendAccess) =>
	access === "sending"
		? "Resend takes it. It can only send, so Mail can't make the webhook that tells it what became of the mail it sends, or of mail Resend receives."
		: "Resend takes it. It has full access to the Resend account, which Mail needs to make the webhook that tells it what became of the mail it sends, and of mail Resend receives.";

/** The workspace's Resend key, for owners and admins: add, check, replace or remove it. */
export function ResendKey({
	state,
	onChanged,
}: {
	state: ResendKeyState | null;
	onChanged: () => Promise<void>;
}) {
	const { id: organizationId } = useWorkspace();
	const [replacing, setReplacing] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [checking, setChecking] = useState(false);
	const [said, setSaid] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	if (!state) {
		return (
			<p role="status" className="text-sm text-muted-foreground">
				Loading…
			</p>
		);
	}
	if (state.unavailable) {
		return (
			<p className="text-sm text-muted-foreground">
				{state.unavailable} Whoever runs this server can set one; the self-hosting guide says how.
			</p>
		);
	}

	async function check() {
		setChecking(true);
		setError(null);
		setSaid(null);
		const result = await authClient.providers.checkKey({ organizationId, provider: "resend" });
		setChecking(false);
		if (result.error) setError(failure(result.error, "The key wasn't checked. Try again."));
		else setSaid(accessWords(result.data.access));
	}

	async function remove() {
		setError(null);
		setSaid(null);
		const result = await authClient.providers.removeKey({ organizationId, provider: "resend" });
		setRemoving(false);
		if (result.error) setError(failure(result.error, "The key wasn't removed. Try again."));
		else await onChanged();
	}

	const { key } = state;
	return (
		<div className="space-y-3">
			{key && !replacing ? (
				<div className="space-y-3 rounded-lg border p-4">
					<p className="text-sm">
						<span className="font-mono">re_…{key.hint}</span>
						<span className="text-muted-foreground">
							, added by {key.addedBy ?? "someone no longer here"} on {formatShortDate(key.addedAt)}
						</span>
					</p>
					<div className="flex flex-wrap gap-2">
						<LiveButton size="sm" variant="outline" disabled={checking} onClick={check}>
							{checking ? "Checking…" : "Check key"}
						</LiveButton>
						<Button size="sm" variant="outline" onClick={() => setReplacing(true)}>
							Replace
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
							Remove
						</Button>
					</div>
				</div>
			) : (
				<AddKey
					replacing={key !== null}
					onCancel={key ? () => setReplacing(false) : null}
					onAdded={async (access, note) => {
						setReplacing(false);
						setError(note);
						setSaid(accessWords(access));
						await onChanged();
					}}
				/>
			)}
			{said && (
				<p role="status" className="text-sm text-muted-foreground">
					{said}
				</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{removing && (
				<ConfirmDialog
					title="Remove the Resend key?"
					confirmLabel="Remove key"
					onConfirm={remove}
					onClose={() => setRemoving(false)}
				>
					Mail from domains that send through Resend isn't sent until a key is added again, and mail
					waiting to be tried again is refused.
				</ConfirmDialog>
			)}
		</div>
	);
}

function AddKey({
	replacing,
	onCancel,
	onAdded,
}: {
	replacing: boolean;
	onCancel: (() => void) | null;
	/** With what the workspace's domains can't do with the key, if anything. */
	onAdded: (access: ResendAccess, note: string | null) => Promise<void>;
}) {
	const { id: organizationId } = useWorkspace();
	const [key, setKey] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		const result = await authClient.providers.setKey({
			organizationId,
			provider: "resend",
			key: key.trim(),
		});
		setPending(false);
		if (result.error) {
			setError(failure(result.error, "The key wasn't saved. Try again."));
			return;
		}
		setKey("");
		await onAdded(result.data.access, result.data.note);
	}

	return (
		<form onSubmit={onSubmit} className="space-y-3 rounded-lg border p-4">
			<div className="space-y-2">
				<Label htmlFor="resend-key">{replacing ? "New Resend key" : "Resend key"}</Label>
				<Input
					id="resend-key"
					type="password"
					autoComplete="off"
					spellCheck={false}
					placeholder="re_…"
					value={key}
					onChange={(event) => setKey(event.target.value)}
					required
				/>
				<p className="text-xs text-muted-foreground">
					Resend checks it before it is kept. It is kept encrypted and never shown again.
				</p>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				<LiveButton type="submit" size="sm" disabled={pending || !key.trim()}>
					{pending ? "Checking with Resend…" : replacing ? "Replace key" : "Add key"}
				</LiveButton>
				{onCancel && (
					<Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
						Cancel
					</Button>
				)}
			</div>
		</form>
	);
}
