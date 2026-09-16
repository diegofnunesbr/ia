FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Portuguese OCR data, fetched once at build time so tesseract.js never
# needs to reach the internet at runtime (the namespace's NetworkPolicy
# blocks that anyway).
RUN mkdir -p /app/tessdata && \
    wget -O /app/tessdata/por.traineddata.gz \
    https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0/por.traineddata.gz

COPY index.js db.js memory.js notes.js sessions.js whatsapp.js documents.js ./

EXPOSE 3000
CMD ["node", "index.js"]
