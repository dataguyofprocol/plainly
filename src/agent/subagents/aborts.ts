/**
 * The registry lives on globalThis: Next dev gives each route entry its own
 * module instances, so a module-level Map would be a different object in each.
 */

interface LhAbortGlobal {
	__lhJobAborts?: Map<string, AbortController>;
}

function registry(): Map<string, AbortController> {
	const g = globalThis as typeof globalThis & LhAbortGlobal;
	return (g.__lhJobAborts ??= new Map());
}

export function registerJobAbort(jobId: string, controller: AbortController): void {
	registry().set(jobId, controller);
}

export function unregisterJobAbort(jobId: string): void {
	registry().delete(jobId);
}

export function isJobLive(jobId: string): boolean {
	return registry().has(jobId);
}

/** Abort a running job's loop. Returns false when no controller is live —
 * the job's loop is not executing (crashed, or in the delivering-result
 * phase where the runner has already returned); the caller then owns the
 * whole abort on the record side. */
export function fireJobAbort(jobId: string): boolean {
	const controller = registry().get(jobId);
	if (!controller) return false;
	registry().delete(jobId);
	controller.abort();
	return true;
}
