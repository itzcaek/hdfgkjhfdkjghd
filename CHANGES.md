# версия-23-redesign — redesign + resilience port

Прошлая версия редизайна была на CSS из `forgotten - voice.html` (старый
forgotten-society.com). Новая версия — **на стиле Forgotten Demo** + порт
функций устойчивости из деобф'нного `index-app.js` демки в твой
`nektoAudioClient.ts`.

---

## 1. UI

### Палитра / типографика (из `index-C6MeN3n9.css` демки)

| token         | value                                               |
| ------------- | --------------------------------------------------- |
| `--bg`        | `#000`                                              |
| `--surface`   | `#08081099` (полупрозр. + backdrop-filter: blur 20) |
| `--text`      | `#c8c8dc`                                           |
| `--text-dim`  | `#5c5c78`                                           |
| `--white`     | `#eeeef8`                                           |
| `--blue`      | `#3b82f6`                                           |
| `--green`     | `#22c55e`                                           |
| `--red`       | `#ef4444`                                           |
| `--yellow`    | `#eab308`                                           |
| `--orange`    | `#f97316`                                           |
| `--radius`    | `16px`                                              |
| `--radius-sm` | `10px`                                              |

- **Шрифты:** Inter (тело) + JetBrains Mono (цифры таймера / RTT / loss)
- **Иконки:** Phosphor (`ph ph-*` regular / `ph-fill ph-*` fill) с CDN
  `@phosphor-icons/web@2.1.1` — заменил bootstrap-icons (`bi bi-*`).
- **Фон:** солидный `#000` + тройная radial-vignette (blue / green / red
  по углам, очень слабая). Старая `floating-nicks` анимация удалена.

### Экраны (5 вместо 8)

| было                                                        | стало                              |
| ----------------------------------------------------------- | ---------------------------------- |
| warning + welcome + checkToken + failToken                  | **welcome** + **token** (overlay)  |
| options                                                     | **options** (grid 2-кол, 9 пресет) |
| waiting + call                                              | **call** (waiting → overlay)       |
| end                                                         | **end**                            |
| mic-error фуллскрин                                         | **warning-overlay** (модалка)      |

### Новые компоненты в `src/App.tsx`

- **`<WaveBars>`** — 4 CSS-бара с staggered `animation-delay` (`bar-bounce`
  keyframes), реагируют на `MediaStream` через `AnalyserNode`. Заменил
  `<canvas>` + `getByteFrequencyData` (как в демке).
- **`<Participant>`** — круглая аватарка 72px с phosphor-иконкой внутри,
  side-label сверху (`ПАРТНЁР А` / `B`), wave-bars + статус снизу.
  Цвет авы зависит от статуса (`idle` / `searching` / `connected` /
  `disconnected` / `reconnecting`). Шейк-аватара когда `.lags` активны.
  Клик / правый клик / тап → `float-panel`.
- **`<TimerPill>`** — фиксированный pill сверху с count-up `MM:SS` +
  градиент-прогресс на фоне, цвет границы меняется на красный когда
  таймер < 2 мин.
- **`.float-panel`** — bottom-sheet на мобиле, поповер на десктопе.
  Per-peer (mute mic / mute sound / lags / disconnect + stats RTT / loss)
  и settings (autoRestart / refind через iOS-style switch).
- **`.warning-overlay`** — модалка для mic-error / fail-token / waiting.

### Сохранил

- MITM-схема (два `NektoAudioClient`, side `"A"` / `"B"`)
- per-client age / sex конфиг (теперь в options через пресеты)
- Запись через `MediaRecorder` (`.rec-pill` снизу)
- per-peer mute / sound / lags / disconnect (в float-panel)
- autoRestart / refind toggles (в settings float-panel)
- 9 пресетов (НЕКТО / ДЕВУШКА И ПАРЕНЬ / ... / PDF CATCHER)

### Удалил

- `style.min.css` + `header.css` overlays — теперь один `index.css`
- bootstrap-icons (`bi bi-*`) → Phosphor (`ph ph-*`)
- `<canvas>` AudioVisualizer → CSS wave-bars
- Floating nicks анимация
- Старый `<Glitch>` компонент

---

## 2. Resilience (порт из демки в `nektoAudioClient.ts`)

Все эти поля / методы взяты из деобф'нного `index-app.js` Forgotten Demo,
адаптированы под твой класс:

### Новые приватные поля

