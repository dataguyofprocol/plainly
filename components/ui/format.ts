export function displayTitle(title: string): string {
	const t = title.trim().replace(/(?<!\.)\.$/, "");
	return t ? t.charAt(0).toLocaleUpperCase() + t.slice(1) : t;
}

export function displayTopic(name: string): string {
	return displayTitle(name.replace(/\.(md|markdown|txt)$/i, ""));
}
