FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY auth.js db.js k8s.js sync.js ./

CMD ["node", "sync.js"]
