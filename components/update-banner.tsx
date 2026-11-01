"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";

type UpdateStatus = { status: string; version: string | null };

export default function UpdateBanner() {
	const [ready, setReady] = useState<UpdateStatus | null>(null);

	useEffect(() => {
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
