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
  Multilingual: { male: 'en-US-GuyNeural', female: 'en-US-AvaMultilingualNeural' },
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
      if (mapped.includes('Andrew')) {
        return 'en-US-GuyNeural';
      }
      if (mapped.includes('Ryan') || mapped.includes('Brian') || mapped.includes('Guy') || mapped.includes('Thierry') || mapped.includes('Dmitry') || mapped.includes('Tamas') || mapped.includes('Asad') || mapped.includes('Madhur')) {
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

    // Generous initial timeout scaled by character length
    const initialTimeoutMs = Math.max(25000, text.length * 60);
    let timer = setTimeout(() => {
      cleanupAndReject(new Error(`Edge TTS timeout for voice: ${shortName}`));
    }, initialTimeoutMs);

    const resetInactivityTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        cleanupAndReject(new Error(`Edge TTS stream inactive for voice: ${shortName}`));
      }, 15000);
    };

    const cleanupAndReject = (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try {
          tts.close();
        } catch {}
        reject(err);
      }
    };

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
          resetInactivityTimer();
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
          cleanupAndReject(err);
        });
      })
      .catch((err: Error) => {
        cleanupAndReject(err);
      });
  });
}

async function synthesizeGoogleFallback(text: string, lang: string): Promise<Buffer> {
  const langLower = (lang || 'English').toLowerCase();
  let code = 'en';
  if (langLower.includes('urdu') || langLower.includes('pakistan')) code = 'ur';
  else if (langLower.includes('hindi') || langLower.includes('india')) code = 'hi';
  else if (langLower.includes('arabic')) code = 'ar';
  else if (langLower.includes('french')) code = 'fr';
  else if (langLower.includes('spanish')) code = 'es';
  else if (langLower.includes('german')) code = 'de';
  else if (langLower.includes('russian')) code = 'ru';
  else if (langLower.includes('japanese')) code = 'ja';
  else if (langLower.includes('chinese')) code = 'zh';
  else if (langLower.includes('turkish')) code = 'tr';
  else if (langLower.includes('tamil')) code = 'ta';

  const clean = text.replace(/[*_`~><^#|\\]/g, '').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ');
  const parts: string[] = [];
  let curr = '';
  for (const w of words) {
    if ((curr + ' ' + w).length <= 180) {
      curr = curr ? `${curr} ${w}` : w;
    } else {
      if (curr) parts.push(curr);
      curr = w;
    }
  }
  if (curr) parts.push(curr);
  if (parts.length === 0) parts.push(clean || 'Hello');

  const buffers: Buffer[] = [];
  for (const part of parts) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(part)}&tl=${encodeURIComponent(code)}&client=tw-ob`;
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) throw new Error(`Google TTS HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    buffers.push(Buffer.from(ab));
  }
  return Buffer.concat(buffers);
}

async function synthesizeWithFallback(
  shortName: string,
  text: string,
  pitch: number,
  rate: number,
  selectedVoice: VoiceEntry
): Promise<{ buffer: Buffer; provider: string }> {
  const isMale = selectedVoice.gender.toLowerCase() === 'male';

  // 1. Primary Edge voice attempt
  try {
    const buf = await ttsQueue.run(() => singleEdgeAttempt(shortName, text, pitch, rate));
    return { buffer: buf, provider: `Edge (${shortName})` };
  } catch (err1: any) {
    console.warn(`[TTS] Attempt 1 failed for ${shortName}:`, err1?.message);
  }

  // 2. Retry with short backoff
  await new Promise((r) => setTimeout(r, 400));
  try {
    const buf = await ttsQueue.run(() => singleEdgeAttempt(shortName, text, pitch, rate));
    return { buffer: buf, provider: `Edge (${shortName} retry)` };
  } catch (err2: any) {
    console.warn(`[TTS] Attempt 2 failed for ${shortName}:`, err2?.message);
  }

  // 3. Fallback to alternative neural voice of matching gender
  const altVoice = isMale ? 'en-US-GuyNeural' : 'en-US-AvaMultilingualNeural';
  if (shortName !== altVoice) {
    try {
      const buf = await ttsQueue.run(() => singleEdgeAttempt(altVoice, text, pitch, rate));
      return { buffer: buf, provider: `Edge Neural Fallback (${altVoice})` };
    } catch (err3: any) {
      console.warn(`[TTS] Attempt 3 failed with alternate neural voice:`, err3?.message);
    }
  }

  // 4. Guaranteed fallback via Google TTS audio stream
  console.log(`[TTS] Falling back to Google TTS for language ${selectedVoice.language}`);
  const fallbackBuf = await synthesizeGoogleFallback(text, selectedVoice.language);
  return { buffer: fallbackBuf, provider: 'Google TTS Fallback' };
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

    const { buffer: audioBuffer, provider } = await synthesizeWithFallback(
      shortName,
      text,
      pitch,
      rate,
      selectedVoice
    );

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(audioBuffer.length));
    res.setHeader('X-Pitch', String(pitch));
    res.setHeader('X-Rate', String(rate));
    res.setHeader('X-Voice-Name', encodeURIComponent(selectedVoice.name));
    res.setHeader('X-Voice-Gender', selectedVoice.gender);
    res.setHeader('X-Edge-ShortName', shortName);
    res.setHeader('X-TTS-Provider', provider);
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
