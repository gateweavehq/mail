import { type ReactNode, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";

/**
 * Asks before doing something that cannot be undone. `onConfirm` may be async; the dialog
 * stays open, with its buttons disabled, until it settles.
 */
export function ConfirmDialog({
	title,
	children,
	confirmLabel,
	onConfirm,
	onClose,
}: {
	title: string;
	children: ReactNode;
	confirmLabel: string;
	onConfirm: () => Promise<void> | void;
	onClose: () => void;
}) {
	const [pending, setPending] = useState(false);

	async function confirm() {
		setPending(true);
		try {
			await onConfirm();
		} finally {
			setPending(false);
		}
		onClose();
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{children}</DialogDescription>
				</DialogHeader>
				<DialogFooter className="gap-2">
					<Button variant="outline" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={confirm} disabled={pending}>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
