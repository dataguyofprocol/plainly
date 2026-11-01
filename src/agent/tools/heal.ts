import type { AgentTool } from "@earendil-works/pi-agent-core";
import { healEncodedArguments } from "../../core/argument-heal.ts";

export { healEncodedArguments };

export function withArgumentHeal(tool: AgentTool<any>): AgentTool<any> {
	const inner = tool.prepareArguments;
	return {
		...tool,
		prepareArguments: (args: unknown) => healEncodedArguments(inner ? inner(args) : args, tool.parameters),
	};
}

export function healToolRecord(tools: Record<string, AgentTool<any>>): Record<string, AgentTool<any>> {
	return Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, withArgumentHeal(tool)]));
}
