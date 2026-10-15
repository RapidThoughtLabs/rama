// Home fixture transcripts — HOME_REDESIGN_PLAN.md HD6. The mockup's ten Home conversations
// (mock:L882-1004) rewritten as what the engine would actually store: markdown text as a model
// would write it (draft cards as ```draft fences, the formula as an ```excel fence), thinking and
// tool calls as ordered blocks, one assistant row per step, and the per-row model that wrote it.
// Rendering them must reproduce the mockup's HTML.

import type { AttachmentDTO, ChatBlock, MessageDTO, ToolCallDTO } from "@rama/protocol";

export interface ModelRef {
  providerId: string;
  modelId: string;
}

type Step = { thinking?: { text: string; ms: number }; tool?: { name: string; input: unknown; summary: string; meta?: Record<string, unknown> }; text?: string };
type Turn = { role: "user"; text: string; attach?: AttachmentDTO } | { role: "ai"; steps: Step[] };

const NB = " ";

const LEASE_REPLY = `Most of this is a standard furnished lease. Three clauses put more on you than usual, and they're worth raising before Friday:

- **Leaving early (§9.2).** If you move out before the year is up, you owe rent for every remaining month. Two months' rent is a common cap, so ask for that.
- **Repairs (§11.3).** Anything under €250 is on you, including the appliances that come with the flat. In a furnished place, the landlord usually looks after what they supplied.
- **Automatic renewal (§4.1).** The lease rolls over for another year unless you give 90 days' written notice. It starts on 1 November, so that notice would be due by 2 August next year.

The rest is typical: a two-month deposit, 24 hours' notice before the landlord visits, and no pets without written consent.

Want me to draft a short note to the landlord asking for those three changes?`;

const LEASE_DRAFT = `Here's a version that asks for all three without sounding like a negotiation:

\`\`\`draft Email draft
Subject: A few small questions about the lease

Hi Marta,

Thanks for sending the lease over. The flat is lovely and I'm keen to sign on Friday. Before I do, would you be open to three small changes?

Capping the cost of leaving early at two months' rent (§9.2).
Covering repairs to the appliances that come with the flat (§11.3).
Shortening the renewal notice to 30 days (§4.1).

Happy to talk it through by phone if that's easier.

Best,
Sam
\`\`\`

If she pushes back, hold firm on repairs. Over a year, that's the clause most likely to cost you money.`;

const LISBON_REPLY = `Mid-March is good walking weather. Expect highs around 18${NB}°C, lows near 10${NB}°C, and rain on about one day in four. Bring a light layer and shoes with some grip: the stone pavements get slippery when wet.

Four days is plenty if you take the city one area at a time:

| Day | Where | Don't miss |
| --- | --- | --- |
| 1 | Alfama and the castle | Sunset from Miradouro de Santa Luzia |
| 2 | Belém | Pastéis de nata where they started, then the Jerónimos cloisters |
| 3 | Sintra, as a day trip | Pena Palace. Book the first entry slot. |
| 4 | Chiado and Príncipe Real | A slow afternoon in the bookshops and gardens |

Tram 28 is worth one ride, but board at Martim Moniz early in the morning. By midday the queue can take longer than walking.`;

const BILL_REPLY = `Split it by each room's share of the total area. The rooms add up to 34 m², so:

| Room | Size | Share | Pays |
| --- | ---: | ---: | ---: |
| Largest | 14 m² | 41.2% | €76.59 |
| Middle | 11 m² | 32.4% | €60.18 |
| Smallest | 9 m² | 26.5% | €49.24 |

Those add up to €186.01 because of rounding, so take a cent off the largest share.

With room sizes in \`B2:B4\` and the bill in \`E1\`, put this in \`C2\` and fill down:

\`\`\`excel
=ROUND($E$1 * B2 / SUM($B$2:$B$4), 2)
\`\`\`

Some flats split a fixed part equally first, for shared things like the fridge and the router, and only divide the rest by room size. Say if you'd like that version.`;

