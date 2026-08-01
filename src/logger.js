const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(level = 'info', output = console) {
	const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
	const emit = (name, method) => (message) => {
		if (LEVELS[name] < threshold) return;
		output[method](`[${name}] ${message}`);
	};

	return {
		level,
		debug: emit('debug', 'log'),
		info: emit('info', 'log'),
		warn: emit('warn', 'warn'),
		error: emit('error', 'error'),
	};
}
