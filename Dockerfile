FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV CONVORUM_DB=/data/hub.db PORT=7420
VOLUME /data
EXPOSE 7420
CMD ["node", "bin/convorum.js", "serve"]
