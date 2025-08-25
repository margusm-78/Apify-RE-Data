FROM apify/actor-node-playwright:latest

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

CMD ["node", "main.js"]
