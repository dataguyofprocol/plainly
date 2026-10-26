import type { Metadata } from "next";
import { JetBrains_Mono, Literata, Manrope } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, ShellProvider } from "@/components/sidebar";
import "./v4.css";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";

// v4 redesign (light, 2026-10-26): chrome = Manrope, teaching prose and
// titles = Literata, numbers/code = JetBrains Mono. next/font self-hosts all
// three at build time — the desktop app makes no font requests at runtime.
const ui = Manrope({ subsets: ["latin"], variable: "--font-manrope" });
const prose = Literata({ subsets: ["latin"], variable: "--font-literata", style: ["normal", "italic"] });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className={`${ui.variable} ${prose.variable} ${mono.variable}`}>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<AppearanceProvider>
					<ShellProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</ShellProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
		</body>
		</html>
	);
}
