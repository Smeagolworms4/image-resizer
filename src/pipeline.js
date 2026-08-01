// Le traitement sharp proprement dit : décodage, rotation, redimensionnement,
// encodage. Aucune entrée/sortie ici — le module reçoit des octets et en rend.
import sharp from 'sharp';
import { MIME_TYPES } from './config.js';

export function applySharpTuning(config) {
	if (config.sharpConcurrency > 0) sharp.concurrency(config.sharpConcurrency);
	sharp.cache({ memory: config.sharpCacheMemory });
}

// On ne demande pas à sharp s'il s'agit de HEIC : ses binaires précompilés
// n'ouvrent pas le HEVC et renverraient simplement une erreur, alors que la
// signature du conteneur, elle, se lit en douze octets. L'AVIF partage ce
// conteneur mais sharp le décode nativement — il ne doit donc pas partir chez
// le convertisseur externe.
const HEIF_BRANDS = new Set([ 'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1' ]);

export function isHeif(buffer) {
	if (buffer.length < 12) return false;
	if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
	return HEIF_BRANDS.has(buffer.toString('ascii', 8, 12).toLowerCase());
}

export async function detectContentType(buffer) {
	if (isHeif(buffer)) return MIME_TYPES.heif;
	try {
		const { format } = await sharp(buffer).metadata();
		return MIME_TYPES[format] || 'application/octet-stream';
	} catch {
		return 'application/octet-stream';
	}
}

export async function transform(buffer, preset, config) {
	// `FAIL_ON=none` : mieux vaut rendre une image tronquée que rien du tout.
	// `rotate()` sans argument applique l'orientation EXIF — sans lui, les
	// photos de téléphone sortent couchées.
	let image = sharp(buffer, { failOn: config.failOn });
	if (config.autoRotate) image = image.rotate();
	const metadata = await image.metadata();

	const hasExplicitResize = Boolean(preset.width || preset.height);
	if (hasExplicitResize) {
		image = image.resize({
			width: preset.width || null,
			height: preset.height || null,
			fit: preset.fit,
			position: config.defaultPosition,
			kernel: config.resizeKernel,
			background: config.containBackground,
			withoutEnlargement: !config.allowEnlargement,
		});
	} else if (config.autoDownscale && (metadata.width > config.maxSize || metadata.height > config.maxSize)) {
		// Aucune dimension demandée : on borne quand même à MAX_SIZE, sinon un
		// original de 8000 px part tel quel dans le réseau à chaque requête.
		image = image.resize({
			width: config.maxSize,
			height: config.maxSize,
			fit: 'inside',
			kernel: config.resizeKernel,
			withoutEnlargement: true,
		});
	}

	if (!config.stripMetadata) image = image.withMetadata();

	switch (preset.format) {
		case 'jpeg':
			image = image.jpeg({
				quality: preset.quality,
				mozjpeg: config.jpegMozjpeg,
				progressive: config.jpegProgressive,
				chromaSubsampling: config.jpegChromaSubsampling,
			});
			break;
		case 'png':
			image = image.png({
				compressionLevel: config.pngCompressionLevel,
				palette: config.pngPalette,
			});
			break;
		case 'webp':
			image = image.webp({
				quality: preset.quality,
				effort: config.webpEffort,
				lossless: config.webpLossless,
				smartSubsample: config.webpSmartSubsample,
			});
			break;
		case 'avif':
			image = image.avif({
				quality: preset.quality,
				effort: config.avifEffort,
				lossless: config.avifLossless,
				chromaSubsampling: config.avifChromaSubsampling,
			});
			break;
		case 'gif':
			image = image.gif();
			break;
		case 'tiff':
			image = image.tiff({ quality: preset.quality });
			break;
	}

	return {
		buffer: await image.toBuffer(),
		contentType: MIME_TYPES[preset.format],
	};
}
