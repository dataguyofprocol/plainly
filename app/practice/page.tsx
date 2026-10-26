import { redirect } from "next/navigation";

// "Practice" (owner, 2026-10-26: one uniform flow): practice starts the way
// a lesson does — type a topic — so this route opens Home's field ready to
// practise. Unfinished practice sessions are resumed from the sidebar,
// never opened on the learner's behalf.
export default function PracticePage() {
	redirect("/?mode=practice");
}
