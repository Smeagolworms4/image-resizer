// HEIC/HEVC et vignettes vidéo : les deux chemins qui sortent de sharp pour
// aller chercher un binaire externe. Le HEIC est une des images d'exemple du
// dépôt (public/photo.heic), la vidéo est fabriquée par ffmpeg à la volée.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { copyHeic, hasCommand, imageInfo, makeTempDir, startApp, writeVideo } from './helpers.js';
import { isHeif } from '../src/pipeline.js';

// Le fichier HEIC est versionné : seul le décodeur est requis pour ces tests.
const hasHeifTools = await hasCommand('heif-convert');
const hasFfmpeg = await hasCommand('ffmpeg', [ '-version' ]);

if (!hasHeifTools) console.warn('heif-convert absent : tests de conversion HEIC ignorés (paquet libheif-examples / libheif-tools)');
if (!hasFfmpeg) console.warn('ffmpeg absent : tests de vignette vidéo ignorés');

test('HEVC : le fichier de test est bien du HEVC, que sharp ne sait pas décoder', async (t) => {
	const root = await makeTempDir();
	t.after(() => fs.rm(root, { recursive: true, force: true }));

	const heic = await copyHeic(join(root, 'photo.heic'));

	// La marque du conteneur : `heic` = HEVC, à ne pas confondre avec `avif`,
	// que sharp décode nativement et qui ne doit donc pas partir chez le
	// convertisseur externe.
	assert.equal(heic.toString('ascii', 4, 12), 'ftypheic');
	assert.ok(isHeif(heic));

	// sharp lit l'en-tête (il annonce même la compression) mais échoue au
	// décodage : ses binaires précompilés n'embarquent pas de décodeur HEVC.
	// C'est toute la raison d'être du détour par heif-convert — si ce test se
	// met un jour à échouer, c'est que ce détour peut disparaître.
	assert.equal((await sharp(heic).metadata()).compression, 'hevc');
	await assert.rejects(() => sharp(heic).resize(50, 50).jpeg().toBuffer());
});

test('HEVC : un HEIC est converti puis redimensionné', { skip: !hasHeifTools }, async (t) => {
	const root = await makeTempDir();
	const cacheDir = await makeTempDir();
	t.after(async () => {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(cacheDir, { recursive: true, force: true });
	});

	await copyHeic(join(root, 'photo.heic'));
	const app = await startApp({ SOURCE_LOCAL: root, CACHE_DIR: cacheDir, LOG_FORMAT: 'off', LOG_LEVEL: 'silent' });
	t.after(() => app.close());

	const response = await app.get('/local/photo.heic/_cover_120_120_80.jpg');
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-type'), 'image/jpeg');

	const image = await imageInfo(response);
	assert.equal(image.format, 'jpeg');
	assert.equal(image.width, 120);
	assert.equal(image.height, 120);

	// La conversion est chère : son résultat doit finir dans le cache disque.
	const converted = await fs.readFile(join(cacheDir, 'converted', 'local', 'photo.heic.png'));
	assert.equal((await sharp(converted).metadata()).format, 'png');
});

test('HEVC : la deuxième requête ne relance pas le convertisseur', { skip: !hasHeifTools }, async (t) => {
	const root = await makeTempDir();
	const cacheDir = await makeTempDir();
	t.after(async () => {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(cacheDir, { recursive: true, force: true });
	});

	await copyHeic(join(root, 'photo.heic'));
	const app = await startApp({
		SOURCE_LOCAL: root,
		CACHE_DIR: cacheDir,
		HEIC_COMMAND: 'heif-convert',
		LOG_FORMAT: 'off',
		LOG_LEVEL: 'silent',
	});
	t.after(() => app.close());

	assert.equal((await app.get('/local/photo.heic/_cover_100_100_80.jpg')).status, 200);

	// Le convertisseur est remplacé par un nom qui n'existe pas : si la
	// deuxième requête aboutit, c'est bien que le cache a servi.
	const secondApp = await startApp({
		SOURCE_LOCAL: root,
		CACHE_DIR: cacheDir,
		HEIC_COMMAND: 'binaire-inexistant',
		LOG_FORMAT: 'off',
		LOG_LEVEL: 'silent',
	});
	t.after(() => secondApp.close());

	const cached = await secondApp.get('/local/photo.heic/_cover_64_64_80.webp');
	assert.equal(cached.status, 200);
	assert.equal((await imageInfo(cached)).width, 64);
});

