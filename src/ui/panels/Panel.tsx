import React from 'react';
import { Box, Text, useStdout } from 'ink';

/**
 * Shared panel wrapper that replicates Claude Code CLI's title-in-border style:
 *
 *   ╭─ Title ────────────────────────────────────────────────╮
 *   │ content row...                                          │
 *   ╰─────────────────────────────────────────────────────────╯
 *
 * Ink 6.8 has no native borderLabel prop. The workaround:
 *   1. Draw the top border manually as a <Text> using useStdout().columns.
 *   2. Set borderTop={false} on the inner Box so Ink only renders │ sides
 *      and the ╰──────╯ bottom — no duplicate top border.
 *   3. Set the same numeric width on both so all four corners align.
 *
 * Render-border.js confirms: when borderTop={false}, topLeft/topRight corners
 * are skipped and the left/right bars start at y+0 (offsetY=0), producing:
 *
 *   [manual Text]  ╭─ Title ──────────────────────────────────╮
 *   [Ink Box row0] │ content...                                │
 *   [Ink Box last] ╰───────────────────────────────────────────╯
 */
export function Panel({
  title,
  borderColor = 'gray',
  children,
}: {
  title: string;
  borderColor?: string;
  children: React.ReactNode;
}) {
  const { stdout } = useStdout();

  // Subtract 2 cols for App.tsx's outer paddingX={1}; cap at 120 for readability
  const termCols = (stdout as NodeJS.WriteStream & { columns?: number }).columns ?? 80;
  const panelWidth = Math.min(Math.max(termCols - 2, 40), 120);

  // Build top border: ╭─ Title ──────────────────────────────────╮
  // inner = number of chars between ╭ and ╮
  const inner = panelWidth - 2;
  const titleSeg = `─ ${title} `;
  const fill = '─'.repeat(Math.max(0, inner - titleSeg.length));
  const topBorder = '╭' + titleSeg + fill + '╮';

  return (
    <Box flexDirection="column" marginTop={1} width={panelWidth}>
      {/* Manually drawn top border with title embedded — same width as inner Box */}
      <Text color={borderColor}>{topBorder}</Text>

      {/* Ink draws │ left, │ right, and ╰──╯ bottom; top is already above */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderTop={false}
        borderColor={borderColor}
        paddingX={1}
        width={panelWidth}
      >
        {children}
      </Box>
    </Box>
  );
}
