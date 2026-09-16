FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

RUN mkdir -p /data/auth
VOLUME ["/data/auth"]

EXPOSE 3001
CMD ["node", "index.js"]
