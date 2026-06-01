import { useState } from 'react';
import { verifyToken, setToken } from '../api';

function Login({ onAuthed }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!value.trim()) return;
    setChecking(true);
    setError('');
    const ok = await verifyToken(value.trim());
    setChecking(false);
    if (ok) {
      setToken(value.trim());
      onAuthed();
    } else {
      setError('Invalid token. Check the server logs for the generated AUTH_TOKEN.');
    }
  };

  return (
    <div className="login-screen">
      <form className="card login-card" onSubmit={submit}>
        <h1 className="login-title">🦑 RTMP SQUID</h1>
        <p className="login-sub">Enter your access token to continue.</p>
        <div className="form-group">
          <label htmlFor="token">Access token</label>
          <input
            id="token"
            type="password"
            value={value}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- single-purpose login field; focusing it is the expected UX
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            placeholder="AUTH_TOKEN"
          />
        </div>
        {error && <p className="login-error">{error}</p>}
        <button className="btn btn-primary btn-full" type="submit" disabled={checking || !value.trim()}>
          {checking ? 'Checking…' : 'Connect'}
        </button>
      </form>
    </div>
  );
}

export default Login;
