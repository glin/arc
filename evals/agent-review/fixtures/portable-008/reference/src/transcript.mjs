export function parseTranscript(lines) {
  const text = [];
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.type === 'text') text.push(String(event.value ?? ''));
  }
  return text;
}
