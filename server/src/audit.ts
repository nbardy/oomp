import { getHarness, listHarnesses, resolveBinary } from '@nbardy/agent-cli';

export interface AuditResult {
  name: string;
  binary: string;
  installed: boolean;
  path: string | null;
}

export function auditLocalAgents(): AuditResult[] {
  console.log('\n=========================================================');
  console.log('⧲ Orchestral Local Agent Audit');
  console.log('=========================================================');
  console.log('Orchestral acts as a local orchestrator and UI wrapper.');
  console.log('It requires the underlying CLI agents to be installed');
  console.log('and authenticated on your machine to function correctly.');
  console.log('--------------------------------------------------------\n');

  const harnesses = listHarnesses();
  const results: AuditResult[] = [];
  let allGood = true;

  for (const name of harnesses) {
    const config = getHarness(name);
    try {
      const binPath = resolveBinary(config.binary);
      console.log(`✅ [${name.toUpperCase()}] Installed: ${binPath}`);
      results.push({ name, binary: config.binary, installed: true, path: binPath });
    } catch (e) {
      console.log(`⍌ [${name.toUpperCase()}] NOT FOUND`);
      console.log(`   Expected binary: '${config.binary}'`);
      allGood = false;
      results.push({ name, binary: config.binary, installed: false, path: null });
    }
  }

  console.log('\n==========================================================\n');
  
  if (!allGood) {
    console.log('Note: You can still run Orchestral, but missing agents');
    console.log('will fail when you attempt to route tasks to them.\n');
  }

  return results;
}
