// Reads a Server-Sent Events stream from a fetch() Response.
// EventSource can only make GET requests, and asking a question is a POST with a JSON body,
// so for /ask we read the stream ourselves. Bytes can arrive split anywhere (even mid-line),
// so we buffer until a complete event (terminated by a blank line) is available.
export async function* readSse(res: Response): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        // lines starting with ":" are heartbeats/comments; "retry:" is for EventSource
      }
      if (data.length) yield { event, data: JSON.parse(data.join('\n')) };
    }
  }
}
