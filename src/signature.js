// Signature HMAC des URL, optionnelle : sans clé, ce module ne sert à rien et
// le service se comporte exactement comme avant.
//
// Le problème qu'elle règle : les dimensions vivent dans l'URL, donc n'importe
// qui peut demander `_cover_1999_1999_100.avif` et faire calculer des variantes
// qui ne servent aucune page. Le cache se remplit de bruit, le service travaille
// pour rien. Une URL signée ne se fabrique qu'avec la clé, donc uniquement par
// l'application qui écrit les pages.
//
// La signature est un champ de plus dans le preset, juste avant l'extension :
//
//   _cover_320_320_80.webp   ->   _cover_320_320_80_a1b2c3d4e5f60718.webp
//
// Ce qui est signé est le chemin décodé, sans BASE_PATH ni barre oblique de
// tête : `<source>/<chemin>/<preset sans signature>`. Le préfixe de montage en
// est exclu à dessein — déplacer le service sous `/images` n'invalide pas les
// URL déjà signées.
import { createHmac, timingSafeEqual } from 'node:crypto';

// Longueur en caractères hexadécimaux de chaque empreinte, pour refuser au
// démarrage une signature plus longue que ce que l'algorithme produit.
export const DIGEST_LENGTHS = { sha1: 40, sha256: 64, sha512: 128 };

export const SIGNATURE_ALGORITHMS = Object.keys(DIGEST_LENGTHS);

// La chaîne signée. Volontairement la plus simple possible : trois morceaux
// joints par des barres obliques, ce qui se réécrit en une ligne dans n'importe
// quel langage (cf. SIGNATURE.md).
export function canonicalPath(sourceName, relative, preset) {
	return `${sourceName}/${relative}/${preset}`;
}

export function computeSignature(config, canonical) {
	return createHmac(config.signatureAlgorithm, config.signatureKey)
		.update(canonical, 'utf8')
		.digest('hex')
		.slice(0, config.signatureLength);
}

// Le preset signé tel qu'il doit apparaître dans l'URL. Sert aux tests et à la
// documentation : le service, lui, ne fait que vérifier.
export function signPreset(config, sourceName, relative, preset) {
	const dot = preset.lastIndexOf('.');
	const signature = computeSignature(config, canonicalPath(sourceName, relative, preset));
	return `${preset.slice(0, dot)}_${signature}${preset.slice(dot)}`;
}

// Sépare `_cover_320_320_80_a1b2….webp` en preset et signature. On coupe sur le
// dernier tiret bas plutôt que par une expression régulière : les champs du
// preset sont des chiffres et la signature de l'hexadécimal, donc un motif
// « optionnel » les confondrait dès qu'une signature ne contient que des
// chiffres. Ici la position décide, pas le contenu.
export function splitSignature(segment) {
	const dot = segment.lastIndexOf('.');
	if (dot <= 0) return null;

	const body = segment.slice(0, dot);
	// Il faut le tiret bas d'ouverture du preset *et* celui qui précède la
	// signature : `_.webp` n'est donc pas une URL signée, c'en est une à qui il
	// manque la signature.
	const cut = body.lastIndexOf('_');
	if (cut <= 0) return null;

	return { preset: body.slice(0, cut) + segment.slice(dot), signature: body.slice(cut + 1) };
}

export function verifySignature(config, canonical, provided) {
	const expected = Buffer.from(computeSignature(config, canonical), 'utf8');
	const given = Buffer.from(String(provided).toLowerCase(), 'utf8');
	// `timingSafeEqual` exige deux tampons de même taille : une longueur
	// différente est de toute façon une signature fausse.
	if (given.length !== expected.length) return false;
	return timingSafeEqual(given, expected);
}
