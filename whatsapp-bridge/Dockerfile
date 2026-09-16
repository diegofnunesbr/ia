FROM node:20-alpine

WORKDIR /app

# baileys pulls a transitive dependency straight from GitHub, so npm
# needs git available to resolve it.
RUN apk add --no-cache git

COPY package.json ./
RUN npm install --omit=dev

COPY index.js pdf.js ./

RUN mkdir -p /data/auth
VOLUME ["/data/auth"]

EXPOSE 3001
CMD ["node", "index.js"]
