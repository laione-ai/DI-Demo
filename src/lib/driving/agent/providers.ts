// ============================================================
// Driving Agent — Provider adapters for tool calling.
//
// Normalises OpenAI and Anthropic tool-calling APIs into a
// single interface consumed by the agent engine.
// ============================================================

import type {
  ToolCallingArgs,
  ToolCallingResult,
  ToolCallingMessage,
  ToolCall,
} from './types';
import {
  normalizeUsage,
  providerHttpError,
  toNetworkError,
} from '@/lib/ai/providers/shared';

const ANTHROPIC_VERSION = '2023-06-01';

const DEFAULT_OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * Resolve the chat-completions URL from OPENAI_BASE_URL.
 *
 * The rest of the codebase (src/lib/ai/providers/openai.ts, the dental agent,
 * docs/phase-1/P1-8-openrouter.md) treats OPENAI_BASE_URL as the FULL endpoint,
 * e.g. https://openrouter.ai/api/v1/chat/completions. This adapter used to append
 * "/chat/completions" unconditionally, which produced a doubled path and a 404
 * whenever the variable was set as documented. Accept both forms: a full
 * endpoint is used as-is, a bare base (…/v1) gets the path appended.
 */
export function resolveOpenAiChatUrl(
  base: string | undefined = process.env.OPENAI_BASE_URL,
): string {
  const trimmed = (base ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_OPENAI_CHAT_URL;
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

/**
 * Call OpenAI (or an OpenAI-compatible endpoint) with tool calling.
 */
export async function generateWithToolsOpenAi(
  args: ToolCallingArgs,
): Promise<ToolCallingResult> {
  const { apiKey, model, messages, tools, timeoutMs } = args;

  const url = resolveOpenAiChatUrl();

  const openAiMessages = messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool' as const,
        tool_call_id: m.tool_call_id,
        content: m.content || '',
      };
    }
    if (m.role === 'assistant' && m.tool_calls) {
      return {
        role: 'assistant' as const,
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }
    return {
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content || '',
    };
  });

  const openAiTools = tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const isReasoningModel = /^(gpt-5|luna|o1|o3|o4)/i.test(model);

  const requestBody: Record<string, unknown> = {
    model,
    messages: openAiMessages,
    tools: openAiTools.length > 0 ? openAiTools : undefined,
  };

  if (!isReasoningModel) {
    requestBody.temperature = 0.3;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const message = choice?.message;

  const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map(
    (tc: { id: string; function: { name: string; arguments: string } }) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeParseJson(tc.function.arguments),
    }),
  );

  return {
    text: message?.content || '',
    toolCalls,
    usage: normalizeUsage(data.usage),
    done: toolCalls.length === 0,
  };
}

/**
 * Call Anthropic with tool calling.
 */
export async function generateWithToolsAnthropic(
  args: ToolCallingArgs,
): Promise<ToolCallingResult> {
  const { apiKey, model, messages, tools, timeoutMs } = args;

  const url = 'https://api.anthropic.com/v1/messages';

  // Extract system prompt
  const systemMsg = messages.find((m) => m.role === 'system');
  const systemPrompt = systemMsg?.content || '';

  // Convert messages for Anthropic
  const anthropicMessages: Array<{
    role: 'user' | 'assistant';
    content: unknown;
  }> = [];

  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      anthropicMessages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: m.content || '',
          },
        ],
      });
      continue;
    }

    if (m.role === 'assistant' && m.tool_calls) {
      const contentBlocks: unknown[] = [];
      if (m.content) {
        contentBlocks.push({ type: 'text', text: m.content });
      }
      for (const tc of m.tool_calls) {
        contentBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }
      anthropicMessages.push({ role: 'assistant', content: contentBlocks });
      continue;
    }

    anthropicMessages.push({
      role: m.role as 'user' | 'assistant',
      content: m.content || '',
    });
  }

  const anthropicTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        messages: anthropicMessages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        max_tokens: 1024,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res);
  }

  const data = await res.json();
  let text = '';
  const toolCalls: ToolCall[] = [];

  for (const block of data.content ?? []) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input ?? {},
      });
    }
  }

  return {
    text,
    toolCalls,
    usage: data.usage
      ? {
          promptTokens: data.usage.input_tokens ?? 0,
          completionTokens: data.usage.output_tokens ?? 0,
          totalTokens:
            (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
        }
      : null,
    done: toolCalls.length === 0,
  };
}

export async function generateWithTools(
  provider: 'openai' | 'anthropic',
  args: ToolCallingArgs,
): Promise<ToolCallingResult> {
  if (provider === 'anthropic') {
    return generateWithToolsAnthropic(args);
  }
  return generateWithToolsOpenAi(args);
}

function safeParseJson(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
