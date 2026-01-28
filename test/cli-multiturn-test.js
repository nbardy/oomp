/**
 * Test multi-turn conversation with Claude CLI using session-id
 * Each message spawns a new process but uses the same session-id to maintain context
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const SESSION_ID = crypto.randomUUID();

console.log('=== Testing Claude CLI Multi-Turn ===');
console.log(`Session ID: ${SESSION_ID}`);
console.log('');

function sendMessage(prompt) {
  return new Promise((resolve, reject) => {
    console.log(`[send] "${prompt}"`);

    const proc = spawn('claude', [
      '--print',
      '--verbose',
      '--output-format=stream-json',
      '--session-id', SESSION_ID,
    ], {
      cwd: process.cwd(),
    });

    let fullOutput = '';

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      fullOutput += chunk;

      // Parse each line
      chunk.split('\n').filter(l => l.trim()).forEach(line => {
        try {
          const json = JSON.parse(line);
          if (json.type === 'assistant') {
            const text = json.message?.content?.[0]?.text || '';
            console.log(`[assistant] ${text.substring(0, 100)}`);
          }
        } catch (e) {
          // Ignore parse errors for partial lines
        }
      });
    });

    proc.stderr.on('data', (data) => {
      console.log('[stderr]', data.toString().substring(0, 100));
    });

    proc.on('close', (code) => {
      console.log(`[exit] code=${code}`);
      resolve(fullOutput);
    });

    proc.on('error', reject);

    // Send the prompt and close stdin
    proc.stdin.write(prompt + '\n');
    proc.stdin.end();
  });
}

async function main() {
  try {
    // Turn 1
    console.log('\n--- Turn 1 ---');
    await sendMessage('Remember the number 42. Just say "OK, I will remember 42"');

    // Turn 2
    console.log('\n--- Turn 2 ---');
    await sendMessage('What number did I ask you to remember? Wrap it in <answer>{N}</answer>');

    console.log('\n=== TEST COMPLETE ===');
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
