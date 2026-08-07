// Point d'entrée AWS Lambda. Le service reste exactement le même que sous
// Docker : c'est l'application Express de `server.js`, démarrée une seule fois
// par conteneur sur une socket de bouclage, à laquelle chaque invocation est
// relayée. Réécrire un adaptateur qui fabrique de faux `req`/`res` aurait
// dupliqué le routage, les en-têtes et la gestion d'erreurs — et ces deux
// copies auraient divergé. Le prix payé est un aller-retour sur 127.0.0.1,
// quelques dixièmes de milliseconde à côté d'un décodage d'image.
import http from 'node:http';
import { once } from 'node:events';
import { describeConfig, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createApp } from './server.js';

// Lambda plafonne la réponse d'une invocation classique à 6 Mo, et le corps y
// voyage en base64 (+33 %). On garde de la marge pour l'enveloppe JSON et les
// en-têtes. Au-delà, il faut le mode « response streaming » plus bas.
const MAX_BUFFERED_BYTES = 4_500_000;

// Ces en-têtes décrivent une connexion, pas un message : les relayer à travers
// un autre saut n'a pas de sens et peut casser la réponse.
const HOP_BY_HOP = new Set([
	'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
	'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

const SKIPPED_REQUEST_HEADERS = new Set([ ...HOP_BY_HOP, 'host', 'content-length', 'accept-encoding' ]);
const SKIPPED_RESPONSE_HEADERS = new Set([ ...HOP_BY_HOP, 'content-length', 'content-encoding' ]);

// Ce qui peut voyager en clair dans le JSON de réponse. Tout le reste part en
// base64 : les images, évidemment, mais aussi les originaux servis tels quels.
const TEXTUAL = /^(?:text\/|application\/(?:json|javascript|xml)\b)/i;

let booting = null;

async function start() {
	const config = loadConfig();
	const logger = createLogger(config.logLevel);
	const { app } = createApp({ config, logger });

	for (const [ key, value ] of Object.entries(describeConfig(config))) {
		logger.info(`${key} = ${typeof value === 'object' ? JSON.stringify(value) : value}`);
	}

	// Port 0 : le noyau en choisit un de libre. Rien d'autre que cette Lambda ne
	// parle à cette socket, et elle n'écoute que sur la boucle locale.
	const server = app.listen(0, '127.0.0.1');
	await once(server, 'listening');

	// La socket ne doit pas être ce qui maintient le processus en vie : sous
	// Lambda c'est le runtime qui le fait, et sans ça un test ou un script qui
	// importe ce module ne rendrait jamais la main.
	server.unref();

	const { port } = server.address();
	logger.info(`image-resizer prêt pour Lambda sur http://127.0.0.1:${port}${config.basePath || ''}`);
	return { origin: `http://127.0.0.1:${port}`, config, logger };
}

// L'initialisation est partagée par toutes les invocations d'un même conteneur.
// Si elle échoue — configuration invalide, port indisponible — on l'oublie,
// pour que la prochaine invocation retente au lieu de servir une erreur figée.
function boot() {
	if (!booting) {
		booting = start().catch((error) => {
			booting = null;
			throw error;
		});
	}
	return booting;
}

// Trois formes d'événement mènent ici : URL de fonction et HTTP API (« payload
// 2.0 »), REST API (« 1.0 ») et ALB. Elles ne nomment pas les mêmes champs mais
// portent les mêmes informations.
function readRequest(event) {
	const method = event.requestContext?.http?.method || event.httpMethod || 'GET';

	// `rawPath` (2.0) et `path` (1.0, ALB) sont pris tels quels : le parseur
	// d'URL encode ce qui doit l'être, et ne touche pas aux `%XX` déjà présents.
	const path = event.rawPath || event.path || '/';

	let query = event.rawQueryString || '';
	if (!query) {
		const parameters = new URLSearchParams();
		for (const [ key, values ] of Object.entries(event.multiValueQueryStringParameters || {})) {
			for (const value of values) parameters.append(key, value);
		}
		if (!parameters.size) {
			for (const [ key, value ] of Object.entries(event.queryStringParameters || {})) {
				if (value !== undefined && value !== null) parameters.append(key, value);
			}
		}
		query = parameters.toString();
	}

	const headers = {};
	for (const [ name, value ] of Object.entries(event.headers || {})) {
		if (value === undefined || value === null) continue;
		if (SKIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
		headers[name] = String(value);
	}

	return { method, url: `${path}${query ? `?${query}` : ''}`, headers };
}

// Le relais passe par `node:http` et non par `fetch` : undici retire les
// en-têtes conditionnels (`If-None-Match`, `If-Modified-Since`) qu'il n'a pas
// posés lui-même. Avec lui, la revalidation d'un CDN ne rendrait jamais 304 et
// chaque vérification renverrait l'image entière.
function proxy(origin, { method, url, headers }) {
	return new Promise((resolve, reject) => {
		const request = http.request(`${origin}${url}`, { method, headers }, (response) => {
			const chunks = [];
			response.on('data', (chunk) => chunks.push(chunk));
			response.on('error', reject);
			response.on('end', () => resolve({
				status: response.statusCode,
				headers: response.headers,
				body: Buffer.concat(chunks),
			}));
		});
		request.on('error', reject);
		request.end();
	});
}

async function invoke(event) {
	const { origin } = await boot();
	const response = await proxy(origin, readRequest(event));

	const headers = {};
	for (const [ name, value ] of Object.entries(response.headers)) {
		if (SKIPPED_RESPONSE_HEADERS.has(name)) continue;
		headers[name] = Array.isArray(value) ? value.join(', ') : value;
	}

	return {
		status: response.status,
		headers,
		body: response.body,
		contentType: response.headers['content-type'] || '',
	};
}

function encodeBody(result) {
	if (TEXTUAL.test(result.contentType)) {
		return { body: result.body.toString('utf8'), isBase64Encoded: false };
	}
	return { body: result.body.toString('base64'), isBase64Encoded: true };
}

// Invocation classique : la réponse entière transite dans le JSON rendu à
// Lambda, d'où le plafond. Une image qui le dépasse est refusée explicitement,
// parce que la même situation sans contrôle donne un « Internal server error »
// d'API Gateway impossible à relier à sa cause.
export const handler = async (event) => {
	const result = await invoke(event);

	if (result.body.byteLength > MAX_BUFFERED_BYTES) {
		return {
			statusCode: 502,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
			body: JSON.stringify({
				error: `Response too large for a buffered Lambda response (${result.body.byteLength} bytes, limit ${MAX_BUFFERED_BYTES}). `
					+ 'Lower MAX_SIZE or DEFAULT_QUALITY, or deploy the streaming handler (src/lambda.streamingHandler).',
			}),
			isBase64Encoded: false,
		};
	}

	return { statusCode: result.status, headers: result.headers, ...encodeBody(result) };
};

// Variante « response streaming » : à déployer avec le mode d'invocation
// RESPONSE_STREAM d'une URL de fonction. Le corps sort en octets bruts, sans
// base64 ni enveloppe JSON, ce qui monte le plafond à 20 Mo. `awslambda` est un
// objet global fourni par le runtime : il n'existe pas ailleurs, d'où le garde-fou.
export const streamingHandler = globalThis.awslambda?.streamifyResponse
	? globalThis.awslambda.streamifyResponse(async (event, responseStream) => {
		const result = await invoke(event);
		const stream = globalThis.awslambda.HttpResponseStream.from(responseStream, {
			statusCode: result.status,
			headers: result.headers,
		});
		stream.end(result.body);
	})
	: undefined;
