// Toute la configuration vit ici : le reste du code ne lit jamais `process.env`
// directement. Un seul endroit à regarder pour savoir ce qui est réglable, et
// les tests peuvent fabriquer une configuration sans toucher à l'environnement.
import { resolve } from 'node:path';
import os from 'node:os';

const TRUE_VALUES = new Set([ '1', 'true', 'yes', 'on', 'y' ]);
const FALSE_VALUES = new Set([ '0', 'false', 'no', 'off', 'n' ]);

export const FIT_OPTIONS = [ 'contain', 'cover', 'fill', 'inside', 'outside' ];

// Extension demandée dans l'URL -> format sharp. Plusieurs extensions peuvent
// pointer vers le même format (jpg/jpeg), c'est le format qui est configurable.
export const FORMAT_ALIASES = {
	jpg: 'jpeg',
	jpeg: 'jpeg',
	png: 'png',
	webp: 'webp',
	avif: 'avif',
	gif: 'gif',
	tiff: 'tiff',
	tif: 'tiff',
};

export const MIME_TYPES = {
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
	avif: 'image/avif',
	gif: 'image/gif',
	tiff: 'image/tiff',
	svg: 'image/svg+xml',
	heif: 'image/heif',
};

export class ConfigError extends Error {}

function readString(env, name, fallback) {
	const value = env[name];
	return value === undefined || value === '' ? fallback : String(value);
}

// Pour les réglages où la chaîne vide est un choix (« pas d'en-tête CORS »,
// « pas de préfixe ») et non l'absence de réglage.
function readOptionalString(env, name, fallback) {
	const value = env[name];
	return value === undefined ? fallback : String(value);
}

function readBool(env, name, fallback) {
	const value = env[name];
	if (value === undefined || value === '') return fallback;
	const normalized = String(value).trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	throw new ConfigError(`${name}: valeur booléenne invalide '${value}' (attendu true/false)`);
}

function readInt(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
	const value = env[name];
	if (value === undefined || value === '') return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
		throw new ConfigError(`${name}: entier attendu, reçu '${value}'`);
	}
	if (parsed < min || parsed > max) {
		throw new ConfigError(`${name}: doit être compris entre ${min} et ${max}, reçu ${parsed}`);
	}
	return parsed;
}

