# Estágio 1: Build da aplicação React com Vite
FROM node:18-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Estágio 2: Servir a aplicação buildada com Nginx
FROM nginx:alpine

# Copia os arquivos estáticos da pasta 'dist' gerada no estágio de build
COPY --from=build /app/dist /usr/share/nginx/html

# Remove a configuração padrão do Nginx
RUN rm /etc/nginx/conf.d/default.conf

# Copia nossa configuração customizada que lida com o proxy para a API
COPY nginx.conf /etc/nginx/conf.d

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]