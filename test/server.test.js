import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { FIXTURES, imageInfo, makeTempDir, rawGet, startApp, startUpstream } from './helpers.js';

const localEnv = (extra = {}) => ({ SOURCE_LOCAL: FIXTURES, LOG_FORMAT: 'off', LOG_LEVEL: 'silent', ...extra });

test('santé : le service se déclare prêt et annonce ses sources', async (t) => {
	const app = await startApp(localEnv());
	t.after(() => app.close());

	const response = await app.get('/health');
	const body = await response.json();
	assert.equal(response.status, 200);
	assert.equal(body.status, 'ok');
	assert.deepEqual(body.sources, [ 'local' ]);
	assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('redimensionne aux dimensions demandées', async (t) => {
	const app = await startApp(localEnv());
	t.after(() => app.close());

	const response = await app.get('/local/test.png/_cover_100_50_80.jpg');
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-type'), 'image/jpeg');

	const image = await imageInfo(response);
	assert.equal(image.format, 'jpeg');
	assert.equal(image.width, 100);
	assert.equal(image.height, 50);
});

test('chaque mode d\'ajustement donne le cadrage attendu', async (t) => {
	const app = await startApp(localEnv());
	t.after(() => app.close());

	// L'original fait 715x273 : `cover` et `fill` remplissent le cadre demandé,
	// `inside` s'y inscrit sans le remplir.
	for (const fit of [ 'cover', 'fill', 'contain' ]) {
		const image = await imageInfo(await app.get(`/local/test.png/_${fit}_200_200_80.jpg`));
		assert.equal(image.width, 200, fit);
		assert.equal(image.height, 200, fit);
	}

	const inside = await imageInfo(await app.get('/local/test.png/_inside_200_200_80.jpg'));
	assert.equal(inside.width, 200);
	assert.ok(inside.height < 200, `inside doit préserver le ratio, reçu ${inside.height}`);

	const outside = await imageInfo(await app.get('/local/test.png/_outside_200_200_80.jpg'));
	assert.ok(outside.width >= 200 && outside.height >= 200);
});

test('une seule dimension conserve les proportions', async (t) => {
	const app = await startApp(localEnv());
	t.after(() => app.close());

	const image = await imageInfo(await app.get('/local/test.png/_inside_300__.png'));
	assert.equal(image.format, 'png');
	assert.equal(image.width, 300);
	assert.equal(image.height, Math.round(300 * 273 / 715));
});

test('tous les formats de sortie autorisés sont produits', async (t) => {
	const app = await startApp(localEnv({ ALLOWED_FORMATS: 'jpeg,png,webp,avif' }));
	t.after(() => app.close());

	for (const [ extension, format ] of [ [ 'jpg', 'jpeg' ], [ 'jpeg', 'jpeg' ], [ 'png', 'png' ], [ 'webp', 'webp' ], [ 'avif', 'heif' ] ]) {
		const response = await app.get(`/local/test.png/_cover_80_80_80.${extension}`);
		assert.equal(response.status, 200, extension);
		const image = await imageInfo(response);
		assert.equal(image.format, format, extension);
	}
});

test('la qualité demandée agit sur le poids du fichier', async (t) => {
	const app = await startApp(localEnv());
	t.after(() => app.close());

	const low = await imageInfo(await app.get('/local/BIG.jpg/_cover_400_400_20.jpg'));
	const high = await imageInfo(await app.get('/local/BIG.jpg/_cover_400_400_95.jpg'));
	assert.ok(low.buffer.byteLength < high.buffer.byteLength, `${low.buffer.byteLength} doit être < ${high.buffer.byteLength}`);
});

test('sans dimension, une image trop grande est réduite à MAX_SIZE', async (t) => {
	const app = await startApp(localEnv({ MAX_SIZE: '1024' }));
	t.after(() => app.close());

	const image = await imageInfo(await app.get('/local/BIG.jpg/_.jpg'));
	assert.equal(image.width, 1024);
	assert.equal(image.height, 750); // 4096x3000 réduit dans un carré de 1024.
});

test('AUTO_DOWNSCALE=false laisse passer les dimensions d\'origine', async (t) => {
	const app = await startApp(localEnv({ MAX_SIZE: '1024', AUTO_DOWNSCALE: 'false' }));
	t.after(() => app.close());

	const image = await imageInfo(await app.get('/local/BIG.jpg/_.jpg'));
	assert.equal(image.width, 4096);
});

test('les dimensions demandées sont bornées par MAX_SIZE', async (t) => {
	const app = await startApp(localEnv({ MAX_SIZE: '512' }));
	t.after(() => app.close());

	const image = await imageInfo(await app.get('/local/BIG.jpg/_inside_4000_4000_80.jpg'));
	assert.equal(image.width, 512);
});

test('le preset original rend les octets exacts du fichier', async (t) => {
	const app = await startApp(localEnv());
	t.after(() => app.close());

	const response = await app.get('/local/test.png/_original___.jpg');
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-type'), 'image/png'); // Le type réel, pas l'extension demandée.

	const expected = await fs.readFile(join(FIXTURES, 'test.png'));
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
});

test('ALLOW_ORIGINAL=false interdit la diffusion des originaux', async (t) => {
	const app = await startApp(localEnv({ ALLOW_ORIGINAL: 'false' }));
	t.after(() => app.close());

	const response = await app.get('/local/test.png/_original___.jpg');
	assert.equal(response.status, 400);
});

test('les sous-dossiers et les noms encodés sont servis', async (t) => {
	const root = await makeTempDir();
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	await fs.mkdir(join(root, 'un dossier'), { recursive: true });
	await fs.copyFile(join(FIXTURES, 'test.png'), join(root, 'un dossier', 'été & co.png'));
	await fs.cp(join(FIXTURES, 'sub'), join(root, 'sub'), { recursive: true });

	const app = await startApp(localEnv({ SOURCE_LOCAL: root }));
	t.after(() => app.close());

	assert.equal((await app.get('/local/sub/sub2/test.png/_cover_50_50_80.jpg')).status, 200);
	const encoded = await app.get(`/local/un%20dossier/${encodeURIComponent('été & co.png')}/_cover_50_50_80.jpg`);
	assert.equal(encoded.status, 200);
	assert.equal((await imageInfo(encoded)).width, 50);
});

test('les en-têtes de cache et CORS sont posés pour un CDN', async (t) => {
	const app = await startApp(localEnv({ MAX_AGE: '600', S_MAX_AGE: '86400', STALE_WHILE_REVALIDATE: '60' }));
	t.after(() => app.close());

	const response = await app.get('/local/test.png/_.jpg');
	assert.equal(response.headers.get('cache-control'), 'public, max-age=600, s-maxage=86400, stale-while-revalidate=60');
	assert.equal(response.headers.get('access-control-allow-origin'), '*');
	assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
	assert.ok(response.headers.get('etag'), 'un ETag est nécessaire pour la revalidation');
});

test('CACHE_CONTROL remplace entièrement l\'en-tête calculé', async (t) => {
	const app = await startApp(localEnv({ CACHE_CONTROL: 'public, immutable, max-age=31536000' }));
	t.after(() => app.close());

	const response = await app.get('/local/test.png/_.jpg');
	assert.equal(response.headers.get('cache-control'), 'public, immutable, max-age=31536000');
});

test('une requête conditionnelle rend 304', async (t) => {
	const app = await startApp(localEnv());
	t.after(() => app.close());

	const first = await app.get('/local/test.png/_cover_60_60_80.jpg');
	const etag = first.headers.get('etag');
	await first.arrayBuffer();

	const second = await rawGet(`${app.base}/local/test.png/_cover_60_60_80.jpg`, { 'If-None-Match': etag });
	assert.equal(second.status, 304);
});

test('BASE_PATH décale toutes les routes', async (t) => {
	const app = await startApp(localEnv({ BASE_PATH: '/images' }));
	t.after(() => app.close());

	assert.equal((await app.get('/images/local/test.png/_cover_40_40_80.jpg')).status, 200);
	assert.equal((await app.get('/local/test.png/_cover_40_40_80.jpg')).status, 404);
});

test('les erreurs client sont explicites', async (t) => {
	const app = await startApp(localEnv());
	t.after(() => app.close());

	assert.equal((await app.get('/inconnue/test.png/_.jpg')).status, 400); // Source inconnue.
	assert.equal((await app.get('/local/absente.png/_.jpg')).status, 404); // Fichier absent.
	assert.equal((await app.get('/local/test.png/_squish_10_10_80.jpg')).status, 400); // Ajustement inconnu.
	assert.equal((await app.get('/local/test.png/pas-un-preset')).status, 404);
	assert.equal((await app.get('/local')).status, 404);
	assert.equal((await app.get('/')).status, 404);

	const traversal = await app.get(`/local/${encodeURIComponent('../../etc/passwd')}/_.jpg`);
	assert.ok([ 400, 404 ].includes(traversal.status), `attendu 400/404, reçu ${traversal.status}`);
});

test('seules les lectures sont acceptées', async (t) => {
	const app = await startApp(localEnv());
	t.after(() => app.close());

	assert.equal((await app.get('/local/test.png/_.jpg', { method: 'OPTIONS' })).status, 204);
	assert.equal((await app.get('/local/test.png/_.jpg', { method: 'POST' })).status, 405);

	const head = await app.get('/local/test.png/_cover_40_40_80.jpg', { method: 'HEAD' });
	assert.equal(head.status, 200);
	assert.equal(head.headers.get('content-type'), 'image/jpeg');
});

test('CORS_ORIGIN vide retire les en-têtes', async (t) => {
	const app = await startApp(localEnv({ CORS_ORIGIN: '' }));
	t.after(() => app.close());

	const response = await app.get('/local/test.png/_.jpg');
	assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('source HTTP : téléchargement puis mise en cache disque', async (t) => {
	const upstream = await startUpstream(FIXTURES);
	const cacheDir = await makeTempDir();
	t.after(async () => {
		await upstream.close();
		await fs.rm(cacheDir, { recursive: true, force: true });
	});

	const app = await startApp({
		SOURCE_REMOTE: upstream.base,
		CACHE_DIR: cacheDir,
		LOG_FORMAT: 'off',
		LOG_LEVEL: 'silent',
	});
	t.after(() => app.close());

	assert.equal((await app.get('/remote/test.png/_cover_50_50_80.jpg')).status, 200);
	assert.equal(upstream.hits.length, 1);

	// Deuxième requête, format différent : l'original vient du cache disque.
	assert.equal((await app.get('/remote/test.png/_cover_60_60_80.webp')).status, 200);
	assert.equal(upstream.hits.length, 1);

	const cached = await fs.readFile(join(cacheDir, 'originals', 'remote', 'test.png'));
	assert.deepEqual(cached, await fs.readFile(join(FIXTURES, 'test.png')));
});

test('source HTTP : CACHE_ORIGINALS=false retourne chercher à chaque fois', async (t) => {
	const upstream = await startUpstream(FIXTURES);
	const cacheDir = await makeTempDir();
	t.after(async () => {
		await upstream.close();
		await fs.rm(cacheDir, { recursive: true, force: true });
	});

	const app = await startApp({
		SOURCE_REMOTE: upstream.base,
		CACHE_DIR: cacheDir,
		CACHE_ORIGINALS: 'false',
		LOG_FORMAT: 'off',
		LOG_LEVEL: 'silent',
	});
	t.after(() => app.close());

	await app.get('/remote/test.png/_cover_50_50_80.jpg');
	await app.get('/remote/test.png/_cover_50_50_80.jpg');
	assert.equal(upstream.hits.length, 2);
});

test('source HTTP : les erreurs amont sont traduites', async (t) => {
	const upstream = await startUpstream(FIXTURES);
	t.after(() => upstream.close());

	const app = await startApp({ SOURCE_REMOTE: upstream.base, LOG_FORMAT: 'off', LOG_LEVEL: 'silent' });
	t.after(() => app.close());

	assert.equal((await app.get('/remote/absente.png/_.jpg')).status, 404);

	const broken = await startUpstream(FIXTURES, { status: 500 });
	t.after(() => broken.close());
	const brokenApp = await startApp({ SOURCE_REMOTE: broken.base, LOG_FORMAT: 'off', LOG_LEVEL: 'silent' });
	t.after(() => brokenApp.close());
	assert.equal((await brokenApp.get('/remote/test.png/_.jpg')).status, 502);
});

test('source HTTP : un original trop gros est refusé', async (t) => {
	const upstream = await startUpstream(FIXTURES);
	t.after(() => upstream.close());

	const app = await startApp({
		SOURCE_REMOTE: upstream.base,
		MAX_INPUT_BYTES: '1024',
		LOG_FORMAT: 'off',
		LOG_LEVEL: 'silent',
	});
	t.after(() => app.close());

	assert.equal((await app.get('/remote/BIG.jpg/_.jpg')).status, 413);
});

test('sous saturation, le service refuse au lieu de s\'effondrer', async (t) => {
	const app = await startApp(localEnv({ MAX_CONCURRENCY: '1', RETRY_AFTER: '3' }));
	t.after(() => app.close());

	// Le 4096x3000 en AVIF prend assez de temps pour que les requêtes lancées
	// ensemble se croisent réellement dans le limiteur.
	const responses = await Promise.all(Array.from({ length: 6 }, () => app.get('/local/BIG.jpg/_cover_800_800_80.avif')));
	const statuses = responses.map((response) => response.status);

	assert.ok(statuses.includes(200), `au moins une requête doit aboutir : ${statuses}`);
	assert.ok(statuses.includes(503), `au moins une requête doit être refusée : ${statuses}`);

	const refused = responses.find((response) => response.status === 503);
	assert.equal(refused.headers.get('retry-after'), '3');
	await Promise.all(responses.map((response) => response.arrayBuffer()));
});

test('ALLOW_ENLARGEMENT=false n\'agrandit pas au-delà de l\'original', async (t) => {
	const app = await startApp(localEnv({ ALLOW_ENLARGEMENT: 'false' }));
	t.after(() => app.close());

	// L'original fait 715x273 : demander 1400 de large ne doit rien inventer.
	const image = await imageInfo(await app.get('/local/test.png/_inside_1400__.png'));
	assert.equal(image.width, 715);

	const enlarged = await startApp(localEnv({ ALLOW_ENLARGEMENT: 'true' }));
	t.after(() => enlarged.close());
	assert.equal((await imageInfo(await enlarged.get('/local/test.png/_inside_1400__.png'))).width, 1400);
});

test('CONTAIN_BACKGROUND colore les bandes ajoutées par contain', async (t) => {
	const app = await startApp(localEnv({ CONTAIN_BACKGROUND: '#ff0000' }));
	t.after(() => app.close());

	const { buffer } = await imageInfo(await app.get('/local/test.png/_contain_200_200_90.png'));
	// L'original est plus large que haut : le coin haut-gauche est une bande.
	const corner = await sharp(buffer).extract({ left: 0, top: 0, width: 4, height: 4 }).raw().toBuffer();
	assert.equal(corner[0], 255, 'rouge attendu dans la bande');
	assert.ok(corner[1] < 10 && corner[2] < 10, 'la bande ne doit contenir que du rouge');
});

test('les options d\'encodage changent le fichier produit', async (t) => {
	// mozjpeg optimise les passes de balayage, donc produit déjà du progressif :
	// pour observer JPEG_PROGRESSIVE seul, il faut le désactiver.
	const base = await startApp(localEnv({ JPEG_MOZJPEG: 'false' }));
	const progressive = await startApp(localEnv({ JPEG_MOZJPEG: 'false', JPEG_PROGRESSIVE: 'true' }));
	const mozjpeg = await startApp(localEnv());
	const lossless = await startApp(localEnv({ WEBP_LOSSLESS: 'true' }));
	t.after(() => Promise.all([ base.close(), progressive.close(), mozjpeg.close(), lossless.close() ]));

	const path = '/local/test.png/_cover_200_200_80.jpg';
	const plain = await imageInfo(await base.get(path));
	const interlaced = await imageInfo(await progressive.get(path));
	assert.equal(plain.isProgressive, false);
	assert.equal(interlaced.isProgressive, true);

	// mozjpeg tient sa promesse : plus petit à qualité égale.
	const optimised = await imageInfo(await mozjpeg.get(path));
	assert.ok(optimised.buffer.byteLength < plain.buffer.byteLength,
		`mozjpeg ${optimised.buffer.byteLength} doit être < ${plain.buffer.byteLength}`);

	const compressed = await imageInfo(await mozjpeg.get('/local/test.png/_cover_200_200_80.webp'));
	const exact = await imageInfo(await lossless.get('/local/test.png/_cover_200_200_80.webp'));
	assert.ok(exact.buffer.byteLength > compressed.buffer.byteLength, 'le sans-perte doit peser plus lourd');
});

test('AUTO_ROTATE=false ignore l\'orientation EXIF', async (t) => {
	const root = await makeTempDir();
	t.after(() => fs.rm(root, { recursive: true, force: true }));

	// Orientation 6 : l'image est stockée couchée et doit être redressée.
	const rotated = await sharp(join(FIXTURES, 'test.png'))
		.jpeg()
		.withMetadata({ orientation: 6 })
		.toBuffer();
	await fs.writeFile(join(root, 'exif.jpg'), rotated);

	const on = await startApp(localEnv({ SOURCE_LOCAL: root }));
	const off = await startApp(localEnv({ SOURCE_LOCAL: root, AUTO_ROTATE: 'false' }));
	t.after(() => Promise.all([ on.close(), off.close() ]));

	const redressed = await imageInfo(await on.get('/local/exif.jpg/_.jpg'));
	const asStored = await imageInfo(await off.get('/local/exif.jpg/_.jpg'));
	assert.ok(redressed.height > redressed.width, 'redressée : portrait');
	assert.ok(asStored.width > asStored.height, 'brute : paysage');
});

test('FETCH_HEADERS sont envoyés à la source HTTP', async (t) => {
	const received = [];
	const upstream = await startUpstream(FIXTURES, { onRequest: (req) => received.push(req.headers) });
	t.after(() => upstream.close());

	const app = await startApp({
		SOURCE_REMOTE: upstream.base,
		FETCH_HEADERS: '{"Authorization":"Bearer secret-du-bucket","X-Tenant":"acme"}',
		FETCH_USER_AGENT: 'mon-resizer/2',
		LOG_FORMAT: 'off',
		LOG_LEVEL: 'silent',
	});
	t.after(() => app.close());

	assert.equal((await app.get('/remote/test.png/_cover_50_50_80.jpg')).status, 200);
	assert.equal(received[0].authorization, 'Bearer secret-du-bucket');
	assert.equal(received[0]['x-tenant'], 'acme');
	assert.equal(received[0]['user-agent'], 'mon-resizer/2');
});
