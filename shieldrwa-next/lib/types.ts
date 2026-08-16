import type { CSSProperties } from "react";

export type ViewId = "landing" | "onboard" | "dashboard" | "policy" | "proof";

export type Posture = "Conservative" | "Balanced" | "Aggressive";

export type LimitKey =
  | "drawdown"
  | "exposure"
  | "liquidity"
  | "stable"
  | "mode";

export type Limits = Record<LimitKey, string>;

export type FeedItem = { text: string; time: string; c: string };

export type HistoryItem = {
  time: string;
  action: string;
  reason: string;
  amount: string;
  before: number;
  after: number;
  tx: string;
};

export type NavItem = {
  label: string;
  id: ViewId;
  go: () => void;
  ul: string;
  fg: string;
};

export type CtaCard = {
  n: string;
  arrow: string;
  size: string;
  rule: string;
  title: string;
  body: string;
  fg: string;
  go: () => void;
};

export type SpineNode = {
  n: string;
  title: string;
  status: string;
  fg: string;
  statusC: string;
  bar: string;
  dot: string;
  anim: CSSProperties["animation"];
};

export type MeterCell = { h: string; c: string };
export type ForecastCell = { h: string; c: string; o: string };

export type Signal = {
  label: string;
  note: string;
  value: string;
  color: string;
  w: string;
};

export type Factor = { label: string; pct: string; w: string; c: string };

export type Analyst = {
  confidence: string;
  factors: Factor[];
  reasoning: string;
  action: string;
};

export type Guardian = {
  fg: string;
  text: string;
  checks: { k: string; v: string; c: string }[];
  decision: string;
};

export type OnboardStep = {
  n: string;
  status: string;
  statusC: string;
  title: string;
  fg: string;
  titleC: string;
  rule: string;
  body: string;
  rows: { k: string; v: string }[];
  cta: string;
  btnFg: string;
  action: () => void;
};

export type PostureCard = {
  n: string;
  title: string;
  body: string;
  mark: string;
  rule: string;
  fg: string;
  pick: () => void;
};

export type PolicyOption = {
  label: string;
  pick: () => void;
  ul: string;
  fg: string;
};

export type PolicyRow = {
  label: string;
  hint: string;
  options: PolicyOption[];
};

export type HistoryRow = HistoryItem & { beforeC: string; afterC: string };
