import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { LegalLinks } from "#/components/legal-links";
import { LiveButton } from "#/components/live-button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { safeRedirect } from "#/lib/redirect";
import { getAuthOptions, getSession } from "#/lib/session";
import { signInRefusal } from "#/lib/sign-in-refusal";
import { SIGN_UP_CLOSED_MESSAGE } from "#/lib/sign-up-allow";

const loginSearch = z.object({
	/** Where to go once signed in, such as the invitation that sent the user here. */
	redirect: z.string().optional().catch(undefined),
	/** Prefills the email field, for example with the address an invitation was sent to. */
	email: z.string().optional().catch(undefined),
	mode: z.enum(["sign-in", "sign-up"]).optional().catch(undefined),
	/** Why a sign-in through GitHub or another provider came back here. */
	error: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/login")({
	validateSearch: loginSearch,
	beforeLoad: async ({ search }) => {
		if (await getSession()) throw redirect({ href: safeRedirect(search.redirect) ?? "/" });
	},
	loader: () => getAuthOptions(),
	component: SignInForm,
});

/** The provider's id in Better Auth. The server's constant is out of the browser's reach. */
const OIDC_PROVIDER = "oidc";

/** This page's address without why the last attempt came back, for a refusal to return to. */
function thisPage() {
	const query = new URLSearchParams(window.location.search);
	query.delete("error");
	query.delete("error_description");
	const rest = query.toString();
	return `/login${rest && `?${rest}`}`;
}

/** "Continue with …": sends someone to GitHub or the configured provider, and back to `next`. */
function ProviderButton({
	provider,
	label,
	next,
	onFailure,
}: {
	provider: "github" | typeof OIDC_PROVIDER;
	label: string;
	next: string;
	onFailure: (message: string | null) => void;
}) {
	const [pending, setPending] = useState(false);

	async function onClick() {
		setPending(true);
		onFailure(null);
		const result = await authClient.signIn.social({
			provider,
			callbackURL: next,
			errorCallbackURL: thisPage(),
		});
		if (result.error) {
			// Mail finds out what a provider offers only now, and cannot tell it if the provider is down.
			onFailure(
				result.error.code === "PROVIDER_NOT_FOUND"
					? `We could not reach ${label}. Try again, or use your password.`
					: (result.error.message ?? "Something went wrong"),
			);
		}
		// Going back from the provider can bring this page back as it was, so it must not stay disabled.
		setPending(false);
	}

	return (
		<LiveButton variant="outline" className="w-full" disabled={pending} onClick={onClick}>
			{`Continue with ${label}`}
		</LiveButton>
	);
}

function SignInForm() {
	const options = Route.useLoaderData();
	const search = Route.useSearch();
	const next = safeRedirect(search.redirect) ?? "/";
	const router = useRouter();
	// While sign-up is closed the form makes no account for anyone, an invited address included:
	// the server refuses it, so the page never offers it, whatever the link that led here asks.
	const closed = options.signUpClosed;
	const [mode, setMode] = useState<"sign-in" | "sign-up">(
		closed ? "sign-in" : (search.mode ?? "sign-in"),
	);
	// Someone new and someone whose account could not be linked are sent back with different
	// codes. On a closed server both read the same here, so the page says nothing about which.
	const [error, setError] = useState(() =>
		signInRefusal(
			closed && search.error === "account_not_linked" ? "SIGN_UP_CLOSED" : search.error,
		),
	);
	const providers = [options.oidc, options.github ? "GitHub" : null].filter(
		(name): name is string => Boolean(name),
	);
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const email = String(form.get("email"));
		const password = String(form.get("password"));
		setPending(true);
		setError(null);
		const result =
			mode === "sign-in"
				? await authClient.signIn.email({ email, password })
				: await authClient.signUp.email({
						email,
						password,
						name: String(form.get("name")),
						// Where the verification email brings them back to, such as an invitation.
						callbackURL: next,
					});
		if (result.error) {
			setPending(false);
			setError(result.error.message ?? "Something went wrong");
			return;
		}
		if (mode === "sign-up" && options.email) {
			toast.success("Check your email", {
				description: `We sent a link to verify ${email}.`,
			});
		}
		setPending(false);
		await router.invalidate();
		await router.navigate({ href: next });
	}

	return (
		<main className="flex min-h-svh items-center justify-center p-6">
			<div className="w-full max-w-sm space-y-6">
				<div className="space-y-1.5 text-center">
					<h1 className="text-xl font-semibold tracking-tight">
						{mode === "sign-in" ? "Sign in to Gateweave Mail" : "Create your account"}
					</h1>
					<p className="text-sm text-muted-foreground">
						Mailboxes for people and agents, on Cloudflare.
					</p>
				</div>

				{closed && (
					<div
						role="note"
						aria-label="Sign-up is closed"
						className="space-y-1 rounded-lg border p-3 text-center text-sm text-muted-foreground"
					>
						<p>{SIGN_UP_CLOSED_MESSAGE}</p>
						{providers.length > 0 && (
							<p>{`Invited? Continue with ${providers.join(" or ")}, under the address your invitation names.`}</p>
						)}
						{options.askForAccess && (
							<p>
								<a
									href={options.askForAccess}
									target="_blank"
									rel="noreferrer"
									className="font-medium text-foreground underline underline-offset-4"
								>
									Ask for access
								</a>
							</p>
						)}
					</div>
				)}

				{(options.oidc || options.github) && (
					<>
						{options.oidc && (
							<ProviderButton
								provider={OIDC_PROVIDER}
								label={options.oidc}
								next={next}
								onFailure={setError}
							/>
						)}
						{options.github && (
							<ProviderButton provider="github" label="GitHub" next={next} onFailure={setError} />
						)}
						<div className="flex items-center gap-3 text-xs text-muted-foreground">
							<span className="h-px flex-1 bg-border" />
							or
							<span className="h-px flex-1 bg-border" />
						</div>
					</>
				)}

				<form onSubmit={onSubmit} className="space-y-4">
					{mode === "sign-up" && (
						<div className="space-y-2">
							<Label htmlFor="name">Name</Label>
							<Input id="name" name="name" autoComplete="name" maxLength={100} required />
						</div>
					)}
					<div className="space-y-2">
						<Label htmlFor="email">Email</Label>
						<Input
							id="email"
							name="email"
							type="email"
							autoComplete="email"
							defaultValue={search.email}
							required
						/>
					</div>
					<div className="space-y-2">
						<div className="flex items-baseline justify-between">
							<Label htmlFor="password">Password</Label>
							{mode === "sign-in" && options.email && (
								<Link
									to="/forgot-password"
									search={{ email: search.email }}
									className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
								>
									Forgot password?
								</Link>
							)}
						</div>
						<Input
							id="password"
							name="password"
							type="password"
							minLength={8}
							autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
							required
						/>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<LiveButton type="submit" className="w-full" disabled={pending}>
						{mode === "sign-in" ? "Sign in" : "Create account"}
					</LiveButton>
				</form>

				{!closed && (
					<p className="text-center text-sm text-muted-foreground">
						{mode === "sign-in" ? "New to Gateweave Mail? " : "Already have an account? "}
						<button
							type="button"
							className="font-medium text-foreground underline-offset-4 hover:underline"
							onClick={() => {
								setMode(mode === "sign-in" ? "sign-up" : "sign-in");
								setError(null);
							}}
						>
							{mode === "sign-in" ? "Create an account" : "Sign in"}
						</button>
					</p>
				)}

				<LegalLinks links={options.legal} agreeing />
			</div>
		</main>
	);
}
