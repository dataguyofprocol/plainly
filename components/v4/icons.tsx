/**
 * The v4 icon set — the stroke icons drawn in the design, verbatim, so the
 * shell reads exactly as the artboards do. All decorative (aria-hidden):
 * the control carrying one always has its own label.
 */

type P = { size?: number; className?: string };

export function LogoMark({ size = 20 }: P) {
	return (
		<svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none">
			<circle cx="7" cy="16" r="4.5" fill="#156e62" />
			<circle cx="17" cy="7" r="3.5" stroke="#156e62" strokeWidth="2" />
			<path d="M10 13l4.5-4" stroke="#156e62" strokeWidth="2" strokeLinecap="round" />
		</svg>
	);
}

export function HomeIcon({ size = 15 }: P) {
	return (
		<svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
			<path d="M4 10.5L12 4l8 6.5V20h-5.5v-5.5h-5V20H4z" />
		</svg>
	);
}

export function KnowledgeIcon({ size = 15 }: P) {
	return (
		<svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
			<circle cx="6" cy="6" r="2.5" />
			<circle cx="18" cy="9" r="2.5" />
			<circle cx="9" cy="18" r="2.5" />
			<path d="M8.3 7.2l7.4 1.2M7 8.4l1.4 7.2M16.4 11l-5.6 5.4" />
		</svg>
	);
}

export function PracticeIcon({ size = 15 }: P) {
	return (
		<svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
			<circle cx="12" cy="12" r="8" />
			<circle cx="12" cy="12" r="4" />
		</svg>
	);
}

export function SettingsIcon({ size = 15 }: P) {
	return (
		<svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
			<path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
			<circle cx="16" cy="7" r="2" />
			<circle cx="10" cy="17" r="2" />
		</svg>
	);
}

export function SessionsIcon({ size = 18 }: P) {
	return (
		<svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
			<path d="M5 6h14M5 12h14M5 18h9" />
		</svg>
	);
}

export function PlusIcon({ size = 16 }: P) {
	return (
		<svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
			<path d="M12 5v14M5 12h14" />
		</svg>
	);
}

export function AttachIcon({ size = 15 }: P) {
	return (
		<svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
			<path d="M21 12.5l-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.5-8.5" />
		</svg>
	);
}

export function MicIcon({ size = 15 }: P) {
	return (
		<svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
			<rect x="9" y="3" width="6" height="11" rx="3" />
			<path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
		</svg>
	);
}

export function PlanMapIcon({ size = 16 }: P) {
	return (
		<svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
			<circle cx="5" cy="6" r="2" />
			<circle cx="5" cy="18" r="2" />
			<circle cx="19" cy="12" r="2" />
			<path d="M7 6h4a3 3 0 0 1 3 3v0a3 3 0 0 0 3 3M7 18h4a3 3 0 0 0 3-3v0a3 3 0 0 1 3-3" />
		</svg>
	);
}

export function ChevronDownIcon({ size = 10 }: P) {
	return (
		<svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
			<path d="M6 9l6 6 6-6" />
		</svg>
	);
}

export function CheckIcon({ size = 12, className }: P) {
	return (
		<svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={className}>
			<path d="M5 12.5l4.5 4.5L19 7" />
		</svg>
	);
}

export function SearchIcon({ size = 13 }: P) {
	return (
		<svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
			<circle cx="11" cy="11" r="6.5" />
			<path d="M20 20l-4-4" />
		</svg>
	);
}
