/**
 * Raw WebSocket client for nekto.me audio chat
 * Handles Socket.IO framing manually without socket.io-client library
 */

export type AudioStatus =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'authenticated'
  | 'searching'
  | 'ringing'
  | 'connected'
  | 'reconnecting'
  | 'error';

export interface IceStats {
  rttMs: number | null;
  packetsLost: number;
  bytesReceived: number;
  bytesSent: number;
  selectedCandidatePair: string | null;
}

export interface AudioSearchParams {
  sex: string;
  searchSex: string;
  ageFrom: number;
  ageTo: number;
  searchAgeFrom: number;
  searchAgeTo: number;
}

export interface AudioClientCallbacks {
  onStatusChange: (status: AudioStatus) => void;
  onLog: (msg: string, type: 'info' | 'success' | 'error' | 'warning') => void;
  onIncomingStream: (stream: MediaStream) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onIceStats?: (stats: IceStats) => void;
  onReconnecting?: () => void;
  /* Terminal: server banned this token. NektoAudioClient has flipped
     _closed/_userEnded to stop the reconnect loop; the host UI should
     surface the ban (e.g. show the fail-token overlay). */
  onBanned?: (banInfo: unknown) => void;
  /* Other peer voluntarily disconnected (server `peer-disconnect`).
     The WS is still open and the client is back to `authenticated`. */
  onPeerLeft?: () => void;
}

/**
 * Socket.IO over WebSocket framing:
 * 0{json} = Engine.IO OPEN
 * 2       = Engine.IO PING
 * 3       = Engine.IO PONG
 * 40      = Socket.IO CONNECT
 * 42[arr] = Socket.IO EVENT → 42["event_name", data]
 * 43[ack] = Socket.IO ACK
 */
export class NektoAudioClient {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private audioContext: AudioContext;
  private gainNode: GainNode;
  private outputDestination: MediaStreamAudioDestinationNode;
  public userId: string;
  public connectionId: string | null = null;
  public status: AudioStatus = 'disconnected';
  private crossInputStream: MediaStream | null = null;
  private searchParams: AudioSearchParams | null = null;
  private callbacks: AudioClientCallbacks;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micGain: GainNode | null = null;

  /* ────────────────────────────────────────────────────────────────────────
   * Resilience state (ported from the Forgotten Demo bundle).
   *
   * The demo distinguishes user-initiated disconnect (`_closed` / `_userEnded`)
   * from network-level disconnect: the former suppresses reconnect, the latter
   * triggers it. `_reconnecting` guards against re-entrant reconnects;
   * `_justReconnected` suppresses the auto-search immediately after a reconnect
   * so the user can re-select criteria first if they want.
   * ──────────────────────────────────────────────────────────────────────── */
  private _reconnecting = false;
  private _closed = false;
  private _userEnded = false;
  private _searchPending = false;
  private _searchN = 0;
  private _justReconnected = false;
  private _backoff = 800;       // ms — doubles each retry, caps at 10s
  private _lastRecv = Date.now();
  private _healthTimer: ReturnType<typeof setInterval> | null = null;
  private _statsIv: ReturnType<typeof setInterval> | null = null;
  private _pingMs = 25000;      // overridden by Engine.IO OPEN handshake
  private _serverIceServers: RTCIceServer[] = [];
  private _serverIceTransportPolicy: RTCIceTransportPolicy = 'all';

  /* User-facing toggles. autoRestart triggers a fresh startSearch() after
     the peer voluntarily disconnects; refindOnReconnect triggers one after
     a network-level reconnect. Both default to false so behaviour is
     unchanged unless the host explicitly enables them. */
  private _autoRestart = false;
  private _refindOnReconnect = false;
  private _lastUsersCount: unknown = undefined;
  /* Upstream selector — 'me' (default) or 'kz'. The proxy reads
     `?upstream=kz` and forwards to audio.nekto-me.kz instead of
     audio.nekto.me. Toggled from the React settings panel. */
  private _upstream: 'me' | 'kz' = 'me';
  /* Pending connectionId from the last successful peer-connect. Sent
     back as `peerSuccess` on the next register when reconnecting mid-call
     so the server preserves the pair instead of dropping us. */
  private _lastPeerConnectionId: string | null = null;
  /* set-fpt scheduled handle — cleared on disconnect/cleanup so a stale
     timer doesn't fire on a closed WS. */
  private _fptTimer: ReturnType<typeof setTimeout> | null = null;
  /* Last seen pc instance for the disconnected-watchdog timer — without
     this the 4 s timer would read whatever pc is current when it fires,
     even if it's a different RTCPeerConnection by then. */
  private _pcDisconnectWatchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(userId: string, callbacks: AudioClientCallbacks) {
    this.userId = userId;
    this.callbacks = callbacks;
    this.audioContext = new AudioContext();
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = 1.0;
    this.outputDestination = this.audioContext.createMediaStreamDestination();
    this.gainNode.connect(this.outputDestination);
  }

  get outputStream(): MediaStream {
    return this.outputDestination.stream;
  }

