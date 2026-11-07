import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { authClient } from "#/lib/auth-client";

/**
 * Emails the signed-in user a link that verifies their address. The link signs them in and
 * returns them to `callbackURL`, or to this page.
 */
export function VerifyEmailButton({
	email,
	callbackURL,
	className,
	variant,
	size,
}: {
	email: string;
	callbackURL?: string;
	className?: string;
	variant?: "default" | "outline";
	size?: "default" | "sm";
}) {
	const [state, setState] = useState<"idle" | "sending" | "sent">("idle");

	async function send() {
		setState("sending");
		const result = await authClient.sendVerificationEmail({
			email,
			callbackURL: callbackURL ?? window.location.pathname,
		});
		if (result.error) {
			setState("idle");
			toast.error("Could not send the link", { description: result.error.message });
			return;
		}
		setState("sent");
	}

	if (state === "sent") {
		return (
			<p className="text-sm" aria-live="polite">
				Sent. Open the link in the email to <span className="font-medium">{email}</span>.
			</p>
		);
	}
	return (
		<Button
			className={className}
			variant={variant}
			size={size}
			onClick={send}
			disabled={state === "sending"}
		>
			Email me a link
		</Button>
	);
}
