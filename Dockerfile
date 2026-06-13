FROM node:20-alpine

# Install sqlite CLI to run sqlite3 commands inside the container
RUN apk add --no-cache sqlite

WORKDIR /usr/src/app

# Since there is no package.json (only native Node modules), we don't run npm install.
# If you decide to add dependencies later, they will be handled.
COPY . .

EXPOSE 4000

CMD ["node", "dashboard_server.js"]
