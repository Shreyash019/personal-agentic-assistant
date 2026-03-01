/**
 * useSSEChat — XHR-based Server-Sent Events hook for React Native / Hermes.
 *
 * Why XHR instead of fetch + getReader()?
 * Hermes (the React Native JS engine) does not expose a streaming ReadableStream
 * on fetch responses. XMLHttpRequest fires onreadystatechange progress events as
 * bytes arrive (readyState 3 = LOADING), giving us the same incremental access
 * without relying on the Web Streams API.
 *
 * Wire protocol: shared/api/chat_request.json + shared/api/sse_payloads.json
 */

import { useCallback, useReducer, useRef } from 'react';

// ── Public types ──────────────────────────────────────────────────────────────

/** A single entry in the rendered conversation. */
export type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type ChatState = {
  messages: ChatMessage[];
  /** True between event:tool_call and event:tool_result. */
  isExecutingTool: boolean;
  /** True while the XHR stream is open. */
  isStreaming: boolean;
  /** Non-null when a network or pipeline error has occurred. */
  error: string | null;
};

export type UseSSEChatReturn = {
  messages: ChatMessage[];
  isExecutingTool: boolean;
  isStreaming: boolean;
  error: string | null;
  sendMessage: (text: string) => void;
  reset: () => void;
};

// ── Reducer ───────────────────────────────────────────────────────────────────

type Action =
  | { type: 'USER_MESSAGE'; content: string }
  | { type: 'STREAM_START' }
  | { type: 'APPEND_ASSISTANT_TEXT'; content: string }
  | { type: 'TOOL_EXECUTING' }
  | { type: 'TOOL_DONE'; systemMsg: string }
  | { type: 'STREAM_DONE' }
  | { type: 'STREAM_ERROR'; error: string }
  | { type: 'RESET' };

const initialState: ChatState = {
  messages: [],
  isExecutingTool: false,
  isStreaming: false,
  error: null,
};

function chatReducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {

    case 'USER_MESSAGE':
      return {
        ...state,
        error: null,
        messages: [...state.messages, { role: 'user', content: action.content }],
      };

    case 'STREAM_START':
      return {
        ...state,
        isStreaming: true,
        error: null,
        // Open an empty assistant turn; text tokens are appended into it.
        messages: [...state.messages, { role: 'assistant', content: '' }],
      };

    case 'APPEND_ASSISTANT_TEXT': {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      // Guard: only append if we have an open assistant turn.
      if (!last || last.role !== 'assistant') return state;
      msgs[msgs.length - 1] = { role: 'assistant', content: last.content + action.content };
      return { ...state, messages: msgs };
    }

    case 'TOOL_EXECUTING':
      return { ...state, isExecutingTool: true };

    case 'TOOL_DONE':
      return {
        ...state,
        isExecutingTool: false,
        // Append a system message confirming the action so the user sees it
        // in the conversation history even after the banner disappears.
        messages: [...state.messages, { role: 'system', content: action.systemMsg }],
      };

    case 'STREAM_DONE':
      return { ...state, isStreaming: false };

    case 'STREAM_ERROR':
      return { ...state, isStreaming: false, isExecutingTool: false, error: action.error };

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

const DEFAULT_BASE_URL = 'http://localhost:8080'; // Go backend

export function useSSEChat(baseUrl = DEFAULT_BASE_URL): UseSSEChatReturn {
  const [state, dispatch] = useReducer(chatReducer, initialState);

  // XHR instance kept in a ref so sendMessage / reset can abort it.
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  // Accumulates partial SSE frames that arrive split across XHR progress events.
  const sseBufferRef = useRef('');
  // Tracks how many characters of xhr.responseText we have already processed.
  const processedRef = useRef(0);

  // ── Frame dispatcher ──────────────────────────────────────────────────────
  // dispatch is stable (guaranteed by useReducer), so this callback is safe
  // to reference from inside the XHR closure without stale-closure risk.
  const handleFrame = useCallback((event: string, rawData: string) => {
    let payload: unknown;
    try {
      payload = JSON.parse(rawData);
    } catch {
      // Malformed JSON — silently skip; never crash the stream.
      return;
    }

    switch (event) {
      // event: message → append text token to the current assistant turn.
      case 'message': {
        const { content } = payload as { content: string };
        if (content) dispatch({ type: 'APPEND_ASSISTANT_TEXT', content });
        break;
      }

      // event: tool_call → signal the UI to show the executing banner.
      case 'tool_call':
        dispatch({ type: 'TOOL_EXECUTING' });
        break;

      // event: tool_result → hide the banner and push a confirmation message.
      case 'tool_result': {
        const p = payload as {
          status: 'success' | 'error';
          task_id?: string;
          error_msg?: string;
        };
        const systemMsg =
          p.status === 'success'
            ? `✅ Task created successfully (ID: ${p.task_id ?? 'unknown'})`
            : `❌ Task creation failed: ${p.error_msg ?? 'Unknown error'}`;
        dispatch({ type: 'TOOL_DONE', systemMsg });
        break;
      }

      // event: error → surface as an error state; stream is now dead.
      case 'error': {
        const { error } = payload as { error: string };
        dispatch({ type: 'STREAM_ERROR', error: error ?? 'Unknown stream error' });
        xhrRef.current?.abort();
        break;
      }
    }
  }, []); // dispatch is stable, no deps needed

  // ── sendMessage ───────────────────────────────────────────────────────────
  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      // Abort any in-flight request and reset progressive-read state.
      xhrRef.current?.abort();
      sseBufferRef.current = '';
      processedRef.current = 0;

      dispatch({ type: 'USER_MESSAGE', content: trimmed });
      dispatch({ type: 'STREAM_START' });

      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;

      // async = true so the UI thread is never blocked.
      xhr.open('POST', `${baseUrl}/api/v1/chat`, /* async */ true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Accept', 'text/event-stream');
      xhr.setRequestHeader('Cache-Control', 'no-cache');

      // ── Progressive read ────────────────────────────────────────────────
      // readyState 3 (LOADING): data is arriving.
      // readyState 4 (DONE):    stream is complete or errored.
      // xhr.responseText always contains the FULL accumulated response, so we
      // slice from processedRef.current to extract only the new bytes.
      xhr.onreadystatechange = () => {
        if (
          xhr.readyState !== XMLHttpRequest.LOADING &&
          xhr.readyState !== XMLHttpRequest.DONE
        ) {
          return;
        }

        // Slice only the newly arrived bytes.
        const newChunk = xhr.responseText.slice(processedRef.current);
        processedRef.current = xhr.responseText.length;

        if (newChunk) {
          // Append to our partial-frame buffer, then split on the SSE frame
          // delimiter (blank line). The last split element is the incomplete
          // frame tail — keep it in the buffer for the next progress event.
          sseBufferRef.current += newChunk;
          const frames = sseBufferRef.current.split('\n\n');
          sseBufferRef.current = frames.pop() ?? '';

          for (const frame of frames) {
            const trimmedFrame = frame.trim();
            if (!trimmedFrame) continue;
            const parsed = parseSSEFrame(trimmedFrame);
            if (parsed) handleFrame(parsed.event, parsed.data);
          }
        }

        if (xhr.readyState === XMLHttpRequest.DONE) {
          // Process any final frame left in the buffer (no trailing \n\n).
          if (sseBufferRef.current.trim()) {
            const parsed = parseSSEFrame(sseBufferRef.current.trim());
            if (parsed) handleFrame(parsed.event, parsed.data);
            sseBufferRef.current = '';
          }

          if (xhr.status >= 400) {
            dispatch({
              type: 'STREAM_ERROR',
              error: `HTTP ${xhr.status}: ${xhr.responseText.slice(0, 200)}`,
            });
          } else {
            dispatch({ type: 'STREAM_DONE' });
          }
        }
      };

      xhr.onerror = () => {
        // Log to Metro so network failures are visible during development.
        console.error('[useSSEChat] XHR onerror — cannot reach', baseUrl,
          '| Check BASE_URL / LAN IP and that the Go server is running.');
        dispatch({ type: 'STREAM_ERROR', error: `Cannot connect to ${baseUrl}. Check your BASE_URL.` });
      };

      // onabort fires when we intentionally cancel — not a user-visible error.
      xhr.onabort = () => {
        dispatch({ type: 'STREAM_DONE' });
      };

      // ChatRequest schema: { messages: [{role, content}], stream: true }
      xhr.send(
        JSON.stringify({
          messages: [{ role: 'user', content: trimmed }],
          stream: true,
        }),
      );
    },
    [baseUrl, handleFrame],
  );

  // ── reset ─────────────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    xhrRef.current?.abort();
    xhrRef.current = null;
    sseBufferRef.current = '';
    processedRef.current = 0;
    dispatch({ type: 'RESET' });
  }, []);

  return {
    messages: state.messages,
    isExecutingTool: state.isExecutingTool,
    isStreaming: state.isStreaming,
    error: state.error,
    sendMessage,
    reset,
  };
}
