import { loadForkMarkerReader } from '../../capture/fork.ts';
import { handleHook, logHookError, type HookPayload } from '../../capture/hook.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function run(args: string[]): Promise<number> {
  const event = args[0] ?? '';
  let payload: HookPayload = {};
  try {
    payload = JSON.parse((await readStdin()) || '{}') as HookPayload;
    const ev = event || payload.hook_event_name || '';
    // Only capturing events can record a fork parent; don't pay for loading src/ask on every prompt.
    const readForkMarker = ev === 'Stop' || ev === 'SessionEnd' ? await loadForkMarkerReader() : undefined;
    handleHook(ev, payload, { readForkMarker });
  } catch (err) {
    logHookError(payload.cwd, event, err);
  }
  return 0; // never block the agent
}
