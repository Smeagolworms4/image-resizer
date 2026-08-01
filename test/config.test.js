import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ConfigError, loadConfig, parseSources } from '../src/config.js';
import { parsePreset, isPreset } from '../src/preset.js';
import { normalizeRelative, safeJoin, buildUpstreamUrl } from '../src/storage.js';
import { createLimiter } from '../src/semaphore.js';

const base = { SOURCES: '{"demo":"https://cdn.example.com"}' };

test('sources : syntaxe JSON', () => {
	const sources = parseSources({ SOURCES: '{"a":"https://a.example.com/","b":"/data/b"}' });
	assert.deepEqual(sources.a, { name: 'a', type: 'http', base: 'https://a.example.com' });
	assert.deepEqual(sources.b, { name: 'b', type: 'local', base: resolve('/data/b') });
});

test('sources : syntaxe courte nom=cible', () => {
	const sources = parseSources({ SOURCES: 'a=https://a.example.com, b=file:///data/b' });
	assert.equal(sources.a.base, 'https://a.example.com');
	assert.equal(sources.b.type, 'local');
	assert.equal(sources.b.base, resolve('/data/b'));
});

test('sources : une variable par source', () => {
	const sources = parseSources({ SOURCE_PHOTOS: 'https://cdn.example.com', SOURCE_LOCAL: './images' });
	assert.equal(sources.photos.type, 'http');
	assert.equal(sources.local.type, 'local');
	assert.equal(sources.local.base, resolve('./images'));
});

test('sources : au moins une source est obligatoire', () => {
	assert.throws(() => parseSources({}), ConfigError);
});

test('sources : nom invalide refusé', () => {
	assert.throws(() => parseSources({ SOURCES: '{"a/b":"https://x.example.com"}' }), ConfigError);
});

test('config : valeurs par défaut', () => {
	const config = loadConfig(base);
	assert.equal(config.port, 3000);
	assert.equal(config.maxSize, 2048);
	assert.equal(config.defaultQuality, 80);
	assert.equal(config.defaultFit, 'cover');
	assert.equal(config.defaultFormat, 'jpeg');
	assert.equal(config.basePath, '');
	assert.deepEqual(config.allowedFormats, [ 'jpeg', 'png', 'webp', 'avif' ]);
});

test('config : chaque réglage se surcharge par variable', () => {
	const config = loadConfig({
		...base,
		PORT: '8080',
		BASE_PATH: 'img/',
		MIN_SIZE: '16',
		MAX_SIZE: '4096',
		DEFAULT_QUALITY: '55',
		DEFAULT_FIT: 'inside',
		DEFAULT_FORMAT: 'webp',
		ALLOWED_FORMATS: 'webp,avif',
		ALLOW_ORIGINAL: 'false',
		AUTO_DOWNSCALE: 'no',
		CACHE_DIR: '/var/cache/images',
		MAX_AGE: '120',
		S_MAX_AGE: '3600',
	});

	assert.equal(config.port, 8080);
	assert.equal(config.basePath, '/img');
	assert.equal(config.minSize, 16);
	assert.equal(config.maxSize, 4096);
	assert.equal(config.defaultQuality, 55);
	assert.equal(config.defaultFit, 'inside');
	assert.equal(config.defaultFormat, 'webp');
	assert.equal(config.allowOriginal, false);
	assert.equal(config.autoDownscale, false);
	assert.equal(config.cacheDir, '/var/cache/images');
	assert.equal(config.maxAge, 120);
	assert.equal(config.sMaxAge, 3600);
});

test('config : les valeurs incohérentes sont rejetées au démarrage', () => {
	assert.throws(() => loadConfig({ ...base, PORT: 'abc' }), ConfigError);
	assert.throws(() => loadConfig({ ...base, MIN_SIZE: '4000', MAX_SIZE: '100' }), ConfigError);
	assert.throws(() => loadConfig({ ...base, DEFAULT_FIT: 'squish' }), ConfigError);
	assert.throws(() => loadConfig({ ...base, ALLOWED_FORMATS: 'jpeg,bmp' }), ConfigError);
	assert.throws(() => loadConfig({ ...base, DEFAULT_FORMAT: 'avif', ALLOWED_FORMATS: 'jpeg' }), ConfigError);
	assert.throws(() => loadConfig({ ...base, ALLOW_ORIGINAL: 'peut-être' }), ConfigError);
});

test('preset : reconnaissance', () => {
	assert.ok(isPreset('_.jpg'));
	assert.ok(isPreset('_cover_100_100_80.webp'));
	assert.ok(!isPreset('test.png'));
	assert.ok(!isPreset('_no-extension'));
});

test('preset : format seul', () => {
	const preset = parsePreset(loadConfig(base), '_.webp');
	assert.deepEqual(preset, { original: false, fit: 'cover', width: null, height: null, quality: 80, format: 'webp' });
});

test('preset : champs vides = valeurs par défaut', () => {
	const preset = parsePreset(loadConfig(base), '_inside_800__.jpg');
	assert.equal(preset.fit, 'inside');
	assert.equal(preset.width, 800);
	assert.equal(preset.height, null);
	assert.equal(preset.quality, 80);
});

test('preset : dimensions et qualité bornées par la configuration', () => {
	const config = loadConfig({ ...base, MIN_SIZE: '10', MAX_SIZE: '500', MIN_QUALITY: '20' });
	const preset = parsePreset(config, '_cover_9000_5_1.jpg');
	assert.equal(preset.width, 500);
	assert.equal(preset.height, 10);
	assert.equal(preset.quality, 20);
});

test('preset : original respecte ALLOW_ORIGINAL', () => {
	assert.deepEqual(parsePreset(loadConfig(base), '_original___.jpg'), { original: true, format: 'jpeg' });
	assert.throws(() => parsePreset(loadConfig({ ...base, ALLOW_ORIGINAL: 'false' }), '_original___.jpg'), /désactivée/);
});

test('preset : ajustements et formats inconnus refusés', () => {
	const config = loadConfig(base);
	assert.throws(() => parsePreset(config, '_squish_10_10_80.jpg'), /Mode d'ajustement inconnu/);
	assert.throws(() => parsePreset(config, '_.bmp'), /Format de sortie inconnu/);
	assert.throws(() => parsePreset(config, '_.gif'), /non autorisé/);
});

test('chemins : traversée impossible', () => {
	assert.throws(() => normalizeRelative('../../etc/passwd'), /invalide/);
	assert.throws(() => normalizeRelative('a/../../etc/passwd'), /invalide/);
	assert.throws(() => normalizeRelative('a\0b'), /invalide/);
	assert.throws(() => safeJoin('/srv/images', '../../etc/passwd'), /invalide/);
	assert.equal(normalizeRelative('/sub/./test.png'), 'sub/test.png');
	assert.equal(safeJoin('/srv/images', 'sub/test.png'), '/srv/images/sub/test.png');
});

test("chemins : l'URL amont est réencodée segment par segment", () => {
	assert.equal(
		buildUpstreamUrl('https://cdn.example.com', 'dossier accentué/été 2024.jpg'),
		'https://cdn.example.com/dossier%20accentu%C3%A9/%C3%A9t%C3%A9%202024.jpg',
	);
});

test('limiteur : refuse au-delà de la limite et libère ensuite', () => {
	const limiter = createLimiter(2);
	const first = limiter.acquire();
	const second = limiter.acquire();
	assert.ok(first && second);
	assert.equal(limiter.acquire(), null);
	assert.equal(limiter.inFlight, 2);

	first();
	first(); // Double libération sans effet.
	assert.equal(limiter.inFlight, 1);
	assert.ok(limiter.acquire());
});
