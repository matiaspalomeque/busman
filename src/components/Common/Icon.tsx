/**
 * Centralised icon library. All inline SVGs across the app should reference
 * this component to avoid duplication and keep icon styles consistent.
 */

const SVG_ATTRS = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
};

// ─── Icon path definitions ────────────────────────────────────────────────────

function QueuePaths() {
  return (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="21" x2="9" y2="9" />
    </>
  );
}

function TopicPaths() {
  return (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  );
}

function SettingsPaths() {
  return (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  );
}

function RefreshPaths() {
  return (
    <>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </>
  );
}

function ChevronRightPaths() {
  return <polyline points="9 18 15 12 9 6" />;
}

function ServerPaths() {
  return (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M10 4v4" />
      <path d="M2 8h20" />
      <path d="M6 4v4" />
    </>
  );
}

function SunPaths() {
  return (
    <>
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </>
  );
}

function MoonPaths() {
  return <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />;
}

function EyePaths() {
  return (
    <>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </>
  );
}

function SearchPaths() {
  return (
    <>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>
  );
}

function MovePaths() {
  return (
    <>
      <polyline points="15 14 20 9 15 4" />
      <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
    </>
  );
}

function TrashPaths() {
  return (
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </>
  );
}

function BoxPaths() {
  return (
    <>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </>
  );
}

function ClosePaths() {
  return (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  );
}

function InfoPaths() {
  return (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </>
  );
}

function SendPaths() {
  return (
    <>
      <path d="M22 2L11 13" />
      <path d="M22 2L15 22 11 13 2 9l20-7z" />
    </>
  );
}

function ChevronDownPaths() {
  return <polyline points="6 9 12 15 18 9" />;
}

function LoaderPaths() {
  return <path d="M21 12a9 9 0 1 1-6.219-8.56" />;
}

function StarPaths() {
  return <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />;
}

function StarFilledPaths() {
  return <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor" />;
}

function PlusPaths() {
  return (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  );
}

function BellPaths() {
  return (
    <>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </>
  );
}

function BellFilledPaths() {
  return (
    <>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" fill="currentColor" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </>
  );
}

function AlertTrianglePaths() {
  return (
    <>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>
  );
}

// ─── Icon map ─────────────────────────────────────────────────────────────────

export type IconName =
  | "queue"
  | "topic"
  | "settings"
  | "refresh"
  | "chevronRight"
  | "chevronDown"
  | "server"
  | "sun"
  | "moon"
  | "eye"
  | "search"
  | "move"
  | "trash"
  | "box"
  | "close"
  | "info"
  | "send"
  | "loader"
  | "star"
  | "starFilled"
  | "plus"
  | "bell"
  | "bellFilled"
  | "alertTriangle";

const PATHS: Record<IconName, () => JSX.Element> = {
  queue: QueuePaths,
  topic: TopicPaths,
  settings: SettingsPaths,
  refresh: RefreshPaths,
  chevronRight: ChevronRightPaths,
  chevronDown: ChevronDownPaths,
  server: ServerPaths,
  sun: SunPaths,
  moon: MoonPaths,
  eye: EyePaths,
  search: SearchPaths,
  move: MovePaths,
  trash: TrashPaths,
  box: BoxPaths,
  close: ClosePaths,
  info: InfoPaths,
  send: SendPaths,
  loader: LoaderPaths,
  star: StarPaths,
  starFilled: StarFilledPaths,
  plus: PlusPaths,
  bell: BellPaths,
  bellFilled: BellFilledPaths,
  alertTriangle: AlertTrianglePaths,
};

// ─── Icon component ───────────────────────────────────────────────────────────

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 16, className }: IconProps) {
  const Paths = PATHS[name];
  return (
    <svg
      width={size}
      height={size}
      {...SVG_ATTRS}
      className={className}
    >
      <Paths />
    </svg>
  );
}
