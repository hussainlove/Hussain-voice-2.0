import express from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import path from 'path';
import { MsEdgeTTS, OUTPUT_FORMAT, ProsodyOptions } from 'msedge-tts';

const PORT = 3000;

interface VoiceEntry {
  index: number;
  id: string;
  name: string;
  gender: string;
  language: string;
  country: string;
}

interface VoicesData {
  success: boolean;
  total: number;
  voices: VoiceEntry[];
  grouped: Record<string, VoiceEntry[]>;
}

const voicesFilePath = path.resolve(process.cwd(), 'src/data/voices.json');
const edgeMapFilePath = path.resolve(process.cwd(), 'src/data/edgeMap.json');

let voicesData: VoicesData = {
  success: true,
  total: 0,
  voices: [],
  grouped: {},
};

let edgeMap: Record<number, string> = {};

try {
  voicesData = JSON.parse(fs.readFileSync(voicesFilePath, 'utf-8'));
} catch (err) {
  console.error('Failed to read src/data/voices.json:', err);
}

try {
  if (fs.existsSync(edgeMapFilePath)) {
    edgeMap = JSON.parse(fs.readFileSync(edgeMapFilePath, 'utf-8'));
  }
} catch (err) {
  console.error('Failed to read src/data/edgeMap.json:', err);
}

// Language fallbacks with strictly enforced GENDER separation
const LANGUAGE_FALLBACKS: Record<string, { male: string; female: string }> = {
  Multilingual: { male: 'en-US-AndrewMultilingualNeural', female: 'en-US-AvaMultilingualNeural' },
  English: { male: 'en-GB-RyanNeural', female: 'en-US-AriaNeural' },
  Urdu: { male: 'ur-PK-AsadNeural', female: 'ur-PK-UzmaNeural' },
  Hindi: { male: 'hi-IN-MadhurNeural', female: 'hi-IN-SwaraNeural' },
  Arabic: { male: 'ar-SA-HamedNeural', female: 'ar-YE-MaryamNeural' },
  French: { male: 'fr-CA-ThierryNeural', female: 'fr-FR-DeniseNeural' },
  Spanish: { male: 'es-ES-AlvaroNeural', female: 'es-ES-ElviraNeural' },
  German: { male: 'de-DE-ConradNeural', female: 'de-DE-KatjaNeural' },
  Russian: { male: 'ru-RU-DmitryNeural', female: 'ru-RU-SvetlanaNeural' },
  Hungarian: { male: 'hu-HU-TamasNeural', female: 'hu-HU-NoemiNeural' },
  Tamil: { male: 'ta-MY-SuryaNeural', female: 'ta-IN-PallaviNeural' },
  Turkish: { male: 'tr-TR-AhmetNeural', female: 'tr-TR-EmelNeural' },
  Chinese: { male: 'zh-CN-YunxiNeural', female: 'zh-CN-XiaoxiaoNeural' },
  Japanese: { male: 'ja-JP-KeitaNeural', female: 'ja-JP-NanamiNeural' },
  Korean: { male: 'ko-KR-InJoonNeural', female: 'ko-KR-SunHiNeural' },
  Portuguese: { male: 'pt-BR-AntonioNeural', female: 'pt-BR-FranciscaNeural' },
  Italian: { male: 'it-IT-DiegoNeural', female: 'it-IT-ElsaNeural' },
  Bengali: { male: 'bn-BD-PradeepNeural', female: 'bn-BD-NabanitaNeural' },
};

function resolveShortName(voice: VoiceEntry): string {
  // Special explicit checks for prominent voices like Ryan
  if (voice.index === 27 || voice.name.toLowerCase().includes('ryan')) {
    return 'en-GB-RyanNeural';
  }

  // 1. Direct precomputed edgeMap lookup
  if (edgeMap[voice.index]) {
    const mapped = edgeMap[voice.index];
    // Safety check: ensure mapped voice matches the voice gender
    const isVoiceMale = voice.gender.toLowerCase() === 'male';
    const isVoiceFemale = voice.gender.toLowerCase() === 'female';
    
    // If it's a known male voice mapping or matches, use it
    if (isVoiceMale) {
      if (mapped.includes('Ryan') || mapped.includes('Andrew') || mapped.includes('Brian') || mapped.includes('Guy') || mapped.includes('Thierry') || mapped.includes('Dmitry') || mapped.includes('Tamas') || mapped.includes('Asad') || mapped.includes('Madhur')) {
        return mapped;
      }
    } else if (isVoiceFemale) {
      if (mapped.includes('Ava') || mapped.includes('Emma') || mapped.includes('Aria') || mapped.includes('Jenny') || mapped.includes('Maryam') || mapped.includes('Noemi') || mapped.includes('Uzma') || mapped.includes('Swara')) {
        return mapped;
      }
    }
    return mapped;
  }

  // 2. Language-based fallback with strict gender
  const isMale = voice.gender.toLowerCase() === 'male';
  const langMatch = LANGUAGE_FALLBACKS[voice.language] || LANGUAGE_FALLBACKS.English;
  return isMale ? langMatch.male : langMatch.female;
}

// Concurrency queue to prevent Microsoft Edge WebSocket connection drops
class ConcurrencyQueue {
  private active = 0;
  private maxConcurrent = 3;
  private queue: Array<() => void> = [];

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next) next();
      }
    }
  }
}

const ttsQueue = new ConcurrencyQueue();

