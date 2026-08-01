import express from 'express';
import morgan from 'morgan';
import { describeConfig, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { HttpError, badRequest, notFound, unavailable } from './errors.js';
import { createLimiter } from './semaphore.js';
import { createConverters } from './converters.js';
import { loadOriginal, normalizeRelative, tryLoadOriginal } from './storage.js';
import { isPreset, parsePreset } from './preset.js';
import { applySharpTuning, detectContentType, isHeif, transform } from './pipeline.js';

const decodeSegment = (segment) => {
	try {
		return decodeURIComponent(segment);
	} catch {
		// Un `%` isolé n'est pas décodable : on garde le segment tel quel plutôt
		// que de rejeter, le fichier s'appelle peut-être vraiment comme ça.
		return segment;
	}
};

function cacheControlFor(config) {
	if (config.cacheControl) return config.cacheControl;
	return `public, max-age=${config.maxAge}, s-maxage=${config.sMaxAge}, stale-while-revalidate=${config.staleWhileRevalidate}`;
}

export function createApp({ config = loadConfig(), logger = createLogger(config?.logLevel) } = {}) {
	applySharpTuning(config);

	const app = express();
	const context = { config, logger };
	const converters = createConverters(config, logger);
	const limiter = createLimiter(config.maxConcurrency);
	const cacheControl = cacheControlFor(config);

	app.disable('x-powered-by');
	if (config.trustProxy) app.set('trust proxy', config.trustProxy === 'true' ? true : config.trustProxy);

	if (config.logFormat && config.logFormat !== 'off') {
		app.use(morgan(config.logFormat, { skip: (req) => req.path === config.healthPath }));
	}

	// Une image servie derrière un CDN est lue depuis n'importe quel domaine :
	// sans ces en-têtes, `<canvas>` et les mesures de performance échouent.
	app.use((req, res, next) => {
		if (config.corsOrigin) {
			res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
			res.setHeader('Timing-Allow-Origin', config.corsOrigin);
			res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
			res.setHeader('Vary', 'Origin');
		}
		if (req.method === 'OPTIONS') {
			res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
			return res.sendStatus(204);
		}
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			return res.status(405).json({ error: 'Method not allowed' });
		}
		return next();
	});

	app.get(config.healthPath, (req, res) => {
		res.setHeader('Cache-Control', 'no-store');
		res.json({
			status: 'ok',
			uptime: Math.round(process.uptime()),
			inFlight: limiter.inFlight,
			maxConcurrency: limiter.max,
			sources: Object.keys(config.sources),
		});
	});

	async function handleImage(req, res) {
		const path = req.path.slice(config.basePath.length);
		const segments = path.split('/').filter(Boolean).map(decodeSegment);

		if (segments.length < 2) throw notFound('Route not found');

		const [ sourceName ] = segments;
		const preset = segments[segments.length - 1];
		const relative = normalizeRelative(segments.slice(1, -1).join('/'));

		if (!config.sources[sourceName]) throw badRequest(`Source '${sourceName}' inconnue`);
		if (!isPreset(preset)) throw notFound('Route not found');

		const parsed = parsePreset(config, preset);

		// Vignette de vidéo : le chemin pointe vers un fichier qui n'existe pas,
		// mais la vidéo qui est derrière, elle, existe.
		let buffer = null;
		const videoPath = converters.splitVideoPoster(relative);
		if (videoPath) {
			buffer = await tryLoadOriginal(context, sourceName, relative);
			if (!buffer) {
				const video = await loadOriginal(context, sourceName, videoPath);
				buffer = await converters.videoPoster(context, sourceName, relative, video);
			}
		} else {
			buffer = await loadOriginal(context, sourceName, relative);
		}

		if (parsed.original) {
			res.set({ 'Content-Type': await detectContentType(buffer), 'Cache-Control': cacheControl });
			return res.send(buffer);
		}

		const release = limiter.acquire();
		if (!release) {
			throw unavailable('Server busy', { 'Retry-After': String(config.retryAfter) });
		}

		try {
			if (isHeif(buffer)) {
				buffer = await converters.heicToPng(context, sourceName, relative, buffer);
			}
			const output = await transform(buffer, parsed, config);
			res.set({ 'Content-Type': output.contentType, 'Cache-Control': cacheControl });
			return res.send(output.buffer);
		} finally {
			release();
		}
	}

	app.get(`${config.basePath}/*splat`, (req, res, next) => {
		handleImage(req, res).catch(next);
	});

	app.use((req, res) => {
		res.status(404).json({ error: 'Route not found' });
	});

	// eslint-disable-next-line no-unused-vars -- Express reconnaît le middleware
	// d'erreur à ses quatre paramètres.
	app.use((error, req, res, next) => {
		const status = error instanceof HttpError ? error.status : 500;
		if (status >= 500 && !(error instanceof HttpError)) {
			logger.error(`${req.method} ${req.originalUrl} -> ${error.stack || error.message}`);
		}
		if (error.headers) res.set(error.headers);
		// Les erreurs sont cachées brièvement : sans ça, un 404 sur une page
		// populaire tape l'amont à chaque visite.
		res.set('Cache-Control', `public, max-age=${config.errorMaxAge}`);
		res.status(status).json({ error: status >= 500 && !error.expose ? 'Internal error' : error.message });
	});

	return { app, config, logger, limiter, describe: () => describeConfig(config) };
}
