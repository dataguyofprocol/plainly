"use client";

/**
 * The auto-update banner (Wave C, owner 2026-10-10: silent download +
 * restart-banner UX). The shell pushes "lh:update-status" once a staged
 * update exists (electron/main.cjs update-downloaded); this is the whole
 * renderer surface — a small fixed card, bottom-right, offering Restart.
 * Browser builds have no window.lh and never see a push: renders null.
 *
 * No dismiss: a downloaded update installs on quit anyway
 * (autoInstallOnAppQuit); the banner is a courtesy, not a gate.
 */

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";

// The window.lh bridge type lives in components/sidebar.tsx (the incumbent
// declare-global) — onUpdateStatus/installUpdate are declared there too.

type UpdateStatus = { status: string; version: string | null };

export default function UpdateBanner() {
	const [ready, setReady] = useState<UpdateStatus | null>(null);

	useEffect(() => {
		// Absent bridge (browser / dev) → stays hidden forever.
		return window.lh?.onUpdateStatus?.((s) => {
			if (s?.status === "downloaded") setReady(s);
		});
	}, []);

	if (!ready) return null;
	return (
		<div className="v4 scope">
			<div data-testid="update-banner" role="status" className="pop ub">
				<span className="well" aria-hidden>
					<Icon name="download" size="md" />
				</span>
				<span className="st-text grow-1">
					<span className="ub-t">Update ready</span>
					<span className="ub-d">
						Plainly {ready.version ?? "update"} installs when you restart.
					</span>
				</span>
				<button type="button" onClick={() => window.lh?.installUpdate?.()} className="btn sm brand">
					Restart
				</button>
			</div>
		</div>
	);
}
