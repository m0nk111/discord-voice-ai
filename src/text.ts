// Pure text helpers (no side effects) — shared by the bot and covered by tests.

// Split a message into pieces under Discord's character limit, without breaking words.
export function splitMessage(message: string, limit = 2000): string[] {
  const parts: string[] = [];
  let currentPart = '';
  for (const word of message.split(' ')) {
    if (currentPart.length + word.length + 1 > limit) {
      parts.push(currentPart);
      currentPart = '';
    }
    currentPart += (currentPart.length > 0 ? ' ' : '') + word;
  }
  if (currentPart.length > 0) parts.push(currentPart);
  return parts;
}

// Chunk a full block of text into speakable pieces — split on sentence-ending
// punctuation, falling back to a word cap for very long run-on sentences.
export function chunkForSpeech(text: string, maxWords = 60): string[] {
  const words = text.split(' ');
  const punctuation = ['.', '!', '?', ';', ':'];
  const chunks: string[] = [];

  for (let i = 0; i < words.length;) {
    let end = Math.min(i + maxWords, words.length);
    if (end < words.length) {
      let lastPunct = -1;
      for (let j = i; j < end; j++) {
        if (punctuation.includes(words[j].slice(-1))) lastPunct = j;
      }
      if (lastPunct !== -1) end = lastPunct + 1;
    }
    chunks.push(words.slice(i, end).join(' '));
    i = end;
  }
  return chunks;
}

// Pull complete sentences out of a growing buffer (used while the LLM streams),
// leaving any unfinished trailing text in `rest`. A sentence is text up to
// terminal punctuation followed by whitespace, so decimals like "3.14" and an
// as-yet-unfinished final sentence stay buffered.
export function extractSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  const re = /^([\s\S]*?[.!?]+)(\s+)([\s\S]*)$/;

  let m = rest.match(re);
  while (m) {
    const sentence = m[1].trim();
    if (sentence) sentences.push(sentence);
    rest = m[3];
    m = rest.match(re);
  }
  return { sentences, rest };
}

// Strip Markdown and symbols from text that is about to be spoken, so the TTS
// never reads formatting characters aloud. A safety net for when the model
// ignores the "no formatting" instruction. Text-channel replies do not use this.
export function stripFormatting(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images: ![alt](url) -> alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')   // links: [label](url) -> label
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-+*]\s+|\d+\.\s+)/gm, '') // headings, quotes, list markers
    .replace(/^\s*([-*_] ?){3,}\s*$/gm, '')    // horizontal rules on their own line
    .replace(/`+/g, '')                         // inline code and fences
    .replace(/[*_~]/g, '')                      // bold, italic, strikethrough markers
    .replace(/[ \t]{2,}/g, ' ')                 // tidy leftover spacing
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
