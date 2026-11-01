/**
 * Mints a short-lived Deepgram token so the renderer never holds the key.
 * Deepgram checks the token only at the WebSocket handshake, so a dictation
 * session outlives the 300s TTL. The key needs the Member role or higher to
 * call /auth/grant (Deepgram token-based auth FAQ).
 */
import { keyValue } from "@/src/server";

export async function GET() {
	const key = keyValue("DEEPGRAM_API_KEY");
	if (!key) {
		return Response.json(
			{ message: "No DEEPGRAM_API_KEY — add it to auth.json (desktop) or .env.local (dev)." },
			{ status: 503 },
		);
	}

	try {
		const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
			method: "POST",
			headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ttl_seconds: 300 }),
		});
		if (!res.ok) {
			const detail = await res.text();
			if (res.status === 401 || res.status === 403) {
				return Response.json(
					{
						message:
							res.status === 403
								? "Deepgram rejected the key (403): it needs the Member role or higher"
								: "Deepgram rejected the key (401): check it was pasted correctly",
						reason: "key-rejected",
					},
					{ status: 502 },
				);
			}
			return Response.json(
				{ message: `Deepgram token grant failed (${res.status}): ${detail.slice(0, 200)}` },
				{ status: 502 },
			);
		}
		const data = (await res.json()) as { access_token?: string };
		if (!data.access_token) {
			return Response.json({ message: "Deepgram grant returned no token" }, { status: 502 });
		}
		return Response.json({ token: data.access_token });
	} catch {
		return Response.json({ message: "Deepgram unreachable" }, { status: 502 });
	}
}
