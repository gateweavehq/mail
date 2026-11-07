import { useHydrated } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { Button } from "#/components/ui/button";

/**
 * A button that works only through the page's script, and so stays disabled until there is one. In
 * a form this matters more than it looks: pressed before the script has run, a submit button makes
 * the browser send the form itself, as a GET, with the password in the URL. Disabling the button
 * stops that, Enter included.
 */
export function LiveButton({ disabled, ...props }: ComponentProps<typeof Button>) {
	const hydrated = useHydrated();
	return <Button {...props} disabled={disabled || !hydrated} />;
}
