/* Streaming markdown's block split — shared by Home's and Code's prose (home/HomeMarkdown.tsx). Moved
   out of the old chat/Markdown.tsx when docs/CODE_REDESIGN_PLAN.md CR6 retired that renderer. */

export interface SplitBlock {
  key: string;
  text: string;
  isComplete: boolean;
}

/**
 * Splits raw markdown into block chunks at blank lines and fence boundaries.
 * All chunks before the last one are complete (immutable during streaming);
 * only the trailing chunk is re-parsed on subsequent text deltas.
 * Exported for Home's prose renderer (HOME_REDESIGN_PLAN.md HD6, home/HomeMarkdown.tsx).
 */
export function splitMarkdownBlocks(markdown: string): SplitBlock[] {
  const lines = markdown.split("\n");
  const blocks: SplitBlock[] = [];
  let currentLines: string[] = [];
  let inFence = false;
  let fenceMarker = "";
  let blockIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = !inFence && line.match(/^([`~]{3,})/);

    if (fenceMatch) {
      if (currentLines.length > 0) {
        blocks.push({
          key: `b-${blockIndex++}`,
          text: currentLines.join("\n"),
          isComplete: true,
        });
        currentLines = [];
      }
      inFence = true;
      fenceMarker = fenceMatch[1];
      currentLines.push(line);
    } else if (inFence) {
      currentLines.push(line);
      if (line.trim().startsWith(fenceMarker)) {
        inFence = false;
        blocks.push({
          key: `b-${blockIndex++}`,
          text: currentLines.join("\n"),
          isComplete: true,
        });
        currentLines = [];
      }
    } else if (line.trim() === "") {
      if (currentLines.length > 0) {
        blocks.push({
          key: `b-${blockIndex++}`,
          text: currentLines.join("\n"),
          isComplete: true,
        });
        currentLines = [];
      }
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    blocks.push({
      key: `b-${blockIndex++}`,
      text: currentLines.join("\n"),
      isComplete: false,
    });
  }

  return blocks;
}
