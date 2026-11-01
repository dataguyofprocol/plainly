import { Home } from "@/components/home";
import { readSettingsRecord } from "@/src/server";
import { slotsConfigured } from "@/src/core";

export const dynamic = "force-dynamic";

export default async function HomePage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
	const { mode } = await searchParams;
	return <Home initialConfigured={slotsConfigured(readSettingsRecord()?.models)} initialMode={mode === "practice" ? "practice" : "teach"} />;
}
