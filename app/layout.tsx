import type { Metadata } from "next";
import { JetBrains_Mono, Literata, Manrope } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, ShellProvider } from "@/components/sidebar";
import "./v4.css";
import "./ui/shell.css";
import "./ui/home.css";
import "./ui/lesson.css";
import "./ui/dock.css";
import "./ui/knowledge.css";
import "./ui/settings.css";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import { THEME_BOOT_SCRIPT } from "@/components/theme-boot";
import UpdateBanner from "@/components/update-banner";

const ui = Manrope({ subsets: ["latin"], variable: "--font-manrope" });
const prose = Literata({ subsets: ["latin"], variable: "--font-literata", style: ["normal", "italic"] });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
	title: "Plainly",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		// suppressHydrationWarning: the boot script rewrites data-theme before hydration.
		<html lang="en" data-theme="light" className={`${ui.variable} ${prose.variable} ${mono.variable}`} suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
			</head>
			<body className="min-h-dvh antialiased">
			<ServerEventsProvider>
				<AppearanceProvider>
					<ShellProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</ShellProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			<UpdateBanner />
		</body>
		</html>
	);
}
