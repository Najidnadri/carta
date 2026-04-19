/**
 * Shared types for Carta. Exported via `src/index.ts`.
 * Branded units (Time, Interval, Pixel, Price) enforce unit-safety at public
 * API boundaries without runtime cost.
 */

// ─── Branded units ─────────────────────────────────────────────────────────
export type Time = number & { readonly __brand: "Time" };
export type Interval = number & { readonly __brand: "Interval" };
export type Pixel = number & { readonly __brand: "Pixel" };
export type Price = number & { readonly __brand: "Price" };

export const asTime = (n: number): Time => n as Time;
export const asInterval = (n: number): Interval => n as Interval;
export const asPixel = (n: number): Pixel => n as Pixel;
export const asPrice = (n: number): Price => n as Price;

// ─── Record types ──────────────────────────────────────────────────────────
export interface OhlcRecord {
  readonly time: Time;
  readonly open: Price;
  readonly high: Price;
  readonly low: Price;
  readonly close: Price;
  readonly volume?: number;
}

export interface PointRecord {
  readonly time: Time;
  readonly value: Price;
  readonly color?: number;
}

export interface MarkerRecord {
  readonly time: Time;
  readonly position: "above" | "below" | "inBar";
  readonly shape: "circle" | "square" | "arrowUp" | "arrowDown";
  readonly color?: number;
  readonly text?: string;
}

export type DataRecord = OhlcRecord | PointRecord | MarkerRecord;

// ─── Channels ──────────────────────────────────────────────────────────────
export type ChannelKind = "ohlc" | "point" | "marker";

export interface Channel {
  readonly id: string;
  readonly kind: ChannelKind;
}

// ─── Window & event payloads ───────────────────────────────────────────────
export interface ChartWindow {
  readonly startTime: Time;
  readonly endTime: Time;
}

export interface DataRequest {
  readonly channelId: string;
  readonly kind: ChannelKind;
  readonly intervalDuration: Interval;
  readonly startTime: Time;
  readonly endTime: Time;
}

export interface CrosshairInfo {
  readonly time: Time;
  readonly price: Price;
  readonly x: Pixel;
  readonly y: Pixel;
}

export interface SizeInfo {
  readonly width: number;
  readonly height: number;
}

// ─── Theme ─────────────────────────────────────────────────────────────────
export interface Theme {
  readonly background: number;
  readonly grid: number;
  readonly frame: number;
  readonly text: number;
  readonly up: number;
  readonly down: number;
  readonly line: number;
}

export const DEFAULT_THEME: Theme = {
  background: 0x0e1116,
  grid: 0x1f2630,
  frame: 0x2d333b,
  text: 0xc9d1d9,
  up: 0x26a69a,
  down: 0xef5350,
  line: 0x58a6ff,
};

// ─── Logger ────────────────────────────────────────────────────────────────
export interface Logger {
  debug(msg: string, ...args: readonly unknown[]): void;
  info(msg: string, ...args: readonly unknown[]): void;
  warn(msg: string, ...args: readonly unknown[]): void;
  error(msg: string, ...args: readonly unknown[]): void;
}

// ─── Public options ────────────────────────────────────────────────────────
export interface TimeSeriesChartOptions {
  readonly container: HTMLElement;
  readonly startTime: Time | number;
  readonly endTime: Time | number;
  readonly intervalDuration: Interval | number;
  readonly width?: number;
  readonly height?: number;
  readonly autoResize?: boolean;
  readonly devicePixelRatio?: number;
  readonly theme?: Partial<Theme>;
  readonly logger?: Logger;
}
