/**
 * The v4 icon names — kept as thin aliases over the one icon system
 * (components/ui/icon.tsx, Lucide behind a tuned wrapper) so call sites
 * read naturally. New code should use <Icon name="…" /> directly.
 */

import { Icon, LogoMark, type IconSize } from "@/components/ui/icon";

type P = { size?: number; className?: string };

const px = (size: number | undefined, fallback: IconSize): IconSize =>
	size === undefined ? fallback : size <= 12 ? "xs" : size <= 14 ? "sm" : size <= 17 ? "md" : size <= 21 ? "lg" : "xl";

export { LogoMark };
export const HomeIcon = ({ size, className }: P) => <Icon name="home" size={px(size, "md")} className={className} />;
export const KnowledgeIcon = ({ size, className }: P) => <Icon name="knowledge" size={px(size, "md")} className={className} />;
export const PracticeIcon = ({ size, className }: P) => <Icon name="practice" size={px(size, "md")} className={className} />;
export const SettingsIcon = ({ size, className }: P) => <Icon name="settings" size={px(size, "md")} className={className} />;
export const SessionsIcon = ({ size, className }: P) => <Icon name="sessions" size={px(size, "lg")} className={className} />;
export const PlusIcon = ({ size, className }: P) => <Icon name="plus" size={px(size, "md")} className={className} />;
export const AttachIcon = ({ size, className }: P) => <Icon name="attach" size={px(size, "md")} className={className} />;
export const MicIcon = ({ size, className }: P) => <Icon name="mic" size={px(size, "md")} className={className} />;
export const PlanMapIcon = ({ size, className }: P) => <Icon name="plan" size={px(size, "md")} className={className} />;
export const ChevronDownIcon = ({ size, className }: P) => <Icon name="chevron-down" size={px(size, "xs")} className={className} />;
export const CheckIcon = ({ size, className }: P) => <Icon name="check" size={px(size, "sm")} className={className} />;
export const SearchIcon = ({ size, className }: P) => <Icon name="search" size={px(size, "sm")} className={className} />;
