import { EdgeTTS } from '@andresaya/edge-tts';


// ============================================================
// EVA EDGE TTS PROXY
//
// TEST STAGE
//
// Output:
//   RAW PCM
//   24,000 Hz
//   16-bit
//   MONO
//
// IMPORTANT:
//   This version intentionally uses:
//
//       synthesize()
//       ↓
//       toBuffer()
//
//   We are NOT using synthesizeStream() for PCM.
//
//   First objective:
//   Generate a REAL non-zero PCM byte buffer from Edge TTS.
//
// ============================================================


const PCM_FORMAT = 'raw-24khz-16bit-mono-pcm';

const DEFAULT_VOICE = 'en-IN-NeerjaNeural';

const MAX_TEXT_LENGTH = 4000;


// ============================================================
// ERROR RESPONSE
// ============================================================

function sendError(res, status, message) {

  if (!res.headersSent) {

    res.status(status);

    res.setHeader(
      'Content-Type',
      'text/plain; charset=utf-8'
    );

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

  }

  res.end(message);
}


// ============================================================
// MAIN HANDLER
// ============================================================

export default async function handler(req, res) {

  // ----------------------------------------------------------
  // GET ONLY
  // ----------------------------------------------------------

  if (req.method !== 'GET') {

    res.setHeader(
      'Allow',
      'GET'
    );

    return sendError(
      res,
      405,
      'Method Not Allowed'
    );

  }


  try {

    // ========================================================
    // READ TEXT
    // ========================================================

    const rawText =
      typeof req.query?.text === 'string'
        ? req.query.text
        : '';


    const text =
      rawText.trim();


    // ========================================================
    // READ VOICE
    // ========================================================

    const voice =
      typeof req.query?.voice === 'string' &&
      req.query.voice.trim().length > 0

        ? req.query.voice.trim()

        : DEFAULT_VOICE;


    // ========================================================
    // VALIDATE TEXT
    // ========================================================

    if (!text) {

      return sendError(
        res,
        400,
        'Missing text parameter'
      );

    }


    if (text.length > MAX_TEXT_LENGTH) {

      return sendError(
        res,
        400,
        `Text is too long. Maximum is ${MAX_TEXT_LENGTH} characters.`
      );

    }


    console.log(
      `[EVA-TTS] START | voice=${voice} | chars=${text.length}`
    );


    // ========================================================
    // CREATE TTS
    // ========================================================

    const tts =
      new EdgeTTS();


    // ========================================================
    // SYNTHESIZE COMPLETE PCM
    //
    // IMPORTANT:
    //
    // RAW PCM is intentionally generated using synthesize().
    //
    // We are NOT using synthesizeStream() here.
    // ========================================================

    await tts.synthesize(
      text,
      voice,
      {
        outputFormat: PCM_FORMAT,

        rate: 0,

        pitch: 0,

        volume: 0
      }
    );


    // ========================================================
    // GET RAW AUDIO BUFFER
    // ========================================================

    const audioBuffer =
      tts.toBuffer();


    // ========================================================
    // SAFETY CHECK
    // ========================================================

    if (
      !audioBuffer ||
      audioBuffer.length === 0
    ) {

      console.error(
        '[EVA-TTS] ERROR | Generated PCM buffer is EMPTY'
      );

      return sendError(
        res,
        502,
        'Edge TTS returned zero audio bytes'
      );

    }


    // ========================================================
    // PCM DIAGNOSTICS
    // ========================================================

    const byteLength =
      audioBuffer.length;


    const estimatedSeconds =
      byteLength / (24000 * 2);


    console.log(
      `[EVA-TTS] PCM READY | bytes=${byteLength} | seconds=${estimatedSeconds.toFixed(2)}`
    );


    // ========================================================
    // HTTP RESPONSE
    // ========================================================

    res.statusCode = 200;


    res.setHeader(
      'Content-Type',
      'application/octet-stream'
    );


    res.setHeader(
      'Content-Length',
      String(byteLength)
    );


    res.setHeader(
      'X-EVA-Audio-Format',
      PCM_FORMAT
    );


    res.setHeader(
      'X-EVA-Sample-Rate',
      '24000'
    );


    res.setHeader(
      'X-EVA-Channels',
      '1'
    );


    res.setHeader(
      'X-EVA-Bits',
      '16'
    );


    res.setHeader(
      'X-EVA-Audio-Bytes',
      String(byteLength)
    );


    res.setHeader(
      'X-EVA-Audio-Seconds',
      estimatedSeconds.toFixed(3)
    );


    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate'
    );


    res.setHeader(
      'Pragma',
      'no-cache'
    );


    res.setHeader(
      'Access-Control-Allow-Origin',
      '*'
    );


    // ========================================================
    // SEND PCM BYTES
    //
    // No:
    //   MP3
    //   WAV header
    //   JSON
    //   Base64
    //
    // ONLY PCM BYTES
    // ========================================================

    res.end(
      audioBuffer
    );


    console.log(
      `[EVA-TTS] COMPLETE | sent=${byteLength} bytes`
    );

  }


  catch (error) {

    console.error(
      '[EVA-TTS] ERROR:',
      error
    );


    if (
      error &&
      typeof error === 'object' &&
      'stack' in error
    ) {

      console.error(
        error.stack
      );

    }


    if (
      res.headersSent
    ) {

      if (!res.writableEnded) {
        res.end();
      }

      return;

    }


    return sendError(
      res,
      502,
      'Edge TTS synthesis failed'
    );

  }

}
