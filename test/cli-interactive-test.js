/**
 * Test Claude CLI without --print to see if we can do interactive streaming
 */

const { spawn } = require('node:child_process');

console.log('=== Testing Claude CLI Interactive Mode ===');

const proc = spawn('claude', [
  '--verbose',
  '--output-format=stream-json',
], {
  cwd: process.cwd(),
});

let messageCount = 0;

proc.stdout.on('data', (data) => {
  console.log('[stdout]', data.toString().substring(0, 300));
});

proc.stderr.on('data', (data) => {
  console.log('[stderr]', data.toString().substring(0, 200));
});

proc.on('close', (code) => {
  console.log(`[exit] code=${code}`);
});

proc.on('error', (err) => {
  console.error('[error]', err.message);
});

// Send first message after a delay
setTimeout(() => {
  console.log('[send] First message');
  proc.stdin.write('Say "hello world". Nothing else.\n');
}, 1000);

// Send second message after response
setTimeout(() => {
  console.log('[send] Second message');
  proc.stdin.write('Now say "goodbye world". Nothing else.\n');
}, 10000);

// End after 20 seconds
setTimeout(() => {
  console.log('[timeout] Ending...');
  proc.stdin.end();
}, 20000);
