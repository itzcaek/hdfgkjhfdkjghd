import { useState, useRef, useCallback, useEffect } from 'react';
import { NektoAudioClient, type AudioStatus, type IceStats } from './nektoAudioClient';
import { Background } from './components/Background';
import { Header } from './components/Header';

/* ═══════════════════════════════════════════════════════════════════════════
   forgotten · voice — React redesign, Forgotten Demo style
   ═══════════════════════════════════════════════════════════════════════════
   Visual: monochrome dark palette + Phosphor icons + CSS wave-bars, modelled
   on the Forgotten Demo (May 2026). No more style.min.css / header.css.
   Behaviour: two NektoAudioClient instances (MITM), 9 presets, per-peer
   mute / sound / lags / disconnect via the click-to-open .float-panel.
   Resilience handled by NektoAudioClient (reconnect / health-timer /
   getStats / server-controlled TURN). ─────────────────────────────────────── */

/* ─── Types ──────────────────────────────────────────────────────────── */
type LogType = 'info' | 'success' | 'error' | 'warning';
interface ClientConfig {
  token: string;
  sex: string;
  searchSex: string;
  ageFrom: number;
  ageTo: number;
  searchAgeFrom: number;
  searchAgeTo: number;
}
type Screen = 'welcome' | 'token' | 'options' | 'call' | 'end';
type Overlay = null | 'mic-error' | 'fail-token' | 'waiting';

/* ─── Persistence ────────────────────────────────────────────────────── */
const STORAGE_KEY = 'forgotten-voice-redesign-config';
function loadConfig(): { c1: ClientConfig; c2: ClientConfig } | null {
  try { const r = localStorage.getItem(STORAGE_KEY); if (r) return JSON.parse(r); } catch {}
  return null;
}
function saveConfig(c: { c1: ClientConfig; c2: ClientConfig }) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(c)); } catch {}
}

/* ─── Preset criteria (decoded from forgotten-voice.html data-options) ─ */
interface PresetCriteria {
  peerSex: string;
  userSex: string;
  userAge?: { from: number; to: number };
  peerAges?: Array<{ from: number; to: number }>;
}
interface PresetEntry { criteria: PresetCriteria; initiator: boolean }
interface Preset { name: string; data: [PresetEntry, PresetEntry]; popular?: boolean; hot?: boolean }

function presetToConfigs(p: Preset, t1: string, t2: string): { c1: ClientConfig; c2: ClientConfig } {
  const mk = (e: PresetEntry, token: string): ClientConfig => {
    const ua = e.criteria.userAge ?? { from: 18, to: 25 };
    const pa = e.criteria.peerAges?.[0] ?? { from: 18, to: 25 };
    return {
      token,
      sex: e.criteria.userSex,
      searchSex: e.criteria.peerSex,
      ageFrom: ua.from, ageTo: ua.to,
      searchAgeFrom: pa.from, searchAgeTo: pa.to,
    };
  };
  return { c1: mk(p.data[0], t1), c2: mk(p.data[1], t2) };
}

const PRESETS: Preset[] = [
  { name: 'НЕКТО', data: [
    { criteria: { peerSex: 'ANY', userSex: 'ANY' }, initiator: true },
    { criteria: { peerSex: 'ANY', userSex: 'ANY' }, initiator: true },
  ], popular: true },
  { name: 'ДЕВУШКА И ПАРЕНЬ', data: [
    { criteria: { peerSex: 'MALE', userSex: 'FEMALE', userAge: { from: 0, to: 17 }, peerAges: [{ from: 0, to: 17 }] }, initiator: false },
    { criteria: { peerSex: 'FEMALE', userSex: 'MALE', userAge: { from: 0, to: 17 }, peerAges: [{ from: 0, to: 17 }] }, initiator: true },
  ], hot: true },
  { name: 'ДЕВУШКА И ПАРЕНЬ 18+', data: [
    { criteria: { peerSex: 'MALE', userSex: 'FEMALE', userAge: { from: 0, to: 17 }, peerAges: [{ from: 18, to: 24 }] }, initiator: false },
    { criteria: { peerSex: 'FEMALE', userSex: 'MALE', userAge: { from: 18, to: 24 }, peerAges: [{ from: 0, to: 17 }] }, initiator: true },
  ]},
  { name: 'ЖЕНЩИНА И МУЖЧИНА 33+', data: [
    { criteria: { peerSex: 'FEMALE', userSex: 'MALE', userAge: { from: 33, to: 100 }, peerAges: [{ from: 33, to: 100 }] }, initiator: true },
    { criteria: { peerSex: 'MALE', userSex: 'FEMALE', userAge: { from: 33, to: 100 }, peerAges: [{ from: 33, to: 100 }] }, initiator: false },
  ]},
  { name: 'ПАРЕНЬ И ПАРЕНЬ', data: [
    { criteria: { peerSex: 'MALE', userSex: 'MALE', userAge: { from: 0, to: 17 }, peerAges: [{ from: 0, to: 17 }] }, initiator: true },
    { criteria: { peerSex: 'MALE', userSex: 'MALE', userAge: { from: 0, to: 17 }, peerAges: [{ from: 0, to: 17 }] }, initiator: true },
  ]},
  { name: 'ДЕВУШКА И ДЕВУШКА', data: [
    { criteria: { peerSex: 'FEMALE', userSex: 'FEMALE', userAge: { from: 0, to: 17 }, peerAges: [{ from: 0, to: 17 }] }, initiator: true },
    { criteria: { peerSex: 'FEMALE', userSex: 'FEMALE', userAge: { from: 0, to: 17 }, peerAges: [{ from: 0, to: 17 }] }, initiator: true },
  ]},
  { name: 'СПОР СКУФОВ', data: [
    { criteria: { peerSex: 'MALE', userSex: 'FEMALE', userAge: { from: 33, to: 100 }, peerAges: [{ from: 33, to: 100 }] }, initiator: true },
    { criteria: { peerSex: 'MALE', userSex: 'FEMALE', userAge: { from: 33, to: 100 }, peerAges: [{ from: 33, to: 100 }] }, initiator: true },
  ]},
  { name: 'СПОР ПАЦАНОВ', data: [
    { criteria: { peerSex: 'MALE', userSex: 'FEMALE', userAge: { from: 18, to: 32 }, peerAges: [{ from: 18, to: 32 }] }, initiator: true },
    { criteria: { peerSex: 'MALE', userSex: 'FEMALE', userAge: { from: 18, to: 32 }, peerAges: [{ from: 18, to: 32 }] }, initiator: true },
  ]},
  { name: 'PDF CATCHER', data: [
    { criteria: { peerSex: 'MALE', userSex: 'FEMALE', userAge: { from: 0, to: 17 }, peerAges: [{ from: 33, to: 100 }] }, initiator: false },
    { criteria: { peerSex: 'FEMALE', userSex: 'MALE', userAge: { from: 0, to: 17 }, peerAges: [{ from: 0, to: 17 }] }, initiator: true },
  ]},
];