export const TRANSCRIPTS: Record<string, Turn[]> = {
  lease: [
    {
      role: "user",
      attach: { id: "att-lease", name: "lease-2026-draft.pdf", mime: "application/pdf", size: 412_000, pages: 14 },
      text: "Can you read through this before I sign it on Friday? Flag anything that looks unusual or one-sided. I've never rented a furnished place before.",
    },
    {
      role: "ai",
      steps: [
        { tool: { name: "read", input: { path: "attachments/lease/lease-2026-draft.pdf" }, summary: "14 pages" } },
        {
          thinking: { text: "Compared each clause with what's usual for a 12-month furnished lease, and kept only the ones that shift cost or risk onto the tenant.", ms: 6200 },
          text: LEASE_REPLY,
        },
      ],
    },
    { role: "user", text: "Yes please. Keep it friendly, I don't want to start off on the wrong foot." },
    { role: "ai", steps: [{ text: LEASE_DRAFT }] },
  ],
  lisbon: [
    { role: "user", text: "I'm in Lisbon for four days in mid-March. Is it good weather for walking, and what shouldn't I miss?" },
    {
      role: "ai",
      steps: [
        {
          tool: {
            name: "web",
            input: { query: "Lisbon weather mid-March, what to see in four days" },
            summary: "6 results",
            meta: {
              sources: [
                { title: "Lisbon climate averages", source: "IPMA" },
                { title: "What's on in March", source: "Visit Lisboa" },
                { title: "The best neighbourhoods in Lisbon", source: "Time Out" },
                { title: "Pena Palace tickets and hours", source: "Parques de Sintra" },
                { title: "Tram 28 timetable", source: "Carris" },
                { title: "A day in Belém", source: "Lonely Planet" },
              ],
            },
          },
        },
        { text: LISBON_REPLY },
      ],
    },
  ],
  bill: [
    { role: "user", text: "Three of us share a flat. The rooms are 14, 11 and 9 m². What's a fair way to split a €186 electricity bill by room size? I'd like a spreadsheet formula." },
    { role: "ai", steps: [{ thinking: { text: "Worked out each room's share of the 34 m² total, then checked the rounding.", ms: 3100 }, text: BILL_REPLY }] },
  ],
  sourdough: [
    { role: "user", text: "My sourdough looks great until I score it, then it slumps flat. What am I doing wrong?" },
    {
      role: "ai",
      steps: [
        {
          text: `That's almost always over-proofing. Once dough has risen for too long, the gluten can't hold the gas any more, and the cut lets it all out at once.

Try the poke test before baking: press a floured finger about a centimetre in. If the dent springs back slowly and leaves a small mark, it's ready. If it doesn't spring back at all, it's gone too far.

Next time, shorten the final rise by 30 to 45 minutes, or do it in the fridge overnight. The cold slows everything down and gives you a much wider window.`,
        },
      ],
    },
  ],
  school: [
    { role: "user", text: "Help me write a short note to Leo's teacher. From now on his dad will pick him up on Thursdays." },
    {
      role: "ai",
      steps: [
        {
          text: `Here's a short one:

\`\`\`draft Email draft
Subject: Thursday pickups

Hi Ms. Okafor,

Just a quick note that from this week on, Leo's dad, Daniel, will pick him up on Thursdays. Let me know if you need anything from us to add him to the pickup list.

Thank you,
Sam
\`\`\``,
        },
      ],
    },
  ],
  recipe: [
    {
      role: "user",
      attach: { id: "att-recipe", name: "recipe-card.jpg", mime: "image/jpeg", size: 1_800_000 },
      text: "This is my grandmother's recipe card, in Portuguese. Can you translate it? Some of the handwriting is hard to read.",
    },
    {
      role: "ai",
      steps: [
        { tool: { name: "read", input: { path: "attachments/recipe/recipe-card.jpg" }, summary: "image (1.8 MB)" } },
        {
          text: `It's a recipe for *bolo de laranja*, an orange cake. Here it is in English, with the two words I wasn't sure about marked:

- 4 eggs
- 2 cups of sugar
- Zest and juice of 2 oranges
- 1 cup of oil
- 2 cups of flour, sifted
- 1 spoon of baking powder *(probably a tablespoon; the word is smudged)*

Beat the eggs and sugar until pale, add the orange and the oil, then fold in the flour and baking powder. Bake in a greased tin in a moderate oven *(“forno médio”, about 180${NB}°C)* until a toothpick comes out clean.`,
        },
      ],
    },
  ],
  index: [
    { role: "user", text: "Explain index funds like I'm 12." },
    {
      role: "ai",
      steps: [
        {
          text: `Imagine you want to bet on your whole school doing well in exams, not just one kid. Instead of picking a favourite, you put a little money on every student. Some do badly, some do brilliantly, and overall you get the school's average.

An index fund does that with companies. It buys a small piece of every company on a list, like the 500 biggest in the US, so you get the average of all of them instead of guessing which one will win.

People like them for two reasons: they're cheap to run, because nobody is paid to pick winners, and over long stretches the average has tended to beat most of the people who try.`,
        },
      ],
    },
  ],
  plant: [
    { role: "user", text: "What's a good first houseplant? My flat doesn't get much light." },
    {
      role: "ai",
      steps: [
        {
          text: `A ZZ plant or a snake plant. Both cope with low light, and both would rather you forgot to water them than fussed over them.

Water when the soil is dry all the way down, which in a dim room might be every three or four weeks. Most people lose these to overwatering, not neglect.`,
        },
      ],
    },
  ],
  toast: [
    { role: "user", text: "I need a 30-second birthday toast for my sister. She's turning 40, loves hiking and is always late." },
    {
      role: "ai",
      steps: [
        {
          text: `Here's one that teases her a little and lands warm:

\`\`\`draft Toast
Forty years ago, my sister arrived two weeks late, which, as everyone here knows, was just the beginning. She's spent the years since dragging the rest of us up hills we didn't want to climb, and she's always been right about the view.

To Ana: the best person to be lost on a mountain with, and worth waiting for every single time.
\`\`\``,
        },
      ],
    },
  ],
  phone: [
    { role: "user", text: "Plan A is €15 a month with 20 GB. Plan B is €22 with unlimited data but a 24-month contract. I use about 12 GB. Which one?" },
    {
      role: "ai",
      steps: [
        {
          text: `Plan A. You use 12 GB, so 20 GB leaves plenty of room, and over two years it costs €360 against €528 for Plan B.

Plan B only makes sense if your usage is about to jump, say a new job with lots of video calls on the go, and even then you'd be locked in for two years. Plan A lets you switch whenever you like.`,
        },
      ],
    },
  ],
};

