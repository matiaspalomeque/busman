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
      onClick={onToggle}
      className={[
        "relative w-8 h-[18px] rounded-full transition-colors",
        enabled ? "bg-azure-primary" : "bg-zinc-300 dark:bg-zinc-600",
      ].join(" ")}
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
          key={String(opt.value)}
          onClick={() => {
            if (opt.value !== value) onChange(opt.value);
          }}
          className={[
            "px-1.5 py-1 text-[10px] transition-colors font-medium",
            value === opt.value
              ? "bg-azure-primary text-white"
              : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700",
          ].join(" ")}
          title={opt.title}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
