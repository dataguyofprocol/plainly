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
	"arrow-right": ArrowRight,
	"arrow-left": ArrowLeft,
	"arrow-down": ArrowDown,
	"arrow-up": ArrowUp,
	"chevron-down": ChevronDown,
	"chevron-up": ChevronUp,
	"chevron-left": ChevronLeft,
	"chevron-right": ChevronRight,
	"chevrons-up-down": ChevronsUpDown,
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
	label?: string;
	strokeWidth?: number;
}) {
	const Glyph = ICONS[name];
	const px = SIZES[size];
	return (
		<Glyph
			width={px}
			height={px}
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

export function LogoMark({ size = 22 }: { size?: number }) {
	return (
		<svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flex: "none" }}>
			<rect width="24" height="24" rx="7" fill="var(--brand)" />
			<rect x="0.5" y="0.5" width="23" height="23" rx="6.5" stroke="rgb(255 255 255 / 0.14)" />
			<path d="M5 9q2.333-2.5 4.667 0t4.667 0t4.666 0" stroke="var(--on-ink)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" opacity="0.5" />
			<path d="M5 15H13" stroke="var(--on-ink)" strokeWidth="2" strokeLinecap="round" />
			<circle cx="18" cy="15" r="2" fill="#F2B95B" />
		</svg>
	);
}
