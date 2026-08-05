export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}

export function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="rama-toggle" onClick={() => onChange(!checked)}>
      <span className="rama-toggle-track">
        <span className="rama-toggle-thumb" />
      </span>
      {label ? <span className="rama-toggle-label">{label}</span> : null}
    </button>
  );
}
