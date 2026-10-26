/**
 * Display-only text helpers shared by every screen (finesse pass). They
 * never change what is stored — only how it reads.
 */

/** A session title as shown: titles often ARE the learner's raw prompt
 *  ("basics of rust. i have done bit of python tho."), so the first letter
 *  is raised and a lone trailing period dropped. Pure. */
export function displayTitle(title: string): string {
	const t = title.trim().replace(/(?<!\.)\.$/, "");
	return t ? t.charAt(0).toLocaleUpperCase() + t.slice(1) : t;
}

/** A graph topic/source label as shown: notes-import sources are file
 *  names ("learn database.md") — the extension goes. Pure. */
export function displayTopic(name: string): string {
	return displayTitle(name.replace(/\.(md|markdown|txt)$/i, ""));
}