const statusLabel: Record<AudioStatus, string> = {
  disconnected: 'не на связи',
  connecting: 'подключение',
  authenticating: 'авторизация',
  authenticated: 'готов',
  searching: 'поиск',
  ringing: 'звонок',
  connected: 'в эфире',
  reconnecting: 'реконнект',
  error: 'ошибка',
};

/* ═══════════════════════════════════════════════════════════════════════
   Sub-components
   ═══════════════════════════════════════════════════════════════════════ */

/* ─── WaveBars: replaces the canvas AudioVisualizer. Demo-style — four CSS
       bars that bounce with a staggered animation-delay whenever the peer's
       MediaStream has audio energy above the silence threshold. ─────────── */
function WaveBars({ stream, threshold = 8 }: { stream: MediaStream | null; threshold?: number }) {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!stream) { setSpeaking(false); return; }
    let acRef: AudioContext | null = null;
    let rafId = 0;
    try {
      acRef = new AudioContext();
      const source = acRef.createMediaStreamSource(stream);
      const analyser = acRef.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        setSpeaking(sum / data.length > threshold);
        rafId = requestAnimationFrame(tick);
      };
      tick();
    } catch {}
    return () => {
      cancelAnimationFrame(rafId);
      acRef?.close().catch(() => {});
    };
  }, [stream, threshold]);
  return (
    <div className="wave-bars" aria-hidden>
      {[0, 1, 2, 3].map(i => (
        <div key={i} className={`bar ${speaking ? 'active' : ''}`} />
      ))}
    </div>
  );
}

/* ─── Participant: avatar circle (status-coloured) + side label + wave-bars +
       status sub-line. Click anywhere on the card opens the per-peer
       float-panel; right-click does the same on desktop. The .lags / .mute /
       .deafen modifier classes are applied to the outer wrapper so the
       avatar shake (CSS) lights up when lags are on. ───────────────────── */
function Participant({
  side, status, stream, micMuted, audioMuted, lags, onOpen,
}: {
  side: 'A' | 'B';
  status: AudioStatus;
  stream: MediaStream | null;
  micMuted: boolean;
  audioMuted: boolean;
  lags: boolean;
  onOpen: (clientX: number, clientY: number) => void;
}) {
  const onClick = (e: React.MouseEvent) => { e.stopPropagation(); onOpen(e.clientX, e.clientY); };
  const onContext = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onOpen(e.clientX, e.clientY); };
  const speakingClass = stream && status === 'connected' ? 'speaking' : '';
  const cls = [
    'participant',
    status,
    micMuted && 'mute',
    audioMuted && 'deafen',
    lags && 'lags',
    speakingClass,
  ].filter(Boolean).join(' ');
  return (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onContextMenu={onContext}
      title="Открыть управление"
    >
      <span className="side-label">Партнёр {side}</span>
      <div className={`avatar ${status}`}>
        <i className="ph ph-user" />
      </div>
      <WaveBars stream={stream} />
      <span className="participant-status">{statusLabel[status]}</span>
    </div>
  );
}

/* ─── Timer-pill: fixed count-up display of the call duration. Demo's pill
       counts down a trial limit, but the user explicitly asked us not to
       add monetization features, so we just count up since `since`. ──── */
