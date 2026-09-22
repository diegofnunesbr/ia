FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

RUN mkdir -p /app/tessdata && \
    wget -O /app/tessdata/por.traineddata.gz \
    https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0/por.traineddata.gz

COPY index.js db.js llm.js memory.js sessions.js documents.js ./

EXPOSE 3000
CMD ["node", "index.js"]
