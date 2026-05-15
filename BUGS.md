# Аудит кода `версия-23-redesign` — баги и фиксы

Машинные проверки (`tsc --noEmit`, `npm run build`) проходили чисто и
**до**, и **после** правок — никаких type-errors / линт-варнингов
обнаружено не было. Все нижеперечисленные баги нашёл ручным review.

Бандл: 256.53 KB → 258.54 KB (gzip 77.66 → 78.07 KB).

| # | Где | Степень | Статус |
|---|-----|---------|--------|
| B1 | `nektoAudioClient.ts` `handleEvent → 'ban'` | **critical** | fixed |
| B2 | `App.tsx` — `autoRestart` / `refind` toggles | **high** | fixed |
| B3 | `App.tsx` `connect()` `onConnected` stale `callStart` | **high** | fixed |
| B4 | `App.tsx` "Назад" в end-screen — leak `recordedUrl` | **medium** | fixed |
| B5 | `App.tsx` `endDialog()` — не шлёт `stop-scan` | **medium** | fixed |
| B6 | `App.tsx` `setTimeout` в `connect()` — стрелки на труп | **medium** | fixed |
| B7 | `nektoAudioClient.ts` 4-сек watchdog — захват stale `pc` | **medium** | fixed |
| B8 | `nektoAudioClient.ts` `_reconnecting` clear через 100 мс | **medium** | fixed |
| B9 | `App.tsx` — overlay `fail-token` рендерится, но не триггерится | **medium** | fixed |
| B10 | `nektoAudioClient.ts` — `users-count` спам в консоль | low | fixed |
| B11 | `src/components/Glitch.tsx` — мёртвый код | cosmetic | deleted |

---

## B1 — Ban → бесконечный реконнект (CRITICAL)

**Симптом.** Сервер шлёт `event-message ban` (токен забанен) — клиент
ставит `status='error'`, но `_closed`/`_userEnded` остаются `false`. Через
несколько секунд сервер закрывает WebSocket (не код 1000), `ws.onclose`
вызывает `_scheduleReconnect()` → клиент пересоздаёт WS с тем же токеном
→ снова `ban` → снова реконнект… и так до бесконечности. В UI вообще
ничего не показывается — только status pill сменился на «ошибка».

**Причина.** Терминальный case `'ban'` не отмечал клиент как закрытый.

**Фикс.** `case 'ban'` теперь делает `_closed = true; _userEnded = true`
до того, как соединение порвётся, и явно закрывает WS кодом 1000. Плюс
добавлен опциональный callback `onBanned` — App-у можно подписаться и
показать overlay (см. B9).

```ts
case 'ban': {
  this._closed = true;
  this._userEnded = true;
  this._reconnecting = false;
  this.log(`ЗАБАНЕН: ${JSON.stringify(data.banInfo)}`, 'error');
  this.setStatus('error');
  this.callbacks.onBanned?.(data.banInfo);
  try { this.ws?.close(1000, 'banned'); } catch {}
  break;
}
```

---

## B2 — `autoRestart` / `refind` toggles ничего не делали (HIGH)

**Симптом.** В Settings float-panel есть два чекбокса
("Искать новый разговор автоматически", "При отключении искать заново").
Они меняли `useState`-значения, но **никуда дальше не уходили** — поведение
клиента было одинаковым независимо от их состояния. Регрессия от
переписки UI на demo-стиль: в предыдущей итерации они работали.

**Причина.** В предыдущей версии toggles читались внутри
`onDisconnected` / `endDialog`. После рефакторинга чтения остались, но
ни одна функция этих переменных не использовала.

**Фикс.** Логика переехала вниз — в `NektoAudioClient`:

```ts
// в NektoAudioClient
setAutoRestart(enabled: boolean) { this._autoRestart = enabled; }
setRefindOnReconnect(enabled: boolean) { this._refindOnReconnect = enabled; }

// case 'peer-disconnect':
if (this._autoRestart && this.searchParams && !this._userEnded && !this._closed) {
  setTimeout(() => this.startSearch(), 600);
}

// case 'registered' (after reconnect):
if (this.searchParams && (this._searchPending || this._refindOnReconnect)) {
  setTimeout(() => this.startSearch(), 500);
}
```

App-сторона:

```ts
useEffect(() => {
  client1Ref.current?.setAutoRestart(autoRestart);
  client2Ref.current?.setAutoRestart(autoRestart);
}, [autoRestart]);
// аналогично для refind
```

Теперь оба чекбокса честно меняют поведение в реальном времени, без
рестарта диалога.

---

## B3 — `callStart` stale-closure → таймер всегда от второго пира (HIGH)

**Симптом.** Полоса таймера в `.timer-pill` показывала длительность
**меньше** реального времени звонка. Похоже на ~1.5 с сдвиг (= задержка
между `c1.connect()` и `c2.connect()`).

