import { MsEdgeTTS, OUTPUT_FORMAT, ProsodyOptions } from 'msedge-tts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const data = req.method === 'GET' ? req.query : req.body || {};

    const text = String(data.text || '').trim();
    const pitch = Math.max(-100, Math.min(100, Number(data.pitch) || 0));
    const rate = Math.max(-100, Math.min(100, Number(data.rate) || 0));

    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    if (text.length > 2000) {
      return res.status(400).json({ error: 'Maximum 2000 characters allowed' });
    }

    const voice = 'en-GB-RyanNeural';

    const tts = new MsEdgeTTS();

    try {
      await tts.setMetadata(
        voice,
        OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
      );

      const prosody = new ProsodyOptions();
      prosody.pitch = `${pitch >= 0 ? '+' : ''}${pitch}Hz`;
      prosody.rate = `${rate >= 0 ? '+' : ''}${rate}%`;

      const { audioStream } = tts.toStream(text, prosody);

      const chunks: Buffer[] = [];

      const audio = await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          audioStream.destroy();
          reject(new Error('TTS request timed out'));
        }, 20000);

        audioStream.on('data', (chunk: Buffer) => {
          chunks.push(Buffer.from(chunk));
        });

        audioStream.on('end', () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks));
        });

        audioStream.on('error', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      if (audio.length === 0) {
        throw new Error('No audio generated');
      }

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', audio.length);

      return res.status(200).send(audio);

    } finally {
      tts.close();
    }

  } catch (error: any) {
    console.error('TTS Error:', error);

    return res.status(500).json({
      error: 'Voice generation failed',
      details: error.message
    });
  }
}
