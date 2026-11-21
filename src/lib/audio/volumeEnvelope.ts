import type { AudioMixSettings, VolumeRegion } from "@/components/video-editor/types";

/** Ramp length at each edge of a volume region, so level changes never click. */
export const VOLUME_FADE_MS = 40;

export interface VolumeEnvelope {
	/** Gain to apply at a source-timeline position (milliseconds). */
	gainAt(timeMs: number): number;
	/** True when the envelope is 1 everywhere and processing can be skipped. */
	isIdentity: boolean;
}

function sortRegions(regions: VolumeRegion[]): VolumeRegion[] {
	return regions
		.filter((region) => region.endMs > region.startMs && Number.isFinite(region.volume))
		.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Builds the gain curve for a project: master volume × the active region's volume,
 * with a short linear crossfade at region edges. Regions never overlap on the
 * timeline; if they do anyway, the first one wins.
 */
export function createVolumeEnvelope(
	regions: VolumeRegion[] | undefined,
	mix: Partial<AudioMixSettings> | undefined,
): VolumeEnvelope {
	const muted = mix?.muted === true;
	const master =
		typeof mix?.masterVolume === "number" && Number.isFinite(mix.masterVolume)
			? Math.max(0, mix.masterVolume)
			: 1;
	const sorted = sortRegions(regions ?? []);

	if (muted || master === 0) {
		return { gainAt: () => 0, isIdentity: false };
	}

	const isIdentity = master === 1 && sorted.every((region) => region.volume === 1);

	const regionGainAt = (timeMs: number): number => {
		// Binary search for the last region starting at or before timeMs.
		let lo = 0;
		let hi = sorted.length - 1;
		let index = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (sorted[mid].startMs <= timeMs) {
				index = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}

		// Also consider the next region's fade-in, which starts at its startMs.
		const region = index >= 0 ? sorted[index] : null;
		if (!region || timeMs >= region.endMs) {
			return 1;
		}

		const duration = region.endMs - region.startMs;
		const fade = Math.min(VOLUME_FADE_MS, duration / 2);
		const intoRegion = timeMs - region.startMs;
		const untilEnd = region.endMs - timeMs;
		const ramp = fade > 0 ? Math.min(1, intoRegion / fade, untilEnd / fade) : 1;
		return 1 + (region.volume - 1) * ramp;
	};

	return {
		gainAt: (timeMs: number) => master * regionGainAt(timeMs),
		isIdentity,
	};
}

/**
 * Multiplies planar float samples in place by the envelope. `startMs` is the
 * source-timeline position of the first frame.
 */
export function applyVolumeEnvelopeToPlanes(
	planes: Float32Array[],
	sampleRate: number,
	startMs: number,
	envelope: VolumeEnvelope,
): void {
	if (envelope.isIdentity || planes.length === 0) return;
	const frameCount = planes[0].length;
	const msPerFrame = 1000 / sampleRate;

	for (let frame = 0; frame < frameCount; frame++) {
		const gain = envelope.gainAt(startMs + frame * msPerFrame);
		if (gain === 1) continue;
		for (const plane of planes) {
			let sample = plane[frame] * gain;
			// Hard-limit boosted audio to the valid range instead of wrapping.
			if (sample > 1) sample = 1;
			else if (sample < -1) sample = -1;
			plane[frame] = sample;
		}
	}
}
