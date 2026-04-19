export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface LinePoint {
  time: number;
  value: number;
}

export interface Range {
  min: number;
  max: number;
}

export interface Viewport {
  x: Range;
  y: Range;
  width: number;
  height: number;
}

export interface ChartOptions {
  container: HTMLElement;
  width?: number;
  height?: number;
  background?: number;
  autoResize?: boolean;
  devicePixelRatio?: number;
}

export interface Theme {
  background: number;
  grid: number;
  text: number;
  up: number;
  down: number;
  line: number;
}

export const DEFAULT_THEME: Theme = {
  background: 0x0e1116,
  grid: 0x1f2630,
  text: 0xc9d1d9,
  up: 0x26a69a,
  down: 0xef5350,
  line: 0x58a6ff,
};
