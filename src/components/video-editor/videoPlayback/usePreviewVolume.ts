import { useCallback, useEffect, useMemo, useRef } from "react";
import { createVolumeEnvelope, type VolumeEnvelope } from "@/lib/audio/volumeEnvelope";
import type { VolumeRegion } from "../types";

interface PreviewAudioGraph {
	context: AudioContext;
	gain: GainNode;
	sources: WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>;
}

const GAIN_SMOOTHING_SECONDS = 0.015;

interface UsePreviewVolumeParams {
	videoRef: React.RefObject<HTMLVideoElement | null>;
	supplementalAudioRef: React.RefObject<HTMLAudioElement | null>;
	volumeRegions: VolumeRegion[];
	masterVolume: number;
	audioMuted: boolean;
	currentTime: number;
}

/**
 * Applies the project's volume envelope to the preview. Media elements are only
 * routed through Web Audio once volume is actually adjusted, so untouched projects
 * play exactly as before. Gains above 100% need Web Audio; if routing fails we fall
 * back to `element.volume`, which caps at 100%.
 */
export function usePreviewVolume({
	videoRef,
	supplementalAudioRef,
	volumeRegions,
	masterVolume,
	audioMuted,
	currentTime,
}: UsePreviewVolumeParams) {
	const graphRef = useRef<PreviewAudioGraph | null>(null);
	const graphFailedRef = useRef(false);

	const envelope: VolumeEnvelope = useMemo(
		() => createVolumeEnvelope(volumeRegions, { masterVolume, muted: audioMuted }),
		[volumeRegions, masterVolume, audioMuted],
	);
	const envelopeRef = useRef(envelope);
	envelopeRef.current = envelope;

	const getMediaElements = useCallback(() => {
		const elements: HTMLMediaElement[] = [];
		if (videoRef.current) elements.push(videoRef.current);
		if (supplementalAudioRef.current) elements.push(supplementalAudioRef.current);
		return elements;
	}, [videoRef, supplementalAudioRef]);

	const ensureRouted = useCallback((): PreviewAudioGraph | null => {
		if (graphFailedRef.current) return null;
		try {
			if (!graphRef.current) {
				const context = new AudioContext();
				const gain = context.createGain();
				gain.connect(context.destination);
				graphRef.current = { context, gain, sources: new WeakMap() };
				// Usually created right after a click (adding a region, moving a slider),
				// which lets the context start even if playback is already running.
				if (context.state === "suspended") {
					void context.resume().catch(() => undefined);
				}
			}
			const graph = graphRef.current;
			for (const element of getMediaElements()) {
				if (!graph.sources.has(element)) {
					const source = graph.context.createMediaElementSource(element);
					source.connect(graph.gain);
					graph.sources.set(element, source);
					element.volume = 1;
				}
			}
			return graph;
		} catch (error) {
			console.warn("[PreviewVolume] Web Audio routing unavailable, using element volume", error);
			graphFailedRef.current = true;
			return null;
		}
	}, [getMediaElements]);

	const applyGain = useCallback(
		(timeMs: number, immediate = false) => {
			const currentEnvelope = envelopeRef.current;
			const target = currentEnvelope.gainAt(timeMs);
			const graph =
				graphRef.current || !currentEnvelope.isIdentity ? ensureRouted() : graphRef.current;

			if (graph) {
				const param = graph.gain.gain;
				if (immediate) {
					param.cancelScheduledValues(graph.context.currentTime);
					param.value = target;
				} else {
					param.setTargetAtTime(target, graph.context.currentTime, GAIN_SMOOTHING_SECONDS);
				}
				return;
			}

			const fallbackVolume = Math.max(0, Math.min(1, target));
			for (const element of getMediaElements()) {
				element.volume = fallbackVolume;
			}
		},
		[ensureRouted, getMediaElements],
	);

	const currentTimeRef = useRef(currentTime);
	currentTimeRef.current = currentTime;

	// Envelope edits apply instantly so slider drags are audible right away.
	useEffect(() => {
		if (envelope) applyGain(currentTimeRef.current * 1000, true);
	}, [envelope, applyGain]);

	// Playback updates currentTime every animation frame.
	useEffect(() => {
		applyGain(currentTime * 1000);
	}, [currentTime, applyGain]);

	useEffect(() => {
		return () => {
			const graph = graphRef.current;
			graphRef.current = null;
			void graph?.context.close().catch(() => undefined);
		};
	}, []);

	/** Call from a user gesture (play) so the AudioContext is allowed to run. */
	const resumePreviewAudio = useCallback(async () => {
		const graph = envelopeRef.current.isIdentity ? graphRef.current : ensureRouted();
		applyGain(videoRef.current ? videoRef.current.currentTime * 1000 : 0, true);
		if (graph && graph.context.state === "suspended") {
			await graph.context.resume().catch(() => undefined);
		}
	}, [applyGain, ensureRouted, videoRef]);

	return { resumePreviewAudio };
}
