import { redirect } from "next/navigation";

export default async function NewSessionPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
	const { mode } = await searchParams;
	redirect(mode === "practice" ? "/?mode=practice" : "/");
}
