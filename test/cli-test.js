/**
 * Simple test to verify Claude CLI stdin/stdout works correctly
 */

const { spawn } = require('node:child_process');

const PROMPT = 'What is 2+2? Wrap your answer in <answer>{N}</answer>';

console.log('=== Testing Claude CLI ===');
console.log(`Prompt: "${PROMPT}"`);
console.log('');

// Test 1: Claude with --print and stream-json
function testClaude() {
  return new Promise((resolve, reject) => {
    console.log('--- Test: Claude CLI ---');
    console.log('Command: claude --print --output-format=stream-json');

    const proc = spawn('claude', ['--print', '--verbose', '--output-format=stream-json'], {
      cwd: process.cwd(),
    });

    let stdout = '';
    let _stderr = '';

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      console.log('[stdout]', chunk.substring(0, 200));
    });

    proc.stderr.on('data', (data) => {
      _stderr += data.toString();
      console.log('[stderr]', data.toString().substring(0, 200));
    });

    proc.on('close', (code) => {
      console.log(`[exit] code=${code}`);
      console.log('');

      // Check for answer
      const match = stdout.match(/<answer>(\d+)<\/answer>/);
      if (match) {
        console.log(`✓ Found answer: ${match[1]}`);
        resolve(match[1] === '4');
      } else {
        console.log('✗ No answer found in output');
        resolve(false);
      }
    });

    proc.on('error', (err) => {
      console.error('[error]', err.message);
      reject(err);
    });

    // Send the prompt
    console.log('[stdin] Writing prompt...');
    proc.stdin.write(`${PROMPT}\n`);
    proc.stdin.end(); // Important: signal end of input

    // Timeout after 30 seconds
    setTimeout(() => {
      console.log('[timeout] Killing process after 30s');
      proc.kill();
    }, 30000);
  });
}

// Run tests
async function main() {
  try {
    const result = await testClaude();
    console.log('');
    console.log(result ? '=== TEST PASSED ===' : '=== TEST FAILED ===');
    process.exit(result ? 0 : 1);
  } catch (err) {
    console.error('Test error:', err);
    process.exit(1);
  }
}

main();
