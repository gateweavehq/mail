import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { LegalLinks } from "#/components/legal-links";
import { LiveButton } from "#/components/live-button";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { getAccount } from "#/lib/session";
import { useDocumentTitle } from "#/lib/title";

// Under /settings because no workspace can be called that, so this takes no workspace's address.
export const Route = createFileRoute("/settings/account")({
	beforeLoad: async () => {
		const { account, legal } = await getAccount();
		if (!account) throw redirect({ to: "/login" });
		return { account, legal };
	},
	component: AccountPage,
});

function AccountPage() {
	const { account, legal } = Route.useRouteContext();
	const [deleted, setDeleted] = useState(false);
	const [signedOut, setSignedOut] = useState(false);
	useDocumentTitle(deleted ? "Account deleted" : signedOut ? "Signed out" : "Your account");

	if (signedOut) {
		return (
			<main className="mx-auto max-w-lg space-y-4 p-6 pt-24">
				<h1 className="text-xl font-semibold tracking-tight">You are signed out everywhere</h1>
				<p className="text-sm text-muted-foreground">
					Every session of this account has ended, here and anywhere else.
				</p>
				<Button variant="outline" size="sm" asChild>
					<Link to="/login">Back to sign-in</Link>
				</Button>
				<LegalLinks links={legal} />
			</main>
		);
	}

	if (deleted) {
		return (
			<main className="mx-auto max-w-lg space-y-4 p-6 pt-24">
				<h1 className="text-xl font-semibold tracking-tight">Your account is deleted</h1>
				<p className="text-sm text-muted-foreground">
					Your account and your place in every workspace are gone.
				</p>
				<Button variant="outline" size="sm" asChild>
					<Link to="/login">Back to sign-in</Link>
				</Button>
				<LegalLinks links={legal} />
			</main>
		);
	}

	return (
		<main className="mx-auto max-w-lg space-y-10 p-6 pt-24">
			<header className="flex items-center justify-between gap-4">
				<div className="min-w-0">
					<h1 className="text-xl font-semibold tracking-tight">Your account</h1>
					<p className="break-words text-sm text-muted-foreground">{account.name}</p>
					<p className="break-words text-sm text-muted-foreground">{account.email}</p>
				</div>
				<Button variant="ghost" size="sm" asChild>
					<Link to="/">Workspaces</Link>
				</Button>
			</header>

			<ChangeName name={account.name} />
			<ChangePassword email={account.email} hasPassword={account.hasPassword} />
			<SignOutEverywhere onSignedOut={() => setSignedOut(true)} />
			<DeleteAccount
				email={account.email}
				hasPassword={account.hasPassword}
				onDeleted={() => setDeleted(true)}
			/>

			<LegalLinks links={legal} />
		</main>
	);
}

/** What to say about a refusal, where the server's own words are not for people. */
function failure(error: { code?: string | undefined; message?: string | undefined }) {
	if (error.code === "SESSION_NOT_FRESH") {
		return "You signed in a while ago. Sign out and sign in again, then try this again.";
	}
	if (error.code === "INVALID_PASSWORD") return "That password is not right.";
	return error.message || "Something went wrong";
}

/** Everyone in someone's workspaces sees this name, which pages read from the database. */
function ChangeName({ name }: { name: string }) {
	const router = useRouter();
	const [value, setValue] = useState(name);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [pending, setPending] = useState(false);
	const next = value.trim();

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		setSaved(false);
		setPending(true);
		const result = await authClient.updateUser({ name: next });
		if (result.error) {
			setPending(false);
			setError(failure(result.error));
			return;
		}
		// The page's own heading comes from the route, which has to ask again.
		await router.invalidate();
		setPending(false);
		setValue(next);
		setSaved(true);
	}

	return (
		<section aria-labelledby="name-heading" className="space-y-4">
			<h2 id="name-heading" className="text-sm font-semibold">
				Name
			</h2>
			<form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
				<div className="space-y-2">
					<Label htmlFor="account-name">Your name</Label>
					<Input
						id="account-name"
						name="name"
						value={value}
						onChange={(event) => {
							setValue(event.target.value);
							setSaved(false);
							setError(null);
						}}
						autoComplete="name"
						maxLength={100}
						required
					/>
					<p className="text-sm text-muted-foreground">Everyone in your workspaces sees it.</p>
				</div>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{saved && (
					<p role="status" className="text-sm text-muted-foreground">
						Your name is changed.
					</p>
				)}
				<LiveButton
					type="submit"
					variant="outline"
					size="sm"
					disabled={pending || !next || next === name}
				>
					Save name
				</LiveButton>
			</form>
		</section>
	);
}

/**
 * Asks for the current password, which the server insists on, as it does for ending every other
 * session: whoever knew the old password may be why it is changing.
 */