function TimerPill({ since }: { since: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [since]);
  if (!since) return null;
  const elapsed = Math.max(0, Math.floor((now - since) / 1000));
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  return (
    <div className="timer-pill">
      <div className="timer-progress" />
      <div className="timer-content">
        <i className="ph ph-timer" />
        <span className="timer-digits">{mm}:{ss}</span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   App
   ═══════════════════════════════════════════════════════════════════════ */

export default function App() {
  const saved = useRef(loadConfig());
  const [screen, setScreen] = useState<Screen>('welcome');
  const [overlay, setOverlay] = useState<Overlay>(null);

  const [cfg1, setCfg1] = useState<ClientConfig>(saved.current?.c1 ?? {
    token: '', sex: 'ANY', searchSex: 'ANY', ageFrom: 18, ageTo: 25, searchAgeFrom: 18, searchAgeTo: 25,
  });
  const [cfg2, setCfg2] = useState<ClientConfig>(saved.current?.c2 ?? {
    token: '', sex: 'ANY', searchSex: 'ANY', ageFrom: 18, ageTo: 25, searchAgeFrom: 18, searchAgeTo: 25,
  });
  const [presetIdx, setPresetIdx] = useState(0);

  const [status1, setStatus1] = useState<AudioStatus>('disconnected');
  const [status2, setStatus2] = useState<AudioStatus>('disconnected');
  const [stream1, setStream1] = useState<MediaStream | null>(null);
  const [stream2, setStream2] = useState<MediaStream | null>(null);
  const [stats1, setStats1] = useState<IceStats | null>(null);
  const [stats2, setStats2] = useState<IceStats | null>(null);

  const [audio1Muted, setAudio1Muted] = useState(false);
  const [audio2Muted, setAudio2Muted] = useState(false);
  const [mic1Muted, setMic1Muted] = useState(false);
  const [mic2Muted, setMic2Muted] = useState(false);
  const [lags1, setLags1] = useState(false);
  const [lags2, setLags2] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);

  const [callStart, setCallStart] = useState<number | null>(null);
  const [finalDuration, setFinalDuration] = useState<string | null>(null);
  /* Refs mirror state for callbacks that outlive the memoization of
     connect(). Without these the two clients' onConnected handlers each
     read a stale captured `callStart` and both setCallStart — the second
     one wins and the timer resets when the second peer connects. */
  const callStartRef = useRef<number | null>(null);

  const [micActive, setMicActive] = useState(false);
  const [micMuted, setMicMuted] = useState(true);
  const [autoRestart, setAutoRestart] = useState(true);
  const [refind, setRefind] = useState(true);
  /* Upstream selector: 'me' (default) or 'kz' (audio.nekto-me.kz).
     The .kz endpoint is a separate edge node, sometimes routes around
     IP bans on .me — user reports it's not reliable from his ISP, so
     keep it opt-in. Persisted to localStorage. Applied on next connect()
     (does NOT move an open WS). */
  const [upstream, setUpstream] = useState<'me' | 'kz'>(
    () => (localStorage.getItem('forgotten:upstream') === 'kz' ? 'kz' : 'me'),
  );
  /* Mirror to refs so the NektoAudioClient toggles can be reflected
     mid-call without re-creating the clients. */
  const autoRestartRef = useRef(autoRestart);
  const refindRef = useRef(refind);
  const upstreamRef = useRef(upstream);

  /* Click-to-open .float-panel for a participant. Stores { which, x, y } so
     we can position the panel near the click on desktop, dock to bottom on
     mobile. */
  const [peerPanel, setPeerPanel] = useState<{ which: 1 | 2 } | null>(null);
  const [settingsPanel, setSettingsPanel] = useState(false);

  const client1Ref = useRef<NektoAudioClient | null>(null);
  const client2Ref = useRef<NektoAudioClient | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recAudioCtxRef = useRef<AudioContext | null>(null);
  const isRecordingRef = useRef(false);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioEl1 = useRef<HTMLAudioElement | null>(null);
  const audioEl2 = useRef<HTMLAudioElement | null>(null);
  /* Pending setTimeout handles from connect(). Cleared at start of every
     fresh connect() and at unmount so a stale timer never fires on a
     client that's already been disposed. */
  const pendingTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const addLog = useCallback((text: string, type: LogType = 'info') => {
    const m = `[forgotten] ${text}`;
    if (type === 'error') console.error(m);
    else if (type === 'warning') console.warn(m);
    else console.log(m);
  }, []);

  useEffect(() => { if (cfg1.token || cfg2.token) saveConfig({ c1: cfg1, c2: cfg2 }); }, [cfg1, cfg2]);

  /* Reflect autoRestart/refind toggles into both clients whenever they
     change. Doing this via useEffect (rather than reading from refs inside
     the client) keeps the source of truth in React state. */
  useEffect(() => {
    autoRestartRef.current = autoRestart;
    client1Ref.current?.setAutoRestart(autoRestart);
    client2Ref.current?.setAutoRestart(autoRestart);
  }, [autoRestart]);
  useEffect(() => {
    refindRef.current = refind;
    client1Ref.current?.setRefindOnReconnect(refind);
    client2Ref.current?.setRefindOnReconnect(refind);
  }, [refind]);
  useEffect(() => {
    upstreamRef.current = upstream;
    localStorage.setItem('forgotten:upstream', upstream);
    /* Apply immediately. setUpstream() only affects the NEXT WS open —
     existing connections stay on whatever they opened with. The user
     needs to disconnect / reconnect to actually re-route an active call. */
    client1Ref.current?.setUpstream(upstream);
    client2Ref.current?.setUpstream(upstream);
  }, [upstream]);

  /* callStart → ref mirror, used by the two clients' onConnected handlers
     so the timer is set exactly once per call (the FIRST peer to connect). */
  useEffect(() => { callStartRef.current = callStart; }, [callStart]);

  useEffect(() => () => {
    pendingTimersRef.current.forEach(t => clearTimeout(t));
    pendingTimersRef.current = [];
    client1Ref.current?.disconnect();
    client2Ref.current?.disconnect();
  }, []);

  /* ─── Recording ─── */
  const startRecording = useCallback(() => {
    try {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      if (stream1) ctx.createMediaStreamSource(stream1).connect(dest);
      if (stream2) ctx.createMediaStreamSource(stream2).connect(dest);
      recAudioCtxRef.current = ctx;
      const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
      const chunks: BlobPart[] = [];
      rec.ondataavailable = e => chunks.push(e.data);
      rec.onstop = () => {
        const b = new Blob(chunks, { type: 'audio/webm' });
        setRecordedUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(b); });
        if (recAudioCtxRef.current) {
          recAudioCtxRef.current.close().catch(() => {});
          recAudioCtxRef.current = null;
        }
      };
      rec.start();
      recorderRef.current = rec;
      isRecordingRef.current = true;
      setIsRecording(true);
      setRecordedUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
      addLog('Запись начата', 'success');
    } catch (e) {
      addLog(`Ошибка записи: ${e}`, 'error');
    }
  }, [stream1, stream2, addLog]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current) { recorderRef.current.stop(); recorderRef.current = null; }
    if (recAudioCtxRef.current) { recAudioCtxRef.current.close().catch(() => {}); recAudioCtxRef.current = null; }
    isRecordingRef.current = false;
    setIsRecording(false);
    addLog('Запись остановлена', 'info');
  }, [addLog]);

  /* ─── Microphone ─── */
  const enableMic = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = s;
      client1Ref.current?.addMicSource(s);
      client2Ref.current?.addMicSource(s);
      client1Ref.current?.setMicMuted(true);
      client2Ref.current?.setMicMuted(true);
      setMicActive(true); setMicMuted(true);
      addLog('Микрофон подключён (замьючен)', 'success');
      return true;
    } catch (e) {
      addLog(`Микрофон ошибка: ${e}`, 'error');
      return false;
    }
  }, [addLog]);

  const disableMic = useCallback(() => {
    client1Ref.current?.removeMicSource();
    client2Ref.current?.removeMicSource();
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
    setMicActive(false); setMicMuted(true);
  }, []);

  const toggleMicMute = useCallback(() => {
    const m = !micMuted;
    client1Ref.current?.setMicMuted(m);
    client2Ref.current?.setMicMuted(m);
    setMicMuted(m); setMic1Muted(m); setMic2Muted(m);
    addLog(m ? 'Замьючен' : 'Говорю!', m ? 'warning' : 'success');
  }, [micMuted, addLog]);

  /* ─── Connect (creates two NektoAudioClient instances) ─── */
  const connect = useCallback(() => {
    if (!cfg1.token || !cfg2.token) { addLog('Оба токена обязательны', 'error'); return; }
    saveConfig({ c1: cfg1, c2: cfg2 });
    /* Cancel any pending timers from a previous connect() — e.g. the
       1500 ms "c2.connect" or 2500 ms "startRecording" fuses — so they
       don't fire on the clients we're about to throw away. */
    pendingTimersRef.current.forEach(t => clearTimeout(t));
    pendingTimersRef.current = [];
    setStream1(null); setStream2(null);
    setCallStart(null);
    callStartRef.current = null;
    setAudio1Muted(false); setAudio2Muted(false);
    setMic1Muted(false); setMic2Muted(false);
    setLags1(false); setLags2(false);
    setStats1(null); setStats2(null);
    if (audioEl1.current) audioEl1.current.muted = false;
    if (audioEl2.current) audioEl2.current.muted = false;
    client1Ref.current?.disconnect();
    client2Ref.current?.disconnect();
    client1Ref.current = null; client2Ref.current = null;
    addLog('═══ Запуск Audio MITM ═══', 'success');

    /* Read once and call setCallStart only the first time. Refs avoid
       the stale-closure bug where both onConnected handlers captured the
       same null and the second one always overwrote the first. */
    const setCallStartOnce = () => {
      if (callStartRef.current == null) {
        const now = Date.now();
        callStartRef.current = now;
        setCallStart(now);
      }
    };

    const c1 = new NektoAudioClient(cfg1.token, {
      onStatusChange: setStatus1,
      onLog: addLog,
      onIncomingStream: s => {
        setStream1(s);
        if (!audioEl1.current) {
          audioEl1.current = new Audio();
          audioEl1.current.autoplay = true;
          audioEl1.current.volume = 0.5;
        }
        audioEl1.current.srcObject = s;
        audioEl1.current.muted = false;
      },
      onConnected: () => { addLog('Клиент 1 подключён', 'success'); setCallStartOnce(); },
      onDisconnected: () => {
        setStream1(null);
        if (audioEl1.current) { audioEl1.current.srcObject = null; audioEl1.current.muted = false; }
        setAudio1Muted(false); setMic1Muted(false); setLags1(false);
        setStats1(null);
      },
      onIceStats: setStats1,
      onReconnecting: () => addLog('Клиент 1: реконнект…', 'warning'),
      onBanned: () => setOverlay('fail-token'),
      onPeerLeft: () => addLog('Клиент 1: собеседник вышел', 'warning'),
    });
    const c2 = new NektoAudioClient(cfg2.token, {
      onStatusChange: setStatus2,
      onLog: addLog,
      onIncomingStream: s => {
        setStream2(s);
        if (!audioEl2.current) {
          audioEl2.current = new Audio();
          audioEl2.current.autoplay = true;
          audioEl2.current.volume = 0.5;
        }
        audioEl2.current.srcObject = s;
        audioEl2.current.muted = false;
      },
      onConnected: () => { addLog('Клиент 2 подключён', 'success'); setCallStartOnce(); },
      onDisconnected: () => {
        setStream2(null);
        if (audioEl2.current) { audioEl2.current.srcObject = null; audioEl2.current.muted = false; }
        setAudio2Muted(false); setMic2Muted(false); setLags2(false);
        setStats2(null);
      },
      onIceStats: setStats2,
      onReconnecting: () => addLog('Клиент 2: реконнект…', 'warning'),
      onBanned: () => setOverlay('fail-token'),
      onPeerLeft: () => addLog('Клиент 2: собеседник вышел', 'warning'),
    });
    c1.setCrossInput(c2.outputStream);
    c2.setCrossInput(c1.outputStream);
    c1.setSearchParams({ sex: cfg1.sex, searchSex: cfg1.searchSex, ageFrom: cfg1.ageFrom, ageTo: cfg1.ageTo, searchAgeFrom: cfg1.searchAgeFrom, searchAgeTo: cfg1.searchAgeTo });
    c2.setSearchParams({ sex: cfg2.sex, searchSex: cfg2.searchSex, ageFrom: cfg2.ageFrom, ageTo: cfg2.ageTo, searchAgeFrom: cfg2.searchAgeFrom, searchAgeTo: cfg2.searchAgeTo });
    /* Apply current toggle state to the freshly created clients. */
    c1.setAutoRestart(autoRestartRef.current);
    c2.setAutoRestart(autoRestartRef.current);
    c1.setRefindOnReconnect(refindRef.current);
    c2.setRefindOnReconnect(refindRef.current);
    c1.setUpstream(upstreamRef.current);
    c2.setUpstream(upstreamRef.current);
    client1Ref.current = c1; client2Ref.current = c2;
    if (micStreamRef.current) {
      c1.addMicSource(micStreamRef.current);
      c2.addMicSource(micStreamRef.current);
      c1.setMicMuted(micMuted);
      c2.setMicMuted(micMuted);
    }
    c1.connect();
    /* Track the two delayed kicks so the cleanup useEffect (or a fresh
       connect()) can cancel them and avoid firing on stale clients. */
    pendingTimersRef.current.push(
      setTimeout(() => {
        if (client2Ref.current === c2) c2.connect();
      }, 1500),
    );
    setScreen('call');
    /* Auto-start recording — same UX as the previous redesign. */
    pendingTimersRef.current.push(
      setTimeout(() => {
        if (!isRecordingRef.current) startRecording();
      }, 2500),
    );
  }, [cfg1, cfg2, addLog, micMuted, startRecording]);

  /* ─── End / restart / disconnect helpers ─── */
  const formattedDuration = useCallback(() => {
    if (!callStart) return null;
    const d = Math.floor((Date.now() - callStart) / 1000);
    return `${String(Math.floor(d / 60)).padStart(2, '0')}:${String(d % 60).padStart(2, '0')}`;
  }, [callStart]);

  const endDialog = useCallback(() => {
    setFinalDuration(formattedDuration());
    setCallStart(null);
    callStartRef.current = null;
    if (isRecording) stopRecording();
    const c1 = client1Ref.current, c2 = client2Ref.current;
    c1?.setLags(false); c2?.setLags(false);
    /* stopSearch() first so the server cancels any pending scan-for-peer
       — disconnectPeer() only sends `peer-disconnect` when a connectionId
       is set, so a search-in-progress would otherwise keep running. */
    c1?.stopSearch(); c2?.stopSearch();
    c1?.disconnectPeer(); c2?.disconnectPeer();
    setStream1(null); setStream2(null);
    setAudio1Muted(false); setAudio2Muted(false);
    setMic1Muted(false); setMic2Muted(false);
    setLags1(false); setLags2(false);
    if (audioEl1.current) audioEl1.current.muted = false;
    if (audioEl2.current) audioEl2.current.muted = false;
    addLog('Диалог закончен', 'warning');
    setScreen('end');
  }, [formattedDuration, isRecording, stopRecording, addLog]);

  const startNewDialog = useCallback(() => {
    if (recordedUrl) { URL.revokeObjectURL(recordedUrl); setRecordedUrl(null); }
    setFinalDuration(null);
    connect();
  }, [connect, recordedUrl]);

  /* ─── Per-peer toggles ─── */
  const togglePeerAudio = useCallback((which: 1 | 2) => {
    const c = which === 1 ? client1Ref.current : client2Ref.current;
    if (!c) return;
    const next = !(which === 1 ? audio1Muted : audio2Muted);
    c.setCrossInputEnabled(!next);
    if (which === 1) setAudio1Muted(next); else setAudio2Muted(next);
    addLog(next ? `Партнёр ${which === 1 ? 'A' : 'B'} больше не слышит собеседника` : `Партнёр ${which === 1 ? 'A' : 'B'} снова слышит собеседника`, 'info');
  }, [addLog, audio1Muted, audio2Muted]);

  const togglePeerMic = useCallback((which: 1 | 2) => {
    const c = which === 1 ? client1Ref.current : client2Ref.current;
    if (!c) return;
    const next = !(which === 1 ? mic1Muted : mic2Muted);
    c.setMicMuted(next);
    if (which === 1) setMic1Muted(next); else setMic2Muted(next);
    addLog(next ? `Мой мик → ${which === 1 ? 'A' : 'B'} замьючен` : `Мой мик → ${which === 1 ? 'A' : 'B'} размьючен`, 'info');
  }, [addLog, mic1Muted, mic2Muted]);

  const togglePeerLags = useCallback((which: 1 | 2) => {
    const c = which === 1 ? client1Ref.current : client2Ref.current;
    if (!c) return;
    const next = !(which === 1 ? lags1 : lags2);
    c.setLags(next);
    if (which === 1) setLags1(next); else setLags2(next);
    addLog(next ? `Лаги → ${which === 1 ? 'A' : 'B'} включены` : `Лаги → ${which === 1 ? 'A' : 'B'} выключены`, 'warning');
  }, [addLog, lags1, lags2]);

  const disconnectPeer = useCallback((which: 1 | 2) => {
    const c = which === 1 ? client1Ref.current : client2Ref.current;
    c?.setLags(false); c?.setCrossInputEnabled(true); c?.disconnectPeer();
    if (which === 1) {
      setStream1(null); setAudio1Muted(false); setMic1Muted(false); setLags1(false);
      if (audioEl1.current) audioEl1.current.muted = false;
    } else {
      setStream2(null); setAudio2Muted(false); setMic2Muted(false); setLags2(false);
      if (audioEl2.current) audioEl2.current.muted = false;
    }
    addLog(`Собеседник ${which === 1 ? 'A' : 'B'} отключён`, 'warning');
  }, [addLog]);

  /* ─── Validation ─── */
  const t1valid = cfg1.token.length === 36;
  const t2valid = cfg2.token.length === 36;
  const tokensValid = t1valid && t2valid && cfg1.token !== cfg2.token;

  const applyPreset = (idx: number) => {
    setPresetIdx(idx);
    const { c1: nc1, c2: nc2 } = presetToConfigs(PRESETS[idx], cfg1.token, cfg2.token);
    setCfg1(nc1); setCfg2(nc2);
  };

  const onStart = useCallback(async () => {
    const ok = await enableMic();
    if (!ok) { setOverlay('mic-error'); return; }
    connect();
  }, [enableMic, connect]);

  /* ─── Peer-panel callbacks bound to the currently-open peer ─── */
  const peerWhich = peerPanel?.which ?? 1;
  const peerStatus = peerWhich === 1 ? status1 : status2;
  const peerMicMuted = peerWhich === 1 ? mic1Muted : mic2Muted;
  const peerAudioMuted = peerWhich === 1 ? audio1Muted : audio2Muted;
  const peerLags = peerWhich === 1 ? lags1 : lags2;
  const peerStats = peerWhich === 1 ? stats1 : stats2;

  /* ═══════════════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════════════ */
  return (
    <>
      <Background />
      <Header />
      <div className="app-container">

        {/* ─── WELCOME / START ───────────────────────────────────────── */}
        {screen === 'welcome' && (
          <div className="card-screen">
            <div style={{ fontSize: 36, color: 'var(--blue)', marginBottom: 10 }}>
              <i className="ph-fill ph-broadcast" />
            </div>
            <h1 className="title">forgotten · voice</h1>
            <p className="subtitle">
              Голосовая чат-рулетка <span className="accent">nekto.me</span> — две стороны, один MITM.
              <br />
              <span className="muted">
                Слежка, запись, лаги, реконнект — всё что было и чего не было.
              </span>
            </p>
            <button
              className="btn btn-primary btn-full"
              onClick={() => setScreen(cfg1.token && cfg2.token ? 'options' : 'token')}
            >
              ПРОДОЛЖИТЬ
              <i className="ph ph-arrow-right" />
            </button>
            <div className="creator-row">
              <a href="https://t.me/neuk2007" target="_blank" rel="noopener noreferrer">
                <i className="ph ph-telegram-logo" /> @neuk2007
              </a>
            </div>
          </div>
        )}

        {/* ─── TOKEN INPUT ──────────────────────────────────────────── */}
        {screen === 'token' && (
          <div className="card-screen">
            <h1 className="title small">Два токена</h1>
            <p className="subtitle">
              Нужны оба некто-токена (uuid4).{' '}
              <a href="https://t.me/neuk2007" target="_blank" rel="noopener noreferrer">
                Как получить?
              </a>
            </p>
            <div className="token-form">
              <div>
                <label className="field-label">Первый токен</label>
                <input
                  className="input mono"
                  type="text"
                  placeholder="00000000-0000-0000-0000-000000000000"
                  value={cfg1.token}
                  onChange={e => setCfg1({ ...cfg1, token: e.target.value.trim() })}
                />
              </div>
              <div>
                <label className="field-label">Второй токен</label>
                <input
                  className="input mono"
                  type="text"
                  placeholder="00000000-0000-0000-0000-000000000000"
                  value={cfg2.token}
                  onChange={e => setCfg2({ ...cfg2, token: e.target.value.trim() })}
                />
              </div>
            </div>
            {cfg1.token && cfg2.token && cfg1.token === cfg2.token && (
              <div className="token-error">
                <i className="ph ph-warning-circle" /> Токены должны быть разными.
              </div>
            )}
            <div className="btn-row">
              <button className="btn btn-ghost" onClick={() => setScreen('welcome')}>
                <i className="ph ph-arrow-left" />
                Назад
              </button>
              <button
                className="btn btn-primary"
                disabled={!tokensValid}
                onClick={() => setScreen('options')}
              >
                Дальше
                <i className="ph ph-arrow-right" />
              </button>
            </div>
          </div>
        )}

        {/* ─── OPTIONS ───────────────────────────────────────────────── */}
        {screen === 'options' && (
          <div className="card-screen">
            <h1 className="title small">Конфигурация</h1>
            <p className="subtitle">Выбери пресет и начни поиск.</p>

            {(() => {
              const h = new Date().getUTCHours();
              const isNight = h >= 22 || h < 6;
              if (!isNight) return null;
              return (
                <div className="token-error" style={{ color: 'var(--yellow)', borderColor: 'rgba(234,179,8,0.25)', background: 'rgba(234,179,8,0.08)' }}>
                  <i className="ph ph-moon" />{' '}
                  Ночью (22:00 – 6:00 UTC) активность низкая — поиск может быть долгим.
                </div>
              );
            })()}

            <div className="options-block">
              <span className="options-label">Пресет</span>
              <div className="options-grid">
                {PRESETS.map((p, i) => (
                  <button
                    key={p.name}
                    className={`config-btn ${i === presetIdx ? 'active' : ''} ${p.popular ? 'popular' : ''}`}
                    onClick={() => applyPreset(i)}
                  >
                    {p.hot && <span className="badge-hot">HOT</span>}
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="btn-row">
              <button className="btn btn-ghost" onClick={() => setScreen('token')}>
                <i className="ph ph-pencil-simple" />
                Токены
              </button>
              <button className="btn btn-success" onClick={onStart}>
                <i className="ph ph-magnifying-glass" />
                Начать
              </button>
            </div>
          </div>
        )}

        {/* ─── CALL ──────────────────────────────────────────────────── */}
        {screen === 'call' && (
          <>
            <TimerPill since={callStart} />
            <div className="card-screen call-screen">
              <h2 className="title small">в эфире</h2>
              <p className="subtitle">
                Нажми на партнёра, чтобы открыть управление.
              </p>

              <div className="call-header">
                <Participant
                  side="A"
                  status={status1}
                  stream={stream1}
                  micMuted={mic1Muted}
                  audioMuted={audio1Muted}
                  lags={lags1}
                  onOpen={() => setPeerPanel({ which: 1 })}
                />
                <Participant
                  side="B"
                  status={status2}
                  stream={stream2}
                  micMuted={mic2Muted}
                  audioMuted={audio2Muted}
                  lags={lags2}
                  onOpen={() => setPeerPanel({ which: 2 })}
                />
              </div>

              {/* Tiny stats row: RTT + packet loss when getStats has data */}
              {(stats1 || stats2) && (
                <div className="stats-row">
                  {stats1 && (
                    <span className={`stat-pill ${stats1.rttMs == null ? '' : stats1.rttMs < 80 ? 'good' : stats1.rttMs < 200 ? 'warn' : 'bad'}`}>
                      A RTT <span className="stat-num">{stats1.rttMs ?? '—'}</span>ms
                    </span>
                  )}
                  {stats2 && (
                    <span className={`stat-pill ${stats2.rttMs == null ? '' : stats2.rttMs < 80 ? 'good' : stats2.rttMs < 200 ? 'warn' : 'bad'}`}>
                      B RTT <span className="stat-num">{stats2.rttMs ?? '—'}</span>ms
                    </span>
                  )}
                </div>
              )}

              <div className="call-controls">
                <button
                  className="gear-btn"
                  onClick={() => setSettingsPanel(true)}
                  title="Настройки"
                >
                  <i className="ph ph-gear-six" />
                </button>
                <button
                  className={`mute-btn ${micMuted ? 'muted' : ''}`}
                  onClick={async () => { if (!micActive) await enableMic(); toggleMicMute(); }}
                  title={micActive ? (micMuted ? 'Включить микрофон' : 'Отключить микрофон') : 'Подключить и говорить'}
                >
                  <i className={`ph ${micMuted ? 'ph-microphone-slash' : 'ph-microphone'}`} />
                </button>
                <button className="btn btn-danger" onClick={endDialog} title="Закончить диалог">
                  <i className="ph ph-phone-x" />
                  Закончить
                </button>
              </div>

              <div className="rec-row">
                {isRecording && (
                  <button className="rec-pill rec-active" onClick={stopRecording} title="Остановить запись">
                    <span className="rec-dot" /> Запись · стоп
                  </button>
                )}
                {!isRecording && (stream1 || stream2) && !recordedUrl && (
                  <button className="rec-pill" onClick={startRecording} title="Начать запись">
                    <span className="rec-dot off" /> Записать
                  </button>
                )}
                {recordedUrl && (
                  <a href={recordedUrl} download="forgotten-dialog.webm" className="rec-pill">
                    <i className="ph ph-download-simple" /> Скачать
                  </a>
                )}
              </div>
            </div>
          </>
        )}

        {/* ─── END ───────────────────────────────────────────────────── */}
        {screen === 'end' && (
          <div className="card-screen">
            <div style={{ fontSize: 36, color: 'var(--text-dim)', marginBottom: 10 }}>
              <i className="ph ph-phone-x" />
            </div>
            <h1 className="title small">Конец диалога</h1>
            <p className="subtitle">
              {finalDuration && finalDuration !== '00:00'
                ? <>Диалог длился <span className="mono accent">{finalDuration}</span>.</>
                : <>Соединение завершилось досрочно.</>}
            </p>
            {recordedUrl && (
              <a href={recordedUrl} download="forgotten-dialog.webm" className="btn btn-warning btn-full" style={{ marginBottom: 10 }}>
                <i className="ph ph-download-simple" /> Скачать запись
              </a>
            )}
            <div className="btn-row">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  /* Revoke the recording blob URL before navigating away —
                     otherwise it accumulates over many call/end cycles. */
                  if (recordedUrl) { URL.revokeObjectURL(recordedUrl); setRecordedUrl(null); }
                  setFinalDuration(null);
                  disableMic();
                  setScreen('options');
                }}
              >
                <i className="ph ph-arrow-left" />
                Назад
              </button>
              <button className="btn btn-success" onClick={startNewDialog}>
                <i className="ph ph-magnifying-glass" />
                Новый
              </button>
            </div>
            <div className="creator-row" style={{ marginTop: 20 }}>
              Если было смешно — кидай откат в{' '}
              <a href="https://t.me/neuk2007" target="_blank" rel="noopener noreferrer">
                @neuk2007
              </a>
            </div>
          </div>
        )}
      </div>

      {/* ─── Per-peer float-panel ─────────────────────────────────────── */}
      {peerPanel && (
        <div className="panel-overlay" onClick={() => setPeerPanel(null)}>
          <div className="float-panel" onClick={e => e.stopPropagation()}>
            <div className="panel-handle" />
            <div className="panel-title">
              <i className="ph ph-user" />
              Партнёр {peerWhich === 1 ? 'A' : 'B'} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· {statusLabel[peerStatus]}</span>
            </div>

            <div className="panel-section">
              <div className="panel-grid">
                <button
                  className={`panel-btn ${peerMicMuted ? 'active' : ''}`}
                  onClick={() => togglePeerMic(peerWhich)}
                >
                  <i className={`ph ${peerMicMuted ? 'ph-microphone-slash' : 'ph-microphone'}`} />
                  {peerMicMuted ? 'Микрофон выкл.' : 'Микрофон вкл.'}
                </button>
                <button
                  className={`panel-btn ${peerAudioMuted ? 'active' : ''}`}
                  onClick={() => togglePeerAudio(peerWhich)}
                >
                  <i className={`ph ${peerAudioMuted ? 'ph-speaker-x' : 'ph-speaker-high'}`} />
                  {peerAudioMuted ? 'Глух' : 'Слышит'}
                </button>
              </div>
            </div>

            <div className="panel-section">
              <button
                className={`panel-btn ${peerLags ? 'active' : ''}`}
                onClick={() => togglePeerLags(peerWhich)}
                style={{ width: '100%', color: peerLags ? 'var(--orange)' : undefined }}
              >
                <i className="ph ph-waveform" />
                {peerLags ? 'Лаги вкл.' : 'Включить лаги'}
              </button>
            </div>

            {peerStats && (
              <div className="panel-section">
                <div className="stats-row" style={{ margin: 0 }}>
                  <span className={`stat-pill ${peerStats.rttMs == null ? '' : peerStats.rttMs < 80 ? 'good' : peerStats.rttMs < 200 ? 'warn' : 'bad'}`}>
                    RTT <span className="stat-num">{peerStats.rttMs ?? '—'}</span>ms
                  </span>
                  <span className="stat-pill">
                    LOSS <span className="stat-num">{peerStats.packetsLost}</span>
                  </span>
                  <span className="stat-pill">
                    BYTES <span className="stat-num">{Math.round((peerStats.bytesReceived + peerStats.bytesSent) / 1024)}</span>KB
                  </span>
                </div>
              </div>
            )}

            <div className="panel-section">
              <button
                className="panel-btn danger"
                onClick={() => { disconnectPeer(peerWhich); setPeerPanel(null); }}
                style={{ width: '100%' }}
              >
                <i className="ph ph-prohibit" />
                Отключить партнёра
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Settings float-panel (autoRestart / refind) ──────────────── */}
      {settingsPanel && (
        <div className="panel-overlay" onClick={() => setSettingsPanel(false)}>
          <div className="float-panel" onClick={e => e.stopPropagation()}>
            <div className="panel-handle" />
            <div className="panel-title">
              <i className="ph ph-gear-six" />
              Настройки
            </div>

            <div className="panel-section">
              <div className="panel-row">
                <span className="panel-row-label">Искать новый разговор автоматически</span>
                <label className="switch">
                  <input type="checkbox" checked={autoRestart} onChange={e => setAutoRestart(e.target.checked)} />
                  <span className="slider" />
                </label>
              </div>
              <div className="panel-row">
                <span className="panel-row-label">При отключении искать заново</span>
                <label className="switch">
                  <input type="checkbox" checked={refind} onChange={e => setRefind(e.target.checked)} />
                  <span className="slider" />
                </label>
              </div>
              <div className="panel-row">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                  <span className="panel-row-label" style={{ flex: 'none' }}>
                    Обход бана через .kz домен
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--muted, #6b7280)', lineHeight: 1.3 }}>
                    audio.nekto-me.kz — другая edge-нода. Подробности в IDEAS.md. Не всегда работает — включай если .me не пускает.
                  </span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={upstream === 'kz'}
                    onChange={e => setUpstream(e.target.checked ? 'kz' : 'me')}
                  />
                  <span className="slider" />
                </label>
              </div>
            </div>

            <div className="panel-section">
              <button
                className="panel-btn"
                style={{ width: '100%' }}
                onClick={() => setSettingsPanel(false)}
              >
                <i className="ph ph-check" />
                Готово
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Overlay errors ───────────────────────────────────────────── */}
      {overlay === 'mic-error' && (
        <div className="warning-overlay">
          <div className="warning-modal">
            <div className="warning-img"><i className="ph-fill ph-microphone-slash" /></div>
            <h2 className="title small">Микрофон запрещён</h2>
            <p className="warning-text">
              Ты отказал в доступе к микрофону. Без него нельзя вмешиваться в диалоги.
            </p>
            <div className="warning-actions">
              <button className="btn btn-ghost" onClick={() => setOverlay(null)}>Отмена</button>
              <button className="btn btn-danger" onClick={() => location.reload()}>
                <i className="ph ph-arrow-clockwise" />
                Перезагрузить
              </button>
            </div>
          </div>
        </div>
      )}

      {overlay === 'fail-token' && (
        <div className="warning-overlay">
          <div className="warning-modal">
            <div className="warning-img"><i className="ph-fill ph-prohibit" /></div>
            <h2 className="title small">Токены забанены</h2>
            <p className="warning-text">
              Токены забанены или нужна капча. Сделай новые в инкогнито.
            </p>
            <div className="warning-actions">
              <button className="btn btn-danger" onClick={() => location.reload()}>
                <i className="ph ph-arrow-clockwise" />
                Перезагрузить
              </button>
            </div>
          </div>
        </div>
      )}

      {overlay === 'waiting' && (
        <div className="warning-overlay">
          <div className="warning-modal">
            <div className="warning-img" style={{ color: 'var(--yellow)', background: 'rgba(234,179,8,0.1)' }}>
              <i className="ph-fill ph-hourglass" />
            </div>
            <h2 className="title small">Подожди</h2>
            <p className="warning-text">
              Чтобы токены не забанили за странную активность.
            </p>
            <div className="warning-actions">
              <button className="btn btn-ghost" onClick={() => { setOverlay(null); setScreen('options'); }}>
                <i className="ph ph-arrow-left" />
                Назад
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
