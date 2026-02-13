/**
 * AskUserQuestion Widget
 *
 * Renders interactive question cards when Claude uses the AskUserQuestion tool.
 * Detected via <!--ask_user_question:{json}--> markers in assistant message content.
 *
 * This is display-only — Claude Code handles the actual tool response internally.
 * The widget shows the questions and options so the user can see what Claude is asking,
 * matching the native Claude Code terminal UI.
 */

import { useState } from 'react';
import './AskUserQuestion.css';

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

interface AskUserQuestionInput {
  questions: Question[];
}

// Regex to detect the marker in message content.
// Used by VirtualizedMessageList to split content around these markers.
export const ASK_USER_QUESTION_RE = /<!--ask_user_question:(.*?)-->/gs;

/**
 * Parse marker string into structured data.
 * @throws on malformed JSON — caller should handle gracefully.
 */
export function parseAskUserQuestion(jsonStr: string): AskUserQuestionInput {
  return JSON.parse(jsonStr) as AskUserQuestionInput;
}

export function AskUserQuestionWidget({ data }: { data: AskUserQuestionInput }) {
  return (
    <div className="ask-user-question">
      {data.questions.map((q, qi) => (
        <QuestionCard key={qi} question={q} />
      ))}
    </div>
  );
}

function QuestionCard({ question }: { question: Question }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const toggle = (idx: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (question.multiSelect) {
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
      } else {
        // Single-select: clear and set
        next.clear();
        next.add(idx);
      }
      return next;
    });
  };

  return (
    <div className="ask-question-card">
      {question.header && (
        <span className="ask-question-header">{question.header}</span>
      )}
      <p className="ask-question-text">{question.question}</p>
      <div className="ask-question-options">
        {question.options.map((opt, oi) => (
          <button
            key={oi}
            className={`ask-question-option ${selected.has(oi) ? 'selected' : ''}`}
            onClick={() => toggle(oi)}
          >
            <span className="option-label">{opt.label}</span>
            {opt.description && (
              <span className="option-description">{opt.description}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