**Причина.** Внутри `connect()`:

```ts
onConnected: () => { ... if (!callStart) setCallStart(Date.now()); }
```

`callStart` тут — захвачено в closure при последней мемоизации
`useCallback`. Когда оба пира коннектятся (с разницей ~1.5 с), оба
callback-а видят **один и тот же** `callStart === null` из closure, и
оба вызывают `setCallStart(...)`. Второй вызов перезаписывает первый.

**Фикс.** `callStartRef = useRef<number | null>(null)` зеркалит state,
плюс локальная функция `setCallStartOnce` внутри `connect()`:

```ts
const setCallStartOnce = () => {
  if (callStartRef.current == null) {
    const now = Date.now();
    callStartRef.current = now;
    setCallStart(now);
  }
};
// ...
onConnected: () => { addLog('Клиент 1 подключён', 'success'); setCallStartOnce(); }
```

Теперь таймер ставится строго при коннекте первого пира.

---

## B4 — Leak `recordedUrl` при "Назад" с end-screen (MEDIUM)

**Симптом.** После окончания диалога юзер жмёт "Назад" вместо "Новый
диалог" → переход на options → начинает новый звонок → старый blob от
прошлой записи остаётся в памяти (≈1-5 МБ за каждую запись). За много
циклов end → back → start накапливается заметный memory leak.

**Причина.** Кнопка "Назад" в end-screen вызывала `disableMic() +
setScreen('options')` и забывала про `URL.revokeObjectURL(recordedUrl)`
+ `setRecordedUrl(null)`. (Уборка была в `startNewDialog`, но не в
"Назад".)

**Фикс.**

```tsx
<button onClick={() => {
  if (recordedUrl) { URL.revokeObjectURL(recordedUrl); setRecordedUrl(null); }
  setFinalDuration(null);
  disableMic();
  setScreen('options');
}}>
```

---

## B5 — `endDialog()` оставлял `scan-for-peer` живым на сервере (MEDIUM)

**Симптом.** Юзер жмёт "Закончить" на этапе поиска (ещё ни один пир не
найден) → клиент уходит в end-screen, но сервер продолжает крутить
`scan-for-peer` и слать `users-count` (видно в консоли). Это может
задержать следующий звонок и зря грузит сервер.

**Причина.** `endDialog()` вызывал только `c.disconnectPeer()`, который
шлёт `peer-disconnect` **только если** `this.connectionId` уже выдан
(после `peer-connect`). На этапе поиска `connectionId` ещё `null` →
ничего на сервер не уходит → server-side scan продолжается.

**Фикс.**

```ts
c1?.stopSearch(); c2?.stopSearch();   // ← новое: отменяет server scan
c1?.disconnectPeer(); c2?.disconnectPeer();
```

---

## B6 — `setTimeout` в `connect()` стреляли в выброшенных клиентов (MEDIUM)

**Симптом.** Если юзер быстро жмёт "Закончить" → "Новый диалог" в
пределах 1.5–2.5 с после первого `connect()`, старые таймеры
`setTimeout(() => c2.connect(), 1500)` и
`setTimeout(() => startRecording(), 2500)` всё равно фаерили — на старых
NektoAudioClient-инстансах, которые уже были разрушены через `disconnect()`.
В итоге в логах появлялись лишние «WebSocket открыт» от мёртвых
клиентов, плюс `startRecording` пытался писать с уже остановленного
AudioContext.

**Причина.** Хэндлы таймеров никуда не сохранялись — отменить их было
нельзя.

**Фикс.** Все pending-таймеры теперь идут в
`pendingTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])`. Каждый
свежий `connect()` сначала чистит этот список:

```ts
pendingTimersRef.current.forEach(t => clearTimeout(t));
pendingTimersRef.current = [];
// ...
pendingTimersRef.current.push(
  setTimeout(() => { if (client2Ref.current === c2) c2.connect(); }, 1500),
);
pendingTimersRef.current.push(
  setTimeout(() => { if (!isRecordingRef.current) startRecording(); }, 2500),
);
```

Cleanup useEffect (unmount) тоже чистит этот список.

---

## B7 — 4-сек watchdog читал stale `this.pc` (MEDIUM)

**Симптом.** В редком сценарии (быстрый peer-disconnect → новый
peer-connect внутри 4 с) ложный реконнект на **здоровом** новом
RTCPeerConnection.

**Причина.** В `onconnectionstatechange` для state `'disconnected'`:

```ts
setTimeout(() => {
  if (this.pc && (this.pc.connectionState === 'disconnected' || 'failed')) {
    // tear down
  }
}, 4000);
```

`this.pc` тут — что было в `this` через 4 с, а не тот pc, который
дисконнектился. Если успели создать новый pc, проверка идёт по нему.

