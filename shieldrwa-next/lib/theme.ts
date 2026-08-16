export const DARK = "#171314";
export const LINE = "#2A2325";
export const CREAM = "#F2E9DF";
export const MUTE = "#8E807C";
export const MAUVE = "#7F5461";
export const ROSE = "#C69AA6";
export const GOLD = "#C8A23C";
export const BODY = "#CBBFB9";

export const GREEN = "#5FA57C";
export const AMBER = "#C97A55";
export const RED = "#D64B3E";

export const FONT_SANS = "Archivo,Helvetica,Arial,sans-serif";
export const FONT_BLACK = "'Archivo Black',Archivo,sans-serif";
export const FONT_MONO = "'IBM Plex Mono',monospace";

export type Band = { max: number; label: string; color: string };

export const BANDS: Band[] = [
  { max: 25, label: "LOW", color: GREEN },
  { max: 50, label: "MEDIUM", color: GOLD },
  { max: 75, label: "HIGH", color: AMBER },
  { max: 101, label: "CRITICAL", color: RED },
];

export function band(v: number): Band {
  return BANDS.find((b) => v < b.max) || BANDS[3];
}

export function money(n: number): string {
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
