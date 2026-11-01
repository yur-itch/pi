import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { getTabWidth, withComponentWidth, withTerminalWidth } from "../src/tab-width.ts";
import { type Component, CURSOR_MARKER } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import {
	expandTabs,
	extractSegments,
	getGraphemeCellRange,
	getOsc8LinkAtColumn,
	normalizeTerminalOutput,
	sliceWithWidth,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../src/utils.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class CapturingVirtualTerminal extends VirtualTerminal {
	private output = "";

	override write(data: string): void {
		this.output += data;
		super.write(data);
	}

	getOutput(): string {
		return this.output;
	}
}

class TabContent implements Component {
	inputTabWidth?: number;

	render(): string[] {
		return ["\tX", `a\t${CURSOR_MARKER}Z`];
	}

	handleInput(): void {
		this.inputTabWidth = visibleWidth("\t");
	}

	invalidate(): void {}
}

class CachedTabOverlay implements Component {
	private lines?: string[];

	render(): string[] {
		this.lines ??= [expandTabs("\tX")];
		return this.lines;
	}

	invalidate(): void {
		this.lines = undefined;
	}
}

describe("tab width accounting", () => {
	it("switches at 96 columns and restores nested contexts even after errors", () => {
		assert.strictEqual(getTabWidth(), 2);
		assert.strictEqual(getTabWidth(95), 2);
		assert.strictEqual(getTabWidth(96), 4);
		withTerminalWidth(120, () => {
			assert.strictEqual(getTabWidth(), 4);
			withComponentWidth(20, () => assert.strictEqual(getTabWidth(), 4));
			assert.throws(() =>
				withTerminalWidth(80, () => {
					assert.strictEqual(getTabWidth(), 2);
					throw new Error("test");
				}),
			);
			assert.strictEqual(getTabWidth(), 4);
		});
		assert.strictEqual(getTabWidth(), 2);
	});

	for (const columns of [80, 95, 96, 120]) {
		const tabWidth = columns < 96 ? 2 : 4;
		const spaces = " ".repeat(tabWidth);

		it(`measures, slices, truncates, wraps, and hit-tests tabs consistently at ${columns} columns`, () => {
			withTerminalWidth(columns, () => {
				const text = "out 192M\t.pi/skill-tests/results-ha";
				const slice = sliceWithWidth(text, 0, 8 + tabWidth - 1, true);
				assert.strictEqual(slice.text, "out 192M");
				assert.strictEqual(slice.width, 8);
				assert.strictEqual(visibleWidth(slice.text), slice.width);

				const segments = extractSegments(text, 8 + tabWidth - 1, 13, 10, true);
				assert.strictEqual(segments.before, "out 192M");
				assert.strictEqual(segments.beforeWidth, 8);
				const tabFits = extractSegments(text, 8 + tabWidth, 13, 10, true);
				assert.strictEqual(tabFits.before, "out 192M\t");
				assert.strictEqual(tabFits.beforeWidth, 8 + tabWidth);
				assert.strictEqual(visibleWidth(tabFits.before), tabFits.beforeWidth);
				assert.strictEqual(visibleWidth(segments.after), segments.afterWidth);

				assert.strictEqual(visibleWidth("\x1b[1ma\tb\x1b[22m"), 2 + tabWidth);
				// Exercise the Unicode width cache under both policies with exactly the same source.
				assert.strictEqual(visibleWidth("界\t🙂"), 4 + tabWidth);
				assert.strictEqual(visibleWidth("界\t🙂"), 4 + tabWidth);
				assert.strictEqual(normalizeTerminalOutput("a\tb"), `a${spaces}b`);
				assert.strictEqual(truncateToWidth("a\tbcdef", tabWidth + 3, "…"), "a\tb\x1b[0m…\x1b[0m");
				for (const width of [1, 3, 6]) {
					const lines = wrapTextWithAnsi("a\tbc\tdef", width);
					assert.ok(lines.every((line) => visibleWidth(line) <= width));
				}
				assert.deepStrictEqual(getGraphemeCellRange("a\tb", tabWidth), { start: 1, end: 1 + tabWidth });
				const linked = "a\x1b]8;;https://example.test\x07\tb\x1b]8;;\x07z";
				assert.strictEqual(getOsc8LinkAtColumn(linked, tabWidth), "https://example.test");
				assert.strictEqual(getOsc8LinkAtColumn(linked, tabWidth + 2), undefined);
			});
		});

		it(`keeps tabs inside terminal control sequences byte-identical at ${columns} columns`, () => {
			withTerminalWidth(columns, () => {
				for (const control of [
					"\x1b]8;;https://example.test/a\tb\x07",
					"\x1b]0;window\ttitle\x1b\\",
					"\x1b_payload\tdata\x1b\\",
				]) {
					assert.strictEqual(normalizeTerminalOutput(`${control}label\ttext`), `${control}label${spaces}text`);
					assert.strictEqual(expandTabs(`${control}label\ttext`), `${control}label${spaces}text`);
					assert.strictEqual(visibleWidth(`${control}界\t🙂`), 4 + tabWidth);
				}
			});
		});
	}

	it("uses the standalone viewport width and invalidates fixed-width Text and Markdown caches", () => {
		const text = new Text("a\tb", 0, 0);
		const markdown = new Markdown("a\tb\n\n```text\n\tX\n```", 0, 0, defaultMarkdownTheme);
		assert.ok(text.render(95)[0].startsWith("a  b"));
		assert.ok(text.render(96)[0].startsWith("a    b"));
		assert.ok(markdown.render(95).some((line) => stripTerminalSequences(line).trimEnd() === "    X"));
		assert.ok(markdown.render(96).some((line) => stripTerminalSequences(line).trimEnd() === "      X"));

		for (const columns of [120, 80, 120]) {
			withTerminalWidth(columns, () => {
				const spaces = " ".repeat(getTabWidth());
				const textLines = text.render(40);
				assert.ok(textLines[0].startsWith(`a${spaces}b`));
				assert.strictEqual(text.render(40), textLines);
				const markdownLines = markdown.render(40);
				assert.ok(markdownLines.some((line) => stripTerminalSequences(line).trimEnd() === `  ${spaces}X`));
				assert.strictEqual(markdown.render(40), markdownLines);
			});
		}
	});

	for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
		it(`updates raw content, fixed-width overlays, input measurements, and cursor placement in ${Renderer.name}`, async () => {
			const terminal = new CapturingVirtualTerminal(95, 4);
			const tui = new Renderer(terminal, true);
			const content = new TabContent();
			tui.addChild(content);
			tui.setFocus(content);
			tui.showOverlay(new CachedTabOverlay(), { width: 8, row: 2, col: 4, nonCapturing: true });
			tui.start();
			try {
				for (const columns of [95, 96, 120, 80]) {
					terminal.resize(columns, 4);
					await terminal.waitForRender();
					const tabWidth = columns < 96 ? 2 : 4;
					const spaces = " ".repeat(tabWidth);
					const viewport = terminal.getViewport();
					assert.ok(viewport[0].startsWith(`${spaces}X`));
					assert.ok(viewport[1].startsWith(`a${spaces}Z`));
					assert.strictEqual(viewport[2].indexOf("X"), 4 + tabWidth);
					assert.strictEqual(terminal.getCursorPosition().x, 1 + tabWidth);
					terminal.sendInput("x");
					assert.strictEqual(content.inputTabWidth, tabWidth);
				}
				assert.ok(!terminal.getOutput().includes("\t"));
			} finally {
				tui.stop();
			}
		});
	}
});
