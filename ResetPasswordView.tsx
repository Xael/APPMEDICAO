import React, { useState, useEffect } from 'react';

export default function ResetPasswordView() {
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  
  // Novo estado para controlar se a operação foi bem-sucedida
  const [isSuccess, setIsSuccess] = useState(false);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const tokenFromUrl = urlParams.get('token');
    if (!tokenFromUrl) {
        setMessage('Token de redefinição não encontrado na URL.');
    }
    setToken(tokenFromUrl || '');
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });

      const data = await res.json();
      
      // Verifica se a resposta da API foi positiva (status 2xx)
      if (res.ok) {
        setMessage(data.message || 'Senha redefinida com sucesso!');
        setIsSuccess(true); // Define o sucesso como verdadeiro
      } else {
        // Se a API retornar um erro (status 4xx, 5xx), exibe a mensagem de erro
        setMessage(data.message || 'Ocorreu um erro. O token pode ser inválido ou ter expirado.');
      }
    } catch (err) {
      setMessage('Erro de conexão. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: '400px', margin: 'auto' }}>
      <h2>Redefinir senha</h2>

      {/* Se a redefinição foi bem-sucedida, mostra a mensagem e o botão de login */}
      {isSuccess ? (
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: 'green', fontWeight: 'bold' }}>{message}</p>
          <button
            className="button"
            onClick={() => (window.location.href = '/')}
          >
            Ir para Login
          </button>
        </div>
      ) : (
        /* Caso contrário, mostra o formulário de nova senha */
        <>
          <form onSubmit={handleSubmit}>
            <input
              type="password"
              placeholder="Digite sua nova senha"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6} // É uma boa prática definir um tamanho mínimo
            />
            <button className="button" disabled={loading || !token}>
              {loading ? 'Salvando...' : 'Salvar nova senha'}
            </button>
          </form>
          {/* Exibe mensagens de erro ou de status aqui */}
          {message && <p style={{ color: 'red', marginTop: '1rem', textAlign: 'center' }}>{message}</p>}
        </>
      )}
    </div>
  );
}
