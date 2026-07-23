import { BarChart, CandlestickChart, LineChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, MarkPointComponent, TooltipComponent } from "echarts/components";
import { init, use, type EChartsType } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import type { MarketBar } from "../market/types";

use([LineChart, CandlestickChart, BarChart, GridComponent, DataZoomComponent, MarkPointComponent, TooltipComponent, SVGRenderer]);

export function createEquityChart(element: HTMLDivElement, points: Array<{ date: string; value: number }>): EChartsType {
  const chart = init(element, undefined, { renderer: "svg" });
  chart.setOption({
    animationDuration: 900,
    tooltip: { trigger: "axis", backgroundColor: "#151613", borderWidth: 0, textStyle: { color: "#f4f2e9" } },
    grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
    xAxis: { type: "category", data: points.map((point) => point.date), boundaryGap: false, axisLine: { lineStyle: { color: "rgba(242,240,231,.14)" } }, axisLabel: { color: "rgba(242,240,231,.42)", fontSize: 10 }, axisTick: { show: false } },
    yAxis: { type: "value", scale: true, splitNumber: 3, axisLabel: { formatter: (value: number) => `${(value / 10000).toFixed(0)}w`, color: "rgba(242,240,231,.38)", fontSize: 10 }, splitLine: { lineStyle: { color: "rgba(242,240,231,.08)" } } },
    series: [{ type: "line", data: points.map((point) => point.value), smooth: 0.34, symbol: "none", lineStyle: { color: "#d9ff74", width: 2 }, areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(217,255,116,.24)" }, { offset: 1, color: "rgba(217,255,116,0)" }] } }, markPoint: { symbolSize: 7, data: [{ coord: [points.at(-1)?.date, points.at(-1)?.value] }], itemStyle: { color: "#ff705c" }, label: { show: false } } }],
  });
  return chart;
}

export function createCandlestickChart(element: HTMLDivElement, bars: MarketBar[], interval: "1d" | "1m"): EChartsType {
  const rows = bars.filter((bar) => bar.open != null && bar.high != null && bar.low != null && bar.close != null);
  const labels = rows.map((bar) => formatBarTime(bar.timestamp, interval));
  const volumes = rows.map((bar) => bar.volume);
  const chart = init(element, undefined, { renderer: "svg" });
  chart.setOption({
    animationDuration: 500,
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross", lineStyle: { color: "rgba(239,237,228,.34)" } },
      backgroundColor: "#151613",
      borderWidth: 0,
      textStyle: { color: "#f4f2e9" },
    },
    grid: [
      { left: 8, right: 8, top: 12, height: "66%", containLabel: true },
      { left: 8, right: 8, bottom: 8, height: "16%", containLabel: true },
    ],
    xAxis: [
      { type: "category", data: labels, boundaryGap: true, axisLine: { lineStyle: { color: "rgba(242,240,231,.14)" } }, axisLabel: { color: "rgba(242,240,231,.42)", fontSize: 10 }, axisTick: { show: false } },
      { type: "category", data: labels, gridIndex: 1, boundaryGap: true, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { show: false } },
    ],
    yAxis: [
      { type: "value", scale: true, splitNumber: 3, axisLabel: { color: "rgba(242,240,231,.38)", fontSize: 10 }, splitLine: { lineStyle: { color: "rgba(242,240,231,.08)" } } },
      { type: "value", scale: true, gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
    ],
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1], start: Math.max(0, 100 - 60 / Math.max(rows.length, 1) * 100), end: 100 }],
    series: [
      {
        type: "candlestick",
        name: interval === "1m" ? "1分钟K线" : "日K",
        data: rows.map((bar) => [bar.open, bar.close, bar.low, bar.high]),
        itemStyle: { color: "#ff705c", color0: "#48d597", borderColor: "#ff705c", borderColor0: "#48d597" },
      },
      {
        type: "bar",
        name: "成交量",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: volumes,
        itemStyle: { color: "rgba(217,255,116,.24)" },
      },
    ],
  });
  return chart;
}

function formatBarTime(value: string, interval: "1d" | "1m") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return interval === "1m"
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}
