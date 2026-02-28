import { useEffect, useState } from 'react';
import './AgentAuditOverlay.css';

interface AuditResult {
  name: string;
  binary: string;
  installed: boolean;
  path: string | null;
}

export function AgentAuditOverlay() {
  const [results, setResults] = useState<AuditResult[] | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    fetch('/api/audit')
      .then(res => res.json())
      .then(data => setResults(data))
      .catch(err => console.error("Failed to fetch audit results", err));
  }, []);

  if (dismissed || !results) return null;
  
  const missingAgents = results.filter(r => !r.installed);
  if (missingAgents.length === 0) return null; // Only show if something is missing

  return (
    <div className="audit-overlay">
      <div className="audit-modal">
        <h2>⚠️ Missing CLI Agents Detected</h2>
        <p>Orchestral acts as a local UI wrapper and orchestrator. It requires the underlying agent CLIs to be installed and authenticated on your machine.</p>
        
        <div className="audit-list">
          {results.map(r => (
            <div key={r.name} className={`audit-item ${r.installed ? 'installed' : 'missing'}`}>
              <span className="icon">{r.installed ? '✅' : '❌'}</span>
              <span className="name">{r.name.toUpperCase()}</span>
              <span className="status">{r.installed ? 'Installed' : 'Missing'}</span>
            </div>
          ))}
        </div>

        <p className="note">You can still use Orchestral, but attempts to route tasks to missing agents will fail.</p>
        <button onClick={() => setDismissed(true)}>Acknowledge</button>
      </div>
    </div>
  );
}
