// La signature HMAC : ce qui compte est qu'une clé vide ne change rien, et
// qu'une clé posée rende impossible la fabrication d'une variante à la main.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ConfigError, loadConfig } from '../src/config.js';
import { canonicalPath, computeSignature, signPreset, splitSignature, verifySignature } from '../src/signature.js';
import { FIXTURES, imageInfo, startApp } from './helpers.js';

const KEY = 'une-clé-de-signature-bien-longue';
const localEnv = (extra = {}) => ({ SOURCE_LOCAL: FIXTURES, LOG_FORMAT: 'off', LOG_LEVEL: 'silent', ...extra });

// L'URL telle qu'une application cliente la construirait, en passant par le
// même chemin de code que la documentation décrit.
const signed = (config, path, preset) => {
	const [ source, ...rest ] = path.split('/');
	return `/${source}/${rest.join('/')}/${signPreset(config, source, rest.join('/'), preset)}`;
};

test('signature : la clé vide laisse le service inchangé', async (t) => {
	const app = await startApp(localEnv());
	t.after(() => app.close());

	assert.equal(app.config.signatureKey, '');
	assert.equal((await app.get('/local/test.png/_cover_40_40_80.jpg')).status, 200);
});

test('signature : sans elle, plus rien ne passe', async (t) => {
	const app = await startApp(localEnv({ SIGNATURE_KEY: KEY }));
	t.after(() => app.close());

	assert.equal((await app.get('/local/test.png/_cover_40_40_80.jpg')).status, 403);
	assert.equal((await app.get('/local/test.png/_.jpg')).status, 403);
	assert.equal((await app.get('/local/test.png/_cover_40_40_80_0000000000000000.jpg')).status, 403);

	const body = await (await app.get('/local/test.png/_.jpg')).json();
	assert.match(body.error, /[Ss]ignature/);
});

test('signature : une URL signée est servie normalement', async (t) => {
	const app = await startApp(localEnv({ SIGNATURE_KEY: KEY }));
	t.after(() => app.close());

	const response = await app.get(signed(app.config, 'local/test.png', '_cover_40_40_80.jpg'));
	assert.equal(response.status, 200);
	assert.equal((await imageInfo(response)).width, 40);

	// Le preset réduit au seul format se signe aussi : le champ vide reste.
	assert.equal((await app.get(signed(app.config, 'local/test.png', '_.jpg'))).status, 200);
	assert.equal((await app.get(signed(app.config, 'local/test.png', '_original___.jpg'))).status, 200);
	assert.equal((await app.get(signed(app.config, 'local/sub/sub2/test.png', '_cover_40_40_80.jpg'))).status, 200);
});

test("signature : elle ne vaut que pour la variante qu'on a signée", async (t) => {
	const app = await startApp(localEnv({ SIGNATURE_KEY: KEY }));
	t.after(() => app.close());

	const url = signed(app.config, 'local/test.png', '_cover_40_40_80.jpg');
	const stolen = url.slice(url.lastIndexOf('/') + 1).match(/_([0-9a-f]+)\.jpg$/)[1];

	// C'est tout l'intérêt : la signature d'une vignette ne finance pas un
	// 2000×2000, ni le même preset sur une autre image.
	assert.equal((await app.get(`/local/test.png/_cover_2000_2000_100_${stolen}.jpg`)).status, 403);
	assert.equal((await app.get(`/local/BIG.jpg/_cover_40_40_80_${stolen}.jpg`)).status, 403);
	assert.equal((await app.get(`/local/test.png/_cover_40_40_80_${stolen}.webp`)).status, 403);
	assert.equal((await app.get(url)).status, 200);
});

test('signature : les noms encodés se signent en clair', async (t) => {
	const app = await startApp(localEnv({ SIGNATURE_KEY: KEY }));
	t.after(() => app.close());

	// La chaîne signée est le chemin décodé — celui que l'application connaît,
	// pas celui qui voyage sur le réseau.
	const preset = signPreset(app.config, 'local', 'sub/sub2/test.png', '_cover_30_30_80.jpg');
	assert.equal((await app.get(`/local/sub/${encodeURIComponent('sub2')}/test.png/${preset}`)).status, 200);
});

