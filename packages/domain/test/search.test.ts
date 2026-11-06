import { describe, expect, it } from 'vitest';
import { search } from '../src';

const { ageYears, matchCommands, parseDob, parseQuery, shortName } = search;

describe('search queries (G-03)', () => {
  it('tells a date of birth, a number, a name and a command apart', () => {
    expect(parseQuery('')).toMatchObject({ kind: 'empty' });
    expect(parseQuery('r')).toMatchObject({ kind: 'empty' });
    expect(parseQuery('3/7/1984')).toEqual({ kind: 'dob', text: '3/7/1984', dob: '1984-03-07' });
    expect(parseQuery('1984-03-07')).toMatchObject({ kind: 'dob', dob: '1984-03-07' });
    expect(parseQuery('LFM-26-004790')).toMatchObject({ kind: 'number' });
    expect(parseQuery('8810447')).toMatchObject({ kind: 'number' });
    expect(parseQuery('  rivera ')).toEqual({
      kind: 'name',
      text: 'rivera',
      names: { a: 'rivera', b: null, comma: false },
    });
    expect(parseQuery('Rivera, A')).toMatchObject({ names: { a: 'Rivera', b: 'A', comma: true } });
    expect(parseQuery('ana rivera')).toMatchObject({ names: { a: 'ana', b: 'rivera', comma: false } });
    expect(parseQuery('> upload')).toEqual({ kind: 'command', text: 'upload' });
  });

  it('rejects dates that do not exist', () => {
    expect(parseDob('2/30/1990')).toBeNull();
    expect(parseDob('13/1/1990')).toBeNull();
    expect(parseDob('1/1/1800')).toBeNull();
  });

  it('shows a patient as "Last, F." with an age in whole years', () => {
    expect(shortName('Rivera', 'ana')).toBe('Rivera, A.');
    expect(ageYears('1984-03-07', '2026-03-06')).toBe(41);
    expect(ageYears('1984-03-07', '2026-03-07')).toBe(42);
  });

  it('matches commands by the start of any word', () => {
    const cmds = [
      { id: 'a', label: 'Upload 835 file', href: '/remittances?upload=1', keywords: ['remittance', 'era'] },
      { id: 'b', label: 'Go to denials', href: '/denials' },
    ];
    expect(matchCommands(cmds, 'up').map((c) => c.id)).toEqual(['a']);
    expect(matchCommands(cmds, 'go den').map((c) => c.id)).toEqual(['b']);
    expect(matchCommands(cmds, 'era').map((c) => c.id)).toEqual(['a']);
    expect(matchCommands(cmds, '').map((c) => c.id)).toEqual(['a', 'b']);
    // A match on the label beats one that needed a keyword.
    const go = [...cmds, { id: 'c', label: 'Go to remittances', href: '/remittances' }];
    expect(matchCommands(go, 'rem').map((c) => c.id)).toEqual(['c', 'a']);
  });
});
