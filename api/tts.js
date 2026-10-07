import { EdgeTTS, Constants } from "@andresaya/edge-tts";

const ALLOWED_VOICES = new Set([
"hi-IN-SwaraNeural",
"en-IN-NeerjaNeural",
]);

const OUTPUT_FORMAT =
Constants.OUTPUT_FORMAT.RIFF_24KHZ_16BIT_MONO_PCM;

const MAX_TEXT_LENGTH = 320;
const MAX_PCM_BYTES = 512 * 1024;

// --------------------------------------------------
// EVA LANGUAGE DETECTION
// --------------------------------------------------

function hasDevanagari(text) {
return /[\u0900-\u097F]/u.test(text);
}

// --------------------------------------------------
// VOICE SELECTION
// Hindi / Hinglish -> Swara
// English -> Neerja
// --------------------------------------------------

function selectVoice(text, requestedVoice) {
// Firmware can explicitly request a valid voice.
if (requestedVoice && ALLOWED_VOICES.has(requestedVoice)) {
return requestedVoice;
}

// If text contains Devanagari, always use Indian Hindi Swara.
if (hasDevanagari(text)) {
return "hi-IN-SwaraNeural";
}

// Otherwise use Indian English Neerja.
return "en-IN-NeerjaNeural";
}

// --------------------------------------------------
// WAV -> RAW PCM16LE
// --------------------------------------------------

function extractWavPcm(buffer) {
if (buffer.length < 12) {
throw new Error("Invalid WAV: too short");
}

if (
buffer.toString("ascii", 0, 4) !== "RIFF" ||
buffer.toString("ascii", 8, 12) !== "WAVE"
) {
throw new Error("Invalid WAV: RIFF/WAVE signature missing");
}

let offset = 12;
let formatFound = false;
let dataStart = -1;
let dataLength = 0;

while (offset + 8 <= buffer.length) {
const chunkId = buffer.toString(
"ascii",
offset,
offset + 4
);

```
const chunkSize = buffer.readUInt32LE(offset + 4);
const payloadStart = offset + 8;

if (payloadStart > buffer.length) {
  break;
}

// -------------------------------
// fmt chunk
// -------------------------------

if (chunkId === "fmt ") {
  if (
    chunkSize < 16 ||
    payloadStart + 16 > buffer.length
  ) {
    throw new Error("Invalid WAV fmt chunk");
  }

  const audioFormat =
    buffer.readUInt16LE(payloadStart);

  const channels =
    buffer.readUInt16LE(payloadStart + 2);

  const sampleRate =
    buffer.readUInt32LE(payloadStart + 4);

  const bits =
    buffer.readUInt16LE(payloadStart + 14);

  if (audioFormat !== 1) {
    throw new Error("TTS WAV is not PCM");
  }

  if (channels !== 1) {
    throw new Error(
      `Unexpected channels: ${channels}`
    );
  }

  if (sampleRate !== 24000) {
    throw new Error(
      `Unexpected sample rate: ${sampleRate}`
    );
  }

  if (bits !== 16) {
    throw new Error(
      `Unexpected bit depth: ${bits}`
    );
  }

  formatFound = true;
}

// -------------------------------
// PCM data chunk
// -------------------------------

else if (chunkId === "data") {
  dataStart = payloadStart;

  dataLength = Math.min(
    chunkSize,
    buffer.length - payloadStart
  );

  break;
}

// RIFF chunks are word aligned.
offset =
  payloadStart +
  chunkSize +
  (chunkSize & 1);
```

}

if (!formatFound) {
throw new Error("WAV fmt chunk not found");
}

if (dataStart < 0 || dataLength < 4) {
throw new Error("WAV PCM data not found");
}

// Keep complete 16-bit samples only.
dataLength &= ~1;

if (dataLength > MAX_PCM_BYTES) {
throw new Error(
`PCM payload too large: ${dataLength} bytes`
);
}

return buffer.subarray(
dataStart,
dataStart + dataLength
);
}

// --------------------------------------------------
// VERCEL HANDLER
// --------------------------------------------------

export default async function handler(req, res) {

// CORS preflight
if (req.method === "OPTIONS") {
res.status(204).end();
return;
}

// Only GET is required by EVA firmware.
if (req.method !== "GET") {
res.status(405).json({
ok: false,
error: "Use GET /api/tts",
});

```
return;
```

}

try {

```
// ----------------------------------------------
// READ QUERY PARAMETERS
// ----------------------------------------------

const url = new URL(
  req.url,
  `https://${req.headers.host || "localhost"}`
);

const text =
  (url.searchParams.get("text") || "").trim();

const requestedVoice =
  (url.searchParams.get("voice") || "").trim();

// ----------------------------------------------
// VALIDATION
// ----------------------------------------------

if (!text) {
  res.status(400).json({
    ok: false,
    error: "Missing text",
  });

  return;
}

if (text.length > MAX_TEXT_LENGTH) {
  res.status(400).json({
    ok: false,
    error:
      `Text too long. Maximum is ${MAX_TEXT_LENGTH} characters per sentence.`,
  });

  return;
}

// ----------------------------------------------
// SELECT VOICE
// ----------------------------------------------

const voice = selectVoice(
  text,
  requestedVoice
);

console.log(
  `[EVA-TTS] START | voice=${voice} | chars=${text.length}`
);

// ----------------------------------------------
// CREATE EDGE TTS
// ----------------------------------------------

const tts = new EdgeTTS();

await tts.synthesize(
  text,
  voice,
  {
    outputFormat: OUTPUT_FORMAT,

    // Natural speaking rate.
    rate: "0%",

    // Natural pitch.
    pitch: "0Hz",

    // Normal volume.
    volume: "0%",
  }
);

// ----------------------------------------------
// GET WAV BUFFER
// ----------------------------------------------

const wav = tts.toBuffer();

if (!wav || wav.length === 0) {
  throw new Error(
    "Edge TTS returned empty audio"
  );
}

// ----------------------------------------------
// REMOVE WAV HEADER
// RETURN RAW PCM
// ----------------------------------------------

const pcm = extractWavPcm(wav);

console.log(
  `[EVA-TTS] READY | voice=${voice} | pcmBytes=${pcm.length}`
);

// ----------------------------------------------
// RESPONSE HEADERS
// ----------------------------------------------

res.status(200);

res.setHeader(
  "Content-Type",
  "application/octet-stream"
);

res.setHeader(
  "Content-Length",
  String(pcm.length)
);

// EVA audio format information.
res.setHeader(
  "X-EVA-Audio-Format",
  "raw-pcm16le"
);

res.setHeader(
  "X-EVA-Sample-Rate",
  "24000"
);

res.setHeader(
  "X-EVA-Channels",
  "1"
);

res.setHeader(
  "X-EVA-Bits",
  "16"
);

res.setHeader(
  "X-EVA-Voice",
  voice
);

// Do not cache dynamic TTS.
res.setHeader(
  "Cache-Control",
  "no-store, no-cache, must-revalidate"
);

// ----------------------------------------------
// SEND AUDIO
// ----------------------------------------------

res.end(pcm);
```

} catch (error) {

```
console.error(
  "[EVA-TTS] ERROR:",
  error
);

if (!res.headersSent) {

  res.status(500).json({
    ok: false,
    error:
      error instanceof Error
        ? error.message
        : "TTS synthesis failed",
  });

} else {

  res.end();

}
```

}
}
