// Les deux formats que sharp ne sait pas ouvrir seul : le HEIC/HEIF (les
// binaires précompilés n'embarquent pas de décodeur HEVC) et la vidéo. Dans les
// deux cas on passe par un outil externe, dans un dossier temporaire, avec un
// délai maximum — un binaire qui ne rend jamais la main bloquerait un créneau
// de concurrence pour toujours.
import { promises as fs } from 'node:fs';
import { join, extname } from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HttpError, unavailable } from './errors.js';
import { createLimiter } from './semaphore.js';
import { derivedCachePath, readFileOrNull, writeFileAtomic } from './storage.js';

const execFileAsync = promisify(execFile);

export function createConverters(config, logger) {
	// Une seule limite pour les deux outils externes : ils se disputent le même
	// processeur, et c'est le total des conversions en vol qui compte.
	const toolLimiter = createLimiter(config.heicMaxConcurrency);

	async function withTempDir(prefix, task) {
		const dir = await fs.mkdtemp(join(os.tmpdir(), prefix));
		try {
			return await task(dir);
		} finally {
			fs.rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	}

	function toolFailure(command, error) {
		if (error.code === 'ENOENT') {
			logger.error(`'${command}' est introuvable : fonctionnalité indisponible`);
			return new HttpError(501, `'${command}' is not installed`);
		}
		if (error.killed || error.signal) {
			return new HttpError(504, `'${command}' timed out`);
		}
		// Un outil présent qui échoue quand même a presque toujours dit
		// pourquoi sur sa sortie d'erreur — sans elle, le 500 est indéchiffrable
		// (un décodeur HEVC manquant ressemble à un binaire absent).
		const details = String(error.stderr || error.message).trim().split('\n')[0];
		logger.error(`'${command}' a échoué : ${details}`);
		return new HttpError(500, `'${command}' failed: ${details}`);
	}

	// HEIC -> PNG. La conversion est chère (plusieurs centaines de ms et
	// beaucoup de mémoire) : c'est exactement le genre de rafale qui met le
	// service à terre, d'où une limite de concurrence propre et un cache disque
	// du résultat quand un CACHE_DIR est configuré.
	async function heicToPng(sourceName, relative, buffer) {
		if (!config.heicEnabled) throw new HttpError(415, 'HEIC support is disabled');

		const cachePath = derivedCachePath(config, 'converted', sourceName, relative, '.png');
		if (cachePath) {
			const cached = await readFileOrNull(cachePath);
			if (cached) return cached;
		}

		const release = toolLimiter.acquire();
		if (!release) {
			throw unavailable('Too many HEIC conversions in flight', { 'Retry-After': String(config.retryAfter) });
		}

		try {
			const png = await withTempDir('heic-', async (dir) => {
				const input = join(dir, 'in.heic');
				const output = join(dir, 'out.png');
				await fs.writeFile(input, buffer);
				try {
					await execFileAsync(config.heicCommand, [ input, output ], { timeout: config.heicTimeout });
				} catch (error) {
					throw toolFailure(config.heicCommand, error);
				}
				return fs.readFile(output);
			});

			if (cachePath) {
				await writeFileAtomic(cachePath, png).catch((error) => logger.warn(`cache HEIC impossible : ${error.message}`));
			}
			return png;
		} finally {
			release();
		}
	}

	// `/source/clip.mp4.jpg` : l'extension image est ajoutée derrière celle de
	// la vidéo, ce qui laisse l'URL passer par le même pipeline (et le même
	// cache CDN) que n'importe quelle image.
	function splitVideoPoster(relative) {
		if (!config.videoPosterEnabled) return null;
		const imageExtension = extname(relative);
		if (!imageExtension) return null;
		const withoutImage = relative.slice(0, -imageExtension.length);
		const videoExtension = extname(withoutImage).slice(1).toLowerCase();
		if (!videoExtension || !config.videoPosterExtensions.includes(videoExtension)) return null;
		return withoutImage;
	}

	async function videoPoster(sourceName, relative, videoBuffer) {
		const cachePath = derivedCachePath(config, 'posters', sourceName, relative, '.jpg');
		if (cachePath) {
			const cached = await readFileOrNull(cachePath);
			if (cached) return cached;
		}

		const release = toolLimiter.acquire();
		if (!release) {
			throw unavailable('Too many conversions in flight', { 'Retry-After': String(config.retryAfter) });
		}

		try {
			const poster = await withTempDir('poster-', async (dir) => {
				const input = join(dir, `in${extname(relative.slice(0, -extname(relative).length))}`);
				const output = join(dir, 'out.jpg');
				await fs.writeFile(input, videoBuffer);
				try {
					await execFileAsync(config.videoPosterCommand, [
						'-y',
						'-ss', String(config.videoPosterSeek),
						'-i', input,
						'-frames:v', '1',
						'-vf', `scale=${config.videoPosterWidth}:-2`,
						output,
					], { timeout: config.videoPosterTimeout });
				} catch (error) {
					throw toolFailure(config.videoPosterCommand, error);
				}
				return fs.readFile(output);
			});

			if (cachePath) {
				await writeFileAtomic(cachePath, poster).catch((error) => logger.warn(`cache vignette impossible : ${error.message}`));
			}
			return poster;
		} finally {
			release();
		}
	}

	return { heicToPng, videoPoster, splitVideoPoster, toolLimiter };
}
