import { ContextSupervisor, contextHookOutput } from '../session/supervisor.js';

const MAX_EVENT_BYTES = 256 * 1024;

async function main(): Promise<void> {
  const root = process.argv[2];
  const global = process.argv[3] === '--global';
  if (!root || process.argv.length > (global ? 4 : 3)) return;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += data.length;
    if (length > MAX_EVENT_BYTES) return;
    chunks.push(data);
  }
  const supervisor = new ContextSupervisor(root, { global });
  try {
    const result = supervisor.handle(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const output = contextHookOutput(result);
    if (output) process.stdout.write(output + '\n');
  } finally {
    supervisor.close();
  }
}
// Fail open for Codex; never print input, paths or sensitive diagnostics.
main().catch(() => {});
