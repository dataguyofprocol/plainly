import { redirect } from "next/navigation";
import { listChats } from "@/src/server";

// The Practice destination (v4 rebuild, 2026-10-26): the sidebar's
// "Practice" opens the practice session in progress — the most recent one
// with a problem waiting — and otherwise the home omnibar in Practice mode,
// where a new set starts.
export const dynamic = "force-dynamic";

export default function PracticePage() {
	const open = listChats().find((c) => (c.kind ?? "teach") === "practice" && c.pendingProblem);
	redirect(open ? `/chat/${open.id}` : "/?mode=practice");
}
