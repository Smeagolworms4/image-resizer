// Outillage commun aux tests : démarrage du service sur un port libre, faux
// serveur amont pour les sources HTTP, et fabrication des fichiers que le
// dépôt ne peut pas embarquer (HEIC, vidéo).
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createApp } from '../src/server.js';

const execFileAsync = promisify(execFile);

// Les images d'exemple du dépôt : test.png (715x273) et BIG.jpg (4096x3000),
// assez grand pour déclencher la réduction automatique.
export const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export async function hasCommand(command, args = [ '--help' ]) {
	try {
		await execFileAsync(command, args, { timeout: 10000 });
		return true;
	} catch (error) {
		return error.code !== 'ENOENT';
	}
}

export function makeTempDir(prefix = 'image-resizer-test-') {
	return fs.mkdtemp(join(os.tmpdir(), prefix));
}

// Les binaires précompilés de sharp n'encodent pas le HEVC : on passe par
// heif-enc, qui accompagne heif-convert dans le même paquet.
export async function writeHeic(target, { source = join(FIXTURES, 'test.png'), quality = 80 } = {}) {
	await fs.mkdir(dirname(target), { recursive: true });
	await execFileAsync('heif-enc', [ source, '-q', String(quality), '-o', target ], { timeout: 60000 });
	return fs.readFile(target);
}

export async function writeVideo(target, { width = 320, height = 240, seconds = 2 } = {}) {
	await fs.mkdir(dirname(target), { recursive: true });
	await execFileAsync('ffmpeg', [
		'-y', '-f', 'lavfi',
		'-i', `testsrc=size=${width}x${height}:rate=10`,
		'-t', String(seconds),
		'-pix_fmt', 'yuv420p',
		target,
	], { timeout: 60000 });
	return target;
}

export async function startApp(env) {
	const config = loadConfig(env);
	const { app } = createApp({ config, logger: createLogger('silent') });
	const server = app.listen(0, '127.0.0.1');
	await once(server, 'listening');

	const base = `http://127.0.0.1:${server.address().port}`;
	return {
		base,
		config,
		get: (path, init) => fetch(`${base}${path}`, init),
		close: () => new Promise((done) => server.close(done)),
	};
}

// Serveur amont minimal : sert un dossier et compte les requêtes reçues, ce
// qui est la seule façon de prouver que le cache disque évite le second
// aller-retour.
export async function startUpstream(root, { status = null } = {}) {
	const hits = [];
	const server = http.createServer(async (req, res) => {
		const relative = decodeURIComponent(req.url.replace(/^\//, '').split('?')[0]);
		hits.push(relative);
		if (status) return void res.writeHead(status).end('forced');
		try {
			const buffer = await fs.readFile(resolve(root, relative));
			res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length });
			res.end(buffer);
		} catch {
			res.writeHead(404).end('not found');
		}
	});

	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return {
		hits,
		base: `http://127.0.0.1:${server.address().port}`,
		close: () => new Promise((done) => server.close(done)),
	};
}

// `fetch` (undici) n'envoie pas les en-têtes conditionnels : pour vérifier la
// revalidation, il faut le client HTTP brut.
export function rawGet(url, headers = {}) {
	return new Promise((done, fail) => {
		const request = http.get(url, { headers }, (response) => {
			response.resume();
			response.on('end', () => done({ status: response.statusCode, headers: response.headers }));
		});
		request.on('error', fail);
	});
}

export async function imageInfo(response) {
	const buffer = Buffer.from(await response.arrayBuffer());
	const metadata = await sharp(buffer).metadata();
	return { buffer, ...metadata };
}
