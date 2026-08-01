// Limiteur de concurrence sans file d'attente : au-delà de la limite on refuse
// tout de suite. Empiler les requêtes ne fait que déplacer le problème — la
// mémoire monte, les clients ont déjà abandonné, et la machine tombe quand
// même. Un 503 immédiat est réessayé par le CDN, et le service reste debout.
export function createLimiter(max) {
	let inFlight = 0;

	return {
		max,
		get inFlight() {
			return inFlight;
		},
		// Rend une fonction de libération, ou `null` si la limite est atteinte.
		acquire() {
			if (inFlight >= max) return null;
			inFlight++;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				inFlight--;
			};
		},
	};
}
