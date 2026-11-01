import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { setTimeout } from "node:timers/promises";
import { codeFormatter } from "../src/code-formatter.ts";
import { Markdown } from "../src/components/markdown.ts";
import { withTerminalWidth } from "../src/tab-width.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

afterEach(() => {
	mock.restoreAll();
	codeFormatter.dispose();
});

describe("Markdown code formatting", () => {
	it("formats before highlighting and subtracts margins and code indentation", () => {
		const format = mock.method(codeFormatter, "format", () => "call(\n  first,\n  second,\n);");
		const highlighted: string[] = [];
		const markdown = new Markdown("```ts\ncall(first,second)\n```", 2, 0, {
			...defaultMarkdownTheme,
			highlightCode: (code) => {
				highlighted.push(code);
				return code.split("\n");
			},
		});
		const lines = markdown.render(50).map((line) => stripTerminalSequences(line).trimEnd());
		assert.deepEqual(format.mock.calls[0].arguments, ["call(first,second)", "ts", 44]);
		assert.deepEqual(highlighted, ["call(\n  first,\n  second,\n);"]);
		assert.deepEqual(lines, ["  ```ts", "    call(", "      first,", "      second,", "    );", "  ```"]);
	});

	it("accounts for nested list and quote prefixes", () => {
		const format = mock.method(codeFormatter, "format", (code: string) => code);
		const markdown = new Markdown("- > ```ts\n  > call(first,second)\n  > ```", 1, 0, defaultMarkdownTheme);
		markdown.render(50);
		assert.deepEqual(format.mock.calls[0].arguments, ["call(first,second)", "ts", 42]);
	});

	it("never submits open, partially closed, indented, or explicitly disabled fences", () => {
		const format = mock.method(codeFormatter, "format", (code: string) => code);
		for (const source of [
			"```ts\nconst x=1",
			"```ts\nconst x=1\n``",
			"````ts\nconst x=1\n```",
			"~~~~ts\nconst x=1\n~~~",
			"    const x=1",
		]) {
			new Markdown(source, 0, 0, defaultMarkdownTheme).render(80);
		}
		new Markdown("```ts\nconst x=1\n```", 0, 0, defaultMarkdownTheme, undefined, { formatCode: false }).render(80);
		assert.equal(format.mock.callCount(), 0);
	});

	it("recognizes longer closers, tildes, and fence trailing whitespace", () => {
		const format = mock.method(codeFormatter, "format", (code: string) => code);
		for (const source of ["```ts\nconst x=1\n````  \n", "~~~~ts\nconst x=1\n~~~~\t\n"]) {
			new Markdown(source, 0, 0, defaultMarkdownTheme).render(80);
		}
		assert.equal(format.mock.callCount(), 2);
	});

	it("passes original tabs to the formatter instead of changing source literals first", () => {
		const source = 'const text="\t";';
		const format = mock.method(codeFormatter, "format", () => 'const text = "\\t";');
		const markdown = new Markdown(`\`\`\`ts\n${source}\n\`\`\``, 0, 0, defaultMarkdownTheme);
		assert.ok(stripTerminalSequences(markdown.render(80).join("\n")).includes('const text = "\\t";'));
		assert.equal(format.mock.calls[0].arguments[0], source);
	});

	it("invalidates only affected blocks when a reused streaming block finishes formatting", async () => {
		const { promise, resolve } = Promise.withResolvers<string>();
		let ready = false;
		mock.method(codeFormatter, "format", () => (ready ? "const x = 1;" : promise));
		let headings = 0;
		const markdown = new Markdown("# Title\n\n```ts\nconst x=1\n```", 0, 0, {
			...defaultMarkdownTheme,
			heading: (text) => {
				headings++;
				return text;
			},
		});
		markdown.render(80);
		markdown.setText("# Title\n\n```ts\nconst x=1\n```\n\nafter");
		markdown.render(80);
		const headingsBeforeCompletion = headings;
		ready = true;
		resolve("const x = 1;");
		await promise;
		const output = stripTerminalSequences(markdown.render(80).join("\n"));
		assert.ok(output.includes("const x = 1;"));
		assert.ok(output.includes("after"));
		assert.equal(headings, headingsBeforeCompletion);
	});

	it("ignores stale formatting completions after a resize", async () => {
		const { promise, resolve } = Promise.withResolvers<string>();
		mock.method(codeFormatter, "format", (_code: string, _language: string | undefined, width: number) =>
			width > 40 ? promise : "const x = 1;",
		);
		const markdown = new Markdown("```ts\nconst x=1\n```", 0, 0, defaultMarkdownTheme);
		markdown.render(80);
		const narrow = markdown.render(40);
		resolve("const x = 1;");
		await promise;
		assert.equal(markdown.render(40), narrow);
	});

	it("still wraps indivisible code that overflows after formatting", () => {
		const formatted = `const text = "${"x".repeat(100)}";`;
		mock.method(codeFormatter, "format", () => formatted);
		const markdown = new Markdown("```ts\nconst text='long'\n```", 1, 0, defaultMarkdownTheme);
		const lines = markdown.render(24);
		assert.ok(lines.every((line) => visibleWidth(line) <= 24));
		const content = lines
			.slice(1, -1)
			.map((line) => stripTerminalSequences(line).trim())
			.join("");
		assert.ok(content.includes("x".repeat(100)));
	});

	it("renders real formatter tabs with the enclosing terminal policy at the same code width", async () => {
		const source = "function example(){if(active){run(firstArgument,secondArgument,thirdArgument)}}";
		const markdown = new Markdown(`\`\`\`ts\n${source}\n\`\`\``, 0, 0, defaultMarkdownTheme);
		for (const columns of [95, 96, 80]) {
			const formatted = await withTerminalWidth(columns, () => codeFormatter.format(source, "ts", 38));
			assert.match(formatted, /^\tif/m);
			const lines = withTerminalWidth(columns, () => markdown.render(40)).map(stripTerminalSequences);
			const tabWidth = columns < 96 ? 2 : 4;
			assert.ok(lines.some((line) => line.trimEnd() === `${" ".repeat(2 + tabWidth)}if (active) {`));
			assert.ok(lines.every((line) => visibleWidth(line) <= 40));
		}
	});

	it("automatically repaints the live terminal when real formatting completes", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TuiMainScreen(terminal);
		const markdown = new Markdown("```ts\nconst live={first:1,second:2,third:3}\n```", 0, 0, defaultMarkdownTheme);
		tui.addChild(markdown);
		tui.start();
		try {
			await terminal.waitForRender();
			await codeFormatter.format("const live={first:1,second:2,third:3}", "ts", 38);
			// Worker completion requests a frame without additional input or a resize.
			for (let attempt = 0; attempt < 100; attempt++) {
				if (terminal.getViewport().join("\n").includes("const live = {")) break;
				await setTimeout(10);
			}
			const output = terminal.getViewport().join("\n");
			assert.ok(output.includes("const live = {"), output);
			assert.ok(output.includes("first: 1"), output);
		} finally {
			tui.stop();
		}
	});
});
