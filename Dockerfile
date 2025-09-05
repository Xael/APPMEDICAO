# --- build stage ---
FROM node:18-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm install   # <= trocado

COPY . .
RUN npm run build

# --- runtime stage ---
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

HEALTHCHECK CMD wget -qO- http://localhost/ || exit 1
