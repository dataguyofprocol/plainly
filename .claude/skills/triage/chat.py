#!/usr/bin/env python3
"""Find and print Plainly chat records for triage.

  chat.py list [-n 10]                      newest chats across every data dir
  chat.py find "<text fragment>"            chats whose JSON contains the fragment
  chat.py dump <chat.json> [--from N] [--to M] [--width W] [--thinking]

Reads only <data dir>/chats/*.json. Never opens auth.json or settings.
Run with `python3 -I` from the repo root.
"""

import argparse
import glob
import json
import os
import sys

HOME = os.path.expanduser("~")
DATA_DIRS = [
	f"{HOME}/Library/Application Support/Plainly/data",
	f"{HOME}/Library/Application Support/Plainly-dev/data",
	f"{HOME}/Library/Application Support/LearnHarness/data",
	"data",
	".fresh-data",
]


def chat_files():
	for d in DATA_DIRS:
		yield from glob.glob(os.path.join(d, "chats", "*.json"))


def load(path):
	with open(path, encoding="utf-8") as f:
		return json.load(f)


def summary(path):
	try:
		d = load(path)
	except (OSError, json.JSONDecodeError) as e:
		return f"{path}\n    unreadable: {e}"
	model = (d.get("settings") or {}).get("model", "?")
	n = len(d.get("messages", []))
	return f"{path}\n    {d.get('updatedAt', '?')}  {n} msgs  model={model}  title={d.get('title', '')!r}"


def clip(s, width):
	s = s.replace("\n", "⏎ ")
	return s if width <= 0 or len(s) <= width else s[:width] + f"… (+{len(s) - width})"


def parts(content):
	if isinstance(content, str):
		return [{"type": "text", "text": content}]
	return content if isinstance(content, list) else []


def dump(path, start, end, width, thinking):
	d = load(path)
	msgs = d.get("messages", [])
	print(f"# {d.get('title', '')!r}  id={d.get('id')}  settings={d.get('settings')}  {len(msgs)} msgs")
	for i, m in enumerate(msgs[start:end], start):
		role = m.get("role")
		head = f"[{i}] {role}"
		if role == "assistant":
			head += f"  model={m.get('model')}  stop={m.get('stopReason')}"
			if m.get("rawStopReason") not in (None, m.get("stopReason")):
				head += f" raw={m.get('rawStopReason')}"
		elif role == "toolResult":
			head += f"  {m.get('toolName')}" + ("  ERROR" if m.get("isError") else "")
		elif role == "custom":
			head += f"  {m.get('customType')}"
		print(head)
		for p in parts(m.get("content")):
			t = p.get("type")
			if t == "text":
				print("    text:", clip(p.get("text", ""), width))
			elif t == "toolCall":
				args = json.dumps(p.get("arguments"), ensure_ascii=False)
				print(f"    call {p.get('name')}:", clip(args, width))
			elif t == "thinking":
				body = p.get("thinking", "")
				print("    thinking:", clip(body, width) if thinking else f"({len(body)} chars)")
			else:
				print(f"    {t}:", clip(json.dumps(p, ensure_ascii=False), width))


def main():
	ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	sub = ap.add_subparsers(dest="cmd", required=True)
	ls = sub.add_parser("list")
	ls.add_argument("-n", type=int, default=10)
	fd = sub.add_parser("find")
	fd.add_argument("fragment")
	dp = sub.add_parser("dump")
	dp.add_argument("file")
	dp.add_argument("--from", dest="start", type=int, default=0)
	dp.add_argument("--to", dest="end", type=int, default=None)
	dp.add_argument("--width", type=int, default=400, help="0 = no clipping")
	dp.add_argument("--thinking", action="store_true", help="print thinking text, not just its length")
	a = ap.parse_args()

	if a.cmd == "list":
		files = sorted(chat_files(), key=os.path.getmtime, reverse=True)[: a.n]
		for f in files:
			print(summary(f))
	elif a.cmd == "find":
		hits = 0
		for f in chat_files():
			with open(f, encoding="utf-8", errors="replace") as fh:
				raw = fh.read()
			# Stored JSON escapes newlines and quotes, so also try the escaped form.
			needle_json = json.dumps(a.fragment, ensure_ascii=False)[1:-1]
			if a.fragment in raw or needle_json in raw:
				hits += 1
				print(summary(f))
		if not hits:
			print("no chat contains that fragment in: " + ", ".join(DATA_DIRS), file=sys.stderr)
			sys.exit(1)
	else:
		dump(a.file, a.start, a.end, a.width, a.thinking)


if __name__ == "__main__":
	main()
