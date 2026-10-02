import { EdgeTTS } from '@andresaya/edge-tts';

const PCM_FORMAT = 'raw-24khz-16bit-mono-pcm';

const DEFAULT_VOICE = 'en-IN-NeerjaNeural';

const MAX_TEXT_LENGTH = 4000;


// ============================================================
// EVA EDGE TTS PROXY
//
// OUTPUT FORMAT:
//
//   RAW PCM
//   24,000 Hz
//   16-bit
//   MONO
//
// IMPORTANT:
//   No MP3
//   No WAV header
//   No Base64
//   No JSON around audio
//
// EVA receives the HTTP body directly as PCM bytes.
// ============================================================


function sendError(res, status, message) {

  res.status(status);

  res.setHeader(
    'Content-Type',
    'text/plain; charset=utf-8'
  );

  res.setHeader(
    'Cache-Control',
    'no-store'
  );

  res.end(message);
}


// ============================================================
// MAIN VERCEL HANDLER
// ============================================================

export default async function handler(req, res) {

  // ----------------------------------------------------------
  // Only GET is used by EVA firmware.
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

    // --------------------------------------------------------
    // READ QUERY PARAMETERS
    //
    // EVA sends:
    //
    // /tts?text=...&voice=...
    // --------------------------------------------------------

    const rawText =
      typeof req.query?.text === 'string'
        ? req.query.text
        : '';

    const text =
      rawText.trim();


    const voice =
      typeof req.query?.voice === 'string' &&
      req.query.voice.trim().length > 0

        ? req.query.voice.trim()

        : DEFAULT_VOICE;


    // --------------------------------------------------------
    // VALIDATE TEXT
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // CREATE EDGE TTS INSTANCE
    // --------------------------------------------------------

    const tts =
      new EdgeTTS();


    // ========================================================
    // HTTP AUDIO RESPONSE
    //
    // IMPORTANT:
    //
    // application/octet-stream is intentional.
    //
    // EVA does NOT want:
    //
    // audio/mpeg
    // audio/mp3
    // audio/wav
    //
    // It wants pure PCM bytes.
    // ========================================================

    res.statusCode = 200;


    res.setHeader(
      'Content-Type',
      'application/octet-stream'
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


    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }


    console.log(
      `[EVA-TTS] START | voice=${voice} | chars=${text.length}`
    );


    // ========================================================
    // REAL-TIME EDGE TTS STREAM
    //
    // DO NOT collect the complete response in RAM.
    //
    // Every chunk is forwarded to EVA immediately.
    // ========================================================

    for await (
      const chunk of tts.synthesizeStream(
        text,
        voice,
        {
          outputFormat: PCM_FORMAT,

          rate: 0,

          pitch: 0,

          volume: 0
        }
      )
    ) {

      // ------------------------------------------------------
      // Ignore empty chunks.
      // ------------------------------------------------------

      if (
        !chunk ||
        chunk.length === 0
      ) {
        continue;
      }


      // ------------------------------------------------------
      // Stop if ESP32/client disconnected.
      // ------------------------------------------------------

      if (
        res.writableEnded ||
        res.destroyed
      ) {
        break;
      }


      // ------------------------------------------------------
      // SEND PCM CHUNK TO EVA
      // ------------------------------------------------------

      const ok =
        res.write(
          Buffer.from(chunk)
        );


      // ------------------------------------------------------
      // BACK-PRESSURE
      //
      // If the client is slower than the TTS producer,
      // wait instead of building an unlimited RAM buffer.
      // ------------------------------------------------------

      if (!ok) {

        await new Promise(
          (resolve) => {

            res.once(
              'drain',
              resolve
            );

          }
        );
      }

    }


    // --------------------------------------------------------
    // FINISH HTTP STREAM
    // --------------------------------------------------------

    if (!res.writableEnded) {
      res.end();
    }


    console.log(
      '[EVA-TTS] COMPLETE'
    );

  }

  catch (error) {

    console.error(
      '[EVA-TTS] ERROR',
      error
    );


    // --------------------------------------------------------
    // IMPORTANT:
    //
    // Once PCM bytes have already been sent, NEVER send a
    // text/JSON error into the same stream.
    //
    // That would become garbage PCM for EVA.
    // --------------------------------------------------------

    if (res.headersSent) {

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