/** A chat's turns as stored rows: messages (one assistant row per step) and their tool calls. */
export function buildTranscript(chatId: string, turns: Turn[], model: ModelRef, endAt: number): { messages: MessageDTO[]; toolCalls: ToolCallDTO[] } {
  const messages: MessageDTO[] = [];
  const toolCalls: ToolCallDTO[] = [];
  let seq = 0;
  let t = endAt - turns.length * 60_000;
  for (const turn of turns) {
    t += 60_000;
    if (turn.role === "user") {
      messages.push({ id: `${chatId}-m${++seq}`, chatId, seq, role: "user", content: turn.text, thinking: null, createdAt: t, attachments: turn.attach ? [turn.attach] : undefined });
      continue;
    }
    turn.steps.forEach((step, stepIndex) => {
      const id = `${chatId}-m${++seq}`;
      const blocks: ChatBlock[] = [];
      if (step.thinking) blocks.push({ kind: "thinking", text: step.thinking.text, durationMs: step.thinking.ms, stepIndex, blockIndex: blocks.length });
      if (step.tool) {
        const callId = `${id}-tc`;
        blocks.push({ kind: "tool", callId, stepIndex, blockIndex: blocks.length });
        toolCalls.push({
          id: callId,
          messageId: id,
          chatId,
          name: step.tool.name,
          input: step.tool.input,
          ok: true,
          resultSummary: step.tool.summary,
          startedAt: t,
          endedAt: t + 900,
          artifactId: null,
          resultMeta: step.tool.meta ?? null,
        });
      }
      if (step.text) blocks.push({ kind: "text", text: step.text, stepIndex, blockIndex: blocks.length });
      messages.push({
        id,
        chatId,
        seq,
        role: "assistant",
        content: step.text ?? null,
        thinking: step.thinking?.text ?? null,
        createdAt: t,
        blocks,
        providerId: model.providerId,
        model: model.modelId,
      });
    });
  }
  return { messages, toolCalls };
}
