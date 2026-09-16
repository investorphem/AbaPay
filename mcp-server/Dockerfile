# ⚡ TWO LINES, ON PURPOSE — zero npm dependencies (server.js uses only Node's built-in http/
# https), so there is no `npm install` step and nothing here that could fail on a missing or
# misconfigured secret. This is the whole point: a build that can only ever succeed or fail on
# its own code, not on the consumer app's Supabase/VTpass/RPC configuration.
FROM node:20-slim
WORKDIR /app
COPY server.js package.json ./
EXPOSE 8080
CMD ["node", "server.js"]
