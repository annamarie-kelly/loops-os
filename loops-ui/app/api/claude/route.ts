import { NextRequest } from 'next/server';
import { spawn } from 'node:child_process';
import path from 'node:path';

// POST /api/claude — streams Claude Code CLI output as SSE.
// Uses `--verbose --output-format stream-json` for turn-by-turn streaming.
//
// Session support:
//   - Pass `sessionId` to maintain context across messages.
//   - First message creates the session, subsequent ones resume it.
//
// Body: { prompt: string, sessionId?: string, isResume?: boolean, cwd?: string }
// Response: SSE stream of typed events, terminated by [DONE].

export const runtime = 'nodejs';
export const maxDuration = 300;

// The actual Obsidian vault — where .claude/commands/ (skills) and all
// vault files live. This is the CWD for every claude -p invocation so
// it picks up /decompose, /triage, /review, etc. automatically.
const VAULT_ROOT = process.env.LOOPS_UI_VAULT_ROOT
  ? path.resolve(process.env.LOOPS_UI_VAULT_ROOT)
  : path.resolve(process.cwd(), '../vault-template');

// Concise context so Claude knows the domain without being told each time.
// Customize the handoff repos to match your project layout.
const SYSTEM_CONTEXT = `
You are running inside the Loops OS chat panel — an embedded Claude Code
interface in a task manager UI.

Your working directory is the Obsidian vault at: ${VAULT_ROOT}
You have access to all vault slash commands via /decompose, /triage, /review, etc.

Key vocabulary:
- "loop" = a task (any \`- [ ]\` in the vault). Canonical list: 06-Loops/loops.json.
- "spec" / "agent spec" = design doc in the specs folder. YAML frontmatter with status: drafting|ready|building|shipped.
- "spec" (skill) = flesh out a drafting spec — search vault for context, ask goals, write the full spec.
- "decompose" = break a spec into actionable loops. Use the /decompose skill.
- "handoff" = dispatch a spec to an isolated agent in a git worktree. Agent implements, user reviews the branch.
- "triage" = review untriaged loops and decide: accept, someday, drop, snooze.
- "distill" = extract claim-style patterns from notes.
- "review" = weekly metacognition.

Vault folders: 00-Inbox, 01-Building, 02-Thinking, 03-Working, 04-Living, 05-Relating, 06-Loops, 07-Archive.

Be concise — output renders in a narrow side panel.
`.trim();

export async function POST(request: NextRequest) {
  let body: { prompt?: string; sessionId?: string; isResume?: boolean; cwd?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { prompt, sessionId, isResume, cwd } = body;
  if (!prompt || typeof prompt !== 'string') {
    return new Response(JSON.stringify({ error: 'prompt required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Run from the vault root so claude picks up .claude/commands/* skills
  const workDir = cwd || VAULT_ROOT;

  // Build CLI args
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--dangerously-skip-permissions'];
  args.push('--append-system-prompt', SYSTEM_CONTEXT);
  if (sessionId) {
    if (isResume) {
      args.push('--resume', sessionId);
    } else {
      args.push('--session-id', sessionId);
    }
  }
  args.push(prompt);

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let stdoutBuffer = '';
      let hasStreamedDeltas = false;
      let sentTextLength = 0;

      const send = (obj: { type: string; text: string }) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };

      const close = () => {
        if (closed) return;
        closed = true;
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      };

      const child = spawn('claude', args, {
        cwd: workDir,
        env: { ...process.env, TERM: 'dumb' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
          const event = JSON.parse(trimmed);

          // Assistant message — content blocks (thinking, text, tool_use)
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'thinking' && typeof block.thinking === 'string') {
                hasStreamedDeltas = true;
                send({ type: 'thinking', text: block.thinking });
              } else if (block.type === 'text' && typeof block.text === 'string') {
                hasStreamedDeltas = true;
                // stream-json sends accumulated text — only forward the new portion
                const newText = block.text.slice(sentTextLength);
                if (newText) {
                  send({ type: 'text', text: newText });
                  sentTextLength = block.text.length;
                }
              } else if (block.type === 'tool_use' && block.name) {
                hasStreamedDeltas = true;
                // Surface tool activity like Claude Code does
                const toolName = block.name as string;
                const input = block.input ?? {};
                let detail = '';
                if (toolName === 'Read' && input.file_path) {
                  detail = (input.file_path as string).split('/').pop() ?? '';
                } else if (toolName === 'Glob' && input.pattern) {
                  detail = input.pattern as string;
                } else if (toolName === 'Grep' && input.pattern) {
                  detail = input.pattern as string;
                } else if (toolName === 'Edit' && input.file_path) {
                  detail = (input.file_path as string).split('/').pop() ?? '';
                } else if (toolName === 'Write' && input.file_path) {
                  detail = (input.file_path as string).split('/').pop() ?? '';
                } else if (toolName === 'Bash' && input.command) {
                  detail = (input.command as string).slice(0, 60);
                } else if (toolName === 'Skill' && input.skill) {
                  detail = `/${input.skill as string}`;
                }
                send({ type: 'activity', text: `${toolName}${detail ? ': ' + detail : ''}` });
                // Tool use means a new turn is coming — reset text tracker
                sentTextLength = 0;
              }
            }
            return;
          }

          // Final result — fallback + session ID
          if (event.type === 'result') {
            if (!hasStreamedDeltas && typeof event.result === 'string') {
              send({ type: 'text', text: event.result });
            }
            if (event.session_id) {
              send({ type: 'session', text: event.session_id });
            }
            return;
          }

          // System init — grab session_id early
          if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
            send({ type: 'session', text: event.session_id });
            return;
          }

        } catch {
          send({ type: 'text', text: trimmed });
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        if (closed) return;
        stdoutBuffer += chunk.toString('utf-8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (closed) return;
        const text = chunk.toString('utf-8').trim();
        if (!text) return;
        if (text.includes('Invalid session ID')) {
          send({ type: 'error', text: 'session_invalid' });
        } else {
          send({ type: 'text', text: `[stderr] ${text}` });
        }
      });

      child.on('error', (err) => {
        if (closed) return;
        send({ type: 'text', text: `[error] ${err.message}` });
        close();
      });

      child.on('close', () => {
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        close();
      });

      request.signal.addEventListener('abort', () => {
        child.kill('SIGTERM');
        close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
