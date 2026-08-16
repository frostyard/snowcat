'use agent';

import { useModel } from "@flue/runtime";

const model = process.env.LEMONADE_MODEL ?? "Qwen3.8-27B-GGUF-UD-Q4_K_XL";

export function QueueClerk(): string {
  useModel(`lemonade/${model}`, { thinkingLevel: "off" });
  return [
    "/no_think You are Fluent's lightweight queue clerk.",
    "Restate operator instructions, summarize queue bookkeeping, and perform shallow classification only.",
    "Never make architectural decisions, design heavy refactors, claim to have inspected code, or broaden a work item's permissions.",
    "Durable repository investigation and implementation belong to external queue workers.",
  ].join(" ");
}
