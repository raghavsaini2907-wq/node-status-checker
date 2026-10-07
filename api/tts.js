import { EdgeTTS } from "@andresaya/edge-tts";

const VOICE_HI = "hi-IN-SwaraNeural";
const VOICE_EN = "en-IN-NeerjaNeural";

const RAW_PCM_FORMAT = "raw-24khz-16bit-mono-pcm";

// One request = one complete sentence.
// ESP32 sentence queue isi endpoint ko call karegi.
const MAX_TEXT_CHARS = 600;

function hasDevanagari(text) {
  return /[\u0900-\u097F]/u.test(text);
}

function pickVoice(text, requestedVoice) {
  // Explicit voice from ESP32 wins.
  if (requestedVoice === VOICE_HI || requestedVoice === VOICE_EN) {
    return requestedVoice;
  }

  // Otherwise automatically select from script.
  return hasDevanagari(text) ? VOICE_HI : VOICE_EN;
}

function getQueryParam(req, name) {
  const value = req.query?.[name];

  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return typeof value === "string" ? value : "";
}

async function readPostBody(req) {
  let body = req.body;

  // Vercel may already parse JSON.
  if (body && typeof body === "object") {
    return body;
  }

  // Some runtimes provide the body as a string.
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }

  // Fallback for raw request streams.
  let raw = "";

  try {
    for await (const chunk of req) {
      raw += chunk.toString();
    }
  } catch {
    return {};
  }

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  /*
   * ============================================================
   * METHOD
   * ============================================================
   */

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");

    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    /*
     * ============================================================
     * READ REQUEST
     * ============================================================
     */

    let text = "";
    let requestedVoice = "";

    if (req.method === "POST") {
      const body = await readPostBody(req);

      if (typeof body?.text === "string") {
        text = body.text;
      }

      if (typeof body?.voice === "string") {
        requestedVoice = body.voice;
      }
    } else {
      text = getQueryParam(req, "text");
      requestedVoice = getQueryParam(req, "voice");
    }

    text = text.trim();
    requestedVoice = requestedVoice.trim();

    /*
     * ============================================================
     * VALIDATION
     * ============================================================
     */

    if (!text) {
      return res.status(400).json({
        error: "Missing text"
      });
    }

    if (text.length > MAX_TEXT_CHARS) {
      return res.status(413).json({
        error: "Sentence too long",
        maxCharacters: MAX_TEXT_CHARS
      });
    }

    /*
     * ============================================================
     * VOICE SELECTION
     *
     * Hindi / Hinglish:
     *   LLM produces Devanagari
     *   -> Swara Neural
     *
     * English:
     *   -> Neerja Neural
     * ============================================================
     */

    const voice = pickVoice(text, requestedVoice);

    console.log(
      `[EVA-TTS] voice=${voice} chars=${text.length}`
    );

    /*
     * ============================================================
     * EDGE TTS
     *
     * IMPORTANT:
     * ESP32 expects:
     *
     *   PCM signed 16-bit
     *   24,000 Hz
     *   mono
     *   NO WAV HEADER
     *   NO MP3
     * ============================================================
     */

    const tts = new EdgeTTS();

    await tts.synthesize(
      text,
      voice,
      {
        outputFormat: RAW_PCM_FORMAT,

        // Natural/default speech settings.
        rate: 0,
        pitch: 0,
        volume: 0
      }
    );

    const pcm = tts.toBuffer();

    /*
     * ============================================================
     * PCM VALIDATION
     * ============================================================
     */

    if (!pcm || !Buffer.isBuffer(pcm)) {
      throw new Error("Edge TTS did not return a Buffer");
    }

    if (pcm.length < 4) {
      throw new Error("Edge TTS returned empty PCM");
    }

    // PCM16 must always contain complete 2-byte samples.
    if ((pcm.length & 1) !== 0) {
      throw new Error(
        `Invalid PCM16 length: ${pcm.length}`
      );
    }

    /*
     * ============================================================
     * RESPONSE HEADERS
     * ============================================================
     */

    res.statusCode = 200;

    res.setHeader(
      "Content-Type",
      "application/octet-stream"
    );

    res.setHeader(
      "Content-Length",
      String(pcm.length)
    );

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );

    res.setHeader(
      "X-EVA-Audio-Format",
      RAW_PCM_FORMAT
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

    /*
     * ============================================================
     * RETURN RAW PCM
     * ============================================================
     */

    return res.end(pcm);

  } catch (error) {

    console.error(
      "[EVA-TTS] synthesis failed:",
      error
    );

    return res.status(502).json({
      error: "TTS synthesis failed",
      message:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }
}
