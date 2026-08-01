// Le Dockerfile déclare toutes les variables avec leur valeur par défaut, pour
// qu'un `docker inspect` suffise à connaître les réglages disponibles. Cette
// documentation-là ne vaut que si elle est vraie : ce test compare le bloc ENV
// aux valeurs par défaut réellement appliquées par le service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = await fs.readFile(resolve(ROOT, 'Dockerfile'), 'utf8');

// Le bloc `ENV a=1 \` … `b=2` sur plusieurs lignes, ramené à un objet. Lu
// ligne à ligne : une instruction Docker continue tant que la précédente se
// termine par une barre oblique inverse.
function parseEnv(content) {
	const env = {};
	let inside = false;

	for (const rawLine of content.split('\n')) {
		const line = rawLine.trim();
		const isStart = line.startsWith('ENV ');
		if (!inside && !isStart) continue;

		const assignment = isStart ? line.slice('ENV '.length) : line;
		const continues = assignment.endsWith('\\');
		const cleaned = (continues ? assignment.slice(0, -1) : assignment).trim();
		const index = cleaned.indexOf('=');
		if (index > 0) env[cleaned.slice(0, index)] = cleaned.slice(index + 1);

		inside = continues;
	}
	return env;
}

const dockerEnv = parseEnv(dockerfile);

// Les noms lus par config.js, relevés dans le code : c'est la liste de
// référence, et elle ne peut pas se démoder.
const configSource = await fs.readFile(resolve(ROOT, 'src', 'config.js'), 'utf8');
const readVariables = new Set([ ...configSource.matchAll(/read[A-Za-z]*\(env,\s*'([A-Z0-9_]+)'/g) ].map((match) => match[1]));

test('le Dockerfile déclare toutes les variables lues par le service', () => {
	assert.ok(readVariables.size > 20, `liste de référence suspecte : ${readVariables.size} variables`);

	const missing = [ ...readVariables ].filter((name) => !(name in dockerEnv));
	assert.deepEqual(missing, [], `variables absentes du Dockerfile : ${missing.join(', ')}`);

	// L'inverse compte autant : une variable déclarée dans l'image mais que
	// personne ne lit est une promesse en l'air.
	const unused = Object.keys(dockerEnv).filter((name) => name !== 'NODE_ENV' && !readVariables.has(name));
	assert.deepEqual(unused, [], `variables déclarées mais jamais lues : ${unused.join(', ')}`);
});

test('les valeurs par défaut du Dockerfile sont celles du service', () => {
	const source = { SOURCE_TEST: '/tmp' };
	// Ce que fait le service sans rien : la référence.
	const reference = loadConfig(source);
	// Ce qu'il fait avec le bloc ENV de l'image : cela doit être identique.
	const fromImage = loadConfig({ ...dockerEnv, ...source });

	for (const [ key, value ] of Object.entries(reference)) {
		// CACHE_DIR=/cache est un choix propre à l'image, pas une valeur par
		// défaut du code, qui n'écrit nulle part tant qu'on ne lui dit pas où.
		if (key === 'cacheDir' || key === 'sources') continue;
		assert.deepEqual(fromImage[key], value, `${key} : le Dockerfile impose une valeur différente du défaut`);
	}

	assert.equal(fromImage.cacheDir, '/cache');
});

test('les variables déclarées sont documentées dans les deux README', async () => {
	const readmes = await Promise.all([ 'README.md', 'README.fr.md' ].map(async (file) => [ file, await fs.readFile(resolve(ROOT, file), 'utf8') ]));

	for (const [ file, text ] of readmes) {
		const missing = Object.keys(dockerEnv).filter((name) => name !== 'NODE_ENV' && !text.includes(`\`${name}\``));
		assert.deepEqual(missing, [], `${file} ne documente pas : ${missing.join(', ')}`);
	}
});

test('les variables déclarées existent toutes dans .env.example', async () => {
	const example = await fs.readFile(resolve(ROOT, '.env.example'), 'utf8');
	for (const name of Object.keys(dockerEnv)) {
		if (name === 'NODE_ENV') continue;
		assert.match(example, new RegExp(`^#?\\s*${name}=`, 'm'), `${name} n'est pas documenté dans .env.example`);
	}
});
