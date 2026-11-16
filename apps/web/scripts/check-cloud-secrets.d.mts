export function missingSecrets(
	requiredNames: readonly string[],
	listedNames: readonly string[],
): string[];
export function secretNames(result: {
	status: number | null;
	stdout: string;
	stderr: string;
}): string[];
export function refusal(missing: readonly string[], env: string, name: string): string;
