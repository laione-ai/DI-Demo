import { describe, it, expect } from 'vitest';
import { countQuestions, limitToOneQuestion, stripMarkdown, humanizeReply } from '../style';

describe('limitToOneQuestion', () => {
  it('leaves a single-question message alone', () => {
    const t = 'No worries at all! Are you after manual or automatic lessons?';
    expect(limitToOneQuestion(t)).toBe(t);
  });

  it('keeps only the first question when the model bundles several', () => {
    expect(
      limitToOneQuestion(
        'Great, thanks 😊 Could you tell me your postcode? And a little about your previous driving experience?',
      ),
    ).toBe('Great, thanks 😊 Could you tell me your postcode?');
  });

  it('keeps an emoji that belongs to the question', () => {
    expect(limitToOneQuestion('How old are you? 😊 And your postcode?')).toBe('How old are you? 😊');
  });

  it('ignores question marks inside URLs', () => {
    const t = 'Here you go: https://calendar.google.com/render?action=TEMPLATE&x=1 Anything else?';
    expect(countQuestions(t)).toBe(1);
    expect(limitToOneQuestion(t)).toBe(t);
  });

  it('leaves statements with no question alone', () => {
    expect(limitToOneQuestion('Lovely, you are all booked in!')).toBe('Lovely, you are all booked in!');
  });
});

describe('stripMarkdown / humanizeReply', () => {
  it('removes markdown WhatsApp would show literally', () => {
    expect(stripMarkdown('**Kevin** is free\n\n\n\n## Friday')).toBe('Kevin is free\n\nFriday');
  });

  it('applies every rule together', () => {
    expect(humanizeReply('**Perfect!** What is your full name? How old are you?')).toBe(
      'Perfect! What is your full name?',
    );
  });
});
