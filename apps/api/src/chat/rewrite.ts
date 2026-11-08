import type { LlmMessage, LlmProvider } from '../llm/provider.ts';

const SYSTEM = `Rewrite the user's latest question as a standalone question that can be understood without the conversation.
Keep all names, numbers and technical terms. If it is already standalone, return it unchanged.
Output only the rewritten question, nothing else.`;

// "What about the decoder?" retrieves nothing useful on its own. With the conversation it
// becomes "How many layers does the decoder have?", which retrieval can work with.
// Uses the fast model with thinking off: a tiny task that shouldn't add much latency.
export async function rewriteQuestion(
  llm: LlmProvider,
  history: LlmMessage[],
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!history.length) return question; // first question: nothing to resolve, no extra call

  const transcript = history
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.slice(0, 600)}`)
    .join('\n');
  try {
    const { text } = await llm.complete({
      system: SYSTEM,
      tier: 'fast',
      maxOutputTokens: 200,
      signal,
      messages: [{ role: 'user', text: `Conversation:\n${transcript}\n\nLatest question: ${question}` }],
    });
    const rewritten = text.trim().replace(/^["']|["']$/g, '');
    // Guard against a confused rewrite: fall back to the user's own words.
    return rewritten && rewritten.length <= 500 ? rewritten : question;
  } catch (err) {
    if (signal?.aborted) throw err;
    return question; // rewriting is an optimization; never fail the whole answer over it
  }
}
