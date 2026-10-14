import React, { useState, useEffect, useMemo, useRef } from 'react';
import voicesJson from './data/voices.json';

interface Voice {
  index: number;
  id: string;
  name: string;
  gender: string;
  language: string;
  country: string;
}

interface ToastItem {
  id: number;
  msg: string;
  type: 'ok' | 'err' | '';
}

const MAX_CHUNK = 420;

const SAMPLE_TEXTS = [
  {
    label: '🇬🇧 English (Ryan)',
    voiceIndex: 27,
    text: 'Hello, this is Ryan speaking. Welcome to Hussain Voice! Convert any text into crisp, natural human speech with over 580 voices.',
  },
  {
    label: '⚡ Multi-Chunk Demo',
    voiceIndex: 27,
    text: `Hussain Voice processes long texts smoothly by splitting them at natural sentence boundaries into parallel chunks. Each chunk is synthesized and the browser merges the resulting audio streams into a clean, seamless MP3. Whether you need audio narration, accessibility reading, or voiceover production, you get immediate playback and direct MP3 download.`,
  },
  {
    label: '🇵🇰 Urdu / Hindi',
    voiceIndex: 1,
    text: 'حسین وائس میں خوش آمدید! یہاں آپ کسی بھی تحریر کو قدرتی آواز میں تبدیل کر سکتے ہیں اور با آسانی ایم پی تھری ڈاؤن لوڈ کر سکتے ہیں۔',
  },
  {
    label: '🇸🇦 Arabic',
    voiceIndex: 163,
    text: 'مرحباً بكم في حسين فويس! استمع إلى هذا النص بصوت طبيعي عالي الجودة وحمله بصيغة إم بي ثري بنقرة واحدة.',
  },
];

