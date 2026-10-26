import { redirect } from "next/navigation";

/**
 * The old sessionless draft view (/chat/new) is gone with the v4 rebuild
 * (2026-10-26): sessions start from the home omnibar (or ⌘K), which runs
 * the same pre-send guards. The URL stays routed — bookmarks and the
 * practice deep link land on the omnibar in the right mode.
 */
export default async function NewSessionPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
	const { mode } = await searchParams;
	redirect(mode === "practice" ? "/?mode=practice" : "/");
}
