// Une erreur qui porte son code HTTP : le gestionnaire de route se contente de
// la relayer. Tout ce qui n'est pas une HttpError est un vrai bug, donc un 500
// (et c'est la seule chose qu'on trace dans les logs).
export class HttpError extends Error {
	constructor(status, message, { expose = true, headers = null } = {}) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
		this.expose = expose;
		this.headers = headers;
	}
}

export const badRequest = (message) => new HttpError(400, message);
export const notFound = (message = 'Image not found') => new HttpError(404, message);
export const unavailable = (message, headers) => new HttpError(503, message, { headers });
