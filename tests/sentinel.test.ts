import { describe, it, expect } from 'vitest';
import { checkSentinel, SENTINEL } from '../src/state/sentinel.js';

describe('checkSentinel', () => {
  it('detects sentinel on last line', () => {
    expect(checkSentinel(`some output\n${SENTINEL}`)).toBe(true);
  });

  it('detects sentinel with trailing newline', () => {
    expect(checkSentinel(`some output\n${SENTINEL}\n`)).toBe(true);
  });

  it('detects sentinel with surrounding whitespace on the line', () => {
    expect(checkSentinel(`output\n  ${SENTINEL}  \n`)).toBe(true);
  });

  it('detects sentinel within the last N lines', () => {
    const lines = Array.from({ length: 8 }, (_, i) => `line ${i}`);
    lines.push(SENTINEL);
    lines.push('', '');
    expect(checkSentinel(lines.join('\n'))).toBe(true);
  });

  it('returns false when sentinel is absent', () => {
    expect(checkSentinel('output without sentinel')).toBe(false);
  });

  it('returns false when sentinel is only inside a word', () => {
    expect(checkSentinel(`prefix_${SENTINEL}`)).toBe(false);
  });

  it('returns false when sentinel is buried too deep', () => {
    const lines = [SENTINEL, ...Array.from({ length: 15 }, () => 'filler')];
    expect(checkSentinel(lines.join('\n'), 10)).toBe(false);
  });

  it('returns true when sentinel is within custom scanLines window', () => {
    const lines = [
      ...Array.from({ length: 5 }, () => 'filler'),
      SENTINEL,
      ...Array.from({ length: 4 }, () => 'after'),
    ];
    expect(checkSentinel(lines.join('\n'), 6)).toBe(true);
  });

  it('handles empty content', () => {
    expect(checkSentinel('')).toBe(false);
  });
});
