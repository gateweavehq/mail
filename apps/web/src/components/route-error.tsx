import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import { Notice } from "#/components/workspace/notice";

/** What a page shows when it fails to load, with a retry. */
export function RouteError({ error }: ErrorComponentProps) {
	const router = useRouter();
	return (
		<Notice
			title="Something went wrong"
			action={
				<Button variant="outline" onClick={() => void router.invalidate()}>
					Try again
				</Button>
			}
		>
			{error instanceof Error && error.message ? error.message : "This page could not be loaded."}
		</Notice>
	);
}
