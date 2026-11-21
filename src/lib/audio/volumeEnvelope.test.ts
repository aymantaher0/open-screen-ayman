import { describe, expect, it } from "vitest";
import type { VolumeRegion } from "@/components/video-editor/types";
import {
	applyVolumeEnvelopeToPlanes,
	createVolumeEnvelope,
	VOLUME_FADE_MS,
} from "./volumeEnvelope";

const region = (startMs: number, endMs: number, volume: number, id = "volume-1"): VolumeRegion => ({
	id,
	startMs,
	endMs,
	volume,
});

describe("createVolumeEnvelope", () => {
	it("is the identity when nothing is adjusted", () => {
		const envelope = createVolumeEnvelope([], { masterVolume: 1, muted: false });
		expect(envelope.isIdentity).toBe(true);
		expect(envelope.gainAt(1234)).toBe(1);
	});

	it("treats regions at 100% as identity", () => {
		expect(createVolumeEnvelope([region(0, 1000, 1)], undefined).isIdentity).toBe(true);
	});

	it("applies the region level inside the region and 1 outside", () => {
		const envelope = createVolumeEnvelope([region(1000, 3000, 0.25)], undefined);
		expect(envelope.isIdentity).toBe(false);
		expect(envelope.gainAt(500)).toBe(1);
		expect(envelope.gainAt(2000)).toBeCloseTo(0.25);
		expect(envelope.gainAt(3000)).toBe(1);
		expect(envelope.gainAt(5000)).toBe(1);
	});

	it("ramps linearly over the fade at both edges", () => {
		const envelope = createVolumeEnvelope([region(1000, 3000, 0)], undefined);
		expect(envelope.gainAt(1000)).toBeCloseTo(1);
		expect(envelope.gainAt(1000 + VOLUME_FADE_MS / 2)).toBeCloseTo(0.5);
		expect(envelope.gainAt(1000 + VOLUME_FADE_MS)).toBeCloseTo(0);
		expect(envelope.gainAt(3000 - VOLUME_FADE_MS / 2)).toBeCloseTo(0.5);
	});

	it("shortens the fade for very short regions", () => {
		const envelope = createVolumeEnvelope([region(0, 20, 0)], undefined);
		expect(envelope.gainAt(10)).toBeCloseTo(0);
	});

	it("multiplies regions by master volume", () => {
		const envelope = createVolumeEnvelope([region(0, 1000, 0.5)], { masterVolume: 2 });
		expect(envelope.gainAt(500)).toBeCloseTo(1);
		expect(envelope.gainAt(2000)).toBeCloseTo(2);
	});

	it("silences everything when muted", () => {
		const envelope = createVolumeEnvelope([region(0, 1000, 2)], { masterVolume: 1, muted: true });
		expect(envelope.gainAt(500)).toBe(0);
		expect(envelope.gainAt(5000)).toBe(0);
	});

	it("finds the right region among many, regardless of input order", () => {
		const envelope = createVolumeEnvelope(
			[region(5000, 6000, 0.5, "b"), region(1000, 2000, 1.5, "a"), region(8000, 9000, 0, "c")],
			undefined,
		);
		expect(envelope.gainAt(1500)).toBeCloseTo(1.5);
		expect(envelope.gainAt(3000)).toBe(1);
		expect(envelope.gainAt(5500)).toBeCloseTo(0.5);
		expect(envelope.gainAt(8500)).toBeCloseTo(0);
	});
});

describe("applyVolumeEnvelopeToPlanes", () => {
	it("scales samples by the gain at each frame's source time", () => {
		const sampleRate = 1000; // 1 frame per ms keeps the math readable
		const left = new Float32Array(200).fill(0.5);
		const right = new Float32Array(200).fill(-0.5);
		const envelope = createVolumeEnvelope([region(100, 1000, 0)], undefined);

		applyVolumeEnvelopeToPlanes([left, right], sampleRate, 0, envelope);

		expect(left[50]).toBeCloseTo(0.5);
		expect(left[199]).toBeCloseTo(0);
		expect(right[199]).toBeCloseTo(0);
	});

	it("limits boosted samples to full scale", () => {
		const plane = new Float32Array([0.8, -0.8]);
		const envelope = createVolumeEnvelope([], { masterVolume: 2 });
		applyVolumeEnvelopeToPlanes([plane], 48_000, 0, envelope);
		expect(plane[0]).toBe(1);
		expect(plane[1]).toBe(-1);
	});

	it("offsets by the chunk's start time", () => {
		const plane = new Float32Array(10).fill(1);
		const envelope = createVolumeEnvelope([region(5000, 6000, 0.5)], undefined);
		applyVolumeEnvelopeToPlanes([plane], 1000, 5500, envelope);
		expect(plane[0]).toBeCloseTo(0.5);
	});
});
