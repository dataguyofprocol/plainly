/*
 * Converts mic Float32 samples to 16-bit little-endian PCM and posts:
 *
 *   { type: "level", rms }    — every render quantum, RMS level 0..1.
 *   { type: "audio", buffer } — Int16Array frames of 2048 samples, transferred.
 *
 * Deepgram recommends ~100–200ms chunks. Silence is streamed too, so the
 * socket never hits Deepgram's 10s NET-0001 idle timeout.
 * Plain JS in public/: worklets load outside the module graph.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.frame = new Int16Array(2048);
		this.count = 0;
	}

	process(inputs) {
		const channel = inputs[0] && inputs[0][0];
		if (!channel) return true; // no input yet — stay alive

		let sumSquares = 0;
		for (let i = 0; i < channel.length; i++) sumSquares += channel[i] * channel[i];
		this.port.postMessage({ type: "level", rms: Math.sqrt(sumSquares / channel.length) });

		// A hot mic can exceed ±1.0.
		for (let i = 0; i < channel.length; i++) {
			const s = Math.max(-1, Math.min(1, channel[i]));
			this.frame[this.count++] = s < 0 ? s * 0x8000 : s * 0x7fff;
			if (this.count === this.frame.length) {
				this.port.postMessage({ type: "audio", buffer: this.frame }, [this.frame.buffer]);
				this.frame = new Int16Array(2048);
				this.count = 0;
			}
		}
		return true;
	}
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
