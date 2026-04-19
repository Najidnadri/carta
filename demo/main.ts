import { Chart, CandlestickSeries, type Candle } from "../src/index.js";

function generateCandles(count: number, startPrice = 100): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  const interval = 60 * 60 * 1000;
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    const change = (Math.random() - 0.5) * 2;
    const close = open + change;
    const high = Math.max(open, close) + Math.random();
    const low = Math.min(open, close) - Math.random();
    candles.push({
      time: now - (count - i) * interval,
      open,
      high,
      low,
      close,
    });
    price = close;
  }
  return candles;
}

async function main(): Promise<void> {
  const container = document.getElementById("chart");
  if (container === null) {
    throw new Error("Missing #chart element");
  }

  const chart = await Chart.create({ container });
  const series = new CandlestickSeries();
  series.setData(generateCandles(120));
  chart.addSeries(series);

  const reloadBtn = document.getElementById("reload");
  reloadBtn?.addEventListener("click", () => {
    series.setData(generateCandles(120));
    chart.fitContent();
    chart.requestDraw();
  });
}

void main();
