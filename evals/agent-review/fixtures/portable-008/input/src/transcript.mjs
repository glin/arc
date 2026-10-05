export function parseTranscript(lines) {
  const text = [];
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.type === 'text') text.push(event.value.trim());
  }
  return text;
}
