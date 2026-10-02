import { EdgeTTS } from '@andresaya/edge-tts';

const PCM_FORMAT = 'raw-24khz-16bit-mono-pcm';
const DEFAULT_VOICE = 'en-IN-NeerjaNeural';
const MAX_TEXT_LENGTH = 4000;

function sendError(res, status, message) {
  if (!res.headersSent) {
    res.status(status);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
  }

  res.end(message);
}

export default async function handler(req, res) {

  // ----------------------------------------------------------
  // METHOD
  // ----------------------------------------------------------

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');

    return sendError(
      res,
      405,
      'Method Not Allowed'
    );
  }


  try {

    // --------------------------------------------------------
    // TEXT
    // --------------------------------------------------------

    const rawText =
      typeof req.query?.text === 'string'
        ? req.query.text
        : '';

    const text = rawText.trim();


    // --------------------------------------------------------
    // VOICE
    // --------------------------------------------------------

    const voice =
      typeof req.query?.voice === 'string' &&
      req.query.voice.trim().length > 0
        ? req.query.voice.trim()
        : DEFAULT_VOICE;


    // --------------------------------------------------------
    // VALIDATION
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


    console.log(
      `[EVA-TTS] START | voice=${voice} | chars=${text.length}`
    );


    // --------------------------------------------------------
    // EDGE TTS
    // --------------------------------------------------------

    const tts = new EdgeTTS();


    // --------------------------------------------------------
    // SYNTHESIZE
    //
    // IMPORTANT:
    // RAW PCM is generated using synthesize().
    // We are NOT using synthesizeStream() here.
    // --------------------------------------------------------

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


    console.log(
      '[EVA-TTS] SYNTHESIS COMPLETE'
    );


    // --------------------------------------------------------
    // GET PCM BUFFER
    // --------------------------------------------------------

    const audioBuffer = tts.toBuffer();


    // --------------------------------------------------------
    // EMPTY CHECK
    // --------------------------------------------------------

    if (
      !audioBuffer ||
      audioBuffer.length === 0
    ) {
      throw new Error(
        'Edge TTS returned zero audio bytes'
      );
    }


    // --------------------------------------------------------
    // AUDIO INFORMATION
    // --------------------------------------------------------

    const byteLength =
      audioBuffer.length;

    const estimatedSeconds =
      byteLength / 48000;


    console.log(
      `[EVA-TTS] PCM READY | bytes=${byteLength} | seconds=${estimatedSeconds.toFixed(3)}`
    );


    // --------------------------------------------------------
    // RESPONSE HEADERS
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // SEND PURE PCM
    // --------------------------------------------------------

    res.end(audioBuffer);


    console.log(
      `[EVA-TTS] COMPLETE | sent=${byteLength} bytes`
    );

  }


  catch (error) {

    console.error(
      '[EVA-TTS] ERROR'
    );

    console.error(
      error
    );


    const message =
      error instanceof Error
        ? error.message
        : String(error);


    console.error(
      `[EVA-TTS] ERROR MESSAGE | ${message}`
    );


    // --------------------------------------------------------
    // IMPORTANT
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
      `Edge TTS synthesis failed: ${message}`
    );
  }
}
