// Le point d'entrée Lambda ne refait pas le service : il traduit un événement
// AWS en requête HTTP et la réponse en JSON. Ce sont ces deux traductions qui
// sont testées ici — le reste est couvert par server.test.js.
//
// `src/lambda.js` lit la configuration dans `process.env` au premier appel et
// la garde pour toute la vie du conteneur : l'environnement est donc posé
// avant l'import, une fois pour tout le fichier.
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { FIXTURES } from './helpers.js';

process.env.SOURCE_LOCAL = FIXTURES;
process.env.LOG_FORMAT = 'off';
process.env.LOG_LEVEL = 'silent';

const { handler } = await import('../src/lambda.js');

// Ce que rend une URL de fonction Lambda ou une HTTP API : la charge « 2.0 ».
const functionUrlEvent = (rawPath, { method = 'GET', rawQueryString = '', headers = {} } = {}) => ({
	version: '2.0',
	rawPath,
	rawQueryString,
	headers,
	requestContext: { http: { method, path: rawPath } },
});

// Ce que rend une REST API ou un ALB : la charge « 1.0 », qui ne nomme rien
// pareil.
const restApiEvent = (path, { method = 'GET', queryStringParameters = null, headers = {} } = {}) => ({
	path,
	httpMethod: method,
	headers,
	queryStringParameters,
});

const decode = (response) => Buffer.from(response.body, response.isBase64Encoded ? 'base64' : 'utf8');

test('une image passe en base64 avec ses en-têtes', async () => {
	const response = await handler(functionUrlEvent('/local/test.png/_cover_100_50_80.jpg'));

	assert.equal(response.statusCode, 200);
	assert.equal(response.isBase64Encoded, true);
	assert.equal(response.headers['content-type'], 'image/jpeg');
	assert.match(response.headers['cache-control'], /max-age=604800/);

	const image = await sharp(decode(response)).metadata();
	assert.equal(image.format, 'jpeg');
	assert.equal(image.width, 100);
	assert.equal(image.height, 50);
});

test('le JSON reste du texte : il n\'a rien à gagner au base64', async () => {
	const response = await handler(functionUrlEvent('/health'));

	assert.equal(response.statusCode, 200);
	assert.equal(response.isBase64Encoded, false);
	assert.deepEqual(JSON.parse(response.body).sources, [ 'local' ]);
	assert.equal(response.headers['cache-control'], 'no-store');
});

test('la charge REST/ALB mène au même endroit que la charge 2.0', async () => {
	const response = await handler(restApiEvent('/local/test.png/_cover_60_60_80.png'));

	assert.equal(response.statusCode, 200);
	const image = await sharp(decode(response)).metadata();
	assert.equal(image.format, 'png');
	assert.equal(image.width, 60);
});

test('les chemins encodés et accentués arrivent intacts', async () => {
	// `rawPath` est déjà encodé côté AWS ; il ne doit pas l'être une seconde fois.
	const response = await handler(functionUrlEvent('/local/sub/sub2/test.png/_inside_40__.png'));
	assert.equal(response.statusCode, 200);

	const image = await sharp(decode(response)).metadata();
	assert.equal(image.width, 40);
});

test('les erreurs du service traversent la traduction', async () => {
	const missing = await handler(functionUrlEvent('/local/absente.png/_cover_10_10_80.jpg'));
	assert.equal(missing.statusCode, 404);
	assert.equal(JSON.parse(missing.body).error, 'Image not found');

	const unknownSource = await handler(functionUrlEvent('/nope/test.png/_cover_10_10_80.jpg'));
	assert.equal(unknownSource.statusCode, 400);

	const notAnImage = await handler(functionUrlEvent('/local/test.png', { method: 'POST' }));
	assert.equal(notAnImage.statusCode, 405);
});

test('le préflight CORS répond sans corps', async () => {
	const response = await handler(functionUrlEvent('/local/test.png/_cover_10_10_80.jpg', { method: 'OPTIONS' }));

	assert.equal(response.statusCode, 204);
	assert.equal(response.headers['access-control-allow-origin'], '*');
	assert.equal(response.headers['access-control-allow-methods'], 'GET, HEAD, OPTIONS');
});

test('HEAD rend les en-têtes sans les octets', async () => {
	const response = await handler(functionUrlEvent('/local/test.png/_cover_100_50_80.jpg', { method: 'HEAD' }));

	assert.equal(response.statusCode, 200);
	assert.equal(response.headers['content-type'], 'image/jpeg');
	assert.equal(response.body, '');
});

test('les en-têtes conditionnels donnent bien un 304', async () => {
	const first = await handler(functionUrlEvent('/local/test.png/_cover_100_50_80.jpg'));
	const etag = first.headers.etag;
	assert.ok(etag, 'Express doit avoir posé un ETag');

	const second = await handler(functionUrlEvent('/local/test.png/_cover_100_50_80.jpg', {
		headers: { 'if-none-match': etag },
	}));
	assert.equal(second.statusCode, 304);
});

test('une réponse trop grosse pour Lambda est refusée explicitement', async () => {
	// BIG.png rendu sans perte : bien au-delà des 4,5 Mo qu'une invocation
	// classique peut rapporter. Le message doit dire quoi faire, pas juste
	// échouer — c'est tout l'intérêt du contrôle.
	const response = await handler(functionUrlEvent('/local/BIG.png/_cover_4000_4000_100.png'));

	assert.equal(response.statusCode, 502);
	assert.match(JSON.parse(response.body).error, /Response too large/);
	assert.match(JSON.parse(response.body).error, /streamingHandler/);
});
