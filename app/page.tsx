import { Home } from "@/components/home";
import { readSettingsRecord } from "@/src/server";
import { slotsConfigured } from "@/src/core";

// Dynamic: the configured state is server-rendered into the page (the
// setup card's truth on the first frame), and every navigation re-reads
// the record (dynamic routes aren't cached client-side).
export const dynamic = "force-dynamic";

export default function HomePage() {
	// First-run gate (model-slots wave): sessions cannot start until the
	// models are picked — the home shows the setup card until they are.
	return <Home initialConfigured={slotsConfigured(readSettingsRecord()?.models)} />;
}
