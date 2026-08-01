// Le preset est le dernier segment de l'URL. Il décrit entièrement la
// transformation, ce qui rend chaque variante adressable — et donc cachable
// telle quelle par un CDN, sans query string ni négociation de contenu.
//
//   _.webp                  format seul (redimensionnement automatique)
//   _cover_320_320_80.jpg   ajustement, largeur, hauteur, qualité
//   _inside_800__.webp      les champs vides prennent la valeur par défaut
//   _original___.jpg        l'original, octet pour octet
import { FIT_OPTIONS, FORMAT_ALIASES } from './config.js';
import { badRequest } from './errors.js';

const PRESET_PATTERN = /^_(?<fit>[a-zA-Z]*)(?:_(?<width>\d*))?(?:_(?<height>\d*))?(?:_(?<quality>\d*))?\.(?<extension>[a-zA-Z0-9]+)$/;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export function isPreset(segment) {
	return typeof segment === 'string' && segment.startsWith('_') && PRESET_PATTERN.test(segment);
}

export function parsePreset(config, segment) {
	const match = PRESET_PATTERN.exec(segment);
	if (!match) throw badRequest(`Preset invalide '${segment}'`);

	const { fit, width, height, quality, extension } = match.groups;

	const format = FORMAT_ALIASES[extension.toLowerCase()];
	if (!format) throw badRequest(`Format de sortie inconnu '${extension}'`);
	if (!config.allowedFormats.includes(format)) throw badRequest(`Format de sortie non autorisé '${extension}'`);

	if (fit === 'original') {
		if (!config.allowOriginal) throw badRequest("La diffusion de l'original est désactivée");
		return { original: true, format };
	}

	if (fit && !FIT_OPTIONS.includes(fit)) {
		throw badRequest(`Mode d'ajustement inconnu '${fit}' (connus : ${FIT_OPTIONS.join(', ')}, original)`);
	}

	const parseSize = (value) => {
		if (!value) return null;
		return clamp(Number(value), config.minSize, config.maxSize);
	};

	return {
		original: false,
		fit: fit || config.defaultFit,
		width: parseSize(width),
		height: parseSize(height),
		quality: quality ? clamp(Number(quality), config.minQuality, 100) : config.defaultQuality,
		format,
	};
}
