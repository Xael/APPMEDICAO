import React, { useState } from 'react';

export default function ForgotPasswordView() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      setMessage(data.message || 'Verifique seu e-mail para redefinir a senha.');
    } catch (err) {
      setMessage('Erro ao enviar solicitação. Tente novamente.');
    }
    setLoading(false);
  };

  return (
    <div className="form-container">
      <h2>Recuperar senha</h2>
      <form onSubmit={handleSubmit}>
        <input
          type="email"
          placeholder="E-mail cadastrado"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <button className="button" disabled={loading}>
          {loading ? 'Enviando...' : 'Enviar link de redefinição'}
        </button>
      </form>
      {message && <p>{message}</p>}
    </div>
  );
}
