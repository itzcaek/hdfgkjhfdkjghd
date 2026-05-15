/* Minimal top bar in the demo's monochrome style.
   Brand mark on the left, Telegram link on the right. */

export function Header() {
  return (
    <header className="app-header">
      <a
        href="https://t.me/forgotten_bio"
        target="_blank"
        rel="noopener noreferrer"
        className="brand"
      >
        <i className="ph-fill ph-broadcast" />
        FORGOTTEN · VOICE
      </a>
      <div className="right-slot">
        <a
          href="https://t.me/forgotten_bio"
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-ghost"
          style={{ padding: '6px 12px', fontSize: 12 }}
        >
          <i className="ph ph-telegram-logo" />
          Канал
        </a>
      </div>
    </header>
  );
}
