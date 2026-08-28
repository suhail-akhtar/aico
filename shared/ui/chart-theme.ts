/**
 * What every chart looks like before the model says anything.
 *
 * The first version of this set a palette and a transparent background and left
 * the rest to ECharts' defaults. It looked exactly like that: bars filling their
 * whole band, square corners, dashed gridlines competing with the data, axis
 * text in whatever grey the library picked. A chart is read by people, and
 * "acceptable" is not the same as considered.
 *
 * ## The palette is computed, not chosen
 *
 * The original eight hues were picked by eye and failed three hard checks when
 * finally measured: one colour outside the lightness band, one below the chroma
 * floor (it read as grey), and — the one that matters — an adjacent pair
 * separated by ΔE 3.0 under deuteranopia, which is to say indistinguishable to
 * a colourblind reader. These eight are the validated set, and they pass every
 * check against AICO's own surfaces: worst adjacent CVD ΔE 9.1 light and 8.4
 * dark, worst normal-vision ΔE 19.6 and 19.3.
 *
 * Dark is not an automatic flip. It is the same eight hues stepped for a dark
 * surface and validated separately, because a palette that clears 3:1 on white
 * does not on near-black.
 *
 * **If you change a hue, re-run the validator.** Reasoning about ΔE is exactly
 * how the first palette got shipped.
 *
 * ## The specs the marks follow
 *
 * Bars capped at 24px so the band keeps some air; a 4px radius on the data end
 * only, square at the baseline, because a bar rounded at both ends stops
 * reading as a magnitude from zero. Lines 2px with round caps. Markers 8px, big
 * enough to hit. Area fills a 10% wash rather than a saturated block. Grid and
 * axis lines hairline, solid and one step off the surface — dashed gridlines
 * are ink competing with the data.
 *
 * Text never wears a series colour. Identity comes from the coloured mark
 * beside the label, not from the label itself; a yellow or aqua series colour is
 * illegible as text on either surface.
 *
 * @module shared/ui/chart-theme
 */

/** The validated categorical order. Never cycle it — a ninth series folds to "Other". */
const LIGHT_SERIES = [
  '#2a78d6', '#eb6834', '#1baf7a', '#eda100',
  '#e87ba4', '#008300', '#4a3aa7', '#e34948',
];

/** The same eight hues, stepped for a dark surface and validated against it. */
const DARK_SERIES = [
  '#3987e5', '#d95926', '#199e70', '#c98500',
  '#d55181', '#008300', '#9085e9', '#e66767',
];

interface Ink {
  primary: string;
  secondary: string;
  muted: string;
  /** One step off the surface. Gridlines and axis lines only. */
  line: string;
  /** Tooltip panel, which sits above the chart rather than on the page. */
  panel: string;
  panelBorder: string;
}

const LIGHT_INK: Ink = {
  primary: '#111827',
  secondary: '#4b5563',
  muted: '#6b7280',
  line: '#e5e7eb',
  panel: '#ffffff',
  panelBorder: '#e5e7eb',
};

const DARK_INK: Ink = {
  primary: '#e6e8eb',
  secondary: '#9aa3af',
  muted: '#6b7280',
  line: '#23262d',
  panel: '#16181d',
  panelBorder: '#2a2e37',
};

/**
 * The font stack, matched to the app.
 *
 * A chart in a system font next to prose in another is the detail that makes an
 * interface look assembled rather than designed.
 */
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * Build the theme object ECharts registers.
 *
 * Everything here is a *default*: a spec that names its own `itemStyle` or
 * `color` still wins. The model asked for something specific and overruling it
 * would be worse than a plain chart.
 */
