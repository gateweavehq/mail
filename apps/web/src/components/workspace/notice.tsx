import type { ReactNode } from "react";

/** A centered message that replaces a page, for empty, missing or unavailable content. */
export function Notice({
	title,
	children,
	action,
}: {
	title: string;
	children?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="flex h-full min-h-80 items-center justify-center p-6">
			<div className="max-w-sm space-y-3 text-center">
				<h2 className="text-base font-medium">{title}</h2>
				{children && <div className="text-sm text-muted-foreground">{children}</div>}
				{action && <div className="pt-2">{action}</div>}
			</div>
		</div>
	);
}