function ChangePassword({ email, hasPassword }: { email: string; hasPassword: boolean }) {
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [changed, setChanged] = useState(false);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const newPassword = String(form.get("new-password"));
		setError(null);
		if (newPassword !== String(form.get("new-password-again"))) {
			setError("The new passwords do not match.");
			return;
		}
		setPending(true);
		const result = await authClient.changePassword({
			currentPassword: String(form.get("current-password")),
			newPassword,
			revokeOtherSessions: true,
		});
		setPending(false);
		if (result.error) {
			setError(failure(result.error));
			return;
		}
		setOpen(false);
		setChanged(true);
	}

	return (
		<section aria-labelledby="password-heading" className="space-y-4">
			<h2 id="password-heading" className="text-sm font-semibold">
				Password
			</h2>
			{!hasPassword ? (
				<p className="rounded-lg border p-4 text-sm text-muted-foreground">
					You sign in through GitHub or your sign-in provider, so this account has no password to
					change.
				</p>
			) : open ? (
				<form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
					{/* Tells a password manager which account these passwords belong to. */}
					<input
						type="email"
						name="username"
						autoComplete="username"
						value={email}
						readOnly
						hidden
					/>
					<div className="space-y-2">
						<Label htmlFor="current-password">Current password</Label>
						<Input
							id="current-password"
							name="current-password"
							type="password"
							autoComplete="current-password"
							required
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="new-password">New password</Label>
						<Input
							id="new-password"
							name="new-password"
							type="password"
							autoComplete="new-password"
							minLength={8}
							required
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="new-password-again">New password again</Label>
						<Input
							id="new-password-again"
							name="new-password-again"
							type="password"
							autoComplete="new-password"
							minLength={8}
							required
						/>
					</div>
					<p className="text-sm text-muted-foreground">This signs you out on your other devices.</p>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<div className="flex flex-wrap gap-2">
						<LiveButton type="submit" variant="outline" size="sm" disabled={pending}>
							Save password
						</LiveButton>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => {
								setOpen(false);
								setError(null);
							}}
						>
							Cancel
						</Button>
					</div>
				</form>
			) : (
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border p-4">
					<p className="text-sm text-muted-foreground" role={changed ? "status" : undefined}>
						{changed
							? "Your password is changed, and your other devices are signed out."
							: "Use at least 8 characters."}
					</p>
					<LiveButton
						variant="outline"
						size="sm"
						onClick={() => {
							setChanged(false);
							setOpen(true);
						}}
					>
						Change password
					</LiveButton>
				</div>
			)}
		</section>
	);
}

/**
 * For someone who thinks a cookie of theirs was stolen. It asks for no password, since whoever holds
 * the cookie can use up the tries at one, and on a server without email there is no reset to go to.
 * It ends this session too, because the stolen cookie may be a copy of this browser's and nobody can
 * tell. Those tries don't limit signing in again.
 */
function SignOutEverywhere({ onSignedOut }: { onSignedOut: () => void }) {
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function endThem() {
		setError(null);
		setPending(true);
		const result = await authClient.revokeSessions();
		if (result.error) {
			setPending(false);
			setError(failure(result.error));
			return;
		}
		onSignedOut();
	}

	return (
		<section aria-labelledby="everywhere-heading" className="space-y-4">
			<h2 id="everywhere-heading" className="text-sm font-semibold">
				Sign out everywhere
			</h2>
			<div className="space-y-2 rounded-lg border p-4">
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
					<p className="text-sm text-muted-foreground">Ends every session, this one too.</p>
					<LiveButton variant="outline" size="sm" disabled={pending} onClick={endThem}>
						Sign out everywhere
					</LiveButton>
				</div>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
			</div>
		</section>
	);
}

/**
 * Asks for the password where there is one, which the server insists on. An account without one
 * types its address, which guards only against a slip: for those, a recent session is all the proof
 * there is.
 */
function DeleteAccount({
	email,
	hasPassword,
	onDeleted,
}: {
	email: string;
	hasPassword: boolean;
	onDeleted: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		setError(null);
		if (!hasPassword && String(form.get("address")).trim().toLowerCase() !== email.toLowerCase()) {
			setError("That is not the address of this account.");
			return;
		}
		setPending(true);
		const result = await authClient.$fetch("/account/delete", {
			method: "POST",
			body: hasPassword ? { password: String(form.get("password")) } : {},
		});
		if (result.error) {
			setPending(false);
			setError(failure(result.error));
			return;
		}
		onDeleted();
	}

	return (
		<section aria-labelledby="delete-heading" className="space-y-4">
			<h2 id="delete-heading" className="text-sm font-semibold">
				Delete account
			</h2>
			{open ? (
				<form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
					<p className="text-sm text-muted-foreground">
						This removes your account and takes you out of your workspaces. It cannot be undone.
					</p>
					<ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
						<li>Workspaces you belong to stay with the people still in them.</li>
						<li>Invitations you sent that nobody has taken stop working.</li>
					</ul>
					{hasPassword ? (
						<>
							{/* Tells a password manager which account this password belongs to. */}
							<input
								type="email"
								name="username"
								autoComplete="username"
								value={email}
								readOnly
								hidden
							/>
							<div className="space-y-2">
								<Label htmlFor="delete-password">Your password</Label>
								<Input
									id="delete-password"
									name="password"
									type="password"
									autoComplete="current-password"
									required
								/>
							</div>
						</>
					) : (
						<div className="space-y-2">
							<Label htmlFor="delete-address">Type your email address to confirm</Label>
							<Input id="delete-address" name="address" type="email" autoComplete="off" required />
						</div>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<div className="flex flex-wrap gap-2">
						<LiveButton type="submit" variant="destructive" size="sm" disabled={pending}>
							Delete my account
						</LiveButton>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => {
								setOpen(false);
								setError(null);
							}}
						>
							Keep it
						</Button>
					</div>
				</form>
			) : (
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border p-4">
					<p className="text-sm text-muted-foreground">Remove this account for good.</p>
					<LiveButton variant="outline" size="sm" onClick={() => setOpen(true)}>
						Delete account
					</LiveButton>
				</div>
			)}
		</section>
	);
}