**Фикс.** Захват `pc` instance в момент scheduling + сравнение в
коллбэке:

```ts
const watchedPc = this.pc;
this._pcDisconnectWatchdog = setTimeout(() => {
  this._pcDisconnectWatchdog = null;
  if (this.pc !== watchedPc) return;            // ← новый pc, не наше дело
  if (this.pc && (...disconnected/failed)) { ... }
}, 4000);
```

Плюс одно поле `_pcDisconnectWatchdog: setTimeout | null` для отмены
при `_nukePeer` / `disconnect`.

---

## B8 — `_reconnecting` сбрасывался через 100 мс, а не на onopen/onclose (MEDIUM)

**Симптом.** В шторм-сценариях (быстрая последовательность
disconnect → fail → disconnect → ...) автореконнект мог "застрять": после
неудачной попытки больше не реконнектил.

**Причина.** В `_scheduleReconnect()`:

```ts
setTimeout(() => {
  this.connect();
  setTimeout(() => { this._reconnecting = false; }, 100);  // ←
}, delay);
```

Если новый WS успевал упасть **за** 100 мс (DNS-fail, refused-connection,
proxy-down), `ws.onclose` срабатывал когда `_reconnecting` ещё `true`. На
строке `if (!wasReconnecting) this._scheduleReconnect();` следующий
реконнект **не планировался** → цепочка обрывалась.

**Фикс.** Перенесли `this._reconnecting = false` в сами хэндлеры WS:

- `ws.onopen` — успех, цикл закончен → `false`.
- `ws.onclose` — даже если open не успел, новый scheduler по логике уже
  можно запустить → тоже сбрасываем `false` **до** проверки suppress-флагов.

Бонусом: 100-мс setTimeout больше не нужен — убран.

---

## B9 — Overlay `fail-token` / `waiting` рендерились, но не триггерились (MEDIUM)

**Симптом.** В render-блоке App-а есть полноэкранные overlay для
fail-token (баннер про забаненный токен) и waiting. Но `setOverlay` за всю
жизнь приложения вызывался **только** с `'mic-error'`. То есть юзер при
бане видел просто avatar.disconnected с лейблом "ошибка" и не понимал,
что случилось.

**Причина.** Не было сигнала из `NektoAudioClient` наверх.

**Фикс.** Добавлен опциональный callback `onBanned?: (banInfo: unknown)
=> void` в `AudioClientCallbacks`. App-сторона подписывается:

```ts
onBanned: () => setOverlay('fail-token'),
```

Теперь при бане сразу видно overlay с инструкциями и кнопкой
«Попробовать ещё раз».

---

## B10 — `users-count` спамил консоль (LOW)

**Симптом.** В консоли каждую секунду:
```
[forgotten] [38e1864e] ← users-count
[forgotten] [38e1864e] Онлайн: "..."
[forgotten] [38e1864e] ← users-count
[forgotten] [38e1864e] Онлайн: "..."
```
Заглушало настоящие события.

**Фикс.** Логгер запоминает последнее значение `count` и пишет в консоль
**только когда оно меняется**:

```ts
const current = data.count;
if (JSON.stringify(current) !== JSON.stringify(this._lastUsersCount)) {
  this._lastUsersCount = current;
  this.log(`Онлайн: ${JSON.stringify(current ?? '...')}`);
}
```

---

## B11 — `Glitch.tsx` — мёртвый код (COSMETIC)

`src/components/Glitch.tsx` экспортировал компонент, но он **нигде не
импортировался**. Плюс CSS-класс `.glitch`, на который он опирался, ушёл
вместе с заменой `style.min.css` на новый `index.css`. Файл удалён.

---

# Что НЕ менялось

- Архитектура двух `NektoAudioClient` (MITM) — без правок.
- Пресеты — без правок.
- Per-peer контекст-меню (ПКМ по аватарке) — без правок.
- WebRTC offer/answer/ICE handling — без правок.
- `MediaRecorder` запись — без правок.
- Resilience-флаги `_searchPending` / `_justReconnected` — логика
  оставлена, только пересобран event-flow вокруг них (B2/B8).
- Дизайн / палитра / шрифты / overlay-разметка — без правок.

# Известные ограничения (не баги, но к сведению)

- `addLog` пишет только в `console.*`, в UI лог нет (так задумано — на
  call-screen место занято визуализацией). Если нужно — можно
  пробросить лог в Settings panel за один вечер.
- `togglePeerLags` использует фиксированный период `setInterval` (5–55 мс),
  а не пере-рандомит на каждом тике. Звучит чуть менее «органично», чем в
  оригинале, но эффект «лагов» сохранён.
- `parseTurnParams` не понимает IPv6 TURN endpoints (`turn:[::1]:3478`).
  На практике у нектоши IPv4-only TURN, так что неактуально.
