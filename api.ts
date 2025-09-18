// src/api.ts

// Wrapper para chamadas de API
export async function apiFetch(url: string, options: any = {}) {
  const baseUrl = import.meta.env.VITE_API_BASE; // vem do .env.local ou config da Vercel/EasyPanel
  const fullUrl = baseUrl + url;

  const defaultHeaders: Record<string, string> = {};
  if (!(options.body instanceof FormData)) {
    defaultHeaders["Content-Type"] = "application/json";
  }

  const res = await fetch(fullUrl, {
    headers: {
      ...defaultHeaders,
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API Error ${res.status}: ${text}`);
  }

  // Se não tiver body, retorna null
  if (res.status === 204) return null;

  return res.json();
}
