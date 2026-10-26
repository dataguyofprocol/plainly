/**
 * THE ICON SYSTEM (finesse pass, 2026-10-26) — the ONLY module that imports
 * lucide-react. Every icon in the app is <Icon name="…" />: one stroke
 * weight (1.75), three sizes (sm 14 · md 16 · lg 20), decorative by
 * default (the control carrying it owns the label), and a semantic name
 * map so a concept always draws the same glyph (Practice is always a
 * target, Knowledge always a network). Need a glyph that isn't here?
 * Add a semantic name to ICONS — never import lucide-react elsewhere.
 */

import type { CSSProperties } from "react";
import {
	Archive,
	ArchiveRestore,
	ArrowDown,
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	ArrowUpRight,
	BookOpen,
	Bot,
	Brain,
	ChartColumn,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	ChevronsUpDown,
	CircleAlert,
	CircleCheck,
	CircleDot,
	CircleHelp,
	CirclePause,
	CircleX,
	Clock,
	Command,
	Copy,
	CornerDownLeft,
	Cpu,
	Download,
	Ellipsis,
	ExternalLink,
	Eye,
	EyeOff,
	FileText,
	Flag,
	FolderOpen,
	GraduationCap,
	History,
	House,
	Image,
	Info,
	KeyRound,
	Keyboard,
	Layers,
	Library,
	Lightbulb,
	Link,
	ListTree,
	Loader,
	Maximize2,
	MessageCircle,
	Milestone,
	Mic,
	Minimize2,
	Minus,
	Network,
	Palette,
	PanelLeft,
	PanelRight,
	Paperclip,
	PenLine,
	PenTool,
	Play,
	Plug,
	Plus,
	RefreshCw,
	RotateCcw,
	Route,
	Scan,
	Search,
	Settings2,
	SlidersHorizontal,
	Tags,
	Sparkles,
	Square,
	Target,
	Telescope,
	Trash2,
	Upload,
	Wand2,
	Waypoints,
	X,
	Zap,
	type LucideIcon,
} from "lucide-react";

export const ICONS = {
	// Places
	home: House,
	knowledge: Waypoints,
	graph: Waypoints,
	topics: Tags,
	session: BookOpen,
	practice: Target,
	lesson: BookOpen,
	sessions: Layers,
	settings: Settings2,
	plan: Route,
	path: Milestone,
	tree: Network,
	library: Library,
	// Actions
	plus: Plus,
	minus: Minus,
	close: X,
	check: Check,
	search: Search,
	attach: Paperclip,
	mic: Mic,
	send: ArrowUp,
	stop: Square,
	enter: CornerDownLeft,
	copy: Copy,
	download: Download,
	upload: Upload,
	import: FolderOpen,
	edit: PenLine,
	delete: Trash2,
	archive: Archive,
	unarchive: ArchiveRestore,
	retry: RotateCcw,
	refresh: RefreshCw,
	expand: Maximize2,
	fit: Scan,
	collapse: Minimize2,
	external: ExternalLink,
	open: ArrowUpRight,
	more: Ellipsis,
	show: Eye,
	hide: EyeOff,
	play: Play,
	link: Link,
	sidebar: PanelLeft,
	panel: PanelRight,
	command: Command,
	// Direction
	"arrow-right": ArrowRight,
	"arrow-left": ArrowLeft,
	"arrow-down": ArrowDown,
	"arrow-up": ArrowUp,
	"chevron-down": ChevronDown,
	"chevron-up": ChevronUp,
	"chevron-left": ChevronLeft,
	"chevron-right": ChevronRight,
	"chevrons-up-down": ChevronsUpDown,
	// Status
	"status-ok": CircleCheck,
	"status-error": CircleX,
	"status-warn": CircleAlert,
	"status-paused": CirclePause,
	"status-live": CircleDot,
	help: CircleHelp,
	info: Info,
	loading: Loader,
	time: Clock,
	flag: Flag,
	// Concepts
	idea: Lightbulb,
	thinking: Brain,
	ask: MessageCircle,
	hint: Sparkles,
	agent: Bot,
	research: Telescope,
	demo: Play,
	figure: Image,
	draw: PenTool,
	pdf: FileText,
	file: FileText,
	outline: ListTree,
	history: History,
	stats: ChartColumn,
	learn: GraduationCap,
	magic: Wand2,
	// Settings sections
	key: KeyRound,
	provider: Plug,
	model: Cpu,
	appearance: Palette,
	keyboard: Keyboard,
	tune: SlidersHorizontal,
	fast: Zap,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

const SIZES = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24 } as const;
export type IconSize = keyof typeof SIZES;

export function Icon({
	name,
	size = "md",
	className,
	style,
	label,
	strokeWidth,
}: {
	name: IconName;
	size?: IconSize;
	className?: string;
	style?: CSSProperties;
	/** Only when the icon stands alone as content; controls label themselves. */
	label?: string;
	strokeWidth?: number;
}) {
	const Glyph = ICONS[name];
	const px = SIZES[size];
	return (
		<Glyph
			width={px}
			height={px}
			// Optical weight: hairlines read thin at 12–14px, heavy at 20+.
			strokeWidth={strokeWidth ?? (px <= 14 ? 2 : px >= 20 ? 1.6 : 1.75)}
			absoluteStrokeWidth={false}
			className={className ? `ic ${className}` : "ic"}
			style={style}
			aria-hidden={label ? undefined : true}
			aria-label={label}
			role={label ? "img" : undefined}
			focusable="false"
		/>
	);
}

/**
 * The LearnHarness mark: two ideas joined by the link that connects them,
 * on a brand tile. Drawn on a 24px grid; stays crisp from 16 to 32px.
 */
export function LogoMark({ size = 22 }: { size?: number }) {
	return (
		<svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flex: "none" }}>
			<rect width="24" height="24" rx="7" fill="var(--brand)" />
			<rect x="0.5" y="0.5" width="23" height="23" rx="6.5" stroke="rgb(255 255 255 / 0.14)" />
			<circle cx="8.25" cy="15.75" r="3.25" fill="var(--on-ink)" />
			<circle cx="16" cy="8" r="2.5" stroke="var(--on-ink)" strokeWidth="1.75" />
			<path d="M10.6 13.4l3.6-3.6" stroke="var(--on-ink)" strokeWidth="1.75" strokeLinecap="round" />
		</svg>
	);
}
