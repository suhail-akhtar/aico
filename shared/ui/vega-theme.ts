/**
 * The Vega config, built from the same tokens ECharts uses.
 *
 * Two chart engines on one page is a design problem before it is a technical
 * one. If they carry different palettes, different gridline weights and
 * different fonts, a transcript holding one of each looks like two products
 * stapled together — and the reader has no idea why some charts are blue and
 * others are teal, because the reason is which library happened to render them.
 *
 * So this imports the palette, the ink and the font from `chart-theme` rather
 * than restating them. The colourblind separation of those eight hues was
 * checked against these exact surfaces; a second hand-picked set would have to
 * be checked again, and the one that was not checked is the one that ships
 * wrong. There is one palette here, and both engines read it.
 *
 * @module shared/ui/vega-theme
 */

import { DARK_INK, DARK_SERIES, FONT, LIGHT_INK, LIGHT_SERIES } from './chart-theme';

/**
 * Vega's `config` block: defaults every mark and axis inherits.
 *
 * Everything is a default. A spec naming its own `color` still wins, for the
 * same reason it does in ECharts — the author asked for something specific and
 * overruling it would be worse than a plain chart.
 */
export function vegaTheme(dark: boolean): Record<string, unknown> {
  const series = dark ? DARK_SERIES : LIGHT_SERIES;
  const ink = dark ? DARK_INK : LIGHT_INK;

  return {
    background: 'transparent',
    font: FONT,

    // The categorical order is fixed, never cycled: colour follows the entity,
    // so filtering a series out must not repaint the ones that remain.
    range: {
      category: series,
      // One hue, light to dark. A rainbow ramp reads as categories and destroys
      // the one thing a sequential scale is for — that darker means more.
      ramp: dark
        ? ['#0d2438', '#14456e', '#1a63a3', '#2f80c9', '#6aa9de', '#a8ccec']
        : ['#e8f1fb', '#c3ddf5', '#8fbfea', '#5a9ddb', '#2a78d6', '#18538f'],
      // Two poles and a neutral middle. A hue at the midpoint would imply the
      // centre means something, when what it means is "neither".
      diverging: ['#8f2a1a', '#cc5b3e', '#e9a88f', '#eeeeee', '#8fbfea', '#2f80c9', '#164e86'],
    },

    axis: {
      labelFont: FONT,
      labelFontSize: 11,
      labelColor: ink.secondary,
      titleFont: FONT,
      titleFontSize: 11,
      titleColor: ink.muted,
      titleFontWeight: 'normal',
      // Hairline and solid. A dashed gridline is a second thing to read at the
      // weight of the data itself.
      gridColor: ink.line,
      gridWidth: 1,
      domain: false,
      tickColor: ink.line,
      tickSize: 4,
      labelPadding: 6,
    },
    // Nothing to hold the plot in. The marks are the figure; a box around them
    // is furniture.
    view: { stroke: null },

    legend: {
      labelFont: FONT,
      labelFontSize: 11,
      labelColor: ink.secondary,
      titleFont: FONT,
      titleFontSize: 11,
      titleColor: ink.muted,
      titleFontWeight: 'normal',
      symbolType: 'circle',
      symbolSize: 60,
    },

    title: {
      font: FONT,
      fontSize: 13,
      fontWeight: 600,
      color: ink.primary,
      subtitleFont: FONT,
      subtitleFontSize: 11,
      subtitleColor: ink.muted,
      anchor: 'start',
      offset: 12,
    },

    // Mark specs, matched to the ECharts side so the two engines produce marks
    // of the same weight. Thin bars with rounded data-ends, 2px lines, markers
    // big enough to hit.
    bar: { fill: series[0], cornerRadiusEnd: 4 },
    line: { stroke: series[0], strokeWidth: 2, strokeCap: 'round', strokeJoin: 'round' },
    point: { fill: series[0], size: 64, filled: true },
    // A 2px surface ring on overlapping marks — the spacer that keeps two
    // adjacent points readable as two rather than one blob.
    circle: { fill: series[0], size: 64, stroke: dark ? '#16181d' : '#ffffff', strokeWidth: 2 },
    area: { fill: series[0], fillOpacity: 0.1, line: { strokeWidth: 2 } },
    rect: { fill: series[0] },
    // Box plots and error bars carry statistics, so they wear ink rather than a
    // series colour — the shape is the message, not the identity.
    rule: { stroke: ink.secondary, strokeWidth: 1 },
    text: { font: FONT, fontSize: 11, fill: ink.secondary },
  };
}
