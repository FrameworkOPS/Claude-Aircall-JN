import { flattenTranscript } from '../src/flows/transcript';

describe('flattenTranscript', () => {
  it('handles a plain string', () => {
    expect(flattenTranscript('hello world')).toBe('hello world');
  });

  it('handles { transcription: { content: { utterances } } } shape', () => {
    const raw = {
      transcription: {
        content: {
          utterances: [
            { speaker: 'agent', text: 'Hi, how can I help?' },
            { speaker: 'customer', text: 'My roof is leaking.' },
          ],
        },
      },
    };
    expect(flattenTranscript(raw)).toBe('agent: Hi, how can I help?\ncustomer: My roof is leaking.');
  });

  it('handles a bare array of sentences', () => {
    const raw = { sentences: [{ text: 'one' }, { text: 'two' }] };
    expect(flattenTranscript(raw)).toBe('one\ntwo');
  });

  it('handles { content: { text } } shape', () => {
    expect(flattenTranscript({ content: { text: 'flat text' } })).toBe('flat text');
  });

  it('returns empty string for null / empty', () => {
    expect(flattenTranscript(null)).toBe('');
    expect(flattenTranscript({})).toBe('');
  });
});