async function singleEdgeAttempt(
  shortName: string,
  text: string,
  pitch: number,
  rate: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tts = new MsEdgeTTS();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          tts.close();
        } catch {}
        reject(new Error(`Edge TTS timeout for voice: ${shortName}`));
      }
    }, 12000);

    tts
      .setMetadata(shortName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
      .then(() => {
        const prosody = new ProsodyOptions();
        prosody.pitch = `${pitch >= 0 ? '+' : ''}${pitch}Hz`;
        prosody.rate = `${rate >= 0 ? '+' : ''}${rate}%`;

        const { audioStream } = tts.toStream(text, prosody);
        const chunks: Buffer[] = [];

        audioStream.on('data', (chunk: Buffer) => {
          chunks.push(Buffer.from(chunk));
        });

        audioStream.on('end', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try {
              tts.close();
            } catch {}
            const buf = Buffer.concat(chunks);
            if (buf.length < 100) {
              reject(new Error('Edge TTS returned empty stream'));
            } else {
              resolve(buf);
            }
          }
        });

        audioStream.on('error', (err: Error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try {
              tts.close();
            } catch {}
            reject(err);
          }
        });
      })
      .catch((err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try {
            tts.close();
          } catch {}
          reject(err);
        }
      });
  });
}

async function synthesizeEdgeWithRetry(
  shortName: string,
  text: string,
  pitch: number,
  rate: number,
  isMale: boolean
): Promise<Buffer> {
  // First attempt
  try {
    return await ttsQueue.run(() => singleEdgeAttempt(shortName, text, pitch, rate));
  } catch (err1) {
    console.warn(`[TTS] Attempt 1 failed for ${shortName}:`, (err1 as any)?.message);
  }

  // Second attempt with small delay
  await new Promise((r) => setTimeout(r, 400));
  try {
    return await ttsQueue.run(() => singleEdgeAttempt(shortName, text, pitch, rate));
  } catch (err2) {
    console.warn(`[TTS] Attempt 2 failed for ${shortName}:`, (err2 as any)?.message);
  }

  // Third attempt: Fallback to rock-solid standard male or female Edge voice
  const safeVoice = isMale ? 'en-GB-RyanNeural' : 'en-US-AriaNeural';
  return await ttsQueue.run(() => singleEdgeAttempt(safeVoice, text, pitch, rate));
}

async function handleTtsRequest(req: express.Request, res: express.Response) {
  try {
    const rawVoiceIndex =
      req.method === 'GET' ? req.query.voiceIndex ?? req.query.voice : req.body?.voiceIndex ?? req.body?.voice;
    const rawText = req.method === 'GET' ? req.query.text : req.body?.text;
    const rawPitch = req.method === 'GET' ? req.query.pitch : req.body?.pitch;
    const rawRate = req.method === 'GET' ? req.query.rate : req.body?.rate;

    const text = String(rawText || '').trim();
    if (!text) {
      res.status(400).json({ error: 'Missing required parameter: text' });
      return;
    }
    if (text.length > 2000) {
      res.status(400).json({ error: 'Text exceeds maximum chunk length of 2000 characters.' });
      return;
    }

    const pitch = Math.max(-100, Math.min(100, Number(rawPitch) || 0));
    const rate = Math.max(-100, Math.min(100, Number(rawRate) || 0));

    let selectedVoice: VoiceEntry | undefined;
    if (typeof rawVoiceIndex === 'number' || /^\d+$/.test(String(rawVoiceIndex || ''))) {
      const idx = Number(rawVoiceIndex);
      selectedVoice = voicesData.voices.find((v) => v.index === idx);
    } else if (typeof rawVoiceIndex === 'string' && rawVoiceIndex.trim()) {
      const q = rawVoiceIndex.trim().toLowerCase();
      selectedVoice =
        voicesData.voices.find((v) => v.id.toLowerCase() === q || v.name.toLowerCase().includes(q)) ||
        voicesData.voices[0];
    } else {
      selectedVoice = voicesData.voices.find((v) => v.index === 27) || voicesData.voices[0];
    }

    if (!selectedVoice) {
      selectedVoice = {
        index: 27,
        id: 'voice-84',
        name: 'Ryan',
        gender: 'Male',
        language: 'English',
        country: 'United Kingdom',
      };
    }

    const shortName = resolveShortName(selectedVoice);
    const isMale = selectedVoice.gender.toLowerCase() === 'male';

    console.log(
      `[TTS Request] Voice: #${selectedVoice.index} ${selectedVoice.name} (${selectedVoice.gender}) -> Edge: ${shortName} | Pitch: ${pitch} | Rate: ${rate}`
    );

    const audioBuffer = await synthesizeEdgeWithRetry(shortName, text, pitch, rate, isMale);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(audioBuffer.length));
    res.setHeader('X-Pitch', String(pitch));
    res.setHeader('X-Rate', String(rate));
    res.setHeader('X-Voice-Name', encodeURIComponent(selectedVoice.name));
    res.setHeader('X-Voice-Gender', selectedVoice.gender);
    res.setHeader('X-Edge-ShortName', shortName);
    res.setHeader('X-Char-Count', String(text.length));
    res.send(audioBuffer);
  } catch (err: any) {
    console.error('[TTS Error]:', err?.message);
    res.status(502).json({
      error: 'Failed to generate speech.',
      detail: err?.message || 'Upstream TTS provider error',
    });
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // GET /api/voices
  app.get('/api/voices', (_req, res) => {
    res.json(voicesData);
  });

  // POST & GET /api/tts
  app.post('/api/tts', handleTtsRequest);
  app.get('/api/tts', handleTtsRequest);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Hussain Voice server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
