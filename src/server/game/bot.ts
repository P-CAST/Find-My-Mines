import { z } from "zod";
import { requestResponse } from "./openai";
import type { PublicCell } from "./service";
import { BOARD_SIZE, BOMB_COUNT } from "./rules";

export type BotEvidence = {
  cells: PublicCell[];
  scores: { self: number; opponent: number };
  remainingMs: number;
};
export type BotProvider = (
  evidence: BotEvidence,
  signal: AbortSignal,
) => Promise<number>;

const moveSchema = z
  .object({ cellIndex: z.number().int().min(0).max(35) })
  .strict();
const envelopeSchema = z.object({
  status: z.literal("completed"),
  output: z.array(
    z.object({
      type: z.string(),
      content: z
        .array(
          z.object({
            type: z.string(),
            text: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

export function buildBotInput(evidence: BotEvidence) {
  // Rebuild from public fields rather than spreading caller-supplied objects.
  const cells: (PublicCell & { index: number; coordinate: string })[] =
    evidence.cells.map((cell, index) => ({
      index,
      coordinate: `${String.fromCharCode(65 + Math.floor(index / BOARD_SIZE))}${(index % BOARD_SIZE) + 1}`,
      ...(cell.kind === "empty"
        ? { kind: cell.kind, adjacent: cell.adjacent }
        : { kind: cell.kind }),
    }));
  const grid = [
    "  1 2 3 4 5 6",
    ...Array.from(
      { length: BOARD_SIZE },
      (_, row) =>
        `${String.fromCharCode(65 + row)} ${cells
          .slice(row * BOARD_SIZE, (row + 1) * BOARD_SIZE)
          .map((cell) =>
            cell.kind === "covered"
              ? "?"
              : cell.kind === "bomb"
                ? "B"
                : cell.adjacent,
          )
          .join(" ")}`,
    ),
  ].join("\n");
  return {
    boardSize: BOARD_SIZE,
    bombCount: BOMB_COUNT,
    grid,
    cells,
    legalCellIndices: cells
      .filter((cell) => cell.kind === "covered")
      .map((cell) => cell.index),
    clues: cells
      .filter((cell) => cell.kind === "empty")
      .map((cell) => ({
        index: cell.index,
        coordinate: cell.coordinate,
        adjacent: cell.adjacent,
        neighbors: cells.filter(
          (neighbor) =>
            neighbor.index !== cell.index &&
            Math.abs(
              Math.floor(neighbor.index / BOARD_SIZE) -
                Math.floor(cell.index / BOARD_SIZE),
            ) <= 1 &&
            Math.abs(
              (neighbor.index % BOARD_SIZE) - (cell.index % BOARD_SIZE),
            ) <= 1,
        ),
      })),
    scores: { self: evidence.scores.self, opponent: evidence.scores.opponent },
    remainingMs: evidence.remainingMs,
  };
}

export function createBotProvider(
  config: { apiKey?: string; model?: string },
  transport: typeof fetch = fetch,
  log: (message: string) => void = console.info,
): BotProvider | undefined {
  const { apiKey, model } = config;
  if (!apiKey || !model) return undefined;
  return async (evidence, signal) => {
    const started = Date.now();
    const response = await requestResponse(
      apiKey,
      {
        model,
        reasoning: { effort: "none" },
        max_output_tokens: 1024,
        instructions: `Play Find My Mines using only the supplied public board.

Rules and representation:
The board is 6 by 6 with 11 bombs. Rows A-F run top to bottom; columns 1-6 run left to right.
Numeric cell indices are row-major, 0 through 35: A1=0, A6=5, B1=6, F6=35.
The labeled grid uses ? for covered cells, B for revealed bombs, and numbers for revealed empty cells.
Each clue lists its actual neighbors (horizontal, vertical, diagonal), including their visible states. Edges never wrap.
A number counts ALL bombs among those neighbors, including bombs already revealed.
Choose one index from legalCellIndices. Finding a bomb scores one point and keeps your turn with the ORIGINAL deadline.
Empty cells show their eight-neighbor bomb count and pass play; there is no flood fill.
Timeout passes play. Fresh turns last ten seconds. Finding all 11 bombs ends play; most points wins.

Choosing a move:
Compare each clue with its revealed neighboring bombs and its remaining covered neighbors.
Cross-check overlapping clues. Prioritize a covered cell that must contain a bomb.
Avoid cells you deduce are empty: this game rewards finding bombs.
If no bomb is certain, choose the best-supported uncertain cell. If evidence cannot distinguish candidates, guess without inventing certainty.

Hypothetical examples only; these are NOT additional facts about the supplied board:
- A clue of 2 with one revealed neighboring bomb and exactly one covered neighbor proves that covered neighbor contains a bomb.
- A clue of 1 with one revealed neighboring bomb means all its remaining covered neighbors are empty.

Return only {"cellIndex": number}, without explanation or commentary.`,
        input: JSON.stringify(buildBotInput(evidence)),
        text: {
          format: {
            type: "json_schema",
            name: "bot_move",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                cellIndex: { type: "integer", minimum: 0, maximum: 35 },
              },
              required: ["cellIndex"],
            },
          },
        },
      },
      signal,
      transport,
    );
    if (!response.ok)
      throw new Error(
        response.status === 429 ? "rate_limit" : "provider_error",
      );
    const envelope = envelopeSchema.parse(await response.json());
    const content = envelope.output
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? []);
    if (content.some((part) => part.type === "refusal"))
      throw new Error("refusal");
    const move = moveSchema.parse(
      JSON.parse(
        content
          .filter((part) => part.type === "output_text")
          .map((part) => part.text ?? "")
          .join(""),
      ) as unknown,
    );
    log(
      `[bot] completed ${JSON.stringify({
        durationMs: Date.now() - started,
        inputTokens: envelope.usage.input_tokens,
        outputTokens: envelope.usage.output_tokens,
      })}`,
    );
    return move.cellIndex;
  };
}
