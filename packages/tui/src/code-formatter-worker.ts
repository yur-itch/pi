import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { createFromBuffer } from "@dprint/formatter";
import type { CodeFormatRequest, CodeFormatResponse } from "./code-formatter.ts";

const { pluginPath } = workerData as { pluginPath: string };
// Ignore plugin diagnostics on stdout/stderr: writing there would corrupt the terminal UI.
const formatter = createFromBuffer(readFileSync(pluginPath), { onOutput: () => {} });
const port = parentPort;
if (!port) throw new Error("Code formatter must run in a worker");

port.on("message", (request: CodeFormatRequest) => {
	let text = request.code;
	try {
		formatter.setConfig({ lineWidth: request.width, newLineKind: "lf" }, {});
		text = formatter
			.formatText({ filePath: request.filePath, fileText: request.code })
			.replace(/\r\n/g, "\n")
			.replace(/\n$/, "");
	} catch {
		// Model snippets need not be valid programs. Keep their original display on parse errors.
	}
	port.postMessage({ text } satisfies CodeFormatResponse);
});
