FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts

ENV DB_PATH=/app/data/cascade.db
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "src/server.js"]
