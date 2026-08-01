// Récupération des originaux : disque local, HTTP amont, et cache disque des
// originaux téléchargés. Rien ne sort de ce module qui ne soit un Buffer.
import { promises as fs } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpError, badRequest, notFound } from './errors.js';

// Le chemin vient de l'URL : il est décodé, donc il peut contenir n'importe
// quoi. On refuse tout ce qui pourrait sortir de la racine de la source.
export function normalizeRelative(rawPath) {
	if (!rawPath) throw badRequest('Chemin de fichier vide');
	if (rawPath.includes('\0')) throw badRequest('Chemin de fichier invalide');

	// On refuse au lieu de réécrire : un chemin qui remonte est une tentative,
	// pas une faute de frappe, et le silencieux « je corrige et je sers autre
	// chose » est précisément ce qui rend ces failles difficiles à voir.
	const cleaned = normalize(rawPath.replace(/\\/g, '/')).replace(/^\/+/, '');
	if (!cleaned || cleaned === '.' || cleaned.split('/').includes('..')) {
		throw badRequest('Chemin de fichier invalide');
	}
	return cleaned;
}

export function safeJoin(root, relative) {
	const rootResolved = resolve(root);
	const target = resolve(rootResolved, relative);
	if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
		throw badRequest('Chemin de fichier invalide');
	}
	return target;
}

// Les segments sont réencodés un par un : le chemin décodé peut contenir des
// espaces ou des accents, et l'amont, lui, attend une URL valide.
export function buildUpstreamUrl(base, relative) {
	return `${base}/${relative.split('/').map(encodeURIComponent).join('/')}`;
}

async function readFileOrNull(path) {
	try {
		return await fs.readFile(path);
	} catch (error) {
		if (error.code === 'ENOENT' || error.code === 'EISDIR' || error.code === 'ENOTDIR') return null;
		throw error;
	}
}

// Écriture atomique : deux requêtes sur la même image arrivent en parallèle, et
// un fichier à moitié écrit serait lu comme une image corrompue par la seconde.
export async function writeFileAtomic(path, buffer) {
	await fs.mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
	try {
		await fs.writeFile(temporary, buffer);
		await fs.rename(temporary, path);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

export function originalCachePath(config, sourceName, relative) {
	if (!config.cacheDir) return null;
	return safeJoin(join(config.cacheDir, 'originals', sourceName), relative);
}

export function derivedCachePath(config, kind, sourceName, relative, suffix) {
	if (!config.cacheDir) return null;
	return safeJoin(join(config.cacheDir, kind, sourceName), `${relative}${suffix}`);
}

async function fetchUpstream(config, url, logger) {
	logger.debug(`fetch amont: ${url}`);

	let response;
	try {
		response = await fetch(url, {
			signal: AbortSignal.timeout(config.fetchTimeout),
			headers: { 'User-Agent': config.fetchUserAgent, 'Accept': '*/*' },
			redirect: 'follow',
		});
	} catch (error) {
		if (error.name === 'TimeoutError' || error.name === 'AbortError') {
			throw new HttpError(504, 'Upstream timeout');
		}
		throw new HttpError(502, 'Upstream unreachable');
	}

	if (response.status === 404 || response.status === 403 || response.status === 410) {
		throw notFound();
	}
	if (!response.ok) {
		throw new HttpError(502, `Upstream error (${response.status})`);
	}

	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > config.maxInputBytes) {
		throw new HttpError(413, 'Source image too large');
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.byteLength > config.maxInputBytes) {
		throw new HttpError(413, 'Source image too large');
	}
	return buffer;
}

// Ordre : cache disque, puis source locale ou amont HTTP. Un original
// téléchargé est réécrit dans le cache, sans que l'échec d'écriture (disque
// plein, volume en lecture seule) n'empêche de répondre.
export async function loadOriginal(context, sourceName, relative) {
	const { config, logger } = context;
	const source = config.sources[sourceName];

	if (source.type === 'local') {
		const buffer = await readFileOrNull(safeJoin(source.base, relative));
		if (!buffer) throw notFound();
		if (buffer.byteLength > config.maxInputBytes) throw new HttpError(413, 'Source image too large');
		return buffer;
	}

	const cachePath = config.cacheOriginals ? originalCachePath(config, sourceName, relative) : null;
	if (cachePath) {
		const cached = await readFileOrNull(cachePath);
		if (cached) return cached;
	}

	const buffer = await fetchUpstream(config, buildUpstreamUrl(source.base, relative), logger);

	if (cachePath) {
		try {
			await writeFileAtomic(cachePath, buffer);
		} catch (error) {
			logger.warn(`écriture du cache impossible (${cachePath}): ${error.message}`);
		}
	}
	return buffer;
}

// Comme `loadOriginal`, mais sans erreur si le fichier n'existe pas : sert à
// aller chercher la vidéo derrière une vignette demandée.
export async function tryLoadOriginal(context, sourceName, relative) {
	try {
		return await loadOriginal(context, sourceName, relative);
	} catch (error) {
		if (error instanceof HttpError && error.status === 404) return null;
		throw error;
	}
}

export { readFileOrNull };
