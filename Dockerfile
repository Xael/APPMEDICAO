# --- build stage ---
FROM node:18-alpine AS build
WORKDIR /app

# cache mais eficiente
COPY package*.json ./
RUN npm ci

# copie o resto e construa
COPY . .
# VITE_API_BASE deve ser passado como env no build pelo EasyPanel
RUN npm run build

# --- runtime stage ---
FROM nginx:alpine
# Nginx para SPA (fallback para /index.html)
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Copia o build estático
COPY --from=build /app/dist /usr/share/nginx/html

# (opcional) healthcheck simples: curl
HEALTHCHECK CMD wget -qO- http://localhost/ || exit 1
