function collectSSEEvents(stream, { count = 1, timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = '';
    const timer = setTimeout(() => resolve(events), timeoutMs);

    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          events.push(JSON.parse(line.slice(6)));
        } catch {
          // ignore non-json lines
        }
        if (events.length >= count) {
          clearTimeout(timer);
          resolve(events);
          return;
        }
      }
    });

    stream.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

module.exports = { collectSSEEvents };
