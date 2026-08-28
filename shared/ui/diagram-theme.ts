/**
 * How diagrams look.
 *
 * Mermaid's default is a 2014 wireframe: saturated fills, hard 1px borders and
 * dashed black boxes around groups. Each choice is defensible alone; together
 * they read as a debug view rather than something you would put in a design
 * document. These diagrams sit next to prose in a product, so they have to look
 * like they belong to it.
 *
 * The corrections are all one idea: pull the fills back until they are surfaces
 * rather than blocks of colour, let the border carry the identity, and stop the
 * container competing with its contents. A group is background, not a
 * participant.
 *
 * ## What this deliberately does not touch
 *
 * `architecture-beta`. An earlier version restyled its service tiles and its
 * groups, and the diagram came out as one empty box — twice, from two different
 * selectors, because `rect.node-bkg` is the class on both a group's background
 * and every service tile, and `.architecture-service` wraps a `rect.background`
 * with `stroke: none` set inline.
 *
 * `scripts/theme-bisect.mjs` renders a seven-service architecture diagram
 * through the variables and CSS below and checks every service lands inside the
 * viewBox, so this file is held to not breaking it. Restyling it further is a
 * separate job with its own evidence.
 *
 * @module shared/ui/diagram-theme
 */

interface DiagramInk {
  /** Node fill. A surface, not a block of colour. */
  surface: string;
  /** Node border, which is what carries the identity. */
  border: string;
  text: string;
  muted: string;
  /** Connectors. Lighter than text, so they recede behind the nodes. */
  line: string;
  /** Group background. Barely there on purpose. */
  groupBkg: string;
  groupBorder: string;
  accentSoft: string;
  accent: string;
}

const LIGHT: DiagramInk = {
  surface: '#eef3fc',
  border: '#4176e6',
  text: '#111827',
  muted: '#6b7280',
  line: '#9aa3af',
  groupBkg: '#f8fafc',
  groupBorder: '#dbe3ec',
  accentSoft: '#eaf0fd',
  accent: '#2a78d6',
};

const DARK: DiagramInk = {
  surface: '#1e2431',
  border: '#5b8ff0',
  text: '#e6e8eb',
  muted: '#9aa3af',
  line: '#5b626e',
  groupBkg: '#161a21',
  groupBorder: '#2a313c',
  accentSoft: '#1c2432',
  accent: '#3987e5',
};

/** The categorical order pie and similar charts step through. */
const SERIES_LIGHT = ['#2a78d6', '#1a9c53', '#b8791a', '#d13333', '#7c5cd6', '#2b7fa8', '#c2409c', '#64748b'];
const SERIES_DARK = ['#3987e5', '#4ed17e', '#f7ad31', '#f25a5a', '#a78bfa', '#56b6d8', '#f472b6', '#94a3b8'];

export function diagramTheme(dark: boolean): Record<string, string> {
  const ink = dark ? DARK : LIGHT;
  const series = dark ? SERIES_DARK : SERIES_LIGHT;
  const pie = Object.fromEntries(series.map((c, i) => [`pie${i + 1}`, c]));

  return {
    ...pie,
    fontFamily: 'var(--aico-font)',
    fontSize: '14px',
    background: 'transparent',

    // Nodes.
    primaryColor: ink.surface,
    primaryTextColor: ink.text,
    primaryBorderColor: ink.border,
    mainBkg: ink.surface,
    nodeBorder: ink.border,
    nodeTextColor: ink.text,
    secondaryColor: ink.groupBkg,
    secondaryBorderColor: ink.groupBorder,
    secondaryTextColor: ink.text,
    tertiaryColor: ink.groupBkg,
    tertiaryBorderColor: ink.groupBorder,
    tertiaryTextColor: ink.muted,
    textColor: ink.text,
    lineColor: ink.line,
    // Grouping is context. Mermaid's default is a hard dashed black rectangle
    // that reads as the most important thing on a canvas whose subject is what
    // sits inside it.
    clusterBkg: ink.groupBkg,
    clusterBorder: ink.groupBorder,
    titleColor: ink.text,
    edgeLabelBackground: dark ? '#161a21' : '#ffffff',

    // Sequence.
    actorBkg: ink.surface,
    actorBorder: ink.border,
    actorTextColor: ink.text,
    actorLineColor: ink.line,
    signalColor: ink.text,
    signalTextColor: ink.text,
    labelBoxBkgColor: ink.surface,
    labelBoxBorderColor: ink.border,
    labelTextColor: ink.text,
    loopTextColor: ink.text,
    activationBkgColor: ink.accentSoft,
    activationBorderColor: ink.border,
    sequenceNumberColor: dark ? '#0f1115' : '#ffffff',
    noteBkgColor: dark ? '#2a2410' : '#fdf6e3',
    noteBorderColor: dark ? '#5c4d16' : '#e8d9a8',
    noteTextColor: ink.text,

    // State and class.
    labelColor: ink.text,
    altBackground: ink.groupBkg,

    // Gantt.
    taskBkgColor: ink.surface,
    taskBorderColor: ink.border,
    taskTextColor: ink.text,
    taskTextOutsideColor: ink.text,
    taskTextDarkColor: ink.text,
    activeTaskBkgColor: ink.accentSoft,
    activeTaskBorderColor: ink.accent,
    doneTaskBkgColor: dark ? '#1c2b22' : '#e8f5ee',
    doneTaskBorderColor: dark ? '#2f6f4f' : '#1a9c53',
    critBkgColor: dark ? '#33191c' : '#fdecec',
    critBorderColor: dark ? '#f25a5a' : '#d13333',
    gridColor: ink.groupBorder,
    todayLineColor: ink.accent,
    sectionBkgColor: 'transparent',
    sectionBkgColor2: dark ? '#12151b' : '#fafbfc',

    // Pie.
    pieSectionTextColor: '#ffffff',
    pieStrokeWidth: '0px',
    pieOuterStrokeWidth: '0px',
    pieTitleTextSize: '16px',
    pieSectionTextSize: '13px',
    pieLegendTextColor: ink.muted,
  };
}

/**
 * The few corrections no theme variable exposes.
 *
 * Every rule here is one `themeVariables` genuinely cannot express, and none of
 * them names an `architecture-*` class — see the module note for why.
 */
export function diagramCss(dark: boolean): string {
  const ink = dark ? DARK : LIGHT;
  return [
    // Square corners are the loudest thing about the default look, and there is
    // no variable for radius on any shape.
    '.node rect, .node polygon, .cluster rect, .er rect, .classGroup rect,'
    + ' .stateGroup rect, .task, .actor { rx: 8px; ry: 8px; }',
    // The border carries the identity now, so it has to be visible without
    // being heavy. Mermaid's 1px disappears against a tinted fill.
    '.node rect, .node circle, .node ellipse, .node polygon { stroke-width: 1.5px; }',
    `.cluster rect { stroke-dasharray: none !important; stroke: ${ink.groupBorder} !important;`
    + ` fill: ${ink.groupBkg} !important; }`,
    '.cluster-label, .clusterLabel { font-size: 12px; font-weight: 600; }',
    // Connectors recede. At the default weight they compete with node borders,
    // which turns a ten-node diagram into a mesh.
    '.edgePath .path, .flowchart-link, .relation { stroke-width: 1.5px; }',
    // Edge labels sit on the line they belong to and need a surface under them,
    // or the line strikes the text through.
    '.edgeLabel { font-size: 12px; border-radius: 4px; }',
  ].join('\n');
}
