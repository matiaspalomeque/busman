export interface ButtonGroupOption<T extends string | number> {
  value: T;
  label: string | React.ReactNode;
  title?: string;
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
      className={[
        "relative h-[18px] w-8 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-azure-primary/40 focus:ring-offset-1 dark:focus:ring-offset-zinc-900",
        enabled ? "bg-azure-primary" : "bg-zinc-300 dark:bg-zinc-600",
      ].join(" ")}
      role="switch"
      aria-checked={enabled}
      aria-label={ariaLabel}
    >
      <span
        className={[
          "absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform",
          enabled ? "translate-x-3.5" : "",
        ].join(" ")}
      />
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
      className={[
        "flex items-center border border-zinc-300 dark:border-zinc-600 rounded overflow-hidden",
        disabled ? "opacity-40 pointer-events-none" : "",
        className ?? "",
      ].join(" ")}
    >
      {options.map((opt) => (
        <button
          type="button"
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
          title={opt.title}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
