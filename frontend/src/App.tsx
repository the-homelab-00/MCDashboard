import React, { useState, useEffect, useRef, type SubmitEvent } from 'react';
import { Plus, Activity, LogOut, Terminal, Layers, Trash2, RotateCcw } from 'lucide-react';
import './index.css';


// --- Types ---

export interface BotStats {
  shards: number;
  money: number;
  kills: number;
  deaths: number;
}

interface BotAccount {
  id: string;
  username: string;
  type: 'java' | 'bedrock';
  status: 'online' | 'offline' | 'connecting' | 'error';
  logs: string[];
  accountData: BotStats;
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001/ws';

// --- Sub-Component: Bot Card ---
// Extracted to handle individual log scrolling logic
interface BotCardProps {
  acc: BotAccount;
  onToggle: (id: string, status: string) => void;
  onRemove: (id: string) => void;
}

const BotCard: React.FC<BotCardProps> = ({ acc, onToggle, onRemove }) => {
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [acc.logs]);

  return (
    <div className="bot-card glass fade-in">
      {/* HEADER SECTION */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>

        {/* Left Side: Text Info (with truncation fix) */}
        <div style={{ minWidth: 0, marginRight: 12 }}>
          <h3
            style={{
              fontSize: '1.2rem',
              marginBottom: 4,
              whiteSpace: 'nowrap',       // Prevent wrapping
              overflow: 'hidden',         // Hide overflow
              textOverflow: 'ellipsis'    // Add "..." at the end
            }}
            title={acc.username} // Shows full name on hover
          >
            {acc.username}
          </h3>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' }}>
            {acc.type === 'java' ? <Layers size={12} style={{ marginRight: 4 }} /> : <Activity size={12} style={{ marginRight: 4 }} />}
            {acc.type.toUpperCase()} EDITION
          </span>
        </div>

        {/* Right Side: Status Badge */}
        <span
          className={`status-badge status-${acc.status}`}
          style={{ flexShrink: 0 }} // Prevents badge from being squished
        >
          {acc.status}
        </span>
      </div>

      {/* STATS SECTION */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '8px',
        marginBottom: '16px'
      }}>
        <div style={{
          background: 'rgba(255,215,0,0.1)',
          padding: '8px',
          borderRadius: '6px',
          border: '1px solid rgba(255,215,0,0.2)'
        }}>
          <div style={{ fontSize: '0.7rem', color: 'rgba(255,215,0,0.8)', textTransform: 'uppercase', fontWeight: 'bold' }}>
            Shards
          </div>
          <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#ffd700' }}>
            {acc.accountData?.shards?.toLocaleString() || 0}
          </div>
        </div>

        {/* Optional: Add Money display if you are scraping it too */}
        <div style={{
          background: 'rgba(76,175,80,0.1)',
          padding: '8px',
          borderRadius: '6px',
          border: '1px solid rgba(76,175,80,0.2)'
        }}>
          <div style={{ fontSize: '0.7rem', color: 'rgba(76,175,80,0.8)', textTransform: 'uppercase', fontWeight: 'bold' }}>
            Money
          </div>
          <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#4caf50' }}>
            ${acc.accountData?.money?.toLocaleString() || 0}
          </div>
        </div>
      </div>

      {/* LOG VIEWER */}
      <div className="log-viewer" style={{ height: '150px', overflowY: 'auto', background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '4px' }}>
        {acc.logs.map((log, i) => (
          <div key={i} style={{ marginBottom: 4, fontSize: '0.85rem', fontFamily: 'monospace' }}>{log}</div>
        ))}
        {acc.logs.length === 0 && <span style={{ opacity: 0.3, fontSize: '0.85rem' }}>No logs yet...</span>}
        <div ref={logsEndRef} />
      </div>

      {/* FOOTER BUTTONS */}
      <div style={{ marginTop: 20, display: 'flex', gap: 12 }}>
        <button
          className="btn btn-primary"
          style={{ flex: 1 }}
          onClick={() => onToggle(acc.id, acc.status)}
          disabled={acc.status === 'connecting'}
        >
          {acc.status === 'online' ? (
            <><LogOut size={16} style={{ marginRight: 6 }} /> Stop</>
          ) : (
            <>{acc.status === 'connecting' ? <RotateCcw className="spin" size={16} /> : 'Start AFK'}</>
          )}
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => onRemove(acc.id)}
          title="Delete Account"
        >
          <Trash2 size={18} color="var(--error, #ff4444)" />
        </button>
        <button className="btn btn-secondary" title="Open Terminal">
          <Terminal size={18} />
        </button>
      </div>
    </div>
  );
};