test('HEVC : l\'original HEIC est servi tel quel avec son vrai type', { skip: !hasHeifTools }, async (t) => {
	const root = await makeTempDir();
	t.after(() => fs.rm(root, { recursive: true, force: true }));

	const heic = await copyHeic(join(root, 'photo.heic'));
	const app = await startApp({ SOURCE_LOCAL: root, LOG_FORMAT: 'off', LOG_LEVEL: 'silent' });
	t.after(() => app.close());

	const response = await app.get('/local/photo.heic/_original___.jpg');
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-type'), 'image/heif');
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), heic);
});

test('HEVC : HEIC_ENABLED=false répond 415 plutôt que de planter', { skip: !hasHeifTools }, async (t) => {
	const root = await makeTempDir();
	t.after(() => fs.rm(root, { recursive: true, force: true }));

	await copyHeic(join(root, 'photo.heic'));
	const app = await startApp({ SOURCE_LOCAL: root, HEIC_ENABLED: 'false', LOG_FORMAT: 'off', LOG_LEVEL: 'silent' });
	t.after(() => app.close());

	assert.equal((await app.get('/local/photo.heic/_.jpg')).status, 415);
});

test('HEVC : un convertisseur absent donne un 501 lisible', { skip: !hasHeifTools }, async (t) => {
	const root = await makeTempDir();
	t.after(() => fs.rm(root, { recursive: true, force: true }));

	await copyHeic(join(root, 'photo.heic'));
	const app = await startApp({ SOURCE_LOCAL: root, HEIC_COMMAND: 'binaire-inexistant', LOG_FORMAT: 'off', LOG_LEVEL: 'silent' });
	t.after(() => app.close());

	const response = await app.get('/local/photo.heic/_.jpg');
	assert.equal(response.status, 501);
	assert.match((await response.json()).error, /binaire-inexistant/);
});

test('vignette vidéo : une image est extraite du film', { skip: !hasFfmpeg }, async (t) => {
	const root = await makeTempDir();
	const cacheDir = await makeTempDir();
	t.after(async () => {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(cacheDir, { recursive: true, force: true });
	});

	await writeVideo(join(root, 'clip.mp4'));
	const app = await startApp({
		SOURCE_LOCAL: root,
		CACHE_DIR: cacheDir,
		VIDEO_POSTER_ENABLED: 'true',
		VIDEO_POSTER_WIDTH: '320',
		LOG_FORMAT: 'off',
		LOG_LEVEL: 'silent',
	});
	t.after(() => app.close());

	const response = await app.get('/local/clip.mp4.jpg/_cover_160_120_80.jpg');
	assert.equal(response.status, 200);
	const image = await imageInfo(response);
	assert.equal(image.format, 'jpeg');
	assert.equal(image.width, 160);
	assert.equal(image.height, 120);

	await fs.access(join(cacheDir, 'posters', 'local', 'clip.mp4.jpg.jpg'));
});

test('vignette vidéo : désactivée par défaut', { skip: !hasFfmpeg }, async (t) => {
	const root = await makeTempDir();
	t.after(() => fs.rm(root, { recursive: true, force: true }));

	await writeVideo(join(root, 'clip.mp4'));
	const app = await startApp({ SOURCE_LOCAL: root, LOG_FORMAT: 'off', LOG_LEVEL: 'silent' });
	t.after(() => app.close());

	assert.equal((await app.get('/local/clip.mp4.jpg/_.jpg')).status, 404);
});