```ts
private _reconnecting = false;    // в процессе попытки переподключения
private _justReconnected = false; // первый registered после реконнекта — НЕ авто-search
private _closed = false;          // disconnect() был вызван, заглушаем reconnect
private _userEnded = false;       // пользователь нажал "Закончить"
private _searchPending = false;   // search() в полёте, ждём peer-pre-connect
private _searchN = 0;             // счётчик попыток search для backoff
private _backoff = 800;           // текущий backoff (ms), 800 → 1600 → ... → 10000
private _lastRecv = 0;            // timestamp последнего входящего сообщения
private _healthTimer?: number;    // watchdog таймер
private _iceStatsTimer?: number;  // getStats() семплинг
private _diagIv?: number;         // диагностический интервал (логирование статов)
```

### Что портировано

1. **Экспоненциальный backoff:** `_scheduleReconnect()` — `800ms → 10s
   cap`. Считаем количество попыток и сбрасываем при успешном
   `registered`.
2. **`onconnectionstatechange`** на `RTCPeerConnection` — форсим
   реконнект на `failed` / `disconnected`, шлём `closed` callback на
   `closed`. (Раньше у тебя был только `oniceconnectionstatechange` без
   реакции на `failed`.)
3. **`_iceStatsTimer`** — раз в 3с дёргаем `pc.getStats()`, вытаскиваем
   RTT (из `candidate-pair.currentRoundTripTime`), packet loss (`inbound-rtp.packetsLost`),
   bytes sent/received. Шлём через `onIceStats` callback во вью.
4. **`_healthTimer`** — раз в 5с проверяем `Date.now() - _lastRecv > 2*pingInterval + 5s`,
   если да — форсим реконнект (мёртвый WS, который не закрылся).
5. **Server-controlled `iceServers`** — больше **не хардкодим** STUN /
   TURN. Берём из ответа сервера на `peer-connect` (поле `iceServers`) +
   опционально `iceTransportPolicy: 'relay' | 'all'`. Если сервер
   прислал `turn-params` в середине сессии — пересоздаём `RTCPeerConnection`
   с новой policy.
6. **`_userEnded` / `_closed` гарды** — `disconnect()` ставит флаги
   ДО тирдауна WS. На `ws.onclose` если `event.code === 1000` или
   `_userEnded === true` — НЕ запускаем reconnect.
7. **`_justReconnected` гард в `handleEvent('registered')`** — после
   реконнекта сервер сам найдёт нам нового партнёра, не дёргаем `search`
   вручную (иначе двойной поиск → "вы заняты другим звонком").
8. **`onReconnecting` callback** — отдельный event "идёт реконнект" для
   UI, чтобы аватарка партнёра показала оранжевый `reconnecting` статус.

### Что НЕ менял

- API `connect(token)` / `disconnect()` / `search(filter)` / `mute()` —
  сигнатуры такие же, твоё `App.tsx` дёргает их 1-в-1 как раньше.
- WebRTC handshake (`createOffer` / `createAnswer` / candidate exchange) —
  оставил как было, только обернул в новые гарды.
- MediaRecorder, ping/pong, oniceconnectionstatechange — на месте.

---

## 3. Скриншоты

См. вложения к этому сообщению — сравни с демкой:

1. **welcome** — minimal cardscreen + Inter + phosphor `broadcast` иконка
2. **token** — 2 input'а с UPPERCASE field-label'ами
3. **options** — 9 пресетов в 2-кол grid, `НОТ` бейдж на втором, "Начать" зелёная
4. **call** — два participant с круглыми аватарками + wave-bars + статус
5. **peer-panel** — bottom-sheet с управлением партнёром
6. **settings-panel** — iOS-switch toggles для autoRestart/refind
7. **end** — call-х icon + кнопки "Назад" / "Новый" + скачать запись

---

## 4. Билд

```
$ npm run build
✓ 32 modules transformed.
dist/index.html  253.96 kB │ gzip: 77.31 kB
✓ built in 1.51s
```

TypeScript strict + `noUnusedLocals` + `noUnusedParameters` — без
warnings. Vite singlefile plugin запекает CSS + JS прямо в `index.html`
(один self-contained файл, как у демки).

---

## 5. Запуск

```bash
unzip versiya-23-redesign.zip
cd версия-23-redesign
npm install
npm run dev       # dev
npm run build     # prod build → dist/index.html (self-contained)
npm run preview   # preview prod build
```

Endpoint остался тот же: `wss://audio.nekto.me` (хардкод в
`nektoAudioClient.ts`, не менял).
