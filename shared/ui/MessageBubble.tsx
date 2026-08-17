/**
 * One entry in the transcript.
 *
 * The name is a holdover: assistant replies are deliberately *not* bubbles.
 * They are prose set directly on the page, because that is what they are — a
 * two-paragraph answer wrapped in a bordered card reads as a widget, and a
 * transcript of twenty such cards is a stack of panels rather than a document.
 * Only the user's own messages get a surface, and only so the eye can find
 * where each exchange begins when scanning back.
 *
 * Memoised, and that matters more than it looks: without it every finalized
 * message re-renders on every chunk of a streaming one, which re-parses their
 * markdown and re-runs their diagrams. That was the flicker.
 *
 * @module shared/ui/MessageBubble
 */

import React from 'react';
import type { ChatMessage } from './types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ReasoningBlock } from './ReasoningBlock';
import { ToolCallCard } from './ToolCallCard';

export const MessageBubble = React.memo(function MessageBubble({
  message,
}: { message: ChatMessage }): React.ReactElement {
  if (message.type === 'tool') {
    return (
      <ToolCallCard
        name={message.toolName || 'Tool'}
        args={message.toolArgs}
        result={message.toolResult}
        running={message.toolRunning}
        {...(message.toolProgressMs !== undefined ? { progressMs: message.toolProgressMs } : {})}
      />
    );
  }

  if (message.type === 'reasoning') {
    return (
      <ReasoningBlock
        text={message.content}
        streaming={message.streaming === true}
        {...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {})}
      />
    );
  }

  if (message.type === 'user') {
    return (
      <div className="my-6 flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-aico-elevated px-4 py-2.5 selectable">
          <p className="whitespace-pre-wrap break-words text-[15px] leading-[26px] text-aico-primary">
            {message.content}
          </p>
        </div>
      </div>
    );
  }

  if (message.type === 'assistant') {
    return (
      <div className="my-5 selectable">
        <MarkdownRenderer content={message.content} streaming={message.streaming === true} />
        {message.streaming && <span className="stream-cursor" aria-hidden />}
      </div>
    );
  }

  if (message.type === 'error') {
    return (
      <div className="my-4 flex items-start gap-2 rounded-xl border border-aico-danger/30 bg-aico-danger/8 px-4 py-2.5 selectable">
        <span className="mt-0.5 text-[13px] text-aico-danger">✕</span>
        <span className="flex-1 text-[14px] text-aico-danger">{message.content}</span>
      </div>
    );
  }

  return (
    <div className="my-2 px-1 text-[13px] text-aico-muted selectable">{message.content}</div>
  );
});
