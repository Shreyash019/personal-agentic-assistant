import { useCallback, useReducer, useRef } from 'react';

// ── Payload types (mirrors shared/api/sse_payloads.json) ──────────────────────

export type MessagePayload = {
  content: string;
};

export type ToolCallPayload = {
  tool: string;
  status: 'executing';
  args: Record<string, unknown>;
};

export type ToolResultPayload = {
  tool: string;
  status: 'success' | 'error';
  task_id?: string;
  error_msg?: string;
};

// ── Chat message model ────────────────────────────────────────────────────────

export type TextPart = { kind: 'text'; content: string };
export type ToolCallPart = { kind: 'tool_call'; tool: string; args: Record<string, unknown> };
export type ToolResultPart = {
  kind: 'tool_result';
  tool: string;
  status: 'success' | 'error';
  taskId?: string;
  errorMsg?: string;
};

export type AssistantPart = TextPart | ToolCallPart | ToolResultPart;

export type UserMessage = { role: 'user'; text: string };
export type AssistantMessage = { role: 'assistant'; parts: AssistantPart[] };
export type ChatMessage = UserMessage | AssistantMessage;

// ── State ─────────────────────────────────────────────────────────────────────

export type ChatState = {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
};

// ── Actions ───────────────────────────────────────────────────────────────────

type Action =
  | { type: 'USER_MESSAGE'; text: string }
  | { type: 'STREAM_START' }
  | { type: 'APPEND_TEXT'; content: string }
  | { type: 'ADD_TOOL_CALL'; tool: string; args: Record<string, unknown> }
  | { type: 'ADD_TOOL_RESULT'; tool: string; status: 'success' | 'error'; taskId?: string; errorMsg?: string }
  | { type: 'STREAM_DONE' }
  | { type: 'STREAM_ERROR'; error: string }
  | { type: 'RESET' };

// ── Reducer ───────────────────────────────────────────────────────────────────

const initialState: ChatState = {
  messages: [],
  isStreaming: false,
  error: null,
};

function chatReducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'USER_MESSAGE':
      return {
        ...state,
        error: null,
        messages: [...state.messages, { role: 'user', text: action.text }],
      };

    case 'STREAM_START':
      return {
        ...state,
        isStreaming: true,
        error: null,
        // Append an empty assistant turn; parts are pushed in as they arrive.
        messages: [...state.messages, { role: 'assistant', parts: [] }],
      };

    case 'APPEND_TEXT': {
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last?.role !== 'assistant') return state;

      const parts = [...last.parts];
      const lastPart = parts[parts.length - 1];

      if (lastPart?.kind === 'text') {
        // Coalesce consecutive text chunks into a single part.
        parts[parts.length - 1] = {
          kind: 'text',
          content: lastPart.content + action.content,
        };
      } else {
        parts.push({ kind: 'text', content: action.content });
      }

      messages[messages.length - 1] = { role: 'assistant', parts };
      return { ...state, messages };
    }

    case 'ADD_TOOL_CALL': {
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last?.role !== 'assistant') return state;

      const part: ToolCallPart = {
        kind: 'tool_call',
        tool: action.tool,
        args: action.args,
      };
      messages[messages.length - 1] = {
        role: 'assistant',
        parts: [...last.parts, part],
      };
      return { ...state, messages };
    }

    case 'ADD_TOOL_RESULT': {
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last?.role !== 'assistant') return state;

      const part: ToolResultPart = {
        kind: 'tool_result',
        tool: action.tool,
        status: action.status,
        taskId: action.taskId,
        errorMsg: action.errorMsg,
      };
      messages[messages.length - 1] = {
        role: 'assistant',
        parts: [...last.parts, part],
      };
      return { ...state, messages };
    }

    case 'STREAM_DONE':
      return { ...state, isStreaming: false };

    case 'STREAM_ERROR':
      return { ...state, isStreaming: false, error: action.error };

    case 'RESET':
      return initialState;

    default:
      return state;
  }
}

// ── SSE frame parser ──────────────────────────────────────────────────────────

function parseSSEFrame(frame: string): { event: string; data: string } | null {
  let event = 'message'; // SSE default when no event: line is present
  let data = '';

  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) {
      event = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      data = line.slice(6).trim();
    }
  }

  return data ? { event, data } : null;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export type ChatMode = 'rag' | 'agent';

export type UseSSEChatOptions = {
  /** Backend base URL. Defaults to Python service on localhost. */
  baseUrl?: string;
};

export type UseSSEChatReturn = {
  state: ChatState;
  sendMessage: (query: string, mode?: ChatMode) => Promise<void>;
  reset: () => void;
};

const DEFAULT_BASE_URL = 'http://localhost:8000';

export function useSSEChat({
  baseUrl = DEFAULT_BASE_URL,
}: UseSSEChatOptions = {}): UseSSEChatReturn {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (query: string, mode: ChatMode = 'agent') => {
      // Cancel any in-flight request before starting a new one.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      dispatch({ type: 'USER_MESSAGE', text: query });
      dispatch({ type: 'STREAM_START' });

      try {
        const response = await fetch(`${baseUrl}/api/v1/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, mode }),
          signal: controller.signal,
          // React Native opt-in for streaming response bodies.
          // The key is not in the standard DOM typedefs, so we silence TS here.
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-expect-error
          reactNative: { textStreaming: true },
        });

        if (!response.ok) {
          const text = await response.text();
          dispatch({
            type: 'STREAM_ERROR',
            error: `HTTP ${response.status}: ${text}`,
          });
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          dispatch({ type: 'STREAM_ERROR', error: 'Response body is not readable' });
          return;
        }

        const decoder = new TextDecoder();
        // Partial frame accumulator — a chunk boundary may split a frame.
        let buffer = '';

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // stream:true keeps the decoder's internal state across calls so
          // multi-byte UTF-8 sequences that straddle chunk boundaries decode correctly.
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are delimited by a blank line (\n\n).
          const frames = buffer.split('\n\n');
          // The last element is an incomplete frame (or '') — keep it in the buffer.
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const trimmed = frame.trim();
            if (!trimmed) continue;

            const parsed = parseSSEFrame(trimmed);
            if (!parsed) continue;

            const { event, data } = parsed;

            let payload: unknown;
            try {
              payload = JSON.parse(data);
            } catch {
              continue; // skip malformed JSON without crashing the stream
            }

            switch (event) {
              case 'message': {
                const { content } = payload as MessagePayload;
                if (content) dispatch({ type: 'APPEND_TEXT', content });
                break;
              }

              case 'tool_call': {
                const { tool, args } = payload as ToolCallPayload;
                dispatch({ type: 'ADD_TOOL_CALL', tool, args });
                break;
              }

              case 'tool_result': {
                const { tool, status, task_id, error_msg } =
                  payload as ToolResultPayload;
                dispatch({
                  type: 'ADD_TOOL_RESULT',
                  tool,
                  status,
                  taskId: task_id,
                  errorMsg: error_msg,
                });
                break;
              }

              case 'error': {
                const { error } = payload as { error: string };
                dispatch({ type: 'STREAM_ERROR', error: error ?? 'Unknown stream error' });
                reader.cancel();
                return;
              }
            }
          }
        }

        dispatch({ type: 'STREAM_DONE' });
      } catch (err) {
        // AbortError is a deliberate cancellation — don't surface it as an error.
        if ((err as Error).name === 'AbortError') return;
        dispatch({
          type: 'STREAM_ERROR',
          error: (err as Error).message ?? 'Network error',
        });
      }
    },
    [baseUrl],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    dispatch({ type: 'RESET' });
  }, []);

  return { state, sendMessage, reset };
}
