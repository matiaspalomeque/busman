export interface ButtonGroupOption<T extends string | number> {
  value: T;
  label: string | React.ReactNode;
  title?: string;
  ariaLabel?: string;
}

export function ToggleSwitch({
  enabled,
  onToggle,
  ariaLabel,
}: {
  enabled: boolean;
  onToggle: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex h-11 w-11 items-center justify-center rounded-md focus:outline-none focus:ring-2 focus:ring-azure-primary/50 focus:ring-offset-1 dark:focus:ring-offset-zinc-900"
      role="switch"
      aria-checked={enabled}
      aria-label={ariaLabel}
    >
      <span className={["relative h-5 w-9 rounded-full transition-colors", enabled ? "bg-azure-primary" : "bg-zinc-300 dark:bg-zinc-600"].join(" ")}>
        <span
          className={[
            "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
            enabled ? "translate-x-4" : "",
          ].join(" ")}
        />
      </span>
    </button>
  );
}

export function ButtonGroup<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
  className,
}: {
  options: ButtonGroupOption<T>[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-disabled={disabled || undefined}
      className={[
        "flex items-center border border-zinc-300 dark:border-zinc-600 rounded overflow-hidden",
        disabled ? "opacity-40 pointer-events-none" : "",
        className ?? "",
      ].join(" ")}
    >
      {options.map((opt) => (
        <button
          type="button"
          disabled={disabled}
          key={String(opt.value)}
          onClick={() => {
            if (opt.value !== value) onChange(opt.value);
          }}
          className={[
            "px-1.5 py-1 text-[10px] transition-colors font-medium focus:outline-none focus:ring-2 focus:ring-inset focus:ring-azure-primary/40",
            value === opt.value
              ? "bg-azure-primary text-white"
              : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700",
          ].join(" ")}
          aria-pressed={value === opt.value}
          aria-label={opt.ariaLabel}
          title={opt.title}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
