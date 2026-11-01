import { stripTerminalSequences, type TUI, withTerminalWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { formatToolCallWithArgs } from "../src/core/tools/render-utils.ts";
import { readRenderers } from "../src/core/tools/renderers/read.ts";
import { writeRenderers } from "../src/core/tools/renderers/write.ts";
import { codemodeRenderers } from "../src/extensions/codemode/renderer.ts";
import { createMcpToolRenderers } from "../src/extensions/mcp/tools.ts";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const tui = { requestRender() {} } as unknown as TUI;

function markerColumn(row: ToolExecutionComponent, columns: number): number {
	return withTerminalWidth(columns, () => {
		const lines = row.render(60).map(stripTerminalSequences);
		const line = lines.find((line) => line.includes("marker()"));
		if (!line) throw new Error("Missing tab-indented marker in tool output");
		return line.indexOf("marker()");
	});
}

describe("renderer-wide tabs in tool output", () => {
	beforeAll(() => initTheme("dark"));

	it("preserves literal tabs in expanded generic arguments until layout", () => {
		const args = { code: "header\n\tmarker()" };
		const text = formatToolCallWithArgs("example", args, theme, true);
		expect(text).toContain("\tmarker()");
		expect(args.code).toBe("header\n\tmarker()");
	});

	it("adapts highlighted read output without rebuilding the tool result", () => {
		const row = new ToolExecutionComponent("read", "r", { path: "example.ts" }, {}, readRenderers, tui, "/");
		row.setExpanded(true);
		const output = "function example() {\n\tmarker();\n}";
		row.updateResult({ content: [{ type: "text", text: output }], isError: false });
		const narrow = markerColumn(row, 95);
		expect(markerColumn(row, 96)).toBe(narrow + 2);
		expect(markerColumn(row, 80)).toBe(narrow);
	});

	it("keeps tabs in streaming and completed write highlight caches", () => {
		const content = "function example() {\n\tmarker();\n}";
		const row = new ToolExecutionComponent(
			"write",
			"w",
			{ path: "example.ts", content },
			{},
			writeRenderers,
			tui,
			"/",
		);
		const narrow = markerColumn(row, 95);
		expect(markerColumn(row, 96)).toBe(narrow + 2);
		row.updateArgs({ path: "example.ts", content: `${content}\n// continued` });
		expect(markerColumn(row, 120)).toBe(narrow + 2);
		row.setArgsComplete();
		expect(markerColumn(row, 80)).toBe(narrow);
	});

	it("keeps tabs in codemode script highlighting", () => {
		const row = new ToolExecutionComponent(
			"codemode",
			"c",
			{ code: "if (active) {\n\tmarker();\n}" },
			{},
			codemodeRenderers,
			tui,
			"/",
		);
		const narrow = markerColumn(row, 95);
		expect(markerColumn(row, 96)).toBe(narrow + 2);
		expect(markerColumn(row, 80)).toBe(narrow);
	});

	it("adapts MCP and codemode output in collapsed and expanded views", () => {
		for (const renderers of [createMcpToolRenderers("test/tabs"), codemodeRenderers]) {
			const row = new ToolExecutionComponent("example", "o", {}, {}, renderers, tui, "/");
			row.updateResult({ content: [{ type: "text", text: "header\n\tmarker()" }], isError: false });
			const narrow = markerColumn(row, 95);
			expect(markerColumn(row, 96)).toBe(narrow + 2);
			row.setExpanded(true);
			expect(markerColumn(row, 120)).toBe(narrow + 2);
			expect(markerColumn(row, 80)).toBe(narrow);
		}
	});

	it("preserves tabs through context, added, removed, and intra-line diff highlighting", () => {
		for (const diff of [
			" 1 \tmarker()",
			"+1 \tmarker()",
			"-1 \tmarker()",
			"-1 \told()\n+1 \tmarker()",
			"-1 \told()\n-2 \told_again()\n+1 \tmarker()",
		]) {
			const rendered = renderDiff(diff);
			expect(stripTerminalSequences(rendered)).toContain("\tmarker()");
		}
	});
});
