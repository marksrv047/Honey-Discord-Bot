FROM node:22-slim

# Ensure SSL/TLS CA certificates and curl are installed for Discord Gateway WSS
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_OPTIONS="--dns-result-order=ipv4first"
EXPOSE 3000
CMD ["node", "bot.js"]