export function chartTheme(dark: boolean): Record<string, unknown> {
  const series = dark ? DARK_SERIES : LIGHT_SERIES;
  const ink = dark ? DARK_INK : LIGHT_INK;

  const axis = {
    axisLine: { show: true, lineStyle: { color: ink.line, width: 1 } },
    axisTick: { show: false },
    axisLabel: { color: ink.secondary, fontSize: 11, fontFamily: FONT },
    splitLine: { show: true, lineStyle: { color: ink.line, width: 1, type: 'solid' } },
    // The band separators between categories are noise on top of the gridlines.
    splitArea: { show: false },
  };

  return {
    color: series,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT, color: ink.secondary },

    title: {
      textStyle: { color: ink.primary, fontSize: 13, fontWeight: 600, fontFamily: FONT },
      subtextStyle: { color: ink.muted, fontSize: 11, fontFamily: FONT },
    },

    // Room for axis labels without the chart drifting off-centre. `containLabel`
    // is what stops a long y-axis label being clipped by the plot area.
    grid: { left: 12, right: 16, top: 32, bottom: 8, containLabel: true },

    categoryAxis: { ...axis, splitLine: { show: false } },
    valueAxis: axis,
    logAxis: axis,
    timeAxis: axis,

    line: {
      lineStyle: { width: 2, cap: 'round', join: 'round' },
      symbolSize: 8,
      smooth: false,
      // A ring in the surface colour keeps a marker legible where it crosses
      // another line, and enlarges the hover target at the same time.
      itemStyle: { borderWidth: 2, borderColor: dark ? '#0f1115' : '#ffffff' },
      areaStyle: { opacity: 0.1 },
    },

    bar: {
      // Capped rather than filling the band: the leftover is deliberate air.
      barMaxWidth: 24,
      // Rounded at the data end, square at the baseline. Rounding both ends
      // would stop it reading as a magnitude measured from zero.
      itemStyle: { borderRadius: [4, 4, 0, 0] },
    },

    pie: {
      // The gap does the separating, not a stroke — a border is ink that is not
      // data. `borderColor` is the surface, so the gap reads as space.
      itemStyle: {
        borderWidth: 2,
        borderColor: dark ? '#0f1115' : '#ffffff',
        borderRadius: 4,
      },
      label: { color: ink.secondary, fontFamily: FONT, fontSize: 11 },
    },

    scatter: {
      symbolSize: 10,
      itemStyle: { borderWidth: 2, borderColor: dark ? '#0f1115' : '#ffffff' },
    },

    legend: {
      // Always present for two or more series — identity must never rest on
      // colour-matching alone. ECharts hides it unless asked, so this is on.
      textStyle: { color: ink.secondary, fontSize: 11, fontFamily: FONT },
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
      top: 0,
    },

    tooltip: {
      backgroundColor: ink.panel,
      borderColor: ink.panelBorder,
      borderWidth: 1,
      textStyle: { color: ink.primary, fontSize: 12, fontFamily: FONT },
      // A crosshair is the difference between reading a line chart and guessing
      // at it. Cheap, and the default is a shadow band that obscures the marks.
      axisPointer: {
        type: 'line',
        lineStyle: { color: ink.muted, width: 1, type: 'solid' },
        crossStyle: { color: ink.muted, width: 1 },
        label: { backgroundColor: ink.muted, fontFamily: FONT },
      },
    },

    // Anything with its own colour ramp gets the categorical order too, so a
    // treemap or sunburst is recognisably the same family as the bar chart
    // beside it.
    visualMap: { textStyle: { color: ink.secondary, fontFamily: FONT } },
    timeline: { label: { color: ink.secondary } },
  };
}

/**
 * Defaults a spec cannot carry but every chart wants.
 *
 * Applied under the model's option rather than over it. A legend appears only
 * for two or more named series, because a one-series legend restates the title
 * and costs a row of space.
 */
export function chartDefaults(option: Record<string, unknown>): Record<string, unknown> {
  const series = Array.isArray(option.series) ? option.series : [option.series].filter(Boolean);
  const named = series.filter(
    (s): s is { name?: string } => Boolean(s) && typeof s === 'object' && 'name' in (s as object),
  );

  // Line and area charts want a crosshair down the whole plot; categorical
  // marks want the one under the pointer. Guessing wrong is not harmful, but
  // getting it right is most of what makes a chart feel finished.
  const kinds = new Set(series.map(s => (s as { type?: string } | undefined)?.type));
  const continuous = kinds.has('line') || kinds.has('area');

  return {
    animationDuration: 320,
    tooltip: {
      trigger: continuous ? 'axis' : 'item',
      ...(continuous ? { axisPointer: { type: 'line' } } : {}),
      ...(typeof option.tooltip === 'object' && option.tooltip ? option.tooltip : {}),
    },
    ...(named.length >= 2 && option.legend === undefined ? { legend: {} } : {}),
  };
}
