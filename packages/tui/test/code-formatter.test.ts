// biome-ignore-all lint/complexity/useLiteralKeys: Bracket access intentionally inspects private cache and worker bounds.
import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";
import { CodeFormatter, type CodeFormatterOptions } from "../src/code-formatter.ts";
import { withTerminalWidth } from "../src/tab-width.ts";
import { visibleWidth } from "../src/utils.ts";

const formatters: CodeFormatter[] = [];
function createFormatter(options?: CodeFormatterOptions): CodeFormatter {
	const formatter = new CodeFormatter(options);
	formatters.push(formatter);
	return formatter;
}

afterEach(() => {
	for (const formatter of formatters) formatter.dispose();
	formatters.length = 0;
});

describe("Code formatter", () => {
	it("does not load runtimes for unsupported languages or oversized snippets", () => {
		const formatter = createFormatter({ maxSourceBytes: 32 });
		for (const language of [undefined, "text", "__proto__", "constructor", "../../evil"]) {
			assert.equal(formatter.format("const x=1", language, 80), "const x=1");
		}
		assert.equal(formatter.format("x".repeat(17), "ts", 80), "x".repeat(17));
		assert.equal(formatter["runtimes"].size, 0);
	});

	it("coalesces aliases and widths within a bucket and caches plain formatted source", async () => {
		const formatter = createFormatter();
		const pending = formatter.format("const answer={first:1,second:2}", "ts", 80);
		assert.ok(pending instanceof Promise);
		assert.equal(formatter.format("const answer={first:1,second:2}", "TypeScript extra-info", 87), pending);
		const result = await pending;
		assert.equal(result, "const answer = { first: 1, second: 2 };");
		assert.equal(formatter.format("const answer={first:1,second:2}", "typescript", 81), result);
		assert.ok(formatter.format("const answer={first:1,second:2}", "ts", 79) instanceof Promise);
	});

	it("formats at the lower bucket bound and separates file types and source", async () => {
		const formatter = createFormatter();
		const source = "const answer=call(firstArgument,secondArgument,thirdArgument)";
		const formatted = await formatter.format(source, "ts", 39);
		assert.notEqual(formatted, source);
		assert.ok(formatted.includes("\n"));
		assert.ok(formatted.split("\n").every((line) => visibleWidth(line) <= 32));
		assert.ok(formatter.format(source, "js", 39) instanceof Promise);
		assert.ok(formatter.format(`${source};\nconst extra=1`, "ts", 39) instanceof Promise);
	});

	it("formats JSX, TSX, JSONC, and Python using their real parsers", async () => {
		const formatter = createFormatter();
		for (const [language, source, expected] of [
			["jsx", "const element=<div title='hello'/>;", 'const element = <div title="hello" />;'],
			["tsx", "const element:Element=<div/>;", "const element: Element = <div />;"],
			["jsonc", '{"a":1,// comment\n"b":2}', '"a": 1'],
			["python", "def example( a,b ):\n    return [a,b]", "def example(a, b):"],
		]) {
			const result = await formatter.format(source, language, 40);
			assert.notEqual(result, source, language);
			assert.ok(result.includes(expected), `${language}: ${result}`);
		}
	});

	it("emits indentation tabs for all supported formatter families and file types", async () => {
		const formatter = createFormatter();
		for (const [language, source] of [
			["js", "function example(){if(active){run(firstArgument,secondArgument)}}"],
			["ts", "function example(){if(active){run(firstArgument,secondArgument)}}"],
			["jsx", "function example(){return <div title='hello'><span>world</span></div>}"],
			["tsx", "function example(){return <div title='hello'><span>world</span></div>}"],
			["json", '{"outer":{"firstArgument":1,"secondArgument":2,"thirdArgument":3}}'],
			["jsonc", '{"outer":{"firstArgument":1,"secondArgument":2,"thirdArgument":3}}'],
			["py", "def example():\n    if active:\n        run(first_argument, second_argument)"],
		]) {
			const formatted = await formatter.format(source, language, 40);
			assert.notEqual(formatted, source, language);
			assert.match(formatted, /^\t+\S/m, language);
		}
	});

	it("keys pending and cached formatting by the terminal tab width, not only the code width", async () => {
		const formatter = createFormatter();
		const source = "function example(){if(active){run(firstArgument,secondArgument,thirdArgument)}}";
		const narrow = withTerminalWidth(95, () => formatter.format(source, "ts", 40));
		const wide = withTerminalWidth(96, () => formatter.format(source, "ts", 40));
		assert.ok(narrow instanceof Promise);
		assert.ok(wide instanceof Promise);
		assert.notEqual(narrow, wide);
		const results = await Promise.all([narrow, wide]);
		for (const [index, columns] of [95, 96].entries()) {
			withTerminalWidth(columns, () => {
				assert.ok(results[index].split("\n").every((line) => visibleWidth(line) <= 40));
				assert.equal(formatter.format(source, "ts", 40), results[index]);
			});
		}
		assert.equal(formatter["cache"].size, 2);
	});

	it("caches parser failures without changing original whitespace", async () => {
		const formatter = createFormatter();
		for (const language of ["ts", "json", "py"]) {
			const source = "const = {\t\r\n\n";
			assert.equal(await formatter.format(source, language, 40), source);
			assert.equal(formatter.format(source, language, 40), source);
		}
	});

	it("evicts result entries in LRU order", async () => {
		const formatter = createFormatter({ maxCacheEntries: 2 });
		await formatter.format("const a=1", "ts", 80);
		await formatter.format("const b=2", "ts", 80);
		assert.equal(typeof formatter.format("const a=1", "ts", 80), "string");
		await formatter.format("const c=3", "ts", 80);
		assert.equal(typeof formatter.format("const a=1", "ts", 80), "string");
		assert.ok(formatter.format("const b=2", "ts", 80) instanceof Promise);
	});

	it("bounds cached output by bytes, including keys", async () => {
		const formatter = createFormatter({ maxCacheBytes: 240 });
		for (const name of ["first", "second", "third"]) {
			await formatter.format(`const ${name}=1`, "ts", 80);
			assert.ok(formatter["cacheBytes"] <= 240);
		}
		assert.equal(formatter["cache"].size, 1);
		assert.equal(formatter.format("x".repeat(121), "ts", 80), "x".repeat(121));
	});

	it("evicts idle language workers in LRU order without losing formatted results", async () => {
		const formatter = createFormatter({ maxWorkers: 2 });
		await formatter.format("const a=1", "ts", 80);
		const typescript = formatter["runtimes"].get("typescript")!;
		await formatter.format('{"a":1}', "json", 80);
		const json = formatter["runtimes"].get("json")!;
		// A new formatting uses TS again; cache hits need not keep its runtime resident.
		await formatter.format("const b=2", "ts", 80);
		const exited = once(json.worker, "exit");
		await formatter.format("print( 1 )", "py", 80);
		await exited;
		assert.equal(formatter["runtimes"].get("typescript"), typescript);
		assert.equal(formatter["runtimes"].has("json"), false);
		assert.equal(formatter["runtimes"].size, 2);
		assert.equal(typeof formatter.format('{"a":1}', "json", 80), "string");
	});

	it("queues other languages instead of evicting a busy worker", async () => {
		const formatter = createFormatter({ maxWorkers: 1 });
		const typescript = formatter.format("const x=1", "ts", 80);
		const json = formatter.format('{"a":1}', "json", 80);
		const python = formatter.format("print( 1 )", "py", 80);
		assert.equal(formatter["runtimes"].size, 1);
		assert.equal(formatter["queue"].length, 2);
		assert.deepEqual(await Promise.all([typescript, json, python]), ["const x = 1;", '{ "a": 1 }', "print(1)"]);
		assert.equal(formatter["runtimes"].size, 1);
	});

	it("limits pending work and resolves cancelled requests on disposal", async () => {
		const formatter = createFormatter({ maxPending: 1 });
		const pending = formatter.format("const x=1", "ts", 80);
		assert.equal(formatter.format("const y=2", "ts", 80), "const y=2");
		formatter.dispose();
		assert.equal(await pending, "const x=1");
		assert.equal(formatter["pending"].size, 0);
		assert.equal(formatter["runtimes"].size, 0);
		assert.equal(await formatter.format("const y=2", "ts", 80), "const y = 2;");
	});

	it("times out a runtime and caches the original snippet as fallback", async () => {
		const formatter = createFormatter({ timeoutMs: 1 });
		assert.equal(await formatter.format("const x=1", "ts", 80), "const x=1");
		assert.equal(formatter["runtimes"].size, 0);
		assert.equal(formatter.format("const x=1", "ts", 80), "const x=1");
	});

	it("releases idle workers after their idle timeout", async () => {
		const formatter = createFormatter({ idleMs: 10 });
		await formatter.format("const x=1", "ts", 80);
		const runtime = formatter["runtimes"].get("typescript")!;
		await once(runtime.worker, "exit");
		assert.equal(formatter["runtimes"].size, 0);
		assert.equal(formatter.format("const x=1", "ts", 80), "const x = 1;");
	});
});