function readList(env, name, fallback) {
	const value = readString(env, name, null);
	if (value === null) return fallback;
	return value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

const SOURCE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// Une source locale peut s'écrire `file:///data/photos`, `/data/photos`,
// `./public` — tout ce qui n'est pas http(s) est traité comme un chemin.
function describeSource(name, rawTarget) {
	const target = String(rawTarget).trim();
	if (!target) throw new ConfigError(`SOURCES: la source '${name}' n'a pas de cible`);

	if (/^https?:\/\//i.test(target)) {
		return { name, type: 'http', base: target.replace(/\/+$/, '') };
	}
	const path = target.startsWith('file://') ? target.slice('file://'.length) : target;
	if (!path) throw new ConfigError(`SOURCES: la source '${name}' a un chemin local vide`);
	return { name, type: 'local', base: resolve(path) };
}

// Deux syntaxes acceptées, parce que les deux ont leur usage :
//   SOURCES='{"photos":"https://cdn.example.com","local":"/data/photos"}'
//   SOURCE_PHOTOS=https://cdn.example.com   (plus lisible dans un compose)
export function parseSources(env) {
	const raw = {};

	const inline = readString(env, 'SOURCES', null);
	if (inline !== null) {
		let parsed;
		try {
			parsed = JSON.parse(inline);
		} catch {
			// Repli sur la forme courte `nom=cible,nom2=cible2`.
			parsed = {};
			for (const pair of inline.split(',')) {
				const index = pair.indexOf('=');
				if (index < 0) {
					throw new ConfigError(`SOURCES: JSON invalide et '${pair.trim()}' n'est pas de la forme nom=cible`);
				}
				parsed[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
			}
		}
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new ConfigError('SOURCES: un objet JSON {"nom": "cible"} est attendu');
		}
		Object.assign(raw, parsed);
	}

	for (const [ key, value ] of Object.entries(env)) {
		if (!key.startsWith('SOURCE_')) continue;
		raw[key.slice('SOURCE_'.length).toLowerCase()] = value;
	}

	const sources = {};
	for (const [ name, target ] of Object.entries(raw)) {
		if (!SOURCE_NAME_PATTERN.test(name)) {
			throw new ConfigError(`SOURCES: nom de source invalide '${name}' (autorisé : a-z 0-9 . _ -)`);
		}
		sources[name] = describeSource(name, target);
	}

	if (Object.keys(sources).length === 0) {
		throw new ConfigError('Aucune source configurée : renseignez SOURCES ou au moins un SOURCE_<NOM>');
	}
	return sources;
}

function normalizeBasePath(value) {
	if (!value || value === '/') return '';
	const trimmed = `/${value.replace(/^\/+/, '').replace(/\/+$/, '')}`;
	return trimmed === '/' ? '' : trimmed;
}

export function loadConfig(env = process.env) {
	const sources = parseSources(env);

	const minSize = readInt(env, 'MIN_SIZE', 1, { min: 1, max: 65500 });
	const maxSize = readInt(env, 'MAX_SIZE', 2048, { min: 1, max: 65500 });
	if (minSize > maxSize) throw new ConfigError(`MIN_SIZE (${minSize}) ne peut pas dépasser MAX_SIZE (${maxSize})`);

	const allowedFormats = readList(env, 'ALLOWED_FORMATS', [ 'jpeg', 'png', 'webp', 'avif' ]);
	for (const format of allowedFormats) {
		if (!Object.values(FORMAT_ALIASES).includes(format)) {
			throw new ConfigError(`ALLOWED_FORMATS: format inconnu '${format}' (connus : ${[ ...new Set(Object.values(FORMAT_ALIASES)) ].join(', ')})`);
		}
	}

	const defaultFormat = readString(env, 'DEFAULT_FORMAT', 'jpeg').toLowerCase();
	const resolvedDefaultFormat = FORMAT_ALIASES[defaultFormat];
	if (!resolvedDefaultFormat) throw new ConfigError(`DEFAULT_FORMAT: format inconnu '${defaultFormat}'`);
	if (!allowedFormats.includes(resolvedDefaultFormat)) {
		throw new ConfigError(`DEFAULT_FORMAT: '${resolvedDefaultFormat}' n'est pas dans ALLOWED_FORMATS`);
	}

	const defaultFit = readString(env, 'DEFAULT_FIT', 'cover').toLowerCase();
	if (!FIT_OPTIONS.includes(defaultFit)) {
		throw new ConfigError(`DEFAULT_FIT: mode inconnu '${defaultFit}' (connus : ${FIT_OPTIONS.join(', ')})`);
	}

	const config = {
		port: readInt(env, 'PORT', 3000, { min: 0, max: 65535 }),
		host: readString(env, 'HOST', '0.0.0.0'),
		basePath: normalizeBasePath(readString(env, 'BASE_PATH', '')),
		trustProxy: readString(env, 'TRUST_PROXY', ''),
		logFormat: readString(env, 'LOG_FORMAT', 'tiny'),
		logLevel: readString(env, 'LOG_LEVEL', 'info'),
		healthPath: readString(env, 'HEALTH_PATH', '/health'),

		sources,

		cacheDir: readString(env, 'CACHE_DIR', '') || null,
		cacheOriginals: readBool(env, 'CACHE_ORIGINALS', true),

		minSize,
		maxSize,
		minQuality: readInt(env, 'MIN_QUALITY', 10, { min: 1, max: 100 }),
		defaultQuality: readInt(env, 'DEFAULT_QUALITY', 80, { min: 1, max: 100 }),
		defaultFit,
		defaultFormat: resolvedDefaultFormat,
		allowedFormats,
		allowOriginal: readBool(env, 'ALLOW_ORIGINAL', true),
		autoDownscale: readBool(env, 'AUTO_DOWNSCALE', true),
		stripMetadata: readBool(env, 'STRIP_METADATA', true),

		// `s-maxage` est volontairement bien plus long que `max-age` : le CDN
		// garde l'image longtemps, le navigateur revalide plus souvent.
		cacheControl: readString(env, 'CACHE_CONTROL', null),
		maxAge: readInt(env, 'MAX_AGE', 604800),
		sMaxAge: readInt(env, 'S_MAX_AGE', 5184000),
		staleWhileRevalidate: readInt(env, 'STALE_WHILE_REVALIDATE', 604800),
		errorMaxAge: readInt(env, 'ERROR_MAX_AGE', 60),

		corsOrigin: readOptionalString(env, 'CORS_ORIGIN', '*'),

		fetchTimeout: readInt(env, 'FETCH_TIMEOUT', 15000, { min: 100 }),
		fetchUserAgent: readString(env, 'FETCH_USER_AGENT', 'image-resizer'),
		maxInputBytes: readInt(env, 'MAX_INPUT_BYTES', 64 * 1024 * 1024),

		// Le nombre de transformations simultanées est la seule protection
		// réelle : sharp est gourmand, et une rafale de gros originaux suffit à
		// mettre la machine à genoux. Au-delà, on rend 503 plutôt que de
		// s'effondrer — le CDN réessaiera.
		maxConcurrency: readInt(env, 'MAX_CONCURRENCY', Math.max(2, os.cpus().length), { min: 1 }),
		retryAfter: readInt(env, 'RETRY_AFTER', 2, { min: 1 }),

		sharpConcurrency: readInt(env, 'SHARP_CONCURRENCY', 0),
		sharpCacheMemory: readInt(env, 'SHARP_CACHE_MEMORY', 50),

		// La conversion HEIC/HEIF passe par un binaire externe : les binaires
		// précompilés de sharp ne savent pas décoder le HEVC.
		heicEnabled: readBool(env, 'HEIC_ENABLED', true),
		heicCommand: readString(env, 'HEIC_COMMAND', 'heif-convert'),
		heicMaxConcurrency: readInt(env, 'HEIC_MAX_CONCURRENCY', 2, { min: 1 }),
		heicTimeout: readInt(env, 'HEIC_TIMEOUT', 30000, { min: 1000 }),

		// Vignette de vidéo : `/source/clip.mp4.jpg` extrait une image du film.
		videoPosterEnabled: readBool(env, 'VIDEO_POSTER_ENABLED', false),
		videoPosterCommand: readString(env, 'VIDEO_POSTER_COMMAND', 'ffmpeg'),
		videoPosterExtensions: readList(env, 'VIDEO_POSTER_EXTENSIONS', [ 'mp4', 'mov', 'webm', 'm4v', 'mkv', 'avi' ]),
		videoPosterSeek: readString(env, 'VIDEO_POSTER_SEEK', '1'),
		videoPosterWidth: readInt(env, 'VIDEO_POSTER_WIDTH', 1280, { min: 16, max: 65500 }),
		videoPosterTimeout: readInt(env, 'VIDEO_POSTER_TIMEOUT', 30000, { min: 1000 }),
	};

	if (config.cacheDir) config.cacheDir = resolve(config.cacheDir);
	return config;
}

export function describeConfig(config) {
	return {
		basePath: config.basePath || '/',
		sources: Object.fromEntries(Object.entries(config.sources).map(([ name, source ]) => [ name, `${source.type}:${source.base}` ])),
		cacheDir: config.cacheDir,
		cacheOriginals: config.cacheOriginals && Boolean(config.cacheDir),
		minSize: config.minSize,
		maxSize: config.maxSize,
		defaultQuality: config.defaultQuality,
		defaultFit: config.defaultFit,
		defaultFormat: config.defaultFormat,
		allowedFormats: config.allowedFormats.join(','),
		allowOriginal: config.allowOriginal,
		autoDownscale: config.autoDownscale,
		maxConcurrency: config.maxConcurrency,
		heicEnabled: config.heicEnabled,
		videoPosterEnabled: config.videoPosterEnabled,
	};
}
