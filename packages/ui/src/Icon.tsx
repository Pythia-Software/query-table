import type { ReactNode } from "react";

const artwork = {
  panelList: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M13 8h4M13 12h4M13 16h4" /></>,
  panelDefinition: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m10 9-3 3 3 3m4-6 3 3-3 3" /></>,
  panelReference: <><path d="M12 5v15M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z" /><path d="M6 8h3m6 0h3M6 12h3m6 0h3" /></>,
  panelPreview: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 16v-4m5 4V8m5 8v-6" /></>,
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  resize: <path d="m8 20 12-12m-6 12 6-6" />,
  alert: <><path d="m12 3 10 18H2Z" /><path d="M12 9v5m0 3v.1" /></>,
  add: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  check: <path d="m5 12 4.5 4.5L19 7" />,
  chevronDown: <path d="m5 8.5 7 7 7-7" />,
  chevronRight: <path d="m8.5 5 7 7-7 7" />,
  arrowUp: <path d="M12 19V5m-6 6 6-6 6 6" />,
  arrowDown: <path d="M12 5v14m-6-6 6 6 6-6" />,
  arrowLeft: <path d="M19 12H5m6-6-6 6 6 6" />,
  arrowRight: <path d="M5 12h14m-6-6 6 6-6 6" />,
  grip: <g fill="currentColor" stroke="none">{[5, 12, 19].map((y) => <g key={y}><circle cx="8" cy={y} r="1.5" /><circle cx="16" cy={y} r="1.5" /></g>)}</g>,
  pencil: <><path d="m14.5 5.5 4 4M4 20l1-5L16.5 3.5a2.8 2.8 0 0 1 4 4L9 19Z" /><path d="m5 15 4 4" /></>,
  star: <path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2-4.5-4.4 6.3-.9Z" />,
  undo: <><path d="M9 4 4 9l5 5" /><path d="M4 9h10a5 5 0 0 1 0 10" /></>,
  redo: <><path d="m15 4 5 5-5 5" /><path d="M20 9H10a5 5 0 0 0 0 10" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M5 16H4a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h10a1 1 0 0 1 1 1v1" /></>,
  share: <><path d="M12 15V3m-4 4 4-4 4 4" /><path d="M7 10H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2" /></>,
  refresh: <><path d="M20 4v5h-5M4 20v-5h5" /><path d="M20 9a8 8 0 0 0-13.5-3M4 15a8 8 0 0 0 13.5 3" /></>,
  stopwatch: <><circle cx="12" cy="14" r="8" /><path d="M9 2h6m-3 0v4m6 1 2-2M12 10v4l3-2" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  reset: <><path d="M4 4v5h5" /><path d="M4 9a8 8 0 1 1 0 6" /></>,
  bookmark: <path d="M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4-6 4Z" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof artwork;

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  filled?: boolean;
}

export function Icon({ name, size = 16, className, filled = false }: IconProps) {
  return (
    <svg className={`qt-icon${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 24 24" fill={filled && name === "star" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-icon={name}>
      {artwork[name]}
    </svg>
  );
}
