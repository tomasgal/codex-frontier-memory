import { captureHook, MAX_EVENT_BYTES } from './adapter.js';

// Hook failures must not interrupt Codex or expose input through diagnostics.
async function main(): Promise<void> {
  const root = process.argv[2];
  const diagnostics = process.argv[3] === '--diagnostics';
  if (!root || (process.argv.length !== 3 && !(process.argv.length === 4 && diagnostics))) return;
  if (diagnostics) process.stderr.write('hook: invoked\n');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += data.length;
    if (size > MAX_EVENT_BYTES) {
      if (diagnostics) process.stderr.write('hook: discarded\n');
      return;
    }
    chunks.push(data);
  }
  try {
    captureHook(root, Buffer.concat(chunks).toString('utf8'));
    if (diagnostics) process.stderr.write('hook: processed\n');
  } catch {
    if (diagnostics) process.stderr.write('hook: discarded\n');
  }
}
main().catch(() => {});
