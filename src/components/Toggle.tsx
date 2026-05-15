/* Pill-style toggle switch */

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <div className="toggle-row" onClick={() => onChange(!checked)} style={{ cursor: 'pointer' }}>
      <span>{label}</span>
      <span
        className={`toggle ${checked ? 'on' : ''}`}
        role="switch"
        aria-checked={checked}
        tabIndex={0}
        onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            onChange(!checked);
          }
        }}
      />
    </div>
  );
}