test("signature : BASE_PATH n'entre pas dans le calcul", async (t) => {
	const app = await startApp(localEnv({ SIGNATURE_KEY: KEY, BASE_PATH: '/images' }));
	t.after(() => app.close());

	const preset = signPreset(app.config, 'local', 'test.png', '_cover_40_40_80.jpg');
	assert.equal((await app.get(`/images/local/test.png/${preset}`)).status, 200);
});

test('signature : algorithme et longueur configurables', async (t) => {
	const app = await startApp(localEnv({ SIGNATURE_KEY: KEY, SIGNATURE_ALGORITHM: 'sha512', SIGNATURE_LENGTH: '32' }));
	t.after(() => app.close());

	const expected = createHmac('sha512', KEY).update('local/test.png/_cover_40_40_80.jpg').digest('hex').slice(0, 32);
	const preset = signPreset(app.config, 'local', 'test.png', '_cover_40_40_80.jpg');
	assert.equal(preset, `_cover_40_40_80_${expected}.jpg`);
	assert.equal((await app.get(`/local/test.png/${preset}`)).status, 200);

	// La même clé avec l'algorithme par défaut ne produit pas cette URL.
	const other = await startApp(localEnv({ SIGNATURE_KEY: KEY }));
	t.after(() => other.close());
	assert.equal((await other.get(`/local/test.png/${preset}`)).status, 403);
});

test('signature : découpage du preset signé', () => {
	assert.deepEqual(splitSignature('_cover_320_320_80_a1b2c3d4.webp'), { preset: '_cover_320_320_80.webp', signature: 'a1b2c3d4' });
	assert.deepEqual(splitSignature('__a1b2c3d4.webp'), { preset: '_.webp', signature: 'a1b2c3d4' });
	assert.deepEqual(splitSignature('_original____a1b2c3d4.jpg'), { preset: '_original___.jpg', signature: 'a1b2c3d4' });
	// Pas de champ signature du tout.
	assert.equal(splitSignature('_.webp'), null);
	assert.equal(splitSignature('_cover_320_320_80'), null);
});

test('signature : calcul et vérification', () => {
	const config = loadConfig({ SOURCE_LOCAL: FIXTURES, SIGNATURE_KEY: KEY });
	const canonical = canonicalPath('local', 'un dossier/été.jpg', '_cover_320_320_80.webp');
	const expected = createHmac('sha256', KEY).update(canonical).digest('hex').slice(0, 16);

	assert.equal(computeSignature(config, canonical), expected);
	assert.equal(computeSignature(config, canonical).length, 16);
	assert.ok(verifySignature(config, canonical, expected));
	// La casse ne compte pas, le reste si.
	assert.ok(verifySignature(config, canonical, expected.toUpperCase()));
	assert.ok(!verifySignature(config, canonical, expected.slice(0, 15)));
	assert.ok(!verifySignature(config, canonical, `${expected}00`));
	assert.ok(!verifySignature(config, canonical, ''));
});

test('signature : configuration incohérente refusée au démarrage', () => {
	const base = { SOURCE_LOCAL: FIXTURES, SIGNATURE_KEY: KEY };
	assert.throws(() => loadConfig({ ...base, SIGNATURE_ALGORITHM: 'md5' }), ConfigError);
	assert.throws(() => loadConfig({ ...base, SIGNATURE_LENGTH: '4' }), ConfigError);
	// sha1 ne produit que 40 caractères : en demander 64 serait une promesse
	// tenue par un remplissage silencieux.
	assert.throws(() => loadConfig({ ...base, SIGNATURE_ALGORITHM: 'sha1', SIGNATURE_LENGTH: '64' }), ConfigError);
	assert.equal(loadConfig({ ...base, SIGNATURE_ALGORITHM: 'sha1', SIGNATURE_LENGTH: '40' }).signatureLength, 40);
});
