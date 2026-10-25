FROM node:24-slim

# Ensure SSL/TLS CA certificates are installed for Discord Gateway WSS
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "--dns-result-order=ipv4first", "bot.js"]
