#!/usr/bin/env node
/**
 * Claude Slack Bridge
 *
 * Receives messages in Slack → spawns Claude Code headlessly on Mac mini
 * → sends results back to Slack. Thread = session (conversation continuity).
 *
 * Uses your Pro subscription via Claude Code OAuth — no API costs.
 */

// Load .env from project root
const dotenvPath = require('path').join(__dirname, '..', '.env');
require('fs').readFileSync(dotenvPath, 'utf8').split('\n').forEach((line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  const eq = trimmed.indexOf('=');
  if (eq === -1) return;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = val;
});

const { App } = require('@slack/bolt');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SLACK_BOT_TOKEN  = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN  = process.env.SLACK_APP_TOKEN;
const ALLOWED_USERS    = (process.env.ALLOWED_USERS || '').split(',').filter(Boolean);
const WORKING_DIR      = process.env.CLAUDE_WORKING_DIR || os.homedir();
const MAX_TURNS        = parseInt(process.env.MAX_TURNS || '25', 10);
const HEARTBEAT_SEC    = parseInt(process.env.HEARTBEAT_SEC || '15', 10);
const SESSION_STORE    = path.join(__dirname, '..', 'sessions.json');

// ---------------------------------------------------------------------------
// Session store  (thread_ts → claude session_id)
// ---------------------------------------------------------------------------
class SessionStore {
  constructor(filePath) {
    this.path = filePath;
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {}
  }
  get(threadTs) { return this.data[threadTs]?.sessionId ?? null; }
  set(threadTs, sessionId) {
    this.data[threadTs] = { sessionId, ts: new Date().toISOString() };
    fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
  /** Prune sessions older than N days */
  prune(days = 7) {
    const cutoff = Date.now() - days * 86400000;
    for (const [k, v] of Object.entries(this.data)) {
      if (new Date(v.ts).getTime() < cutoff) delete this.data[k];
    }
    fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
}

const sessions = new SessionStore(SESSION_STORE);
sessions.prune();

// ---------------------------------------------------------------------------
// Slack app (Socket Mode — no public URL needed)
// ---------------------------------------------------------------------------
const app = new App({
  token:     SLACK_BOT_TOKEN,
  appToken:  SLACK_APP_TOKEN,
  socketMode: true,
});

// ---------------------------------------------------------------------------
// Claude Code runner
// ---------------------------------------------------------------------------

/**
 * Spawn `claude -p` and return { result, sessionId }.
 * Sends periodic heartbeat updates to Slack while waiting.
 */
async function runClaude(prompt, { sessionId, channel, threadTs, thinkingTs, client }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--max-turns', String(MAX_TURNS),
      '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch',
    ];

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    const proc = spawn('claude', args, {
      cwd: WORKING_DIR,
      env: {
        ...process.env,
        HOME: os.homedir(),              // ensure claude finds its config
        LANG: 'en_US.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60 * 1000,          // 10 min hard cap
    });

    let stdout = '';
    let stderr = '';
    const startedAt = Date.now();

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    // Heartbeat — update Slack every N seconds so user knows it's alive
    const heartbeat = setInterval(async () => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      try {
        await client.chat.update({
          channel,
          ts: thinkingTs,
          text: `:hourglass_flowing_sand: Working… (${elapsed}s)`,
        });
      } catch {}
    }, HEARTBEAT_SEC * 1000);

    proc.on('close', (code) => {
      clearInterval(heartbeat);
      if (code !== 0 && !stdout) {
        return reject(new Error(stderr || `claude exited with code ${code}`));
      }
      // Try to parse JSON output
      try {
        const json = JSON.parse(stdout);
        resolve({
          result:    json.result || json.text || stdout,
          sessionId: json.session_id || null,
          cost:      json.cost_usd ?? null,
          turns:     json.num_turns ?? null,
        });
      } catch {
        // Fallback: plain text
        resolve({ result: stdout.trim(), sessionId: null, cost: null, turns: null });
      }
    });

    proc.on('error', (err) => {
      clearInterval(heartbeat);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Slack file download helper
// ---------------------------------------------------------------------------
async function downloadSlackFile(fileUrl, destPath) {
  const res = await fetch(fileUrl, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}

// ---------------------------------------------------------------------------
// Message chunker for Slack's 4000-char limit
// ---------------------------------------------------------------------------
function chunkText(text, max = 3900) {
  if (text.length <= max) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    // Try to break at a newline
    let breakAt = max;
    if (remaining.length > max) {
      const nl = remaining.lastIndexOf('\n', max);
      if (nl > max * 0.5) breakAt = nl + 1;
    }
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Extract file paths from Claude output (to upload to Slack)
// ---------------------------------------------------------------------------
function extractOutputFiles(text) {
  const paths = new Set();
  const patterns = [
    /(?:created|wrote|saved|generated|deployed|output)[^`\n]*?[`"]?(\/(?:Users|tmp|home)[^\s`"'\]]+)[`"]?/gi,
    /File:\s*(\/[^\s]+)/gi,
    /\[.*?\]\(computer:\/\/(\/[^\s)]+)\)/gi,
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(text)) !== null) {
      const fp = m[1];
      if (fs.existsSync(fp)) paths.add(fp);
    }
  }
  return [...paths];
}

// ---------------------------------------------------------------------------
// Mention / DM handler
// ---------------------------------------------------------------------------
async function handleMessage(message, client) {
  // Ignore bots and subtypes (joins, edits, etc.)
  if (message.bot_id || message.subtype) return;

  // Auth gate
  if (ALLOWED_USERS.length && !ALLOWED_USERS.includes(message.user)) return;

  // Session key: use channel ID so conversation flows naturally in-channel
  // (no threading — replies go straight to the channel)
  const sessionKey = message.channel;

  // --- Handle file attachments ---
  let fileContext = '';
  if (message.files?.length) {
    const tmpDir = path.join(WORKING_DIR, 'workspace', '_slack-uploads');
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const f of message.files) {
      const dest = path.join(tmpDir, f.name || `file-${Date.now()}`);
      try {
        await downloadSlackFile(f.url_private, dest);
        fileContext += `\n[Attached file: ${f.name} → saved at ${dest}]`;
      } catch (err) {
        fileContext += `\n[Failed to download ${f.name}: ${err.message}]`;
      }
    }
  }

  const prompt = (message.text || '').replace(/<@[A-Z0-9]+>/g, '').trim() + fileContext;
  if (!prompt) return;

  // Post "thinking" placeholder (no thread_ts — stays in channel)
  const thinking = await client.chat.postMessage({
    channel: message.channel,
    text: ':hourglass_flowing_sand: Working…',
  });

  try {
    const existingSession = sessions.get(sessionKey);
    const result = await runClaude(prompt, {
      sessionId: existingSession,
      channel:   message.channel,
      threadTs:  null,
      thinkingTs: thinking.ts,
      client,
    });

    // Store session for channel continuity
    if (result.sessionId) {
      sessions.set(sessionKey, result.sessionId);
    }

    // Send response
    const chunks = chunkText(result.result);

    // Update the "thinking" message with first chunk
    const footer = result.cost != null
      ? `\n_${result.turns ?? '?'} turns · $${result.cost.toFixed(4)}_`
      : '';

    await client.chat.update({
      channel: message.channel,
      ts: thinking.ts,
      text: chunks[0] + (chunks.length === 1 ? footer : ''),
    });

    // Send remaining chunks as follow-ups (no threading)
    for (let i = 1; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await client.chat.postMessage({
        channel: message.channel,
        text: chunks[i] + (isLast ? footer : ''),
      });
    }

    // Upload any output files Claude created (no threading)
    const files = extractOutputFiles(result.result);
    for (const fp of files) {
      try {
        await client.files.uploadV2({
          channel_id: message.channel,
          file: fs.createReadStream(fp),
          filename: path.basename(fp),
          title: path.basename(fp),
        });
      } catch (err) {
        console.error(`[upload] Failed to upload ${fp}:`, err.message);
      }
    }

  } catch (err) {
    console.error('[claude]', err);
    await client.chat.update({
      channel: message.channel,
      ts: thinking.ts,
      text: `:x: Error: ${err.message?.slice(0, 500)}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

// Direct messages
app.event('message', async ({ event, client }) => {
  // Handle DMs and channel messages where bot is mentioned
  if (event.channel_type === 'im') {
    await handleMessage(event, client);
  }
});

// Mentions in channels (@bot)
app.event('app_mention', async ({ event, client }) => {
  await handleMessage(event, client);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async () => {
  await app.start();
  console.log('');
  console.log('  ⚡ Claude Slack Bridge');
  console.log(`  ├─ Working dir : ${WORKING_DIR}`);
  console.log(`  ├─ Max turns   : ${MAX_TURNS}`);
  console.log(`  ├─ Allowed     : ${ALLOWED_USERS.join(', ') || '(everyone)'}`);
  console.log(`  └─ Sessions    : ${SESSION_STORE}`);
  console.log('');
  console.log('  Listening for Slack messages…');
})();
