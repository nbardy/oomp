/**
 * API Tests for Claude Multi-Chat
 *
 * Spins up the server and tests WebSocket communication
 * Run with: npm test
 */

const WebSocket = require('ws');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 3001; // Use different port for tests
const SERVER_URL = `ws://localhost:${PORT}`;

let serverProcess = null;

/**
 * Start the server on test port
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: PORT };
    serverProcess = spawn('npx', ['tsx', 'src/server.ts'], {
      cwd: path.join(__dirname, '..', 'server'),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let started = false;

    serverProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('[Server]', output.trim());
      if (output.includes('Server running') && !started) {
        started = true;
        setTimeout(resolve, 200); // Give it a moment
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error('[Server Error]', data.toString().trim());
    });

    serverProcess.on('error', reject);

    // Timeout if server doesn't start
    setTimeout(() => {
      if (!started) reject(new Error('Server failed to start'));
    }, 5000);
  });
}

/**
 * Stop the server
 */
function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

/**
 * Create WebSocket connection
 */
function createConnection() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Connection timeout')), 3000);
  });
}

/**
 * Wait for specific message type from WebSocket
 */
function waitForMessage(ws, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for message type: ${type}`));
    }, timeout);

    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch (_e) {
        // Ignore parse errors
      }
    };

    ws.on('message', handler);
  });
}

/**
 * Send WebSocket message
 */
function send(ws, data) {
  ws.send(JSON.stringify(data));
}

// Test runner
async function runTests() {
  console.log('\n🧪 Starting API Tests\n');
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      console.log(`❌ ${name}`);
      console.log(`   Error: ${err.message}`);
      failed++;
    }
  }

  try {
    // Start server
    console.log('Starting server...');
    await startServer();
    console.log('Server started on port', PORT);
    console.log('');

    // Test: Connect and receive init
    await test('Connect and receive init message', async () => {
      const ws = await createConnection();
      const msg = await waitForMessage(ws, 'init');
      if (!msg.conversations) throw new Error('Missing conversations array');
      if (!msg.defaultCwd) throw new Error('Missing defaultCwd');
      ws.close();
    });

    // Test: Create conversation
    await test('Create new conversation', async () => {
      const ws = await createConnection();
      await waitForMessage(ws, 'init');

      send(ws, { type: 'new_conversation' });
      const msg = await waitForMessage(ws, 'conversation_created');

      if (!msg.conversation) throw new Error('Missing conversation');
      if (!msg.conversation.id) throw new Error('Missing conversation id');
      if (!msg.conversation.workingDirectory) throw new Error('Missing workingDirectory');

      ws.close();
    });

    // Test: Create conversation with custom directory
    await test('Create conversation with custom directory', async () => {
      const ws = await createConnection();
      await waitForMessage(ws, 'init');

      send(ws, {
        type: 'new_conversation',
        workingDirectory: '/tmp',
      });
      const msg = await waitForMessage(ws, 'conversation_created');

      if (msg.conversation.workingDirectory !== '/tmp') {
        throw new Error(`Expected /tmp, got ${msg.conversation.workingDirectory}`);
      }

      ws.close();
    });

    // Test: Invalid directory returns error
    await test('Invalid directory returns error', async () => {
      const ws = await createConnection();
      await waitForMessage(ws, 'init');

      send(ws, {
        type: 'new_conversation',
        workingDirectory: '/nonexistent/path/12345',
      });
      const msg = await waitForMessage(ws, 'error');

      if (!msg.message.includes('not found')) {
        throw new Error(`Expected 'not found' error, got: ${msg.message}`);
      }

      ws.close();
    });

    // Test: Delete conversation
    await test('Delete conversation', async () => {
      const ws = await createConnection();
      await waitForMessage(ws, 'init');

      // Create first
      send(ws, { type: 'new_conversation' });
      const created = await waitForMessage(ws, 'conversation_created');
      const convId = created.conversation.id;

      // Delete
      send(ws, {
        type: 'delete_conversation',
        conversationId: convId,
      });
      const deleted = await waitForMessage(ws, 'conversation_deleted');

      if (deleted.conversationId !== convId) {
        throw new Error('Deleted wrong conversation');
      }

      ws.close();
    });

    // Test: Multiple connections receive same state
    await test('Multiple connections sync state', async () => {
      const ws1 = await createConnection();
      const init1 = await waitForMessage(ws1, 'init');

      // Create conversation on ws1
      send(ws1, { type: 'new_conversation' });
      await waitForMessage(ws1, 'conversation_created');

      // Connect ws2 and check it sees the conversation
      const ws2 = await createConnection();
      const init2 = await waitForMessage(ws2, 'init');

      if (init2.conversations.length !== init1.conversations.length + 1) {
        throw new Error('Second connection missing new conversation');
      }

      ws1.close();
      ws2.close();
    });

    console.log(`\n${'='.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${'='.repeat(40)}\n`);
  } finally {
    stopServer();
  }

  process.exit(failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch((err) => {
  console.error('Test runner error:', err);
  stopServer();
  process.exit(1);
});
