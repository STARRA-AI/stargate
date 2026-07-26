import { REALTIME_SAMPLE_RATE } from "./pcm-audio";

/**
 * Wrap raw mono PCM16 samples in a WAV container and return it base64-encoded.
 *
 * xAI Realtime streams her spoken audio as 24 kHz mono PCM16 deltas. Accumulate
 * those samples across a response, wrap them here, and you have the EXACT audio
 * she is saying — ready to POST to the Colab lip-sync renderer so the generated
 * face is frame-locked to her real voice (one shared source = her whole face
 * matches her words). Pure function; no browser/Node API beyond btoa/DataView.
 */
export function pcm16ToWavBase64(
  samples: Int16Array,
  sampleRate: number = REALTIME_SAMPLE_RATE,
): string {
  const blockAlign = 2; // mono * 16-bit
  const dataSize = samples.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(off, samples[i] ?? 0, true);
    off += 2;
  }

  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
