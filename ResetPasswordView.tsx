import React, { useState, useEffect } from 'react';

export default function ResetPasswordView() {
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    setToken(urlParams.get('token') || '');
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      setMessage(data.message || 'Senha redefinida.');
    } catch {
      setMessage('Erro ao redefinir senha. Tente novamente.');
    }
  };

  return (
    <div className="form-container">
      <h2>Redefinir senha</h2>
      <form onSubmit={handleSubmit}>
        <input
          type="password"
          placeholder="Nova senha"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button className="button">Salvar nova senha</button>
      </form>
      {message && <p>{message}</p>}
    </div>
  );
}