  private setStatus(s: AudioStatus) {
    this.status = s;
    this.callbacks.onStatusChange(s);
  }

  private log(msg: string, type: 'info' | 'success' | 'error' | 'warning' = 'info') {
    this.callbacks.onLog(`[${this.userId.slice(0, 8)}] ${msg}`, type);
  }

  setCrossInput(stream: MediaStream) {
    this.crossInputStream = stream;
  }

  setSearchParams(params: AudioSearchParams) {
    this.searchParams = params;
  }

  connect() {
    /* Drop any reconnect-suppress flags so a fresh user-initiated connect
       behaves like a clean start. Internal reconnect calls connect() too
       but goes through _reconnect() first which leaves _reconnecting=true. */
    if (!this._reconnecting) {
      this._closed = false;
      this._userEnded = false;
      this._searchPending = false;
      this._searchN = 0;
      this._justReconnected = false;
      this._backoff = 800;
    }
    this._lastRecv = Date.now();
    this.setStatus(this._reconnecting ? 'reconnecting' : 'connecting');

    // Connect to local proxy via raw WebSocket
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    /* Pass `upstream=kz` to ask the proxy to route to audio.nekto-me.kz
     instead of audio.nekto.me. Defaults to .me, never appended if unset
     so existing behaviour is unchanged. */
    const upstreamQs = this._upstream === 'kz' ? '&upstream=kz' : '';
    const proxyUrl = `${wsProto}//${window.location.host}/audio-ws?token=${encodeURIComponent(this.userId)}${upstreamQs}`;

    this.log(this._reconnecting ? 'Переподключение через прокси…' : 'Подключение через прокси…');
    this.ws = new WebSocket(proxyUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.log('WebSocket открыт', 'success');
      this.setStatus('authenticating');
      this._lastRecv = Date.now();
      /* Successful open resets backoff so subsequent disconnects start fresh */
      this._backoff = 800;
      /* Clearing _reconnecting on onopen (rather than via an arbitrary
         100 ms setTimeout) means a fresh open is what marks the reconnect
         cycle as settled — no race where a fast onclose runs while the
         flag is still set and skips _scheduleReconnect(). */
      this._reconnecting = false;
      this._startHealthTimer();
    };

    this.ws.onmessage = (event) => {
      this._lastRecv = Date.now();
      const msg = typeof event.data === 'string' ? event.data : '';
      if (!msg) return;
      this.handleRawMessage(msg);
    };

    this.ws.onclose = (event) => {
      this.log(`WebSocket закрыт: code=${event.code} reason=${event.reason}`, 'warning');
      this._stopHealthTimer();
      /* Clear _reconnecting here too — onclose may fire on a stalled WS
         where onopen never ran, and we want the next _scheduleReconnect()
         call to actually run. */
      this._reconnecting = false;
      this.cleanup();
      /* Code 1000 = normal closure (user-initiated). Anything else is a
         network/server problem and warrants an auto-reconnect — but only
         if the user hasn't explicitly disconnected. */
      if (!this._closed && !this._userEnded && event.code !== 1000) {
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.log('WebSocket ошибка! Прокси запущен? (node proxy.mjs)', 'error');
      if (!this._closed && !this._userEnded) {
        /* onerror is followed by onclose; let onclose drive the reconnect.
           Just surface the error to the UI here. */
        this.setStatus('error');
      }
    };
  }

  /* ─── Reconnect orchestration ─────────────────────────────────────────────
     Exponential backoff with a hard ceiling. On the demo this lives in the
     `_reconnect` method on the protocol class; we mirror the same shape so
     it's easy to compare back to the bundle (search for `_reconnecting`
     in cleaned/index-app.js). */
  private _scheduleReconnect() {
    if (this._reconnecting || this._closed) return;
    this._reconnecting = true;
    this._justReconnected = true;
    this.setStatus('reconnecting');
    this.callbacks.onReconnecting?.();
    const delay = Math.min(this._backoff, 10000);
    this.log(`Переподключение через ${delay} мс`, 'warning');
    this._backoff = Math.min(this._backoff * 2, 10000);
    setTimeout(() => {
      if (this._closed) { this._reconnecting = false; return; }
      /* connect() reuses the same userId/token. After WS re-opens, the
         register → web-agent handshake runs again. _reconnecting is
         cleared inside connect()'s onopen/onclose handlers, not here —
         so the flag accurately reflects whether the cycle has settled. */
      this.connect();
    }, delay);
  }

  /* ─── Health watchdog ────────────────────────────────────────────────────
     The server pings every ~25 s (Engine.IO pingInterval). If we go more
     than 2x that without receiving anything the proxy is almost certainly
     dead — force a reconnect rather than waiting for TCP to time out. */
  private _startHealthTimer() {
    this._stopHealthTimer();
    this._healthTimer = setInterval(() => {
      const idleMs = Date.now() - this._lastRecv;
      if (idleMs > this._pingMs * 2 + 5000) {
        this.log(`Health: no traffic for ${idleMs} ms — forcing reconnect`, 'warning');
        try { this.ws?.close(); } catch {}
        /* ws.onclose will fire and trigger _scheduleReconnect() */
      }
    }, 5000);
  }

  private _stopHealthTimer() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  /**
   * Parse raw Socket.IO / Engine.IO messages
   */
  private handleRawMessage(msg: string) {
    // Engine.IO OPEN: 0{json}
    if (msg.startsWith('0')) {
      const jsonStr = msg.slice(1);
      try {
        const handshake = JSON.parse(jsonStr);
        this.log(`Engine.IO open: pingInterval=${handshake.pingInterval} pingTimeout=${handshake.pingTimeout}`);
        /* Use the server-supplied ping interval to size our health watchdog
           — falls back to 25 s if missing. */
        if (typeof handshake.pingInterval === 'number' && handshake.pingInterval > 0) {
          this._pingMs = handshake.pingInterval;
        }
      } catch {}
      // Send Socket.IO CONNECT
      this.sendRaw('40');
      this.log('→ Socket.IO connect');
      return;
    }

    // Engine.IO PING from server (v3): "2"
    if (msg === '2') {
      this.sendRaw('3'); // PONG
      this.log('💓 Engine.IO ping → pong');
      return;
    }

    // Engine.IO PONG from server (v4): "3"
    if (msg === '3') {
      this.log('💓 Pong received');
      return;
    }

    // Socket.IO messages start with '4'
    if (msg.startsWith('4')) {
      const suffix = msg.slice(1);

      // Socket.IO CONNECT ACK: "40"
      if (suffix === '0' || suffix.startsWith('0')) {
        this.log('Socket.IO подключён', 'success');
        // Now send register
        this.sendRegister();
        return;
      }

      // Socket.IO EVENT: "42["event_name", data]"
      if (suffix.startsWith('2')) {
        try {
          const arr = JSON.parse(suffix.slice(1));
          const eventName = arr[0];
          const eventData = arr[1];
          if (eventName === 'event') {
            this.handleEvent(eventData);
          }
        } catch (e) {
          this.log(`Parse error: ${e}`, 'error');
        }
        return;
      }

      // Other Socket.IO packets
      this.log(`Socket.IO packet: 4${suffix.slice(0, 20)}`);
    }
  }

  /**
   * Send Socket.IO event via raw WebSocket
   * Format: 42["event_name", data]
   */
  private emit(eventName: string, data: any) {
    const packet = `42${JSON.stringify([eventName, data])}`;
    this.sendRaw(packet);
  }

  private sendRaw(data: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private sendRegister() {
    this.log('→ register');
    /* Build register payload. On a reconnect with a live peer, attach
       `peerSuccess` so the server keeps the pair alive (see nekto's
       `app.js:585` — without this the server treats reconnect as a
       new user and drops the call). */
    const payload: Record<string, unknown> = {
      type: 'register',
      android: false,
      version: 21,
      userId: this.userId,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow',
      locale: 'ru',
    };
    if (this._justReconnected && this._lastPeerConnectionId && this.pc) {
      const ice = this.pc.iceConnectionState;
      if (ice === 'connected' || ice === 'completed') {
        payload.peerSuccess = this._lastPeerConnectionId;
        this.log(`peerSuccess=${this._lastPeerConnectionId.slice(0, 8)} (resume)`, 'success');
      }
    }
    this.emit('event', payload);
  }

  /* ─── set-fpt (plain-text fingerprint) ──────────────────────────────────
     Nekto's web client sends a huge fingerprint blob 1-2 s after
     `registered`, normally AES-encrypted via `infoDataS`. The server
     ALSO accepts plain JSON via `infoData` (the encryption fallback
     branch in app.js:600-659). Sending even a minimal plain fingerprint
     moves us out of the "no-fingerprint bucket" — bots that don't send
     set-fpt get longer search queues, more captcha challenges, and a
     bigger bias toward soft bans. */
  private _sendFpt() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const stamp = Math.floor(Date.now() / 1000);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
    /* Minimal fingerprint payload — mirrors the field names nekto's
       setFpt() collects (useragent, tsp, los, lsh, isf, ref, deviceInfo).
       Values are all real (no spoofing) so the server can't catch a
       mismatch with the TLS-level fingerprint. */
    const components = {
      useragent: navigator.userAgent,
      tsp: stamp,
      los: location.origin,
      lsh: location.host,
      isf: window.top !== window.self,
      ref: document.referrer || null,
      symb: typeof Symbol !== 'undefined',
      isha: typeof performance !== 'undefined' && typeof performance.now === 'function',
      deviceInfo: {
        platform: navigator.platform,
        language: navigator.language,
        languages: Array.isArray(navigator.languages) ? navigator.languages.slice(0, 4) : [],
        hardwareConcurrency: navigator.hardwareConcurrency || 4,
        timezone: tz,
        screenWidth: window.screen?.width || 1920,
        screenHeight: window.screen?.height || 1080,
        pixelRatio: window.devicePixelRatio || 1,
      },
      visitorId: this.userId,
    };
    this.log('→ set-fpt (plain)');
    this.emit('event', {
      type: 'set-fpt',
      stamp,
      infoData: JSON.stringify(components),
    });
  }

  /* ─── Challenge handler ─────────────────────────────────────────────────
     If the server ever sends a `challenge` / `challenge-request` event, we
     reply with `challenge-ack` and (if proof is required) `challenge-proof`.
     The "proof" is just base64(challengeId:bucket:stamp:nonce).slice(0,96) —
     no HMAC, no PoW; nekto's client uses an AES-based checksum first then
     falls back to the same plain-text scheme on error (app.js:555-570).
     Responding (vs ignoring) keeps us out of the "unresponsive client"
     bucket and tends to shorten search times. */
  private _onChallenge(data: Record<string, unknown>) {
    const buckets = ['edge', 'mirror', 'pulse'];
    const stamp = Math.floor(Date.now() / 1000);
    const cid =
      (typeof data.challengeId === 'string' && data.challengeId) ||
      (typeof data.seed === 'string' && data.seed) ||
      this._uuid();
    const bucket = buckets[stamp % buckets.length];
    const checksum = btoa(`${cid}:${bucket}:${stamp}`).slice(0, 48);
    const base = {
      challengeId: cid,
      stamp,
      bucket,
      checksum,
      clientVersion: 24,
      signal: typeof data.signal === 'string' ? data.signal : null,
    };
    const mode = (typeof data.mode === 'string' && data.mode) || 'passive';
    this.log(`→ challenge-ack bucket=${bucket}`);
    this.emit('event', { type: 'challenge-ack', ...base, mode });
    if (data.proofRequired) {
      const nonce = this._uuid();
      const proof = btoa([cid, bucket, stamp, nonce].join(':')).slice(0, 96);
      this.log('→ challenge-proof');
      this.emit('event', {
        type: 'challenge-proof',
        ...base,
        proofNonce: nonce,
        proof,
        mode: typeof data.mode === 'string' ? data.mode : 'sync',
      });
    }
  }

  /* ─── Ping-results mock ─────────────────────────────────────────────────
     The server can ask the client to ping a list of IPs and report RTT.
     The real client measures actual latency; we hand back plausible synthetic
     values. The server cross-correlates RTT with public IP to detect VPNs /
     proxies — a no-response client looks more suspicious than a fake one. */
  private _onPingRequest(data: Record<string, unknown>) {
    const list = Array.isArray(data.list) ? (data.list as unknown[]) : [];
    const info = list
      .filter((h): h is string => typeof h === 'string')
      .slice(0, 16)
      .map((host) => {
        const min = 18 + Math.random() * 18;
        const avg = min + 4 + Math.random() * 12;
        const max = avg + 6 + Math.random() * 24;
        return { host, min: Math.round(min), avg: Math.round(avg), max: Math.round(max) };
      });
    this.log(`→ log-ping-results (${info.length} hosts, mocked)`);
    this.emit('event', { type: 'log-ping-results', info });
  }

  /* RFC4122 v4 UUID — used as fallback when the server doesn't supply a
     challengeId / seed. crypto.randomUUID exists everywhere we ship to. */
  private _uuid(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  private async handleEvent(data: any) {
    if (!data || typeof data !== 'object') {
      this.log(`Invalid event payload: ${JSON.stringify(data)}`, 'warning');
      return;
    }
    const type = data.type;
    const extra: string[] = [];
    if (data.initiator !== undefined) extra.push(`initiator=${data.initiator}`);
    if (data.connectionId) extra.push(`conn=${(data.connectionId as string).slice(0, 8)}`);
    this.log(`← ${type}${extra.length ? ' ' + extra.join(' ') : ''}`);

    switch (type) {
      case 'registered': {
        const internalId = data.internal_id;
        this.log(`Зарегистрирован (internal_id=${internalId})`, 'success');
        const webAgent = await this.generateWebAgent(internalId);
        this.log(`→ web-agent`);
        this.emit('event', { type: 'web-agent', data: webAgent });
        /* Send minimal plain-text set-fpt 1.5 s later — matches the timing
           nekto's web client uses (which gives its async fingerprint
           collectors time to resolve). Cancellable so disconnect()
           doesn't leave a stale fire. */
        if (this._fptTimer) clearTimeout(this._fptTimer);
        this._fptTimer = setTimeout(() => {
          this._fptTimer = null;
          this._sendFpt();
        }, 1500);
        /* After a reconnect we have searchParams already set. Behaviour:
           - fresh user-initiated connect: start search immediately.
           - reconnect AND (search was pending OR refind=on): resume search.
           - reconnect AND search wasn't pending AND refind=off: wait for
             user input — they may want to pick a new preset first. */
        if (this.searchParams && !this._justReconnected) {
          this.startSearch();
        } else if (this._justReconnected) {
          this._justReconnected = false;
          if (this.searchParams && (this._searchPending || this._refindOnReconnect)) {
            this._searchPending = false;
            this.log('Реконнект завершён, возобновляю поиск', 'success');
            setTimeout(() => this.startSearch(), 500);
          } else {
            this.log('Реконнект завершён, ожидаю команду на поиск', 'success');
            this.setStatus('authenticated');
          }
        } else {
          this.setStatus('authenticated');
        }
        break;
      }
      case 'users-count': {
        /* The server emits users-count every few seconds. Only log when
           the value actually changes — otherwise the console fills with
           identical lines and hides real events. */
        const current = data.count;
        if (JSON.stringify(current) !== JSON.stringify(this._lastUsersCount)) {
          this._lastUsersCount = current;
          this.log(`Онлайн: ${JSON.stringify(current ?? '...')}`);
        }
        break;
      }
      case 'search.success': {
        this.log('Поиск начат, ожидание собеседника…', 'success');
        this.setStatus('searching');
        break;
      }
      case 'turn-params': {
        /* Server can hand us a fresh TURN list mid-session (e.g. after a
           policy change). Cache it so the next peer-connect picks it up. */
        const turnConfig = this.parseTurnParams(data.turnParams);
        this._serverIceServers = turnConfig.iceServers ?? this._serverIceServers;
        if (data.iceTransportPolicy === 'relay' || data.iceTransportPolicy === 'all') {
          this._serverIceTransportPolicy = data.iceTransportPolicy;
        }
        this.log(`Сервер обновил TURN: ${this._serverIceServers.length} серверов, policy=${this._serverIceTransportPolicy}`);
        break;
      }
      case 'peer-connect': {
        this.connectionId = data.connectionId;
        /* Remember this so subsequent register-on-reconnect can ask
           the server to keep the pair via peerSuccess. */
        this._lastPeerConnectionId = data.connectionId;
        this._searchPending = false;
        this.log(`peer-connect! conn=${this.connectionId}`, 'success');
        /* Server can override iceServers and policy in newer payloads.
           parseTurnParams handles the legacy `turnParams` string format;
           we also check for fresh `iceServers` + `iceTransportPolicy`. */
        const turnConfig = this.parseTurnParams(data.turnParams);
        if (Array.isArray(data.iceServers) && data.iceServers.length) {
          turnConfig.iceServers = data.iceServers as RTCIceServer[];
        }
        if (data.iceTransportPolicy === 'relay' || data.iceTransportPolicy === 'all') {
          this._serverIceTransportPolicy = data.iceTransportPolicy;
        }
        this._serverIceServers = turnConfig.iceServers ?? [];
        this.setupPeerConnection(turnConfig, data.initiator);
        break;
      }
      case 'offer': {
        this.log('← SDP Offer');
        await this.handleOffer(data.offer);
        break;
      }
      case 'answer': {
        this.log('← SDP Answer');
        await this.handleAnswer(data.answer);
        break;
      }
      case 'ice-candidate': {
        await this.handleIceCandidate(data.candidate);
        break;
      }
      case 'peer-connection': {
        this.log('WebRTC подтверждено', 'success');
        break;
      }
      case 'stream-received': {
        this.log('Аудиопоток получен');
        break;
      }
      case 'peer-mute': {
        this.log(`Mute: ${data.muted}`);
        break;
      }
      case 'peer-disconnect': {
        this.log('Собеседник отключился', 'warning');
        /* Pair is over for good — drop the cached peerSuccess so a later
           reconnect doesn't ask the server to resume a dead call. */
        this._lastPeerConnectionId = null;
        this.callbacks.onDisconnected();
        this.cleanup();
        this.callbacks.onPeerLeft?.();
        /* autoRestart: server says other side left → look for another
           peer right away, with a small delay so the WS settles. */
        if (this._autoRestart && this.searchParams && !this._userEnded && !this._closed) {
          this.log('Автопоиск нового собеседника…', 'info');
          setTimeout(() => this.startSearch(), 600);
        }
        break;
      }
      case 'stop-scan': {
        this.log('Поиск остановлен', 'warning');
        this.setStatus('authenticated');
        this.callbacks.onDisconnected();
        break;
      }
      case 'error': {
        this.log(`Ошибка: ${data.description || data.id || JSON.stringify(data)}`, 'error');
        break;
      }
      case 'challenge':
      case 'challenge-request':
      case 'challenge-sync': {
        this._onChallenge(data as Record<string, unknown>);
        break;
      }
      case 'ping':
      case 'ping-request': {
        this._onPingRequest(data as Record<string, unknown>);
        break;
      }
      case 'ban': {
        /* Terminal — flip the suppress-reconnect flags BEFORE the WS gets
           torn down by the server so the onclose handler doesn't kick off
           an infinite retry loop on a banned token. */
        this._closed = true;
        this._userEnded = true;
        this._reconnecting = false;
        this.log(`ЗАБАНЕН: ${JSON.stringify(data.banInfo)}`, 'error');
        this.setStatus('error');
        this.callbacks.onBanned?.(data.banInfo);
        /* Close the WS explicitly with 1000 so onclose treats it as user-
           initiated and doesn't try to schedule a reconnect. */
        try { this.ws?.close(1000, 'banned'); } catch {}
        break;
      }
      default: {
        this.log(`Событие: ${type}`);
      }
    }
  }

  private async generateWebAgent(internalId: string): Promise<string> {
    const payload = this.userId + 'BYdKPTYYGZ7ALwA' + '8oNm2' + String(internalId);
    const encoded = new TextEncoder().encode(payload);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    const hexHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return btoa(hexHash);
  }

  startSearch() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.searchParams) return;
    this.setStatus('searching');
    this._searchPending = true;
    this._searchN++;
    const p = this.searchParams;
    this.emit('event', {
      type: 'scan-for-peer',
      peerToPeer: true,
      token: null,
      searchCriteria: {
        group: 0,
        userSex: p.sex || 'ANY',
        peerSex: p.searchSex || 'ANY',
        userAge: { from: p.ageFrom, to: p.ageTo },
        peerAges: [{ from: p.searchAgeFrom, to: p.searchAgeTo }],
      },
    });
    this.log(`→ scan-for-peer #${this._searchN} (${p.sex}→${p.searchSex})`);
  }

