// src/api.ts

// Wrapper para chamadas de API
export async function apiFetch(url: string, options: any = {}) {
  // 🔧 Se não definir VITE_API_BASE no .env, usa "" (proxy do Nginx cuida do /api)
  // FIX: Cast import.meta to any to access Vite environment variables.
  const baseUrl = (import.meta as any).env.VITE_API_BASE || "";
  const fullUrl = baseUrl + url;

  // 🔑 Recupera sempre o token JWT do localStorage
  const token = localStorage.getItem("crbApiToken");

  // Monta headers padrão
  const defaultHeaders: Record<string, string> = {};
  if (!(options.body instanceof FormData)) {
    defaultHeaders["Content-Type"] = "application/json";
  }
  if (token) {
    defaultHeaders["Authorization"] = `Bearer ${token}`;
  }

  // Faz request
  const res = await fetch(fullUrl, {
    headers: {
      ...defaultHeaders,
      ...(options.headers || {}),
    },
    ...options,
  });

  // Trata erro HTTP
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("API Error:", res.status, text);
    throw new Error(`API Error ${res.status}: ${text}`);
  }

  // 204 No Content → retorna null
  if (res.status === 204) return null;

  // Caso contrário, parse JSON
  return res.json();
}

// Helpers opcionais: setar/remover token
export function setApiToken(token: string | null) {
  if (token) {
    localStorage.setItem("crbApiToken", token);
  } else {
    localStorage.removeItem("crbApiToken");
  }
}
