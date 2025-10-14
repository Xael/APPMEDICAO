# --- build stage ---
FROM node:18-alpine AS build
WORKDIR /app

# cache
COPY package*.json ./
RUN npm install

# copie o resto e construa
COPY . .
# se precisar passar VITE_API_BASE no build, o EasyPanel permite arg/env

# Adicione esta linha para forçar o registry principal
RUN npm config set registry https://registry.npmjs.org/

RUN npm run build

# --- runtime stage ---
FROM nginx:alpine
# Nginx para SPA + proxy /api
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

# (opcional) healthcheck; remova se o EasyPanel já checa
# HEALTHCHECK CMD wget -qO- http://localhost/ || exit 1

