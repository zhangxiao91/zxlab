import { LineChart } from "echarts/charts";
import { GridComponent, MarkPointComponent, TooltipComponent } from "echarts/components";
import { init, use, type EChartsType } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";

use([LineChart, GridComponent, MarkPointComponent, TooltipComponent, SVGRenderer]);

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
