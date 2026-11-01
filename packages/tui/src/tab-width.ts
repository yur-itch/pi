// One tab width per synchronous terminal render/input operation, inherited by nested components.
let activeTabWidth: 2 | 4 | undefined;

/** Current renderer-wide tab width; standalone callers default to an 80-column viewport. */
export function getTabWidth(columns = 80): 2 | 4 {
	return activeTabWidth ?? (columns < 96 ? 2 : 4);
}

/** Run synchronous layout, measurement, and output with the given terminal's tab policy. */
export function withTerminalWidth<T>(columns: number, action: () => T): T {
	const previous = activeTabWidth;
	activeTabWidth = columns < 96 ? 2 : 4;
	try {
		return action();
	} finally {
		activeTabWidth = previous;
	}
}

/** Standalone components use their viewport width; children inherit the enclosing terminal's policy. */
export function withComponentWidth<T>(columns: number, action: () => T): T {
	return activeTabWidth === undefined ? withTerminalWidth(columns, action) : action();
}