function splitText(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rem = text.replace(/[*_`~><^#|\\]/g, '').replace(/\s+/g, ' ').trim();
  while (rem.length > 0) {
    if (rem.length <= max) {
      chunks.push(rem);
      break;
    }
    let i = rem.lastIndexOf('. ', max);
    if (i === -1) i = rem.lastIndexOf('! ', max);
    if (i === -1) i = rem.lastIndexOf('? ', max);
    if (i === -1) i = rem.lastIndexOf('; ', max);
    if (i === -1) i = rem.lastIndexOf(', ', max);
    if (i === -1) i = rem.lastIndexOf(' ', max);
    if (i === -1) i = max;
    const c = rem.substring(0, i + 1).trim();
    if (c) chunks.push(c);
    rem = rem.substring(i + 1).trim();
  }
  return chunks;
}

export default function App() {
  const initialVoices = (voicesJson as { voices: Voice[] }).voices || [];
  const [voices, setVoices] = useState<Voice[]>(initialVoices);
  // Default to Ryan (#27)
  const [selectedVoice, setSelectedVoice] = useState<Voice | null>(
    () => initialVoices.find((v) => v.index === 27) || initialVoices[0] || null
  );
  const [voiceSearch, setVoiceSearch] = useState('');
  const [genderFilter, setGenderFilter] = useState<'All' | 'Male' | 'Female'>('All');
  const [textInput, setTextInput] = useState(
    'Hello, this is Ryan speaking. Welcome to Hussain Voice! Convert any text into crisp, natural human speech with over 580 voices.'
  );
  const [pitch, setPitch] = useState<number>(0);
  const [rate, setRate] = useState<number>(0);

  // Generation states
  const [isGenerating, setIsGenerating] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [progressText, setProgressText] = useState('');
  const [chunkStatuses, setChunkStatuses] = useState<Array<'idle' | 'active' | 'done' | 'error'>>([]);
  const [showResult, setShowResult] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [resToast, setResToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Theme state: Default to the original first style (classic light paper Neo-Brutalist)
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    localStorage.setItem('hv-theme', theme);
  }, [theme]);

  // Sync /api/voices from server
  useEffect(() => {
    fetch('/api/voices')
      .then((r) => r.json())
      .then((d) => {
        if (d.voices && d.voices.length > 0) {
          setVoices(d.voices);
          setSelectedVoice((prev) => prev || d.voices.find((v: Voice) => v.index === 27) || d.voices[0]);
        }
      })
      .catch(() => {});
  }, []);

  const showTopToast = (msg: string, type: 'ok' | 'err' | '' = '') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, msg, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3400);
  };

  const filteredVoices = useMemo(() => {
    const q = voiceSearch.trim().toLowerCase();
    return voices.filter((v) => {
      const matchesGender = genderFilter === 'All' || v.gender.toLowerCase() === genderFilter.toLowerCase();
      const matchesQuery =
        !q ||
        v.name.toLowerCase().includes(q) ||
        v.language.toLowerCase().includes(q) ||
        v.country.toLowerCase().includes(q) ||
        String(v.index).includes(q);
      return matchesGender && matchesQuery;
    });
  }, [voices, voiceSearch, genderFilter]);

  const groupedVoices = useMemo(() => {
    const grp: Record<string, Voice[]> = {};
    for (const v of filteredVoices) {
      if (!grp[v.language]) grp[v.language] = [];
      grp[v.language].push(v);
    }
    return grp;
  }, [filteredVoices]);

  async function handleGenerate() {
    const trimmed = textInput.trim();
    if (!trimmed) {
      setResToast({ msg: 'Please enter some text.', type: 'err' });
      showTopToast('Please enter some text', 'err');
      return;
    }
    if (!selectedVoice) {
      setResToast({ msg: 'Please select a voice first.', type: 'err' });
      showTopToast('Please select a voice', 'err');
      return;
    }

    const chunks = splitText(trimmed, MAX_CHUNK);
    setIsGenerating(true);
    setShowProgress(true);
    setShowResult(false);
    setResToast(null);
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }

    setChunkStatuses(chunks.map(() => 'active'));
    setProgressPct(5);
    setProgressText(`⚡ Synthesizing with ${selectedVoice.name} (${selectedVoice.gender})...`);

    let doneCount = 0;
    const t0 = Date.now();

    const updateProgress = () => {
      doneCount++;
      const pct = Math.round((doneCount / chunks.length) * 92);
      setProgressPct(pct);
      setProgressText(
        chunks.length > 1
          ? `${doneCount}/${chunks.length} chunks generated (${pct}%)`
          : 'Generating...'
      );
    };

    try {
      const blobs: Blob[] = new Array(chunks.length);
      const concurrency = 2; // Process 2 chunks concurrently for smooth websocket stability
      for (let i = 0; i < chunks.length; i += concurrency) {
        const batch = chunks.slice(i, i + concurrency);
        const batchPromises = batch.map(async (chunkText, batchIdx) => {
          const actualIdx = i + batchIdx;
          try {
            const response = await fetch('/api/tts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                voiceIndex: selectedVoice.index,
                text: chunkText,
                pitch,
                rate,
              }),
            });
            if (!response.ok) {
              const errJson = await response.json().catch(() => ({}));
              throw new Error(errJson.error || `HTTP ${response.status}`);
            }
            const blob = await response.blob();
            blobs[actualIdx] = blob;
            setChunkStatuses((prev) => {
              const copy = [...prev];
              copy[actualIdx] = 'done';
              return copy;
            });
            updateProgress();
          } catch (err: any) {
            setChunkStatuses((prev) => {
              const copy = [...prev];
              copy[actualIdx] = 'error';
              return copy;
            });
            throw err;
          }
        });
        await Promise.all(batchPromises);
      }

      setProgressPct(98);
      setProgressText('Merging audio streams in browser...');

      const validBlobs = blobs.filter((b) => b && b.size > 0);
      if (validBlobs.length === 0) {
        throw new Error('No audio received from synthesis');
      }

      const merged = new Blob(validBlobs, { type: 'audio/mpeg' });
      const newUrl = URL.createObjectURL(merged);
      setAudioUrl(newUrl);

      setProgressPct(100);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      setProgressText(`✓ Done in ${elapsed}s`);

      setTimeout(() => {
        setShowProgress(false);
        setShowResult(true);
        setResToast({
          msg: `✓ Generated in ${elapsed}s — Voice: ${selectedVoice.name} (${selectedVoice.gender}) · Pitch: ${pitch} · Speed: ${rate}`,
          type: 'ok',
        });
        showTopToast(`Speech ready (${selectedVoice.name})`, 'ok');
      }, 300);
    } catch (err: any) {
      setShowProgress(false);
      setShowResult(true);
      const message = err?.message || 'Failed to generate speech.';
      setResToast({ msg: `Error: ${message}`, type: 'err' });
      showTopToast(`Error: ${message}`, 'err');
    } finally {
      setIsGenerating(false);
    }
  }

  const charCount = textInput.length;
  const charClass =
    'char-ctr' + (charCount > 10000 ? ' over' : charCount > 6000 ? ' warn' : '');

  return (
    <>
      <div className="halftone" />
      <div className="ink-noise" />

      {/* HEADER NAVBAR */}
      <nav className="hv-nav">
        <div className="nav-inner">
          <div className="logo">
            <div className="logo-badge">HV</div>
            <span className="logo-name">
              Hussain<span>Voice</span>
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="badge">
              🎙️ {voices.length || 580}+ Voices
            </span>
            <button
              className="nav-icon-btn"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              title="Toggle theme"
              type="button"
            >
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
          </div>
        </div>
      </nav>

      <div className="page" id="top">
        {/* MASTHEAD */}
        <div className="masthead" style={{ paddingBottom: 14 }}>
          <div className="mh-top" style={{ marginBottom: 8 }}>
            <div>
              <div className="eyebrow">
                <span className="live-dot" />
                Natural Human Neural Voices · True Parallel Generation
              </div>
              <h1 className="hv-h1">
                Convert text to <em>natural speech.</em>
              </h1>
              <p className="hero-sub">
                Select your preferred voice from 580+ natural neural voices across 70+ languages.
                Adjust pitch and speed, and download your speech as an MP3 instantly.
              </p>
            </div>
            <div className="badges">
              <span className="badge">580+ Voices</span>
              <span className="badge">∞ Length</span>
              <span className="badge">MP3 Download</span>
              <span className="badge">Parallel Engine</span>
            </div>
          </div>
        </div>

        {/* MAIN TEXT TO SPEECH & VOICE LIBRARY WORKSPACE */}
        <div className="app" id="app-anchor" style={{ paddingTop: 0 }}>
          {/* LEFT COLUMN: TEXT INPUT, EFFECTS, GENERATE */}
          <div className="col-stack">
            {/* TEXT INPUT CARD */}
            <div className="card">
              <div className="card-hdr">
                <div className="card-hdr-left">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                  <span className="card-title">Your Text</span>
                </div>
                {textInput.length > 0 && (
                  <button
                    type="button"
                    className="param-reset"
                    onClick={() => setTextInput('')}
                  >
                    Clear Text
                  </button>
                )}
              </div>
              <div className="card-body">
                <div className="ta-wrap">
                  <textarea
                    className="hv-textarea"
                    id="text-input"
                    placeholder="Type or paste any text here — long texts are automatically split into parallel chunks for fast generation..."
                    value={textInput}
                    onChange={(e) => setTextInput(e.target.value)}
                    spellCheck={false}
                  />
                  <span className={charClass} id="char-ctr">
                    {charCount.toLocaleString()}
                  </span>
                </div>
                <div className="sample-bar">
                  {SAMPLE_TEXTS.map((sample) => (
                    <button
                      key={sample.label}
                      type="button"
                      className="sample-chip"
                      onClick={() => {
                        setTextInput(sample.text);
                        const match = voices.find((v) => v.index === sample.voiceIndex);
                        if (match) setSelectedVoice(match);
                      }}
                    >
                      {sample.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* VOICE EFFECTS CARD */}
            <div className="card">
              <div className="card-hdr">
                <div className="card-hdr-left">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                  <span className="card-title">Voice Effects</span>
                </div>
              </div>
              <div className="card-body">
                <div className="audio-params">
                  {/* Pitch Control */}
                  <div className="param-control">
                    <div className="param-label">
                      <span>Pitch</span>
                      <span className="param-value" id="pitch-value">
                        {pitch > 0 ? `+${pitch}` : pitch}
                      </span>
                      <button
                        type="button"
                        className="param-reset"
                        onClick={() => setPitch(0)}
                      >
                        Reset
                      </button>
                    </div>
                    <input
                      type="range"
                      id="pitch-slider"
                      min="-100"
                      max="100"
                      step="1"
                      value={pitch}
                      onChange={(e) => setPitch(parseInt(e.target.value, 10) || 0)}
                    />
                    <div className="param-scale">
                      <span>Deeper</span>
                      <span>Normal</span>
                      <span>Higher</span>
                    </div>
                  </div>

                  {/* Speed / Rate Control */}
                  <div className="param-control">
                    <div className="param-label">
                      <span>Speed</span>
                      <span className="param-value" id="rate-value">
                        {rate > 0 ? `+${rate}` : rate}
                      </span>
                      <button
                        type="button"
                        className="param-reset"
                        onClick={() => setRate(0)}
                      >
                        Reset
                      </button>
                    </div>
                    <input
                      type="range"
                      id="rate-slider"
                      min="-100"
                      max="100"
                      step="1"
                      value={rate}
                      onChange={(e) => setRate(parseInt(e.target.value, 10) || 0)}
                    />
                    <div className="param-scale">
                      <span>Slower</span>
                      <span>Normal</span>
                      <span>Faster</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* GENERATE CARD */}
            <div className="card">
              <div className="card-hdr">
                <div className="card-hdr-left">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  <span className="card-title">Generate Speech</span>
                </div>
              </div>
              <div className="card-body">
                <div
                  className={selectedVoice ? 'sel-disp' : 'sel-disp empty'}
                  id="sel-disp"
                >
                  {selectedVoice ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                      <span>
                        🎤 #{selectedVoice.index} · <strong>{selectedVoice.name}</strong> · {selectedVoice.gender} · {selectedVoice.country} · {selectedVoice.language}
                      </span>
                    </div>
                  ) : (
                    '🎤 No voice selected'
                  )}
                </div>

                <button
                  type="button"
                  className="abtn primary btn-full"
                  id="gen-btn"
                  disabled={isGenerating}
                  onClick={handleGenerate}
                >
                  {isGenerating ? (
                    <>
                      <span
                        className="spin"
                        style={{
                          width: 16,
                          height: 16,
                          border: '2.5px solid rgba(255,255,255,0.3)',
                          borderTopColor: '#fff',
                        }}
                      />{' '}
                      Synthesizing Audio...
                    </>
                  ) : (
                    <>
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>{' '}
                      Generate Speech
                    </>
                  )}
                </button>

                {/* PROGRESS BAR & STATUS PIPS */}
                <div className={`prog-wrap ${showProgress ? 'show' : ''}`} id="prog-wrap">
                  <div className="prog-bar">
                    <div
                      className="prog-fill"
                      id="prog-fill"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  <div className="prog-txt" id="prog-txt">
                    {progressText}
                  </div>
                  <div className="chunk-grid" id="chunk-grid">
                    {chunkStatuses.map((st, idx) => (
                      <div
                        key={idx}
                        className={`chunk-pip ${st === 'idle' ? '' : st}`}
                        title={`Chunk ${idx + 1}`}
                      />
                    ))}
                  </div>
                </div>

                {/* RESULT PLAYER & DOWNLOAD */}
                <div className={`res-wrap ${showResult ? 'show' : ''}`} id="res-wrap">
                  {audioUrl && (
                    <div className="res-box">
                      <div className="res-lbl">
                        <span className="d" />
                        Ready to play
                      </div>
                      <audio
                        ref={audioRef}
                        id="audio-player"
                        className="hv-audio"
                        src={audioUrl}
                        controls
                        autoPlay
                        preload="auto"
                      />
                      <a
                        className="abtn ghost btn-full"
                        id="dl-btn"
                        href={audioUrl}
                        download={`${(selectedVoice?.name || 'Ryan').replace(/\s+/g, '_')}_speech.mp3`}
                        style={{ marginTop: 6 }}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        Download MP3 ({selectedVoice?.name})
                      </a>
                    </div>
                  )}
                  {resToast && (
                    <div className={`res-toast ${resToast.type}`}>
                      {resToast.msg}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN: VOICE LIBRARY */}
          <div className="card">
            <div className="card-hdr">
              <div className="card-hdr-left">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
                <span className="card-title">Voice Library ({filteredVoices.length})</span>
              </div>
              {voiceSearch && (
                <button
                  type="button"
                  className="param-reset"
                  onClick={() => setVoiceSearch('')}
                >
                  Clear
                </button>
              )}
            </div>
            <div className="card-body">
              {/* Voice search */}
              <input
                className="vsearch"
                id="vsearch"
                type="text"
                placeholder="🔍  Search voice name, language, country..."
                value={voiceSearch}
                onChange={(e) => setVoiceSearch(e.target.value)}
              />

              {/* Gender filter tabs */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                {(['All', 'Male', 'Female'] as const).map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setGenderFilter(g)}
                    className="param-reset"
                    style={{
                      flex: 1,
                      padding: '5px 8px',
                      background: genderFilter === g ? 'var(--red)' : 'var(--surface)',
                      color: genderFilter === g ? '#fff' : 'var(--text)',
                      borderColor: genderFilter === g ? 'var(--red)' : 'var(--ink)',
                      fontWeight: 700,
                    }}
                  >
                    {g === 'All' ? 'All Voices' : g === 'Male' ? 'Male ♂' : 'Female ♀'}
                  </button>
                ))}
              </div>

              {/* Voices scrollable list */}
              <div className="vlist" id="vlist" style={{ maxHeight: 600 }}>
                {Object.keys(groupedVoices).length === 0 ? (
                  <div
                    style={{
                      textAlign: 'center',
                      padding: '2rem',
                      color: 'var(--text3)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.75rem',
                    }}
                  >
                    No voices match your search
                  </div>
                ) : (
                  (Object.entries(groupedVoices) as Array<[string, Voice[]]>).map(([lang, list]) => (
                    <React.Fragment key={lang}>
                      <div className="vgrp">
                        {lang} ({list.length})
                      </div>
                      {list.map((v) => {
                        const isSel = selectedVoice?.index === v.index;
                        const isMale = v.gender.toLowerCase() === 'male';
                        const avClass = isMale ? 'av-m' : 'av-f';
                        const initials = v.name
                          .split(' ')
                          .slice(0, 2)
                          .map((w) => w[0] || '')
                          .join('')
                          .toUpperCase()
                          .slice(0, 2);

                        return (
                          <div
                            key={v.index}
                            className={`vitem ${isSel ? 'sel' : ''}`}
                            onClick={() => setSelectedVoice(v)}
                          >
                            <span className="vnum">{v.index}</span>
                            <div className={`vav ${avClass}`}>
                              {initials}
                            </div>
                            <div className="vinfo">
                              <div className="vname">
                                {v.name}
                                <span
                                  style={{
                                    fontSize: '0.65rem',
                                    marginLeft: 6,
                                    padding: '1px 5px',
                                    borderRadius: 4,
                                    background: isMale ? 'var(--blue-dim)' : 'var(--red-dim)',
                                    color: isMale ? 'var(--blue)' : 'var(--red)',
                                  }}
                                >
                                  {v.gender}
                                </span>
                              </div>
                              <div className="vmeta">
                                {v.country} · {v.language}
                              </div>
                            </div>
                            <span className="vchk">✓</span>
                          </div>
                        );
                      })}
                    </React.Fragment>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* MINIMAL FOOTER */}
      <footer className="hv-footer">
        <div className="foot-bottom">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="logo-badge" style={{ width: 24, height: 24, fontSize: '0.75rem' }}>HV</div>
            <span className="foot-copy">
              © 2026 <strong>Hussain Voice</strong> · 580+ Natural Voices Text-to-Speech Studio
            </span>
          </div>
          <div className="foot-status">
            <span className="st-dot" />
            TTS Engine Active
          </div>
        </div>
      </footer>

      {/* TOAST WRAP */}
      <div id="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </>
  );
}
