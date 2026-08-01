#!/usr/bin/env node
import { loadConfig, describeConfig, ConfigError } from './config.js';
import { createLogger } from './logger.js';
import { createApp } from './server.js';

let config;
try {
	config = loadConfig();
} catch (error) {
	if (error instanceof ConfigError) {
		console.error(`[error] Configuration invalide : ${error.message}`);
		process.exit(78); // EX_CONFIG
	}
	throw error;
}

const logger = createLogger(config.logLevel);
const { app } = createApp({ config, logger });

for (const [ key, value ] of Object.entries(describeConfig(config))) {
	logger.info(`${key} = ${typeof value === 'object' ? JSON.stringify(value) : value}`);
}

const server = app.listen(config.port, config.host, () => {
	const address = server.address();
	logger.info(`image-resizer écoute sur http://${config.host}:${address.port}${config.basePath || ''}`);
});

// Sans ça, `docker stop` coupe les requêtes en cours au bout de dix secondes
// avec un SIGKILL. On laisse plutôt les transformations en vol se terminer.
const shutdown = (signal) => {
	logger.info(`${signal} reçu, arrêt en cours…`);
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