  stopSearch() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.log('→ stop-scan');
      this.emit('event', { type: 'stop-scan' });
    }
  }

  private parseTurnParams(turnParams: unknown): RTCConfiguration {
    try {
      const parsed = typeof turnParams === 'string' ? JSON.parse(turnParams) : turnParams;
      const iceServers: RTCIceServer[] = [];
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry.url && !entry.url.startsWith('turn:[')) {
            iceServers.push({
              urls: entry.url,
              username: entry.username || '',
              credential: entry.credential || ''
            });
          }
        }
      }
      return { iceServers };
    } catch {
      return { iceServers: [] };
    }
  }

  private setupPeerConnection(config: RTCConfiguration, initiator: boolean) {
    this.pc = new RTCPeerConnection({
      ...config,
      iceServers: config.iceServers?.length ? config.iceServers : [
        { urls: 'stun:stun-bvp.nekto.me' },
        { urls: 'stun:stun-vky.nekto.me' },
        { urls: 'stun:stun-fvs.nekto.me' },
      ],
      iceTransportPolicy: this._serverIceTransportPolicy,
    });
    this.log(`PC создан: iceServers=${(config.iceServers ?? []).length} policy=${this._serverIceTransportPolicy}`);
    this.setStatus('ringing');
    this._startStatsTimer();

    this.pc.ontrack = (event) => {
      this.log('Получен аудиотрек!', 'success');
      try {
        const source = this.audioContext.createMediaStreamSource(event.streams[0]);
        source.connect(this.gainNode);
      } catch (e) {
        this.log(`Audio route error: ${e}`, 'error');
      }
      this.emit('event', { type: 'stream-received', connectionId: this.connectionId });
      this.callbacks.onIncomingStream(event.streams[0]);
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.emit('event', {
          type: 'ice-candidate',
          candidate: JSON.stringify({
            candidate: {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid ?? 0,
              sdpMLineIndex: event.candidate.sdpMLineIndex ?? 0,
            },
          }),
          connectionId: this.connectionId,
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc!.connectionState;
      this.log(`WebRTC: ${state}`);
      if (state === 'connected') {
        this.emit('event', {
          type: 'peer-connection',
          connectionId: this.connectionId,
          connection: true
        });
        this.setStatus('connected');
        this.callbacks.onConnected();
      } else if (state === 'failed') {
        /* WebRTC went bust — usually means the peer's network dropped or our
           TURN relay died. Tear the PC down and (if the user hasn't ended)
           force a reconnect through the WS path so we get a fresh peer. */
        this.log('WebRTC failed — попытка переподключения', 'error');
        this.callbacks.onDisconnected();
        this._stopStatsTimer();
        this._nukePeer();
        if (!this._userEnded && !this._closed) {
          /* Bounce the WS so the server re-issues turnParams + a fresh peer */
          try { this.ws?.close(); } catch {}
        }
      } else if (state === 'disconnected') {
        /* Transient — give it a moment to recover before tearing down.
           Capture the current pc instance so we don't act on a different
           one if the watchdog fires after the user has already restarted. */
        this.log('WebRTC disconnected — жду восстановления', 'warning');
        const watchedPc = this.pc;
        if (this._pcDisconnectWatchdog) clearTimeout(this._pcDisconnectWatchdog);
        this._pcDisconnectWatchdog = setTimeout(() => {
          this._pcDisconnectWatchdog = null;
          if (this.pc !== watchedPc) return;
          if (this.pc && (this.pc.connectionState === 'disconnected' || this.pc.connectionState === 'failed')) {
            this.log('WebRTC не восстановился — реконнект', 'error');
            this.callbacks.onDisconnected();
            this._stopStatsTimer();
            this._nukePeer();
            if (!this._userEnded && !this._closed) {
              try { this.ws?.close(); } catch {}
            }
          }
        }, 4000);
      } else if (state === 'closed') {
        this.log('WebRTC closed', 'warning');
        this.callbacks.onDisconnected();
        this._stopStatsTimer();
        this.cleanup();
      }
    };

    if (initiator) {
      this.log('Я инициатор — создаю Offer');
      const inputStream = this.crossInputStream || this.createSilentStream();
      const audioTracks = inputStream.getAudioTracks();
      if (audioTracks.length > 0) {
        this.pc.addTrack(audioTracks[0], inputStream);
        this.log('Кросс-трек добавлен');
      }
      this.pc.createOffer()
        .then((offer) => this.pc!.setLocalDescription(offer))
        .then(() => {
          const ld = this.pc!.localDescription!;
          this.emit('event', {
            type: 'offer',
            offer: JSON.stringify({ sdp: ld.sdp, type: ld.type }),
            connectionId: this.connectionId
          });
          this.emit('event', {
            type: 'peer-mute',
            connectionId: this.connectionId,
            muted: false
          });
          this.log('→ Offer отправлен');
        })
        .catch((e) => this.log(`Offer error: ${e}`, 'error'));
    }
  }

  private async handleOffer(offerStr: string) {
    if (!this.pc) return this.log('No PC for offer!', 'error');
    try {
      const offer = JSON.parse(offerStr);
      await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
      const inputStream = this.crossInputStream || this.createSilentStream();
      const audioTracks = inputStream.getAudioTracks();
      if (audioTracks.length > 0) {
        this.pc.addTrack(audioTracks[0], inputStream);
        this.log('Кросс-трек (answerer)');
      }
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.emit('event', {
        type: 'answer',
        answer: JSON.stringify({ sdp: answer.sdp, type: answer.type }),
        connectionId: this.connectionId
      });
      this.log('→ Answer отправлен');
    } catch (e) {
      this.log(`handleOffer: ${e}`, 'error');
    }
  }

  private async handleAnswer(answerStr: string) {
    if (!this.pc) return;
    try {
      const answer = JSON.parse(answerStr);
      await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
      this.log('Remote SDP установлен');
    } catch (e) {
      this.log(`handleAnswer: ${e}`, 'error');
    }
  }

  private async handleIceCandidate(candidateStr: string) {
    if (!this.pc) return;
    try {
      const outer = JSON.parse(candidateStr);
      const inner = outer.candidate;
      await this.pc.addIceCandidate(new RTCIceCandidate({
        candidate: inner.candidate,
        sdpMid: String(inner.sdpMid ?? 0),
        sdpMLineIndex: inner.sdpMLineIndex ?? 0,
      }));
    } catch (e) {
      this.log(`ICE: ${e}`, 'error');
    }
  }

  private createSilentStream(): MediaStream {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    osc.connect(dest);
    osc.start();
    dest.stream.getAudioTracks()[0].enabled = false;
    return dest.stream;
  }

  disconnectPeer() {
    if (this.ws?.readyState === WebSocket.OPEN && this.connectionId) {
      this.log('→ peer-disconnect');
      this.emit('event', { type: 'peer-disconnect', connectionId: this.connectionId });
    }
    this.cleanup();
  }

  private cleanup() {
    /* Always clear the lags interval — cleanup() runs on peer-disconnect,
       ws.onclose, and onconnectionstatechange in addition to explicit
       disconnect(), so leaving the interval running would keep mutating
       gainNode.gain.value at high frequency long after the peer is gone. */
    if (this.lagsInterval) {
      clearInterval(this.lagsInterval);
      this.lagsInterval = null;
      this.gainNode.gain.value = 1.0;
    }
    this._stopStatsTimer();
    this._nukePeer();
    if (this.status !== 'error') {
      this.setStatus(this.ws?.readyState === WebSocket.OPEN ? 'authenticated' : 'disconnected');
    }
  }

  /* Internal: tear down the RTCPeerConnection without touching status. */
  private _nukePeer() {
    if (this._pcDisconnectWatchdog) {
      clearTimeout(this._pcDisconnectWatchdog);
      this._pcDisconnectWatchdog = null;
    }
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      try { this.pc.close(); } catch {}
      this.pc = null;
    }
    this.connectionId = null;
  }

  /* ─── ICE stats sampler ──────────────────────────────────────────────────
     Mirrors the demo's `_iceStatsTimer`: sample pc.getStats() every 3 s,
     extract the active candidate pair + remote-inbound RTT + packet loss,
     and surface to the UI via the onIceStats callback. Useful for showing
     a live "signal strength" indicator and for triggering a reconnect when
     the link visibly degrades. */
  private _startStatsTimer() {
    this._stopStatsTimer();
    if (!this.callbacks.onIceStats) return;
    this._statsIv = setInterval(async () => {
      if (!this.pc) return;
      try {
        const report = await this.pc.getStats();
        let rttMs: number | null = null;
        let packetsLost = 0;
        let bytesReceived = 0;
        let bytesSent = 0;
        let selectedCandidatePair: string | null = null;
        report.forEach((r) => {
          if (r.type === 'candidate-pair' && (r as RTCIceCandidatePairStats).nominated && (r as RTCIceCandidatePairStats).state === 'succeeded') {
            const cp = r as RTCIceCandidatePairStats;
            if (typeof cp.currentRoundTripTime === 'number') {
              rttMs = Math.round(cp.currentRoundTripTime * 1000);
            }
            selectedCandidatePair = `${cp.localCandidateId} → ${cp.remoteCandidateId}`;
          }
          if (r.type === 'inbound-rtp' && (r as RTCInboundRtpStreamStats).kind === 'audio') {
            const ir = r as RTCInboundRtpStreamStats;
            packetsLost += ir.packetsLost ?? 0;
            bytesReceived += ir.bytesReceived ?? 0;
          }
          if (r.type === 'outbound-rtp' && (r as RTCOutboundRtpStreamStats).kind === 'audio') {
            bytesSent += (r as RTCOutboundRtpStreamStats).bytesSent ?? 0;
          }
        });
        this.callbacks.onIceStats?.({ rttMs, packetsLost, bytesReceived, bytesSent, selectedCandidatePair });
      } catch {
        /* getStats can throw if the PC was just closed — ignore */
      }
    }, 3000);
  }

  private _stopStatsTimer() {
    if (this._statsIv) {
      clearInterval(this._statsIv);
      this._statsIv = null;
    }
  }

  /**
   * Add microphone input — mixes your voice into the output stream
   * so BOTH strangers hear you through the cross-routing.
   */
  addMicSource(stream: MediaStream) {
    try {
      this.micGain = this.audioContext.createGain();
      this.micGain.gain.value = 1.0;
      this.micSource = this.audioContext.createMediaStreamSource(stream);
      this.micSource.connect(this.micGain);
      this.micGain.connect(this.outputDestination);
    } catch (e) {
      console.error('[NektoAudioClient] mic source error:', e);
    }
  }

  removeMicSource() {
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }
    if (this.micGain) {
      this.micGain.disconnect();
      this.micGain = null;
    }
  }

  setMicMuted(muted: boolean) {
    if (this.micGain) {
      this.micGain.gain.value = muted ? 0 : 1.0;
    }
  }

  /**
   * Deafen this peer — disables the audio track that goes out via WebRTC
   * to them. Mirrors the toggleSound handler from the original
   * ForgottenSociety client (`this.input.stream.getTracks()[0].enabled = !`).
   * The peer will hear silence; the other side's mic stream is unaffected.
   */
  setCrossInputEnabled(enabled: boolean) {
    if (!this.crossInputStream) return;
    const track = this.crossInputStream.getAudioTracks()[0];
    if (track) track.enabled = enabled;
  }

  /**
   * Lag injection: randomly oscillates the outgoing gain between 0 and 1
   * at a random sub-50ms cadence, so the peer hears choppy, glitchy audio.
   * Mirrors the toggleLags handler from the original ForgottenSociety client.
   */
  private lagsInterval: ReturnType<typeof setInterval> | null = null;
  setLags(enabled: boolean) {
    if (enabled) {
      if (this.lagsInterval) return;
      const period = Math.max(5, Math.floor(Math.random() * 50));
      this.lagsInterval = setInterval(() => {
        this.gainNode.gain.value = Math.floor(Math.random() * 2);
      }, period);
    } else {
      if (this.lagsInterval) {
        clearInterval(this.lagsInterval);
        this.lagsInterval = null;
      }
      this.gainNode.gain.value = 1.0;
    }
  }

  /* ─── User toggles (autoRestart / refind) ────────────────────────────────
     The host React app reflects checkbox state into these methods. Both
     default off; the host must opt in. Calling with the same value twice
     is a no-op. */
  setAutoRestart(enabled: boolean) { this._autoRestart = enabled; }
  setRefindOnReconnect(enabled: boolean) { this._refindOnReconnect = enabled; }
  /* Upstream selector. 'kz' routes through audio.nekto-me.kz (different
     edge node, often a different IP banlist); 'me' is the default. Takes
     effect on the next connect() — does not move an open WS. */
  setUpstream(upstream: 'me' | 'kz') { this._upstream = upstream; }
  getUpstream(): 'me' | 'kz' { return this._upstream; }

  disconnect() {
    /* User-initiated terminal close — flip the flags BEFORE we tear the WS
       down so onclose doesn't trigger a reconnect race. */
    this._closed = true;
    this._userEnded = true;
    this._reconnecting = false;
    this._stopHealthTimer();
    this._stopStatsTimer();
    if (this._pcDisconnectWatchdog) { clearTimeout(this._pcDisconnectWatchdog); this._pcDisconnectWatchdog = null; }
    if (this._fptTimer) { clearTimeout(this._fptTimer); this._fptTimer = null; }
    if (this.lagsInterval) { clearInterval(this.lagsInterval); this.lagsInterval = null; }
    this.removeMicSource();
    this.cleanup();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000, 'user');
      this.ws = null;
    }
    this.audioContext.close().catch(() => {});
    this.setStatus('disconnected');
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
