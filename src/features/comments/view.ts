/** What a conversation's comment blocks show (pure: the module and its tests use it). */

import { flattenQuote, linesLabel } from '../../platform/comments';
import type { CommentDto, CommentsViewDto, ConversationPlaceDto, ConversationQuoteDto, RangeDto } from '../../platform/protocol';
import { t } from './messages';

/** More comments than this start folded into "N comments". */
export const COLLAPSE_ABOVE = 3;

/** Quotes in blocks and in the comment form are cut here (the extension's plan comments cut at 120). */
export const QUOTE_LIMIT = 120;

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** `sample.ts:12` or `sample.ts:12-15`. */
export function sourceLabel(path: string, range: RangeDto): string {
  return `${basename(path)}:${linesLabel(range)}`;
}

/** Whose words text of the conversation is: `Claude's reply`... */
export function conversationSource(role: ConversationPlaceDto['role']): string {
  switch (role) {
    case 'reply':
      return t('claudesReply');
    case 'thinking':
      return t('claudesThinking');
    case 'user':
      return t('yourMessage');
  }
}

/** Where a comment's text is: `sample.ts:12`, or `Claude's reply` for the conversation's own. */
export function commentSource(comment: CommentDto): string {
  return comment.kind === 'conversation' ? conversationSource(comment.place.role) : sourceLabel(comment.path, comment.range);
}

export function commentsView(comments: readonly CommentDto[]): CommentsViewDto | null {
  if (comments.length === 0) {
    return null;
  }
  return {
    // Newest on top: new blocks stack up from the input.
    blocks: [...comments].reverse().map((comment) => ({
      id: comment.id,
      quote: flattenQuote(comment.quote, QUOTE_LIMIT),
      source: commentSource(comment),
      sourceTitle: comment.kind === 'conversation' ? t('showInConversation') : t('goTo', `${comment.path}:${linesLabel(comment.range)}`),
      text: comment.text,
    })),
    collapsed: comments.length > COLLAPSE_ABOVE,
    quotes: comments.flatMap((comment): ConversationQuoteDto[] =>
      comment.kind === 'conversation' ? [{ quote: comment.quote, place: comment.place }] : [],
    ),
    labels: {
      header: comments.length === 1 ? t('oneComment') : t('manyComments', comments.length),
      hint: t('sentWithNextMessage'),
      edit: t('editComment'),
      remove: t('deleteComment'),
      clear: t('clearAll'),
      expand: t('showComments'),
      collapse: t('hideComments'),
    },
  };
}
