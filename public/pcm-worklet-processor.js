/**
 * AudioWorkletProcessor for the STARRA voice-call mic path.
 *
 * Runs on the audio render thread (NOT the main thread) so mic capture stays
 * smooth even under load on an 8GB laptop — a ScriptProcessorNode would run
 * on the main thread and jank under React renders / GC pauses.
 *
 * `process()` is invoked by the browser once per ~128-sample render quantum
 * (roughly every 3ms), which is far too chatty to postMessage/WS-send at
 * that granularity. This processor accumulates samples into a small
 * internal buffer and only posts to the main thread once it fills, cutting
 * postMessage + downstream WebSocket-send frequency by roughly ~16x while
 * still flushing every ~40-50ms — well under any threshold a human would
 * perceive as added barge-in latency.
 *
 * Everything else (resample to 24kHz, Float32->PCM16, base64, RMS gate for
 * barge-in, WebSocket send) happens on the main thread in useVoiceCall.ts
 * via pcm-audio.ts helpers — kept out of this file since a worklet module
 * can't import from the app bundle.
 *
 * Registered as "pcm-worklet-processor" — see useVoiceCall.ts's
 * `audioWorklet.addModule("/pcm-worklet-processor.js")` +
 * `new AudioWorkletNode(ctx, "pcm-worklet-processor", { numberOfOutputs: 0 })`.
 */
class PCMWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufferSize = 2048;
    this._buffer = new Float32Array(this._bufferSize);
    this._writeIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];

    if (channel && channel.length > 0) {
      let read = 0;
      while (read < channel.length) {
        const spaceLeft = this._bufferSize - this._writeIndex;
        const toCopy = Math.min(spaceLeft, channel.length - read);
        this._buffer.set(channel.subarray(read, read + toCopy), this._writeIndex);
        this._writeIndex += toCopy;
        read += toCopy;

        if (this._writeIndex >= this._bufferSize) {
          // Copy out before posting — the internal buffer is reused on the
          // next quantum, and postMessage's transfer list would otherwise
          // detach memory we still need.
          const frame = new Float32Array(this._buffer);
          this.port.postMessage(frame, [frame.buffer]);
          this._writeIndex = 0;
        }
      }
    }

    // Returning true keeps this processor alive for the lifetime of the
    // graph instead of being garbage-collected after one render quantum.
    return true;
  }
}

registerProcessor("pcm-worklet-processor", PCMWorkletProcessor);