// --- Main Application ---
function App() {
  const [accounts, setAccounts] = useState<BotAccount[]>([]);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Modal State
  const [showAddModal, setShowAddModal] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newType, setNewType] = useState<'java' | 'bedrock'>('java');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);

  // WebSocket Connection Manager
  useEffect(() => {
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (socketRef.current?.readyState === WebSocket.OPEN ||
        socketRef.current?.readyState === WebSocket.CONNECTING) {
        return;
      }
      console.log('🔌 Connecting to WebSocket...');
      const socket = new WebSocket(WS_URL);
      socketRef.current = socket;

      socket.onopen = () => {
        console.log('✅ Connected to Backend WebSocket');
        setIsConnected(true);
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'init' || data.type === 'update') {
            setAccounts(data.accounts);
          }
        } catch (err) {
          console.error('❌ Failed to parse WS message:', err);
        }
      };

      socket.onclose = () => {
        console.log('⚠️ WebSocket disconnected. Reconnecting in 3s...');
        setIsConnected(false);
        setWs(null);
        socketRef.current = null;
        // Attempt reconnect
        reconnectTimeout = setTimeout(connect, 3000);
      };

      socket.onerror = (err) => {
        console.error('❌ WebSocket Error:', err);
        socket?.close();
      };

      setWs(socket);
    };

    connect();

    return () => {
      // This is crucial: close the socket when the component unmounts
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
      clearTimeout(reconnectTimeout);
    };
  }, []);

  const addAccount = async (e?: SubmitEvent) => {
    if (e) e.preventDefault();
    if (!newUsername.trim()) return;

    setIsSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername, type: newType })
      });

      if (!res.ok) throw new Error('Failed to add account');

      setShowAddModal(false);
      setNewUsername('');
    } catch (error) {
      alert('Error creating account. Ensure backend is running.');
      console.error(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const removeAccount = async (id: string) => {
    if (!confirm('Are you sure you want to remove this account?')) return;

    try {
      await fetch(`${API_URL}/accounts/${id}`, { method: 'DELETE' });
    } catch (error) {
      console.error('Failed to delete account:', error);
      alert('Failed to delete account.');
    }
  };

  const toggleBot = (id: string, status: string) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      alert('WebSocket is not connected');
      return;
    }

    if (status === 'offline' || status === 'error') {
      ws.send(JSON.stringify({ type: 'connect', id }));
    } else {
      ws.send(JSON.stringify({ type: 'disconnect', id }));
    }
  };

  return (
    <div className="dashboard-container">
      <header>
        <div className="logo">
          MC<span>DASH</span>
          {!isConnected && <span style={{ fontSize: 12, color: 'orange', marginLeft: 10 }}>(Reconnecting...)</span>}
        </div>
        <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
          <Plus size={18} style={{ marginRight: 8 }} /> Add Account
        </button>
      </header>

      <div className="accounts-grid">
        {accounts.map((acc) => (
          <BotCard
            key={acc.id}
            acc={acc}
            onToggle={toggleBot}
            onRemove={removeAccount}
          />
        ))}

        {accounts.length === 0 && isConnected && (
          <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 40, opacity: 0.5 }}>
            <p>No bots configured. Add one to get started.</p>
          </div>
        )}
      </div>

      {showAddModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="glass" style={{ width: 400, padding: 32 }}>
            <h2 style={{ marginBottom: 24 }}>Add New Account</h2>

            <form onSubmit={addAccount}>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', marginBottom: 8, fontSize: '0.9rem' }}>Minecraft Username</label>
                <input
                  type="text"
                  className="glass"
                  autoFocus
                  style={{ width: '100%', padding: '12px', background: 'rgba(255,255,255,0.05)', color: 'white', border: '1px solid var(--glass-border)' }}
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder="Steve"
                />
              </div>
              <div style={{ marginBottom: 24 }}>
                <label style={{ display: 'block', marginBottom: 8, fontSize: '0.9rem' }}>Version</label>
                <select
                  className="glass"
                  style={{ width: '100%', padding: '12px', background: 'rgba(255,255,255,0.05)', color: 'white', border: '1px solid var(--glass-border)' }}
                  value={newType}
                  onChange={(e) => setNewType(e.target.value as 'java' | 'bedrock')}
                >
                  <option value="java">Java Edition</option>
                  <option value="bedrock">Bedrock Edition</option>
                </select>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={isSubmitting}>
                  {isSubmitting ? 'Adding...' : 'Add Account'}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowAddModal(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;