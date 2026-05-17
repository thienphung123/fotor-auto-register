FROM node:22-alpine

# openssl can de gen self-signed cert lan dau
RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev || true

COPY server.js countries.js ./

# certs dir mount tu host volume de persist cert
RUN mkdir -p /app/certs

EXPOSE 8443

CMD ["node", "server.js"]
