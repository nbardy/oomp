/**
 * Test Claude CLI streaming input/output mode
 */

const { spawn } = require('node:child_process');

console.log('=== Testing Claude CLI Streaming Mode ===\n');

const proc = spawn('claude', [
  '--verbose',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--include-partial-messages',
], {
  cwd: process.cwd(),
});

proc.stdout.on('data', (data) => {
  const lines = data.toString().split('\n').filter(l => l.trim());
  lines.forEach(line => {
    try {
      const json = JSON.parse(line);
      console.log(`[stdout] type=${json.type}`, JSON.stringify(json).substring(0, 150));
    } catch {
      console.log(`[stdout raw] ${line.substring(0, 100)}`);
    }
  });
});

proc.stderr.on('data', (data) => {
  console.log('[stderr]', data.toString().substring(0, 200));
});

proc.on('close', (code) => {
  console.log(`[exit] code=${code}`);
});

// Try sending a JSON message
setTimeout(() => {
  // Try format 1: Simple message object
  const msg = JSON.stringify({ type: 'user', content: 'Say "hello streaming"' });
  console.log(`\n[stdin] Sending: ${msg}\n`);
  proc.stdin.write(msg + '\n');
}, 1000);

// Send second message
setTimeout(() => {
  const msg = JSON.stringify({ type: 'user', content: 'What did you just say?' });
  console.log(`\n[stdin] Sending: ${msg}\n`);
  proc.stdin.write(msg + '\n');
}, 10000);

// End after 20 seconds
setTimeout(() => {
  console.log('\n[timeout] Ending...');
  proc.stdin.end();
}, 20000);
